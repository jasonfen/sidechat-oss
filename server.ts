import { Hono } from "hono";
import { timing } from "hono/timing";
import { Database } from "bun:sqlite";
import { createHash, timingSafeEqual } from "crypto";
import { getCookie, setCookie, deleteCookie } from "hono/cookie";
import type { Context, Next } from "hono";
import { mkdirSync, unlinkSync, existsSync } from "fs";
import { extname } from "path";

// --- SQLite Database ---

const DB_PATH = Bun.env.DB_PATH ?? "/var/sidechat/sidechat.db";
const db = new Database(DB_PATH, { create: true });
db.exec("PRAGMA journal_mode=WAL");

db.exec(`
  CREATE TABLE IF NOT EXISTS clients (
    id            INTEGER PRIMARY KEY AUTOINCREMENT,
    name          TEXT NOT NULL,
    public_key    TEXT NOT NULL UNIQUE,
    fingerprint   TEXT NOT NULL UNIQUE,
    status        TEXT NOT NULL DEFAULT 'pending',
    can_post      INTEGER NOT NULL DEFAULT 1,
    source_ip     TEXT,
    registered_at TEXT NOT NULL,
    approved_at   TEXT,
    last_seen     TEXT,
    last_ip       TEXT,
    auto_mention_replies_to_me INTEGER NOT NULL DEFAULT 1
  );
  CREATE TABLE IF NOT EXISTS nonces (
    id          INTEGER PRIMARY KEY AUTOINCREMENT,
    value       TEXT NOT NULL UNIQUE,
    fingerprint TEXT NOT NULL,
    expires_at  TEXT NOT NULL,
    used        INTEGER NOT NULL DEFAULT 0
  );
  CREATE TABLE IF NOT EXISTS sessions (
    id          INTEGER PRIMARY KEY AUTOINCREMENT,
    token       TEXT NOT NULL UNIQUE,
    fingerprint TEXT NOT NULL,
    expires_at  TEXT NOT NULL,
    created_at  TEXT NOT NULL,
    scope       TEXT NOT NULL DEFAULT 'full'
  );
  CREATE TABLE IF NOT EXISTS admin_sessions (
    id         INTEGER PRIMARY KEY AUTOINCREMENT,
    token      TEXT NOT NULL UNIQUE,
    expires_at TEXT NOT NULL,
    created_at TEXT NOT NULL
  );
  CREATE TABLE IF NOT EXISTS observers (
    id            INTEGER PRIMARY KEY AUTOINCREMENT,
    username      TEXT NOT NULL UNIQUE,
    password_hash TEXT NOT NULL,
    status        TEXT NOT NULL DEFAULT 'active',
    can_post      INTEGER NOT NULL DEFAULT 1,
    created_at    TEXT NOT NULL,
    last_seen     TEXT,
    last_ip       TEXT,
    auto_mention_replies_to_me INTEGER NOT NULL DEFAULT 1
  );
  CREATE TABLE IF NOT EXISTS observer_sessions (
    id          INTEGER PRIMARY KEY AUTOINCREMENT,
    token       TEXT NOT NULL UNIQUE,
    observer_id INTEGER NOT NULL REFERENCES observers(id),
    created_at  TEXT NOT NULL,
    expires_at  TEXT
  );
  CREATE TABLE IF NOT EXISTS files (
    id          TEXT PRIMARY KEY,
    filename    TEXT NOT NULL,
    stored_name TEXT NOT NULL,
    size        INTEGER NOT NULL,
    mime_type   TEXT NOT NULL DEFAULT 'application/octet-stream',
    uploader    TEXT NOT NULL,
    message_id  INTEGER,
    uploaded_at TEXT NOT NULL
  );
  CREATE TABLE IF NOT EXISTS settings (
    key   TEXT PRIMARY KEY,
    value TEXT NOT NULL
  );

  -- 2.4.0 scaffolding: messages + receipts tables. Reads + writes still flow
  -- through the in-memory messages array and receipt Maps until the read-path
  -- migration lands in a subsequent commit. Creating the tables now + running
  -- the one-time backfill at startup lets us verify the migration shape
  -- without touching the runtime hot path.
  CREATE TABLE IF NOT EXISTS messages (
    id          INTEGER PRIMARY KEY,
    timestamp   TEXT NOT NULL,
    sender      TEXT NOT NULL,
    content     TEXT NOT NULL,
    mentions    TEXT NOT NULL DEFAULT '[]',
    reply_to_id INTEGER REFERENCES messages(id)
  );
  CREATE INDEX IF NOT EXISTS messages_timestamp ON messages(timestamp);
  CREATE INDEX IF NOT EXISTS messages_reply_to_id ON messages(reply_to_id) WHERE reply_to_id IS NOT NULL;

  CREATE TABLE IF NOT EXISTS message_receipts (
    message_id INTEGER NOT NULL REFERENCES messages(id) ON DELETE CASCADE,
    username   TEXT NOT NULL,
    kind       TEXT NOT NULL CHECK(kind IN ('delivered', 'engaged', 'read')),
    created_at TEXT NOT NULL,
    PRIMARY KEY (message_id, username, kind)
  );
  CREATE INDEX IF NOT EXISTS message_receipts_msg_kind ON message_receipts(message_id, kind);
`);

// --- Schema migrations ---

try { db.exec("ALTER TABLE clients ADD COLUMN webhook_url TEXT"); } catch {}
try { db.exec("ALTER TABLE clients ADD COLUMN webhook_secret TEXT"); } catch {}
try { db.exec("ALTER TABLE observer_sessions ADD COLUMN expires_at TEXT"); } catch {}
try { db.exec("ALTER TABLE clients ADD COLUMN last_known_version TEXT"); } catch {}
try { db.exec("ALTER TABLE observers ADD COLUMN role TEXT NOT NULL DEFAULT 'observer'"); } catch {}
try { db.exec("ALTER TABLE sessions ADD COLUMN scope TEXT NOT NULL DEFAULT 'full'"); } catch {}
try { db.exec("ALTER TABLE clients ADD COLUMN auto_mention_replies_to_me INTEGER NOT NULL DEFAULT 1"); } catch {}
try { db.exec("ALTER TABLE observers ADD COLUMN auto_mention_replies_to_me INTEGER NOT NULL DEFAULT 1"); } catch {}

// One-time backfill (2.6.4): mark all pre-2.4.0 messages as `read` for every
// active client/observer. The 2.4.0 migration (af7b1db) built the receipt
// table and backfilled messages but did NOT retroactively mark anyone's
// historical mentions as read, so every pre-2026-04-19 mention sat in
// perpetual pending for every active bot. Symptom caught 2026-04-21 when
// fenbot and ansi both hit 70+/213+ mention backlogs on /mention-check.
// Idempotent via settings-table marker — if it ran once, skip forever.
try {
  const markerKey = "backfill_markers.read_gap_v2_4_0";
  const existing = db.query("SELECT value FROM settings WHERE key = ?").get(markerKey) as { value: string } | undefined;
  if (!existing) {
    const cutoff = "2026-04-19T00:00:00Z"; // 2.4.0 ship date
    const activeClientNames = (db.query("SELECT name FROM clients WHERE status = 'active'").all() as any[]).map(r => r.name as string);
    const activeObserverNames = (db.query("SELECT username FROM observers WHERE status = 'active'").all() as any[]).map(r => r.username as string);
    const activeUsers = new Set<string>([...activeClientNames, ...activeObserverNames]);
    const ts = new Date().toISOString();
    const insertReceipt = db.prepare(
      "INSERT OR IGNORE INTO message_receipts (message_id, username, kind, created_at) VALUES (?, ?, 'read', ?)"
    );
    let backfilled = 0;
    const tx = db.transaction(() => {
      const rows = db.query(
        "SELECT id, mentions FROM messages WHERE timestamp < ?"
      ).all(cutoff) as Array<{ id: number; mentions: string }>;
      for (const row of rows) {
        let mentions: string[] = [];
        try { mentions = JSON.parse(row.mentions || "[]"); } catch {}
        for (const u of mentions) {
          if (activeUsers.has(u)) {
            const r = insertReceipt.run(row.id, u, ts);
            if (r.changes > 0) backfilled++;
          }
        }
      }
    });
    tx();
    const markerValue = JSON.stringify({
      completed_at: new Date().toISOString(),
      cutoff,
      active_user_count: activeUsers.size,
      receipts_inserted: backfilled,
    });
    db.run("INSERT INTO settings (key, value) VALUES (?, ?)", [markerKey, markerValue]);
    console.log(`[migration] read_gap_v2_4_0 backfill: ${backfilled} read receipts inserted for ${activeUsers.size} active users (cutoff ${cutoff})`);
  }
} catch (err) {
  console.error("[migration] read_gap_v2_4_0 backfill failed:", err);
}

// Endpoints an MCP-scoped session (scope='mcp') is allowed to reach. Anything
// else returns 403 with reason=scope_denied. Full-scoped sessions are
// unrestricted. Method-path pairs; `:id` and `:fp` bind any path segment.
const MCP_SCOPE_ALLOWED: Array<{ method: string; pattern: RegExp }> = [
  { method: "POST",   pattern: /^\/message$/ },
  { method: "GET",    pattern: /^\/messages$/ },
  { method: "GET",    pattern: /^\/messages\/pending-mentions$/ },
  { method: "POST",   pattern: /^\/messages\/[^\/]+\/read$/ },
  { method: "POST",   pattern: /^\/messages\/[^\/]+\/engaged$/ },
  { method: "POST",   pattern: /^\/messages\/[^\/]+\/delivered$/ },
  { method: "GET",    pattern: /^\/users$/ },
  { method: "GET",    pattern: /^\/version$/ },
  { method: "GET",    pattern: /^\/health$/ },
  { method: "GET",    pattern: /^\/events$/ },
];
function mcpScopeAllows(method: string, path: string): boolean {
  return MCP_SCOPE_ALLOWED.some((r) => r.method === method && r.pattern.test(path));
}

// --- Build version ---
// SERVER_VERSION = human-readable semver from package.json (e.g. "2.1.0").
//   Bump in package.json on each release. This is what shows in the admin UI.
// SERVER_SHA = build-stamped git short SHA (via Dockerfile ARG BUILD_SHA).
//   Shown as tooltip in admin UI, useful for pinpointing exact builds between
//   version bumps. Falls back to "unknown" if not built with --build-arg.
let SERVER_VERSION = "0.0.0";
let SERVER_SHA = "unknown";
try { SERVER_VERSION = (JSON.parse(await Bun.file(`${import.meta.dir}/package.json`).text()).version || "0.0.0").trim(); } catch {}
try { SERVER_SHA = (await Bun.file(`${import.meta.dir}/version.txt`).text()).trim() || "unknown"; } catch {}

// MCP_SCHEMA_REV bumps whenever the MCP tool surface changes in a way that
// requires clients to re-handshake (tool added/removed/renamed, arg schema
// changed). Monotonic integer. Separate from SERVER_VERSION because the REST
// surface can evolve without touching MCP.
const MCP_SCHEMA_REV = 1;

// MCP_EXPECTED_CLIENT_BUILD_SHA is the release-tag of mcp/src/server.ts that
// this server release pairs with. When a client's CLIENT_BUILD_SHA diverges
// from this, the version probe logs a drift warning. Intentionally a release
// tag (not a commit sha): handshake is anchored at release boundaries where
// operators reinstall MCP. Bump at release time in lockstep with the client's
// CLIENT_BUILD_SHA.
const MCP_EXPECTED_CLIENT_BUILD_SHA = "2.6.11";

// --- Config from env ---

const ADMIN_USER = Bun.env.ADMIN_USER ?? "admin";
const ADMIN_PASSWORD_HASH = Bun.env.ADMIN_PASSWORD_HASH ?? "";
const SESSION_TTL_HOURS = parseInt(Bun.env.SESSION_TTL_HOURS ?? "24", 10);
// scope=mcp sessions get a longer default (30d). The whitelist enforcement
// narrows the blast radius vs full-scope tokens, so a longer TTL is an
// acceptable tradeoff for not having to re-auth mid-session every 24h.
const MCP_SESSION_TTL_HOURS = parseInt(Bun.env.MCP_SESSION_TTL_HOURS ?? "720", 10);
const NONCE_TTL_SECONDS = parseInt(Bun.env.NONCE_TTL_SECONDS ?? "60", 10);
const ADMIN_SESSION_TTL_HOURS = parseInt(Bun.env.ADMIN_SESSION_TTL_HOURS ?? "8", 10);

// --- File Transfer Config ---

const FILES_DIR = Bun.env.FILES_DIR ?? "/var/sidechat/files";
const ORPHAN_FILE_TTL_MS = 24 * 60 * 60 * 1000; // 24 hours

try { mkdirSync(FILES_DIR, { recursive: true }); } catch {}

// Defaults — overridable via admin settings
const FILE_DEFAULTS = {
  max_file_size: 50 * 1024 * 1024,       // 50 MB per file
  max_user_storage: 500 * 1024 * 1024,    // 500 MB per user
  max_total_storage: 5 * 1024 * 1024 * 1024, // 5 GB global
};

function getSetting(key: string, fallback: number): number {
  const row = db.query("SELECT value FROM settings WHERE key = ?").get(key) as any;
  return row ? parseInt(row.value, 10) : fallback;
}

function setSetting(key: string, value: number) {
  db.run("INSERT INTO settings (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = ?", [key, String(value), String(value)]);
}

function getFileSettings() {
  return {
    max_file_size: getSetting("max_file_size", FILE_DEFAULTS.max_file_size),
    max_user_storage: getSetting("max_user_storage", FILE_DEFAULTS.max_user_storage),
    max_total_storage: getSetting("max_total_storage", FILE_DEFAULTS.max_total_storage),
  };
}

// --- Cleanup Loop (every 5 minutes) ---

function runCleanup() {
  const now = new Date().toISOString();
  db.run("DELETE FROM nonces WHERE expires_at < ? OR used = 1", [now]);
  db.run("DELETE FROM sessions WHERE expires_at < ?", [now]);
  db.run("DELETE FROM admin_sessions WHERE expires_at < ?", [now]);
  db.run("DELETE FROM observer_sessions WHERE expires_at IS NOT NULL AND expires_at < ?", [now]);

  // Clean up orphaned files (uploaded but never attached to a message)
  const cutoff = new Date(Date.now() - ORPHAN_FILE_TTL_MS).toISOString();
  const orphans = db.query(
    "SELECT id, stored_name FROM files WHERE message_id IS NULL AND uploaded_at < ?"
  ).all(cutoff) as { id: string; stored_name: string }[];
  for (const orphan of orphans) {
    try { unlinkSync(`${FILES_DIR}/${orphan.stored_name}`); } catch {}
    db.run("DELETE FROM files WHERE id = ?", [orphan.id]);
  }
  if (orphans.length > 0) {
    console.log(`Cleaned up ${orphans.length} orphaned file(s)`);
  }
}

function getTotalFileStorage(): number {
  const row = db.query("SELECT COALESCE(SUM(size), 0) as total FROM files").get() as { total: number };
  return row.total;
}

function getUserFileStorage(uploader: string): number {
  const row = db.query("SELECT COALESCE(SUM(size), 0) as total FROM files WHERE uploader = ?").get(uploader) as { total: number };
  return row.total;
}
runCleanup(); // run once at startup
setInterval(runCleanup, 5 * 60 * 1000);

// --- SSH Key Parsing & Crypto Utilities ---

function parseOpenSSHEd25519PublicKey(pubkeyLine: string): Uint8Array {
  const parts = pubkeyLine.trim().split(/\s+/);
  if (parts[0] !== "ssh-ed25519") {
    throw new Error("Unsupported key type: " + parts[0]);
  }
  const blob = Buffer.from(parts[1], "base64");
  let offset = 0;
  const typeLen = blob.readUInt32BE(offset);
  offset += 4;
  const keyType = blob.subarray(offset, offset + typeLen).toString("utf8");
  offset += typeLen;
  if (keyType !== "ssh-ed25519") {
    throw new Error("Key type mismatch in blob: " + keyType);
  }
  const keyLen = blob.readUInt32BE(offset);
  offset += 4;
  if (keyLen !== 32) {
    throw new Error("Unexpected Ed25519 key length: " + keyLen);
  }
  return blob.subarray(offset, offset + keyLen);
}

async function importEd25519PublicKey(pubkeyLine: string): Promise<CryptoKey> {
  const rawKey = parseOpenSSHEd25519PublicKey(pubkeyLine);
  return await crypto.subtle.importKey("raw", rawKey, { name: "Ed25519" }, false, ["verify"]);
}

async function verifySignature(pubkeyLine: string, nonce: string, signatureB64: string): Promise<boolean> {
  try {
    const cryptoKey = await importEd25519PublicKey(pubkeyLine);
    const sigBytes = Buffer.from(signatureB64, "base64");

    // Try raw Ed25519 signature first (64 bytes)
    if (sigBytes.length === 64) {
      const message = new TextEncoder().encode(nonce);
      if (await crypto.subtle.verify("Ed25519", cryptoKey, sigBytes, message)) return true;
    }

    // Try parsing as SSH signature blob (from ssh-keygen -Y sign)
    return await verifySSHSignature(cryptoKey, nonce, sigBytes);
  } catch {
    return false;
  }
}

async function verifySSHSignature(cryptoKey: CryptoKey, nonce: string, blob: Buffer): Promise<boolean> {
  try {
    // SSH signature blob: "SSHSIG" magic + uint32 version + length-prefixed fields
    const magic = blob.subarray(0, 6).toString("ascii");
    if (magic !== "SSHSIG") return false;

    let o = 6;
    o += 4; // skip version

    // Skip public key blob (length-prefixed)
    const pkLen = blob.readUInt32BE(o); o += 4 + pkLen;
    // Read namespace (length-prefixed)
    const nsLen = blob.readUInt32BE(o); o += 4;
    const namespace = blob.subarray(o, o + nsLen).toString("utf8"); o += nsLen;
    // Skip reserved (length-prefixed)
    const rsLen = blob.readUInt32BE(o); o += 4 + rsLen;
    // Read hash algorithm (length-prefixed)
    const haLen = blob.readUInt32BE(o); o += 4;
    const hashAlgo = blob.subarray(o, o + haLen).toString("utf8"); o += haLen;
    // Read signature blob (length-prefixed)
    const sigBlobLen = blob.readUInt32BE(o); o += 4;
    const sigBlob = blob.subarray(o, o + sigBlobLen);

    // Extract raw signature from inner sigBlob: key type (length-prefixed) + raw sig (length-prefixed)
    let s = 0;
    const ktLen = sigBlob.readUInt32BE(s); s += 4 + ktLen;
    const rawSigLen = sigBlob.readUInt32BE(s); s += 4;
    const rawSig = sigBlob.subarray(s, s + rawSigLen);

    // Reconstruct the signed message: ssh-keygen -Y sign signs a structured message
    // SSHSIG magic preamble + namespace + reserved + hash_algo + H(message)
    const dataHash = createHash("sha512").update(Buffer.from(nonce)).digest();

    const parts: Buffer[] = [];
    parts.push(Buffer.from("SSHSIG"));
    // namespace (length-prefixed)
    const nsBuf = Buffer.from(namespace);
    const nsLenBuf = Buffer.alloc(4); nsLenBuf.writeUInt32BE(nsBuf.length);
    parts.push(nsLenBuf, nsBuf);
    // reserved (empty, length-prefixed)
    const emptyLen = Buffer.alloc(4); emptyLen.writeUInt32BE(0);
    parts.push(emptyLen);
    // hash algorithm (length-prefixed)
    const haBuf = Buffer.from(hashAlgo);
    const haLenBuf = Buffer.alloc(4); haLenBuf.writeUInt32BE(haBuf.length);
    parts.push(haLenBuf, haBuf);
    // hash of data (length-prefixed)
    const dhLenBuf = Buffer.alloc(4); dhLenBuf.writeUInt32BE(dataHash.length);
    parts.push(dhLenBuf, dataHash);

    const signedMessage = Buffer.concat(parts);

    return await crypto.subtle.verify("Ed25519", cryptoKey, rawSig, signedMessage);
  } catch {
    return false;
  }
}

function computeFingerprint(pubkeyLine: string): string {
  const rawKey = parseOpenSSHEd25519PublicKey(pubkeyLine);
  return createHash("sha256").update(rawKey).digest("hex");
}

function getClientIP(c: Context): string {
  return c.req.header("x-forwarded-for") ?? "unknown";
}

// --- Structured audit log ---
// One JSON line per security/activity event to stdout. `docker logs sidechat`
// is the canonical audit surface; downstream aggregation (Loki, Splunk,
// whatever) is the consumer's choice. Spec: docs/PLAN-logging-2026-04-15.md.
const LOG_VERBOSE = (Bun.env.LOG_VERBOSE ?? "") === "1";

function localTimestamp(): string {
  const d = new Date();
  const pad = (n: number) => String(n).padStart(2, "0");
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}T${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}`;
}

function logEvent(event: string, fields: Record<string, unknown> = {}): void {
  console.log(JSON.stringify({ ts: localTimestamp(), event, ...fields }));
}

// --- Bootstrap admin observer ---
// If no admin exists in the observers table and ADMIN_USER + ADMIN_PASSWORD_HASH
// env vars are set, seed one admin observer. Idempotent — only fires when the
// admin set is empty. Env stays meaningful as a recovery hatch ("forgot all
// admin passwords → set env, restart, login").
{
  if (ADMIN_PASSWORD_HASH && !ADMIN_PASSWORD_HASH.startsWith("$2")) {
    throw new Error("ADMIN_PASSWORD_HASH is not a valid bcrypt hash (must start with $2). Refusing to start.");
  }
  if (ADMIN_USER && ADMIN_PASSWORD_HASH) {
    db.transaction(() => {
      const adminCount = (db.query("SELECT COUNT(*) AS n FROM observers WHERE role = 'admin'").get() as any).n;
      if (adminCount > 0) return;
      const existing = db.query("SELECT id FROM observers WHERE username = ?").get(ADMIN_USER) as any;
      if (existing) {
        db.run("UPDATE observers SET role = 'admin', password_hash = ?, status = 'active' WHERE id = ?", [ADMIN_PASSWORD_HASH, existing.id]);
        logEvent("admin.bootstrap.restored", { username: ADMIN_USER, observer_id: existing.id, action: "promoted_existing" });
      } else {
        db.run(
          "INSERT INTO observers (username, password_hash, status, can_post, role, created_at) VALUES (?, ?, 'active', 1, 'admin', ?)",
          [ADMIN_USER, ADMIN_PASSWORD_HASH, new Date().toISOString()]
        );
        logEvent("admin.bootstrap.restored", { username: ADMIN_USER, action: "inserted_new" });
      }
    })();
  }
}

// --- CSRF (double-submit cookie) ---
// Issue: set httpOnly cookie + embed token in HTML as <meta name="csrf">.
// Verify on POST: cookie value must equal X-CSRF-Token header.
// Browsers enforce same-origin cookie policy, so cross-site forgeries can't
// set the cookie. The header echo proves the page was loaded same-origin.
function issueCsrfToken(c: Context): string {
  const existing = getCookie(c, "csrf_token");
  if (existing && /^[a-f0-9]{32,}$/.test(existing)) return existing;
  const token = crypto.randomUUID().replace(/-/g, "") + crypto.randomUUID().replace(/-/g, "");
  setCookie(c, "csrf_token", token, {
    httpOnly: true,
    secure: isRequestSecure(c),
    sameSite: "Lax",
    path: "/",
    maxAge: 60 * 60 * 4,
  });
  return token;
}

function verifyCsrfToken(c: Context): boolean {
  const cookieToken = getCookie(c, "csrf_token");
  const headerToken = c.req.header("x-csrf-token");
  return !!cookieToken && !!headerToken && cookieToken === headerToken;
}

// Parse JSON body with proper status codes: 415 for non-JSON content-type,
// 400 for missing/empty/malformed JSON. Replaces unguarded `c.req.json()`
// calls that previously surfaced as 500s when clients sent form-encoded
// or empty POSTs.
async function parseJsonBody<T extends object>(c: Context): Promise<{ ok: true; body: T } | { ok: false; res: Response }> {
  const ct = (c.req.header("content-type") ?? "").toLowerCase();
  if (!ct.startsWith("application/json")) {
    return { ok: false, res: c.json({ error: "Content-Type must be application/json" }, 415) };
  }
  try {
    const body = await c.req.json<T>();
    if (body === null || typeof body !== "object") {
      return { ok: false, res: c.json({ error: "Request body must be a JSON object" }, 400) };
    }
    return { ok: true, body };
  } catch {
    return { ok: false, res: c.json({ error: "Invalid JSON body" }, 400) };
  }
}

function adminSessionIdShort(token: string | undefined | null): string | undefined {
  return token ? token.slice(0, 6) : undefined;
}

async function hashUrlHostShort(url: string): Promise<string> {
  try {
    const host = new URL(url).host;
    const buf = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(host));
    return Array.from(new Uint8Array(buf)).slice(0, 4).map(b => b.toString(16).padStart(2, "0")).join("");
  } catch { return "invalid_url"; }
}

// --- Auth rate limiting ---
// Per-IP counter for failed auth attempts. Blocks brute force of weak
// observer passwords and nonce flooding against /auth/challenge. Counts
// only failures so a correct login doesn't burn the budget.
const authRateLimit = new Map<string, { count: number; resetAt: number }>();
const AUTH_RATE_WINDOW_MS = 60_000;
const AUTH_RATE_MAX = 10;

function checkAuthRateLimit(c: Context) {
  const ip = getClientIP(c);
  const now = Date.now();
  const rec = authRateLimit.get(ip);
  if (rec && rec.resetAt > now && rec.count >= AUTH_RATE_MAX) {
    const retryAfter = Math.max(1, Math.ceil((rec.resetAt - now) / 1000));
    return c.json(
      { error: "Too many auth attempts — try again later" },
      429,
      { "Retry-After": String(retryAfter) }
    );
  }
  return null;
}

function recordAuthFailure(c: Context) {
  const ip = getClientIP(c);
  const now = Date.now();
  const rec = authRateLimit.get(ip);
  if (!rec || rec.resetAt < now) {
    authRateLimit.set(ip, { count: 1, resetAt: now + AUTH_RATE_WINDOW_MS });
  } else {
    rec.count++;
  }
}

// Periodic sweep so the map can't grow forever from one-off attackers.
setInterval(() => {
  const now = Date.now();
  for (const [ip, rec] of authRateLimit) {
    if (rec.resetAt < now) authRateLimit.delete(ip);
  }
}, 5 * 60_000).unref?.();

// Whether the original client request was over HTTPS. Honors
// X-Forwarded-Proto from a TLS-terminating reverse proxy so cookies set
// behind Traefik/Caddy keep the Secure flag, while a bare HTTP deployment
// issues non-Secure cookies that browsers will actually store.
function isRequestSecure(c: Context): boolean {
  const xfProto = c.req.header("x-forwarded-proto");
  if (xfProto) return xfProto.split(",")[0].trim().toLowerCase() === "https";
  return new URL(c.req.url).protocol === "https:";
}

// --- Data Structures ---

interface FileAttachment {
  id: string;
  filename: string;
  size: number;
  mime_type: string;
}

interface Message {
  id: number;
  timestamp: string;
  sender: string;
  content: string;
  mentions: string[];
  files?: FileAttachment[];
  reply_to_id?: number | null;
  reply_count?: number;
}

// 2.4.0 retired: the in-memory `messages` array and the
// `readReceipts` / `deliveryReceipts` / `engagedReceipts` Maps. All state
// now lives in SQLite (tables `messages` + `message_receipts`).
// `messageCounter` is the sole in-memory piece that stays — it's the
// id generator for new posts, initialized from MAX(id) on boot and
// monotonically incremented thereafter.
let messageCounter = 0;

// --- Prometheus Counters ---
let webhookDeliveriesTotal = 0;
let webhookDeliveriesFailedTotal = 0;
let authAttemptsTotal = 0;
let authAttemptsFailedTotal = 0;
let messagesPostedTotal = 0;
let fileUploadsTotal = 0;

function parseMentions(content: string): string[] {
  const botNames = (db.query("SELECT name FROM clients WHERE status = 'active'").all() as any[]).map(r => r.name);
  const observerNames = (db.query("SELECT username FROM observers WHERE status = 'active'").all() as any[]).map(r => r.username);
  const allUsernames = [...botNames, ...observerNames, ADMIN_USER];
  return allUsernames.filter(username => {
    const escaped = username.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    return new RegExp(`@${escaped}\\b`, "i").test(content);
  });
}

// Per-user opt-out for "reply to my message implicitly mentions me".
// Default-on for all clients/observers (admin has no row, defaults on).
function isAutoMentionOptedOut(username: string): boolean {
  const c = db.query(
    "SELECT auto_mention_replies_to_me AS v FROM clients WHERE name = ?"
  ).get(username) as { v: number } | null;
  if (c) return c.v === 0;
  const o = db.query(
    "SELECT auto_mention_replies_to_me AS v FROM observers WHERE username = ?"
  ).get(username) as { v: number } | null;
  if (o) return o.v === 0;
  return false;
}

// --- Webhook Delivery ---

async function deliverWebhooks(msg: Message) {
  if (msg.mentions.length === 0) return;
  const clients = db.query(
    "SELECT name, fingerprint, webhook_url, webhook_secret FROM clients WHERE status = 'active' AND webhook_url IS NOT NULL"
  ).all() as any[];
  for (const client of clients) {
    if (!msg.mentions.includes(client.name)) continue;
    if (msg.sender === client.name) continue;
    const payload = JSON.stringify({
      event: "mention",
      message: msg,
      mentioned: client.name,
      timestamp: new Date().toISOString(),
    });
    const headers: Record<string, string> = {
      "Content-Type": "application/json",
      "X-SideChat-Event": "mention",
    };
    if (client.webhook_secret) {
      const hmac = new Bun.CryptoHasher("sha256", client.webhook_secret);
      hmac.update(payload);
      headers["X-SideChat-Signature"] = `sha256=${hmac.digest("hex")}`;
    }
    fetch(client.webhook_url, {
      method: "POST",
      headers,
      body: payload,
      signal: AbortSignal.timeout(5000),
      redirect: "error",
    }).then((res) => {
      if (res.ok) {
        db.run(
          "INSERT OR IGNORE INTO message_receipts (message_id, username, kind, created_at) VALUES (?, ?, ?, ?)",
          [msg.id, client.name, "delivered", new Date().toISOString()]
        );
        broadcastEvent("delivered", { id: msg.id, bot: client.name });
        webhookDeliveriesTotal++;
      } else {
        webhookDeliveriesFailedTotal++;
        logEvent("webhook.delivery.fail", { fingerprint: client.fingerprint ?? null, username: client.name, http_status: res.status });
      }
    }).catch((err) => {
      webhookDeliveriesFailedTotal++;
      logEvent("webhook.delivery.fail", { fingerprint: client.fingerprint ?? null, username: client.name, http_status: 0, reason: String(err?.name ?? "fetch_error") });
    });
  }
}

// --- SSE Client Management ---

const sseClients = new Set<(event: string, data: any) => void>();

// Per-sender open-connection counter. A runaway or malicious bot that opens
// dozens of SSE streams can exhaust file descriptors and the 15s heartbeat
// timers, so cap at a generous-but-bounded limit per identity.
const sseConnectionsPerSender = new Map<string, number>();
const MAX_SSE_CONNECTIONS_PER_SENDER = 5;

function broadcastEvent(event: string, data: any) {
  sseClients.forEach((send) => send(event, data));
}

// --- Archive & Snapshot ---

const ARCHIVE_DIR = Bun.env.ARCHIVE_DIR ?? "/var/sidechat/archives";
const ARCHIVE_INTERVAL_MS = 15 * 60 * 1000;
let lastArchivedId = 0;

function todayLogPath(): string {
  const date = new Date().toISOString().slice(0, 10); // YYYY-MM-DD
  return `${ARCHIVE_DIR}/${date}.md`;
}

// 2.4.0: writeArchive now sources from SQLite. No snapshot write — the
// durable source of truth is the DB itself. This function only maintains
// the daily markdown archive as a human-readable log stream.
async function writeArchive() {
  const newMessages = db
    .query(
      "SELECT id, timestamp, sender, content, reply_to_id FROM messages WHERE id > ? ORDER BY id"
    )
    .all(lastArchivedId) as Array<{ id: number; timestamp: string; sender: string; content: string; reply_to_id: number | null }>;
  if (newMessages.length === 0) return;

  const filepath = todayLogPath();
  const lines: string[] = [];

  const file = Bun.file(filepath);
  if (!(await file.exists())) {
    const date = new Date().toISOString().slice(0, 10);
    lines.push(`# SideChat Log — ${date}`, "", "---", "");
  }

  for (const msg of newMessages) {
    const time = msg.timestamp.split("T")[1]?.split(".")[0] ?? msg.timestamp;
    const replyPrefix = msg.reply_to_id ? ` ↪#${msg.reply_to_id}` : "";
    lines.push(`**[${time}] ${msg.sender}**${replyPrefix}`);
    lines.push(msg.content);
    lines.push("");
    lines.push("---");
    lines.push("");
  }

  try {
    const existing = (await file.exists()) ? await file.text() : "";
    await Bun.write(filepath, existing + lines.join("\n"));
    lastArchivedId = newMessages[newMessages.length - 1].id;
    console.log(`Archive appended ${newMessages.length} messages to ${filepath}`);
  } catch (err) {
    console.error(`Archive failed: ${err}`);
  }
}

// 2.4.0 startup: messageCounter + lastArchivedId initialize from SQLite.
// Rehydrate-from-snapshot is retired — the DB is the source of truth.
try {
  const row = db.query("SELECT COALESCE(MAX(id), 0) AS max_id FROM messages").get() as { max_id: number };
  messageCounter = row.max_id;
  lastArchivedId = messageCounter;
  console.log(`messageCounter initialized from SQLite: ${messageCounter}`);
} catch (err) {
  console.error(`Failed to initialize messageCounter from SQLite: ${err}`);
}

setInterval(writeArchive, ARCHIVE_INTERVAL_MS);

process.on("SIGTERM", () => process.exit(0));
process.on("SIGINT", () => process.exit(0));

// --- Web Frontend ---

function buildChatPage(username: string, canPost: boolean, sessionToken: string, nonce: string): string {
  return `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1, maximum-scale=1, user-scalable=no">
<title>SideChat</title>
<link rel="icon" href="data:image/svg+xml,<svg xmlns='http://www.w3.org/2000/svg' viewBox='0 0 100 100'><g fill='rgb(126,231,135)'><ellipse cx='50' cy='15' rx='13' ry='20'/><ellipse cx='84' cy='40' rx='13' ry='20' transform='rotate(72 84 40)'/><ellipse cx='71' cy='82' rx='13' ry='20' transform='rotate(144 71 82)'/><ellipse cx='29' cy='82' rx='13' ry='20' transform='rotate(216 29 82)'/><ellipse cx='16' cy='40' rx='13' ry='20' transform='rotate(288 16 40)'/></g><circle cx='50' cy='50' r='26' fill='rgb(56,139,253)'/><path d='M34 45 h32 a3 3 0 0 1 3 3 v10 a3 3 0 0 1 -3 3 h-20 l-7 6 v-6 h-5 a3 3 0 0 1 -3 -3 v-10 a3 3 0 0 1 3 -3 z' fill='white'/></svg>">
<style>
  * { margin: 0; padding: 0; box-sizing: border-box; }
  body {
    background: #0d1117;
    color: #c9d1d9;
    font-family: 'SF Mono', 'Cascadia Code', 'Fira Code', 'Consolas', monospace;
    font-size: 14px;
    height: 100vh;
    display: flex;
    flex-direction: row;
  }
  #sidebar {
    width: 220px;
    min-width: 220px;
    background: #010409;
    border-right: 1px solid #21262d;
    display: flex;
    flex-direction: column;
    height: 100vh;
    overflow: hidden;
    transition: width 0.15s, min-width 0.15s;
  }
  #sidebar.collapsed {
    width: 36px;
    min-width: 36px;
  }
  #sidebar.collapsed #calendar,
  #sidebar.collapsed #files-panel,
  #sidebar.collapsed #sidebar-label { display: none; }
  #signout-btn { background: none; border: 1px solid #30363d; border-radius: 6px; color: #c9d1d9; padding: 4px 12px; font-family: inherit; font-size: 12px; cursor: pointer; }
  #signout-btn:hover { border-color: #8b949e; }
  #sidebar-header {
    padding: 0 14px;
    height: 45px;
    font-size: 11px;
    font-weight: 600;
    color: #484f58;
    text-transform: uppercase;
    letter-spacing: 0.8px;
    border-bottom: 1px solid #21262d;
    flex-shrink: 0;
    display: flex;
    align-items: center;
    justify-content: space-between;
  }
  #sidebar.collapsed #sidebar-header {
    padding: 0;
    justify-content: center;
  }
  #sidebar-toggle {
    background: none;
    border: none;
    color: #484f58;
    cursor: pointer;
    font-size: 14px;
    padding: 2px 4px;
    line-height: 1;
  }
  #sidebar-toggle:hover { color: #c9d1d9; }
  #calendar {
    flex: 1;
    overflow-y: auto;
    padding: 10px 12px;
    user-select: none;
  }
  #cal-header {
    display: flex;
    align-items: center;
    justify-content: space-between;
    margin-bottom: 8px;
  }
  #cal-title {
    font-size: 12px;
    font-weight: 600;
    color: #c9d1d9;
    letter-spacing: 0.3px;
  }
  #cal-prev, #cal-next, #cal-today {
    background: none;
    border: none;
    color: #8b949e;
    cursor: pointer;
    font-size: 16px;
    padding: 0 6px;
    line-height: 1;
  }
  #cal-today { font-size: 14px; color: #484f58; }
  #cal-prev:hover, #cal-next:hover, #cal-today:hover { color: #58a6ff; }
  #cal-dow, #cal-grid {
    display: grid;
    grid-template-columns: repeat(7, 1fr);
    gap: 2px;
  }
  #cal-dow {
    margin-bottom: 4px;
  }
  #cal-dow span {
    text-align: center;
    font-size: 10px;
    color: #484f58;
    text-transform: uppercase;
    padding: 2px 0;
  }
  .cal-day {
    text-align: center;
    font-size: 11px;
    padding: 4px 0;
    color: #484f58;
    border-radius: 3px;
    cursor: default;
    min-height: 22px;
    line-height: 14px;
  }
  .cal-day.in-month { color: #8b949e; }
  .cal-day.has-activity {
    color: #c9d1d9;
    font-weight: 600;
    background: #161b22;
    cursor: pointer;
  }
  .cal-day.has-activity:hover { background: #21262d; color: #58a6ff; }
  .cal-day.today {
    outline: 1px solid #30363d;
  }
  .cal-day.active {
    background: #0d419d;
    color: #fff;
  }
  #files-panel {
    border-top: 1px solid #21262d;
    max-height: 40vh;
    display: flex;
    flex-direction: column;
    min-height: 0;
  }
  #files-header {
    padding: 8px 14px;
    font-size: 11px;
    font-weight: 600;
    color: #484f58;
    text-transform: uppercase;
    letter-spacing: 0.8px;
    border-bottom: 1px solid #21262d;
    flex-shrink: 0;
  }
  #files-tabs {
    display: flex;
    border-bottom: 1px solid #21262d;
    flex-shrink: 0;
  }
  .files-tab {
    flex: 1;
    background: none;
    border: none;
    color: #484f58;
    font: inherit;
    font-size: 11px;
    padding: 6px 4px;
    cursor: pointer;
    border-bottom: 2px solid transparent;
  }
  .files-tab:hover { color: #c9d1d9; }
  .files-tab.active {
    color: #c9d1d9;
    border-bottom-color: #58a6ff;
  }
  #files-list {
    overflow-y: auto;
    padding: 4px 0;
  }
  .file-row {
    padding: 6px 12px;
    border-bottom: 1px solid #161b22;
    cursor: pointer;
    font-size: 11px;
    line-height: 1.4;
  }
  .file-row:hover { background: #161b22; }
  .file-row .fn {
    color: #58a6ff;
    font-weight: 500;
    white-space: nowrap;
    overflow: hidden;
    text-overflow: ellipsis;
  }
  .file-row .meta {
    color: #6e7681;
    font-size: 10px;
    display: flex;
    justify-content: space-between;
    margin-top: 2px;
  }
  .file-row .meta-line2 {
    color: #484f58;
    font-size: 10px;
    margin-top: 1px;
  }
  #files-list .empty {
    padding: 12px 14px;
    color: #484f58;
    font-size: 11px;
    font-style: italic;
  }
  #md-overlay {
    position: fixed;
    inset: 0;
    background: rgba(1, 4, 9, 0.75);
    z-index: 1000;
    display: flex;
    align-items: center;
    justify-content: center;
    padding: 4vh 3vw;
  }
  #md-overlay-card {
    background: #0d1117;
    border: 1px solid #30363d;
    border-radius: 8px;
    width: min(900px, 100%);
    height: 100%;
    display: flex;
    flex-direction: column;
    overflow: hidden;
  }
  #md-overlay-header {
    padding: 10px 14px;
    border-bottom: 1px solid #21262d;
    display: flex;
    justify-content: space-between;
    align-items: center;
    font-size: 13px;
    font-weight: 600;
    color: #c9d1d9;
    flex-shrink: 0;
  }
  #md-overlay-close {
    background: none;
    border: none;
    color: #8b949e;
    cursor: pointer;
    font-size: 16px;
    padding: 2px 6px;
  }
  #md-overlay-close:hover { color: #f85149; }
  #md-overlay-body {
    overflow: auto;
    padding: 18px 24px;
    font-family: ui-sans-serif, system-ui, sans-serif;
    line-height: 1.5;
    color: #c9d1d9;
  }
  #md-overlay-body h1, #md-overlay-body h2, #md-overlay-body h3 { margin: 14px 0 8px; }
  #md-overlay-body p, #md-overlay-body ul, #md-overlay-body ol { margin: 8px 0; }
  #md-overlay-body code { background: #161b22; padding: 1px 5px; border-radius: 3px; font-size: 0.92em; }
  #md-overlay-body pre { background: #161b22; padding: 10px 14px; border-radius: 6px; overflow-x: auto; }
  #md-overlay-body pre code { background: none; padding: 0; }
  #md-overlay-body a { color: #58a6ff; }
  #md-overlay-body table { border-collapse: collapse; margin: 8px 0; }
  #md-overlay-body th, #md-overlay-body td { border: 1px solid #30363d; padding: 4px 10px; }
  #sidebar-mobile-toggle {
    display: none;
    background: none;
    border: none;
    color: #c9d1d9;
    font-size: 18px;
    cursor: pointer;
    padding: 4px 8px;
    line-height: 1;
  }
  #sidebar-backdrop {
    display: none;
    position: fixed;
    inset: 0;
    background: rgba(1,4,9,0.6);
    z-index: 400;
  }
  #sidebar-backdrop.open { display: block; }
  @media (max-width: 700px) {
    body { font-size: 13px; }
    #sidebar-mobile-toggle { display: block; }
    #sidebar {
      position: fixed;
      top: 0;
      left: 0;
      z-index: 500;
      transform: translateX(-105%);
      transition: transform 0.2s ease;
      box-shadow: 2px 0 12px rgba(0,0,0,0.4);
    }
    #sidebar.mobile-open { transform: translateX(0); }
    #main { width: 100vw; min-width: 0; }
    #header { padding: 0 10px; }
    #header h1 { font-size: 15px; }
    #messages { padding: 8px 10px; }
    #input-bar { padding: 6px 8px; }
    #input-bar form { gap: 6px; }
    #input-bar input { font-size: 16px; padding: 6px 10px; min-width: 0; }
    #input-bar button { padding: 6px 10px; font-size: 14px; flex-shrink: 0; }
    #attach-btn { padding: 0 6px; flex-shrink: 0; }
    .msg { font-size: 13px; }
    /* No hover on touch — keep the reply icon softly visible. */
    .msg-reply-btn { opacity: 0.4; }
    .msg-body-row { padding-left: 16px; }
    #files-panel { max-height: 35vh; }
    #md-overlay { padding: 2vh 2vw; }
    #md-overlay-body { padding: 12px 14px; font-size: 14px; }
  }
  #main {
    flex: 1;
    display: flex;
    flex-direction: column;
    min-width: 0;
    height: 100vh;
  }
  #header {
    padding: 0 16px;
    height: 45px;
    border-bottom: 1px solid #21262d;
    display: flex;
    justify-content: space-between;
    align-items: center;
    flex-shrink: 0;
  }
  #header h1 {
    font-size: 16px;
    font-weight: 600;
    color: #e6edf3;
  }
  #status {
    font-size: 12px;
    display: flex;
    align-items: center;
    gap: 6px;
  }
  #status .dot {
    width: 8px;
    height: 8px;
    border-radius: 50%;
    display: inline-block;
  }
  #status .dot.connected { background: #3fb950; }
  #status .dot.disconnected { background: #f85149; }
  #messages {
    flex: 1;
    overflow-y: auto;
    padding: 16px;
    padding-bottom: 8px;
  }
  .msg {
    margin-bottom: 6px;
  }
  .msg-children {
    margin-left: 20px;
  }
  .msg-children:empty { display: none; }
  .msg-wrapper.collapsed > .msg-children { display: none; }
  .collapse-caret {
    display: inline-block;
    width: 12px;
    color: #8b949e;
    cursor: pointer;
    user-select: none;
    font-size: 0.8em;
    margin-right: 2px;
  }
  .collapse-caret:hover { color: #58a6ff; }
  .msg-wrapper:not(:has(.msg-children > .msg-wrapper)) > .msg .collapse-caret {
    visibility: hidden;
  }
  .msg-header {
    margin-bottom: 1px;
    display: flex;
    align-items: baseline;
    gap: 6px;
    flex-wrap: wrap;
  }
  .msg-reply-chip {
    font-size: 0.7em;
    color: #6e7681;
    cursor: pointer;
  }
  .msg-reply-chip:hover { color: #58a6ff; }
  .msg-reply-chip-preview {
    font-size: 0.75em;
    color: #8b949e;
    background: #161b22;
    border-left: 2px solid #30363d;
    padding: 2px 8px;
    margin: 1px 0 2px 4px;
    display: none;
    white-space: pre-wrap;
    word-break: break-word;
    max-height: 6em;
    overflow: hidden;
  }
  .msg-reply-chip-preview.expanded { display: block; }
  .msg-body-row {
    display: flex;
    align-items: flex-end;
    gap: 12px;
    /* Small indent that clears the collapse caret; no content-under-sender
       alignment (the 108px gutter that created was too heavy on wide
       viewports and drifted across time-prefix widths). */
    padding-left: 24px;
  }
  .msg-body {
    flex: 0 1 auto;
    min-width: 0;
  }
  .msg-footer {
    display: flex;
    align-items: baseline;
    gap: 8px;
    font-size: 0.7em;
    color: #484f58;
    flex-shrink: 0;
    padding-bottom: 2px;
    white-space: nowrap;
  }
  .msg-reply-btn {
    cursor: pointer;
    background: none;
    border: none;
    color: #484f58;
    font: inherit;
    font-size: 1.2em;
    padding: 0;
    line-height: 1;
    opacity: 0;
    transition: opacity 0.15s ease;
  }
  .msg:hover .msg-reply-btn { opacity: 1; }
  .msg-reply-btn:hover { color: #58a6ff; }
  .msg-reply-count {
    cursor: pointer;
    background: none;
    border: none;
    color: #484f58;
    font: inherit;
    padding: 0;
  }
  .msg-reply-count:hover { color: #58a6ff; }
  .msg-receipts-wrap {
    position: relative;
    display: inline-block;
  }
  .msg-receipts-inline {
    color: #484f58;
    overflow: hidden;
    text-overflow: ellipsis;
    min-width: 0;
    max-width: 320px;
    background: none;
    border: none;
    padding: 0;
    font: inherit;
    cursor: pointer;
    line-height: inherit;
  }
  .msg-receipts-inline:empty { cursor: default; }
  .msg-receipts-inline:not(:empty):hover { color: #8b949e; }
  .msg-receipts-wrap.open .msg-receipts-inline { color: #c9d1d9; }
  .msg-receipts-panel {
    display: none;
    position: absolute;
    bottom: 100%;
    right: 0;
    margin-bottom: 4px;
    padding: 6px 10px;
    background: #161b22;
    border: 1px solid #30363d;
    border-radius: 4px;
    font-size: 1em;
    color: #c9d1d9;
    white-space: nowrap;
    z-index: 20;
    box-shadow: 0 4px 12px rgba(0,0,0,0.4);
  }
  .msg-receipts-wrap.open .msg-receipts-panel { display: block; }
  .msg-receipts-panel-row { padding: 2px 0; }
  .msg-receipts-panel-label {
    color: #8b949e;
    margin-right: 6px;
    font-weight: 600;
  }
  .msg-receipts-panel-empty { color: #484f58; font-style: italic; }
  #replying-to-bar {
    display: none;
    padding: 4px 10px;
    background: #161b22;
    border-top: 1px solid #30363d;
    border-bottom: 1px solid #30363d;
    font-size: 0.8em;
    color: #8b949e;
    align-items: center;
    gap: 8px;
  }
  #replying-to-bar.active { display: flex; }
  #replying-to-text { flex: 1; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
  #replying-to-cancel {
    cursor: pointer;
    color: #8b949e;
    background: none;
    border: none;
    font-size: 1.2em;
    padding: 0 4px;
  }
  #replying-to-cancel:hover { color: #f85149; }
  .msg-time {
    color: #484f58;
  }
  .msg-content {
    color: #c9d1d9;
    white-space: pre-wrap;
    word-break: break-word;
    padding-left: 2px;
  }
  .msg-content .mention {
    color: #58a6ff;
    font-weight: 600;
  }
  .msg-receipts {
    color: #484f58;
    font-size: 0.75em;
    margin-top: 2px;
    padding-left: 2px;
  }
  .msg-files {
    margin-top: 2px;
    padding-left: 2px;
    display: flex;
    flex-wrap: wrap;
    gap: 6px;
    max-height: 160px;
    overflow-y: auto;
  }
  .file-badge {
    display: inline-flex;
    align-items: center;
    gap: 5px;
    background: #161b22;
    border: 1px solid #30363d;
    border-radius: 5px;
    padding: 4px 10px;
    font-size: 12px;
    color: #58a6ff;
    text-decoration: none;
    cursor: pointer;
  }
  .file-badge:hover {
    background: #21262d;
    border-color: #58a6ff;
  }
  .file-badge .file-size {
    color: #484f58;
    font-size: 11px;
  }
  .md-preview {
    margin-top: 6px;
    border: 1px solid #30363d;
    border-radius: 6px;
    background: #161b22;
    overflow: hidden;
  }
  .md-preview > summary {
    list-style: none;
    padding: 6px 10px;
    cursor: pointer;
    font-size: 12px;
    color: #58a6ff;
    user-select: none;
    display: flex;
    align-items: center;
    justify-content: space-between;
    gap: 8px;
  }
  .md-preview > summary::-webkit-details-marker { display: none; }
  .md-preview > summary::before {
    content: "\\25B6";
    display: inline-block;
    font-size: 9px;
    color: #8b949e;
    margin-right: 4px;
    transition: transform 0.15s;
  }
  .md-preview[open] > summary::before { transform: rotate(90deg); }
  .md-preview > summary:hover { background: #21262d; }
  .md-preview .md-preview-label { flex: 1; min-width: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
  .md-preview .md-preview-size { color: #484f58; font-size: 11px; }
  .md-preview .md-preview-download { color: #8b949e; font-size: 11px; text-decoration: none; }
  .md-preview .md-preview-download:hover { color: #58a6ff; }
  .md-preview-body {
    padding: 10px 14px;
    border-top: 1px solid #21262d;
    font-size: 13px;
    line-height: 1.5;
    color: #c9d1d9;
    max-height: 600px;
    overflow-y: auto;
  }
  .md-preview-body .txt-preview-body {
    margin: 0;
    white-space: pre-wrap;
    word-break: break-word;
    font-family: 'SF Mono', 'Cascadia Code', 'Fira Code', 'Consolas', monospace;
    font-size: 12px;
    color: #c9d1d9;
  }
  .md-preview-body h1, .md-preview-body h2, .md-preview-body h3,
  .md-preview-body h4, .md-preview-body h5, .md-preview-body h6 {
    margin: 12px 0 6px;
    line-height: 1.25;
    color: #f0f6fc;
  }
  .md-preview-body h1 { font-size: 18px; border-bottom: 1px solid #30363d; padding-bottom: 4px; }
  .md-preview-body h2 { font-size: 16px; border-bottom: 1px solid #30363d; padding-bottom: 3px; }
  .md-preview-body h3 { font-size: 14px; }
  .md-preview-body p { margin: 6px 0; }
  .md-preview-body ul, .md-preview-body ol { margin: 6px 0; padding-left: 24px; }
  .md-preview-body li { margin: 2px 0; }
  .md-preview-body code {
    background: #0d1117;
    border: 1px solid #30363d;
    border-radius: 3px;
    padding: 1px 4px;
    font-family: ui-monospace, SFMono-Regular, Menlo, monospace;
    font-size: 12px;
  }
  .md-preview-body pre {
    background: #0d1117;
    border: 1px solid #30363d;
    border-radius: 5px;
    padding: 8px 10px;
    overflow-x: auto;
    margin: 8px 0;
  }
  .md-preview-body pre code { background: transparent; border: 0; padding: 0; font-size: 12px; }
  .md-preview-body blockquote {
    border-left: 3px solid #30363d;
    margin: 6px 0;
    padding: 0 10px;
    color: #8b949e;
  }
  .md-preview-body a { color: #58a6ff; }
  .md-preview-body table { border-collapse: collapse; margin: 8px 0; display: block; overflow-x: auto; }
  .md-preview-body th, .md-preview-body td { border: 1px solid #30363d; padding: 4px 8px; }
  .md-preview-body th { background: #161b22; }
  .md-preview-body hr { border: 0; border-top: 1px solid #30363d; margin: 12px 0; }
  .md-preview-body img { max-width: 100%; height: auto; }
  .md-preview-error { color: #f85149; font-size: 12px; padding: 8px 14px; }
  #pending-files {
    display: none;
    padding: 4px 16px 0;
    gap: 6px;
    flex-wrap: wrap;
  }
  .pending-chip {
    display: inline-flex;
    align-items: center;
    gap: 4px;
    background: #161b22;
    border: 1px solid #30363d;
    border-radius: 5px;
    padding: 3px 8px;
    font-size: 12px;
    color: #8b949e;
  }
  .pending-chip .remove-chip {
    color: #f85149;
    cursor: pointer;
    font-weight: 700;
    margin-left: 2px;
  }
  .pending-chip .remove-chip:hover { color: #ff7b72; }
  #attach-btn {
    background: none;
    border: 1px solid #30363d;
    border-radius: 6px;
    color: #8b949e;
    cursor: pointer;
    padding: 8px 10px;
    font-size: 16px;
    line-height: 1;
    flex-shrink: 0;
  }
  #attach-btn:hover { color: #c9d1d9; border-color: #58a6ff; }
  .date-divider {
    display: flex;
    align-items: center;
    margin: 12px 0 6px;
    color: #484f58;
    font-size: 12px;
    font-weight: 600;
    letter-spacing: 0.5px;
  }
  .date-divider::before,
  .date-divider::after {
    content: '';
    flex: 1;
    border-top: 1px solid #21262d;
  }
  .date-divider::before { margin-right: 12px; }
  .date-divider::after { margin-left: 12px; }
  #no-key {
    display: flex;
    align-items: center;
    justify-content: center;
    height: 100vh;
    color: #484f58;
    font-size: 16px;
  }
  #input-bar {
    border-top: 1px solid #21262d;
    padding: 12px 16px;
    flex-shrink: 0;
    display: none;
    position: relative;
  }
  #input-bar form {
    display: flex;
    gap: 8px;
  }
  #input-bar input {
    flex: 1;
    background: #161b22;
    border: 1px solid #30363d;
    border-radius: 6px;
    color: #c9d1d9;
    font-family: inherit;
    font-size: 16px;
    padding: 8px 12px;
    outline: none;
  }
  #input-bar input:focus {
    border-color: #58a6ff;
  }
  #input-bar button {
    background: #238636;
    color: #fff;
    border: none;
    border-radius: 6px;
    padding: 8px 16px;
    font-family: inherit;
    font-size: 14px;
    cursor: pointer;
    font-weight: 600;
  }
  #input-bar button:hover { background: #2ea043; }
  #input-bar button:disabled { opacity: 0.5; cursor: not-allowed; }
  #autocomplete {
    position: absolute;
    bottom: 100%;
    left: 16px;
    right: 16px;
    background: #161b22;
    border: 1px solid #30363d;
    border-radius: 6px;
    display: none;
    max-height: 160px;
    overflow-y: auto;
  }
  #autocomplete .ac-item {
    padding: 8px 12px;
    cursor: pointer;
    color: #c9d1d9;
  }
  #autocomplete .ac-item:hover,
  #autocomplete .ac-item.selected {
    background: #21262d;
    color: #58a6ff;
  }
</style>
</head>
<body>
<div id="sidebar-backdrop"></div>
<div id="app" style="display:flex;flex-direction:row;height:100vh;flex:1;min-width:0;width:100%;">
  <div id="sidebar">
    <div id="sidebar-header">
      <span id="sidebar-label">Calendar</span>
      <button id="sidebar-toggle" title="Toggle sidebar">&laquo;</button>
    </div>
    <div id="calendar">
      <div id="cal-header">
        <button id="cal-prev" title="Previous month">&lsaquo;</button>
        <span id="cal-title"></span>
        <button id="cal-today" title="Jump to today">&#x2302;</button>
        <button id="cal-next" title="Next month">&rsaquo;</button>
      </div>
      <div id="cal-dow"></div>
      <div id="cal-grid"></div>
    </div>
    <div id="files-panel">
      <div id="files-header">Files</div>
      <div id="files-tabs">
        <button class="files-tab active" data-tab="to-me">to me</button>
        <button class="files-tab" data-tab="sent">sent</button>
        <button class="files-tab" data-tab="other">other</button>
      </div>
      <div id="files-list"></div>
    </div>
  </div>
  <div id="main">
    <div id="header">
      <div style="display:flex;align-items:center;gap:10px;">
        <button id="sidebar-mobile-toggle" title="Menu" aria-label="Toggle sidebar">&#x2630;</button>
        <h1>SideChat</h1>
      </div>
      <div style="display:flex;align-items:center;gap:12px;">
        <div id="status"><span class="dot disconnected" id="dot"></span><span id="status-text">Connecting...</span></div>
        <div id="mention-bell" title="Unread mentions" style="display:none;cursor:pointer;position:relative;font-size:18px;">
          <span id="bell-icon">&#x1F514;</span>
          <span id="bell-badge" style="display:none;position:absolute;top:-6px;right:-8px;background:#f85149;color:#fff;border-radius:50%;font-size:11px;min-width:16px;height:16px;line-height:16px;text-align:center;padding:0 3px;font-weight:700;"></span>
        </div>
        <button id="signout-btn">Sign Out</button>
      </div>
    </div>
    <div id="messages"></div>
    <div id="pending-files"></div>
    <div id="input-bar">
      <div id="replying-to-bar">
        <span id="replying-to-text"></span>
        <button type="button" id="replying-to-cancel" title="Cancel reply">&times;</button>
      </div>
      <div id="autocomplete"></div>
      <form id="msg-form">
        <button type="button" id="attach-btn" title="Attach file">&#x1F4CE;</button>
        <input type="file" id="file-input" multiple style="display:none" />
        <input type="text" id="msg-input" placeholder="Type a message..." autocomplete="off" />
        <button type="submit" id="msg-send">Send</button>
      </form>
    </div>
  </div>
</div>
<script src="/static/marked.min.js"></script>
<script src="/static/dompurify.min.js"></script>
<script nonce="${nonce}">
(function() {
  var SC_USER = '${username}';
  var SC_CAN_POST = ${canPost};
  var SC_TOKEN = '${sessionToken}';

  var messagesEl = document.getElementById('messages');
  var calGridEl = document.getElementById('cal-grid');
  var calTitleEl = document.getElementById('cal-title');
  var calDowEl = document.getElementById('cal-dow');
  var dot = document.getElementById('dot');
  var statusText = document.getElementById('status-text');
  var inputBar = document.getElementById('input-bar');
  var msgForm = document.getElementById('msg-form');
  var msgInput = document.getElementById('msg-input');
  var msgSend = document.getElementById('msg-send');
  var autocompleteEl = document.getElementById('autocomplete');
  var attachBtn = document.getElementById('attach-btn');
  var fileInput = document.getElementById('file-input');
  var pendingFilesEl = document.getElementById('pending-files');
  var pendingFiles = []; // { id, filename, size }
  var seen = new Set();
  var msgReceipts = {};
  var msgContentCache = {};
  var replyingToId = null;
  var replyingToBar = document.getElementById('replying-to-bar');
  var replyingToText = document.getElementById('replying-to-text');
  var replyingToCancel = document.getElementById('replying-to-cancel');

  function setReplyingTo(id, sender, content) {
    replyingToId = id;
    var preview = content.length > 80 ? content.slice(0, 80) + '\u2026' : content;
    replyingToText.textContent = 'Replying to ' + sender + ': ' + preview;
    replyingToBar.classList.add('active');
    msgInput.focus();
  }
  function clearReplyingTo() {
    replyingToId = null;
    replyingToBar.classList.remove('active');
  }
  replyingToCancel.addEventListener('click', clearReplyingTo);

  // Compact receipt badge: "\u2713 N" where N is read-count when anyone has read,
  // else "\u25CB N" when only engaged (circle = eyes on, not yet finished).
  // Returns "" when nobody's interacted. Full list available via title attr.
  function compactReceipts(readBy, engagedBy) {
    if (readBy && readBy.length) return '\u2713 ' + readBy.length;
    if (engagedBy && engagedBy.length) return '\u25CB ' + engagedBy.length;
    return '';
  }
  function fullReceiptsTitle(readBy, engagedBy, deliveredTo) {
    var lines = [];
    if (readBy && readBy.length) lines.push('Read by ' + readBy.join(', '));
    if (engagedBy && engagedBy.length) lines.push('Engaged by ' + engagedBy.join(', '));
    if (deliveredTo && deliveredTo.length) lines.push('Delivered to ' + deliveredTo.join(', '));
    return lines.join('\\n');
  }
  function buildReceiptPanelHtml(readBy, engagedBy, deliveredTo) {
    var rows = [];
    function renderName(name) {
      return '<span style="color:' + getSenderColor(name) + ';font-weight:600;">' +
        escapeHtml(name) + '</span>';
    }
    function row(label, names) {
      if (!names || !names.length) return;
      var parts = [];
      for (var i = 0; i < names.length; i++) parts.push(renderName(names[i]));
      rows.push(
        '<div class="msg-receipts-panel-row">' +
          '<span class="msg-receipts-panel-label">' + label + '</span>' +
          parts.join(', ') +
        '</div>'
      );
    }
    row('Read by', readBy);
    row('Engaged by', engagedBy);
    row('Delivered to', deliveredTo);
    if (!rows.length) {
      return '<div class="msg-receipts-panel-empty">No activity yet</div>';
    }
    return rows.join('');
  }
  function updateReceipts(id, type, name) {
    if (!msgReceipts[id]) msgReceipts[id] = { readBy: [], deliveredTo: [], engagedBy: [] };
    var list = type === 'read' ? msgReceipts[id].readBy
             : type === 'engaged' ? msgReceipts[id].engagedBy
             : msgReceipts[id].deliveredTo;
    if (list.indexOf(name) === -1) list.push(name);
    var el = document.getElementById('receipts-' + id);
    if (!el) return;
    var r = msgReceipts[id];
    el.textContent = compactReceipts(r.readBy, r.engagedBy);
    el.title = fullReceiptsTitle(r.readBy, r.engagedBy, r.deliveredTo);
    var panel = document.getElementById('receipts-panel-' + id);
    if (panel) panel.innerHTML = buildReceiptPanelHtml(r.readBy, r.engagedBy, r.deliveredTo);
  }
  // Close any open receipts panel when clicking outside or pressing Escape.
  document.addEventListener('click', function(e) {
    var openWraps = document.querySelectorAll('.msg-receipts-wrap.open');
    if (!openWraps.length) return;
    for (var i = 0; i < openWraps.length; i++) {
      if (!openWraps[i].contains(e.target)) openWraps[i].classList.remove('open');
    }
  });
  document.addEventListener('keydown', function(e) {
    if (e.key !== 'Escape') return;
    var openWraps = document.querySelectorAll('.msg-receipts-wrap.open');
    for (var i = 0; i < openWraps.length; i++) openWraps[i].classList.remove('open');
  });
  var userScrolled = false;
  var currentUser = SC_USER;
  var mentionBell = document.getElementById('mention-bell');
  var bellBadge = document.getElementById('bell-badge');
  var unreadMentions = [];
  var documentVisible = true;

  document.addEventListener('visibilitychange', function() {
    documentVisible = !document.hidden;
  });

  function addUnreadMention(msg) {
    if (msg.sender === currentUser) return;
    var mentions = msg.mentions || [];
    if (mentions.indexOf(currentUser) === -1) return;
    unreadMentions.push(msg);
    lastMentionId = msg.id;
    mentionBell.style.display = '';
    bellBadge.style.display = '';
    bellBadge.textContent = unreadMentions.length;
  }

  function clearMentionBadge() {
    unreadMentions = [];
    bellBadge.style.display = 'none';
    bellBadge.textContent = '';
  }

  var lastMentionId = null;

  if (mentionBell) {
    mentionBell.addEventListener('click', function() {
      if (lastMentionId) {
        var el = document.querySelector('[data-msg-id="' + lastMentionId + '"]');
        if (el) el.scrollIntoView({ behavior: 'smooth', block: 'center' });
      }
      clearMentionBadge();
    });
  }
  var canPost = SC_CAN_POST;
  var allUsers = [];

  if (canPost) { inputBar.style.display = 'block'; }
  else { inputBar.style.display = 'none'; }
  // Calendar state
  var calActivity = {};      // dateKey -> count
  var calViewYear, calViewMonth; // currently displayed month (month is 0-indexed)
  (function initCalDow(){
    var days = ['S','M','T','W','T','F','S'];
    for (var i = 0; i < 7; i++) {
      var s = document.createElement('span');
      s.textContent = days[i];
      calDowEl.appendChild(s);
    }
  })();
  function padCal(n){ return n < 10 ? '0'+n : ''+n; }
  function todayKey(){ var t = new Date(); return t.getFullYear()+'-'+padCal(t.getMonth()+1)+'-'+padCal(t.getDate()); }
  function renderCalendar(){
    calGridEl.innerHTML = '';
    var monthNames = ['January','February','March','April','May','June','July','August','September','October','November','December'];
    calTitleEl.textContent = monthNames[calViewMonth] + ' ' + calViewYear;
    var firstDow = new Date(calViewYear, calViewMonth, 1).getDay();
    var daysInMonth = new Date(calViewYear, calViewMonth + 1, 0).getDate();
    var prevMonthDays = new Date(calViewYear, calViewMonth, 0).getDate();
    var today = todayKey();
    var cells = [];
    for (var i = 0; i < firstDow; i++) {
      cells.push({ day: prevMonthDays - firstDow + 1 + i, inMonth: false, key: null });
    }
    for (var d = 1; d <= daysInMonth; d++) {
      var key = calViewYear + '-' + padCal(calViewMonth+1) + '-' + padCal(d);
      cells.push({ day: d, inMonth: true, key: key });
    }
    while (cells.length % 7 !== 0) {
      cells.push({ day: cells.length - firstDow - daysInMonth + 1, inMonth: false, key: null });
    }
    cells.forEach(function(c){
      var el = document.createElement('div');
      el.className = 'cal-day';
      el.textContent = c.day;
      if (c.inMonth) {
        el.classList.add('in-month');
        if (c.key === today) el.classList.add('today');
        if (calActivity[c.key]) {
          el.classList.add('has-activity');
          el.title = calActivity[c.key] + ' messages';
          el.setAttribute('data-date', c.key);
          el.addEventListener('click', function(){
            var dateAttr = this.getAttribute('data-date');
            var clickedEl = this;
            calGridEl.querySelectorAll('.cal-day.active').forEach(function(a){ a.classList.remove('active'); });
            clickedEl.classList.add('active');
            var target = document.getElementById('date-' + dateAttr);
            if (target) {
              target.scrollIntoView({ behavior: 'smooth', block: 'start' });
              return;
            }
            // Older than the currently loaded window — fetch and re-render.
            var parts = dateAttr.split('-');
            var startOfDay = new Date(parseInt(parts[0],10), parseInt(parts[1],10)-1, parseInt(parts[2],10), 0, 0, 0);
            loadMessagesSince(startOfDay).then(function(){
              var newTarget = document.getElementById('date-' + dateAttr);
              if (newTarget) newTarget.scrollIntoView({ behavior: 'smooth', block: 'start' });
            });
          });
        }
      }
      calGridEl.appendChild(el);
    });
  }
  window.__calMarkDay = function(dateKey){
    calActivity[dateKey] = (calActivity[dateKey] || 0) + 1;
    var parts = dateKey.split('-');
    if (parseInt(parts[0],10) === calViewYear && parseInt(parts[1],10)-1 === calViewMonth) {
      renderCalendar();
    }
  };
  document.getElementById('cal-prev').addEventListener('click', function(){
    calViewMonth--;
    if (calViewMonth < 0) { calViewMonth = 11; calViewYear--; }
    renderCalendar();
  });
  document.getElementById('cal-next').addEventListener('click', function(){
    calViewMonth++;
    if (calViewMonth > 11) { calViewMonth = 0; calViewYear++; }
    renderCalendar();
  });
  document.getElementById('cal-today').addEventListener('click', function(){
    var t = new Date();
    calViewYear = t.getFullYear();
    calViewMonth = t.getMonth();
    renderCalendar();
    messagesEl.scrollTop = messagesEl.scrollHeight;
  });
  (function initCal(){
    var t = new Date();
    calViewYear = t.getFullYear();
    calViewMonth = t.getMonth();
    fetch('/dates?token=' + encodeURIComponent(SC_TOKEN))
      .then(function(r){ return r.json(); })
      .then(function(data){
        (data.dates || []).forEach(function(d){ calActivity[d.date] = d.count; });
        renderCalendar();
      })
      .catch(function(){ renderCalendar(); });
  })();

  // Files panel
  var filesListEl = document.getElementById('files-list');
  function fmtSize(n) {
    if (n < 1024) return n + ' B';
    if (n < 1048576) return (n/1024).toFixed(1) + ' KB';
    if (n < 1073741824) return (n/1048576).toFixed(1) + ' MB';
    return (n/1073741824).toFixed(2) + ' GB';
  }
  function fmtDateTime(iso) {
    var d = new Date(iso);
    var pad = function(n){ return n < 10 ? '0'+n : ''+n; };
    return d.getFullYear()+'-'+pad(d.getMonth()+1)+'-'+pad(d.getDate())+' '+pad(d.getHours())+':'+pad(d.getMinutes());
  }
  function appendFileRow(container, f) {
    var row = document.createElement('div');
    row.className = 'file-row';
    var isMd = /\.(md|markdown)$/i.test(f.filename);
    var isTxt = /\.(txt|log|csv|text)$/i.test(f.filename);
    var inline = isMd || isTxt;
    row.title = inline ? f.filename + ' — click to preview' : f.filename + ' — click to download';
    var fn = document.createElement('div');
    fn.className = 'fn';
    fn.textContent = f.filename;
    var meta = document.createElement('div');
    meta.className = 'meta';
    var left = document.createElement('span');
    left.textContent = f.uploader;
    var right = document.createElement('span');
    right.textContent = fmtSize(f.size);
    meta.appendChild(left); meta.appendChild(right);
    var line2 = document.createElement('div');
    line2.className = 'meta-line2';
    var sentTo = (f.mentions && f.mentions.length) ? '\u2192 ' + f.mentions.join(', ') : '\u2192 everyone';
    line2.textContent = fmtDateTime(f.uploaded_at) + '  ' + sentTo;
    row.appendChild(fn); row.appendChild(meta); row.appendChild(line2);
    row.addEventListener('click', function() {
      if (isMd) {
        openMdOverlay(f.id, f.filename);
      } else if (isTxt) {
        openMdOverlay(f.id, f.filename, 'txt');
      } else {
        window.location.href = '/files/' + encodeURIComponent(f.id) + '/download?token=' + encodeURIComponent(SC_TOKEN);
      }
    });
    container.appendChild(row);
  }
  function filterFilesByTab(files, tab) {
    return files.filter(function(f) {
      var mentions = f.mentions || [];
      var sentToMe = mentions.indexOf(SC_USER) !== -1;
      var isSender = f.uploader === SC_USER;
      if (tab === 'to-me') return sentToMe;
      if (tab === 'sent') return isSender;
      return !sentToMe && !isSender; // 'other'
    });
  }
  function renderFilesPanel(files) {
    filesListEl.innerHTML = '';
    var tab = localStorage.getItem('sc-files-tab') || 'to-me';
    var filtered = filterFilesByTab(files || [], tab);
    if (filtered.length === 0) {
      var e = document.createElement('div');
      e.className = 'empty';
      e.textContent = tab === 'to-me' ? 'No files sent to you'
                    : tab === 'sent' ? 'You haven\\u2019t sent any files'
                    : 'No other files';
      filesListEl.appendChild(e);
      return;
    }
    filtered.forEach(function(f) { appendFileRow(filesListEl, f); });
  }
  function refreshFiles() {
    fetch('/files-list?token=' + encodeURIComponent(SC_TOKEN))
      .then(function(r){ return r.json(); })
      .then(function(d){ renderFilesPanel(d.files || []); })
      .catch(function(){});
  }
  window.__refreshFiles = refreshFiles;
  // Restore + wire the files tabs
  var filesTabs = document.querySelectorAll('.files-tab');
  var savedTab = localStorage.getItem('sc-files-tab') || 'to-me';
  filesTabs.forEach(function(t) {
    t.classList.toggle('active', t.getAttribute('data-tab') === savedTab);
    t.addEventListener('click', function() {
      var tab = t.getAttribute('data-tab');
      localStorage.setItem('sc-files-tab', tab);
      filesTabs.forEach(function(other) { other.classList.toggle('active', other === t); });
      refreshFiles();
    });
  });
  refreshFiles();

  function openMdOverlay(fileId, filename, mode) {
    mode = mode || 'md';
    var ovl = document.createElement('div');
    ovl.id = 'md-overlay';
    var card = document.createElement('div');
    card.id = 'md-overlay-card';
    var hdr = document.createElement('div');
    hdr.id = 'md-overlay-header';
    var title = document.createElement('span');
    title.textContent = filename;
    var actions = document.createElement('span');
    var dl = document.createElement('a');
    dl.textContent = 'Download';
    dl.href = '/files/' + encodeURIComponent(fileId) + '/download?token=' + encodeURIComponent(SC_TOKEN);
    dl.style.marginRight = '14px';
    dl.style.color = '#8b949e';
    dl.style.textDecoration = 'none';
    var close = document.createElement('button');
    close.textContent = '\u2715';
    close.id = 'md-overlay-close';
    actions.appendChild(dl);
    actions.appendChild(close);
    hdr.appendChild(title);
    hdr.appendChild(actions);
    var body = document.createElement('div');
    body.id = 'md-overlay-body';
    body.textContent = 'Loading...';
    card.appendChild(hdr);
    card.appendChild(body);
    ovl.appendChild(card);
    document.body.appendChild(ovl);
    function dismiss() { if (ovl.parentNode) ovl.parentNode.removeChild(ovl); document.removeEventListener('keydown', esc); }
    function esc(e) { if (e.key === 'Escape') dismiss(); }
    close.addEventListener('click', dismiss);
    ovl.addEventListener('click', function(e) { if (e.target === ovl) dismiss(); });
    document.addEventListener('keydown', esc);
    fetch('/files/' + encodeURIComponent(fileId) + '/download?token=' + encodeURIComponent(SC_TOKEN))
      .then(function(r){ if (!r.ok) throw new Error('HTTP ' + r.status); return r.text(); })
      .then(function(text){
        if (text.length > 200 * 1024) { body.textContent = 'File too large for preview. Use Download.'; return; }
        if (mode === 'txt') {
          body.innerHTML = '<pre class="txt-preview-body">' + escapeHtml(text) + '</pre>';
          return;
        }
        var html = window.marked ? window.marked.parse(text) : text;
        body.innerHTML = window.DOMPurify ? window.DOMPurify.sanitize(html, {
          ALLOWED_URI_REGEXP: /^(?:(?:https?|mailto):|[^a-z]|[a-z+.\\-]+(?:[^a-z+.\\-:]|$))/i
        }) : html;
      })
      .catch(function(err){ body.textContent = 'Failed to load: ' + (err.message || err); });
  }
  var acIndex = -1;

  // Color palette for dynamic sender colors
  // Diverse warm/cool mix — greens removed (clash with #3fb950 status
  // dot) and the purple-heavy earlier palette thinned out to one
  // magenta. Ordered so consecutive hash indices read as distinct.
  var senderColors = [
    '#79c0ff', '#ffa657', '#ff7b72', '#56d4dd', '#ffd700',
    '#f778ba', '#f0883e', '#a5d6ff', '#da77f2', '#ff9e64'
  ];
  var senderColorMap = {};

  function getSenderColor(name) {
    if (!senderColorMap[name]) {
      var hash = 0;
      for (var i = 0; i < name.length; i++) {
        hash = ((hash << 5) - hash) + name.charCodeAt(i);
        hash |= 0;
      }
      senderColorMap[name] = senderColors[Math.abs(hash) % senderColors.length];
    }
    return senderColorMap[name];
  }

  messagesEl.addEventListener('scroll', function() {
    var atBottom = messagesEl.scrollHeight - messagesEl.scrollTop - messagesEl.clientHeight < 40;
    userScrolled = !atBottom;
  });

  function escapeHtml(s) {
    var d = document.createElement('div');
    d.textContent = s;
    return d.innerHTML;
  }

  function formatContent(content) {
    // Highlight @mentions
    var escaped = escapeHtml(content);
    if (allUsers.length > 0) {
      var pattern = new RegExp('@(' + allUsers.join('|') + ')\\\\b', 'gi');
      escaped = escaped.replace(pattern, '<span class="mention">@\$1</span>');
    }
    return escaped;
  }

  var lastRenderedDate = '';
  var WEEKDAYS = ['Sunday','Monday','Tuesday','Wednesday','Thursday','Friday','Saturday'];
  var MONTHS = ['Jan','Feb','Mar','Apr','May','Jun','Jul','Aug','Sep','Oct','Nov','Dec'];

  function formatDateLabel(d) {
    var now = new Date();
    var today = new Date(now.getFullYear(), now.getMonth(), now.getDate());
    var msgDay = new Date(d.getFullYear(), d.getMonth(), d.getDate());
    var diff = (today - msgDay) / 86400000;
    if (diff === 0) return 'Today';
    if (diff === 1) return 'Yesterday';
    if (diff < 7) return WEEKDAYS[d.getDay()];
    return WEEKDAYS[d.getDay()] + ', ' + MONTHS[d.getMonth()] + ' ' + d.getDate() + ', ' + d.getFullYear();
  }

  // Auto-mark messages as read when visible (skips initial load)
  var readSent = new Set();
  var initialLoadDone = false;
  var readObserver = new IntersectionObserver(function(entries) {
    if (!initialLoadDone) return;
    entries.forEach(function(entry) {
      if (entry.isIntersecting) {
        var id = entry.target.getAttribute('data-msg-id');
        if (id && !readSent.has(id)) {
          readSent.add(id);
          fetch('/messages/' + id + '/read', {
            method: 'POST',
            headers: { 'Authorization': 'Bearer ' + SC_TOKEN }
          }).catch(function() {});
        }
      }
    });
  }, { threshold: 0.5 });

  // Markdown attachment preview: fetch + render on first expand, sanitize with
  // DOMPurify, cap fetch at 200KB so a huge .md can't wedge the viewer.
  var MD_PREVIEW_CAP_BYTES = 200 * 1024;
  function attachMdPreview(details) {
    var loaded = false;
    details.addEventListener('toggle', function() {
      if (!details.open || loaded) return;
      loaded = true;
      var body = details.querySelector('.md-preview-body');
      var fileId = details.getAttribute('data-file-id');
      var declaredSize = parseInt(details.getAttribute('data-file-size') || '0', 10);
      if (declaredSize > MD_PREVIEW_CAP_BYTES) {
        body.innerHTML = '<div class="md-preview-error">File too large for preview (' +
          (declaredSize / 1024).toFixed(0) + ' KB &gt; ' + (MD_PREVIEW_CAP_BYTES / 1024) + ' KB). Use the download link.</div>';
        return;
      }
      var previewMode = details.getAttribute('data-mode') || 'md';
      if (previewMode === 'md' && (typeof marked === 'undefined' || typeof DOMPurify === 'undefined')) {
        body.innerHTML = '<div class="md-preview-error">Markdown renderer not available.</div>';
        return;
      }
      fetch('/files/' + fileId + '/download', { credentials: 'same-origin' })
        .then(function(r) {
          if (!r.ok) throw new Error('HTTP ' + r.status);
          return r.blob();
        })
        .then(function(blob) {
          if (blob.size > MD_PREVIEW_CAP_BYTES) {
            throw new Error('File exceeds ' + (MD_PREVIEW_CAP_BYTES / 1024) + ' KB cap');
          }
          return blob.text();
        })
        .then(function(text) {
          var mode = details.getAttribute('data-mode') || 'md';
          if (mode === 'txt') {
            // Plaintext: just escape + pre-wrap. No markdown parse, no sanitizer.
            body.innerHTML = '<pre class="txt-preview-body">' + escapeHtml(text) + '</pre>';
            return;
          }
          var rendered;
          try { rendered = marked.parse(text, { breaks: true, gfm: true }); }
          catch (e) { rendered = '<pre>' + escapeHtml(text) + '</pre>'; }
          body.innerHTML = DOMPurify.sanitize(rendered, {
            // img dropped so a tracker pixel in attacker-supplied markdown
            // can't exfil a page visit to an external host.
            FORBID_TAGS: ['style', 'script', 'iframe', 'object', 'embed', 'form', 'input', 'button', 'img', 'svg', 'math'],
            FORBID_ATTR: ['style', 'onerror', 'onload', 'onclick'],
            ALLOWED_URI_REGEXP: /^(?:(?:https?|mailto):|[^a-z]|[a-z+.\\-]+(?:[^a-z+.\\-:]|$))/i
          });
        })
        .catch(function(err) {
          body.innerHTML = '<div class="md-preview-error">Failed to load preview: ' + escapeHtml(String(err.message || err)) + '</div>';
        });
    });
  }

  function renderMessage(msg) {
    if (seen.has(msg.id)) return;
    seen.add(msg.id);
    var d = new Date(msg.timestamp);
    var pad2 = function(n) { return n < 10 ? '0' + n : '' + n; };
    var dateKey = d.getFullYear() + '-' + pad2(d.getMonth()+1) + '-' + pad2(d.getDate());
    var isRoot = !msg.reply_to_id;
    if (isRoot && dateKey !== lastRenderedDate) {
      lastRenderedDate = dateKey;
      var divider = document.createElement('div');
      divider.className = 'date-divider';
      divider.id = 'date-' + dateKey;
      divider.textContent = formatDateLabel(d);
      messagesEl.appendChild(divider);
    }
    var div = document.createElement('div');
    div.className = 'msg';
    div.setAttribute('data-msg-id', msg.id);
    var time = d.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit', second: '2-digit', hour12: false });
    var color = getSenderColor(msg.sender);
    var receiptsText = '';
    var receiptsTitle = '';
    if (msg.deliveredTo || msg.readBy || msg.engagedBy) {
      msgReceipts[msg.id] = { readBy: msg.readBy || [], deliveredTo: msg.deliveredTo || [], engagedBy: msg.engagedBy || [] };
      receiptsText = compactReceipts(msg.readBy || [], msg.engagedBy || []);
      receiptsTitle = fullReceiptsTitle(msg.readBy || [], msg.engagedBy || [], msg.deliveredTo || []);
    }
    var filesHtml = '';
    if (msg.files && msg.files.length > 0) {
      filesHtml = '<div class="msg-files">';
      msg.files.forEach(function(f) {
        var sizeStr = f.size < 1024 ? f.size + ' B'
          : f.size < 1048576 ? (f.size / 1024).toFixed(1) + ' KB'
          : (f.size / 1048576).toFixed(1) + ' MB';
        var lower = (f.filename || '').toLowerCase();
        var isMd = lower.endsWith('.md') || lower.endsWith('.markdown');
        var isTxt = /\\.(txt|log|csv|text)$/i.test(lower);
        if (isMd || isTxt) {
          var mode = isMd ? 'md' : 'txt';
          var icon = isMd ? '&#x1F4DD;' : '&#x1F4C4;';
          filesHtml += '<details class="md-preview" data-file-id="' + encodeURIComponent(f.id) + '" data-file-size="' + f.size + '" data-mode="' + mode + '">' +
            '<summary>' +
              '<span class="md-preview-label">' + icon + ' ' + escapeHtml(f.filename) + ' <span class="md-preview-size">(' + sizeStr + ')</span></span>' +
              '<a class="md-preview-download" href="/files/' + encodeURIComponent(f.id) + '/download" target="_blank" rel="noopener">download</a>' +
            '</summary>' +
            '<div class="md-preview-body" data-loaded="0">Loading\\u2026</div>' +
          '</details>';
        } else {
          filesHtml += '<a class="file-badge" href="/files/' + encodeURIComponent(f.id) + '/download" target="_blank">' +
            '&#x1F4CE; ' + escapeHtml(f.filename) + ' <span class="file-size">(' + sizeStr + ')</span></a>';
        }
      });
      filesHtml += '</div>';
    }
    // Chip only when the parent is OUT of the loaded window — otherwise the
    // visual indent under the parent is the relationship cue and the chip
    // is redundant noise (UX review: 5 signals for one relationship).
    var parentInDom = msg.reply_to_id
      ? !!messagesEl.querySelector('.msg-wrapper[data-wrapper-for="' + msg.reply_to_id + '"]')
      : false;
    var showChip = msg.reply_to_id && !parentInDom;
    var replyChipHtml = showChip
      ? '<span class="msg-reply-chip" data-reply-to="' + msg.reply_to_id + '" title="Reply to an earlier message (out of view)">\\u21B3 reply</span>'
      : '';
    var replyChipPreviewHtml = showChip
      ? '<div class="msg-reply-chip-preview" id="preview-' + msg.id + '"></div>'
      : '';
    var replyCountHtml = (msg.reply_count && msg.reply_count > 0)
      ? '<button type="button" class="msg-reply-count" data-parent-id="' + msg.id + '">\\u21B3 ' +
          msg.reply_count + ' repl' + (msg.reply_count === 1 ? 'y' : 'ies') + '</button>'
      : '';
    div.innerHTML =
      '<div class="msg-header">' +
        '<span class="collapse-caret" data-target-msg-id="' + msg.id + '">\\u25BE</span>' +
        '<span class="msg-time">[' + time + ']</span>' +
        '<span style="color:' + color + ';font-weight:600;">' + escapeHtml(msg.sender) + '</span>' +
        replyChipHtml +
      '</div>' +
      replyChipPreviewHtml +
      '<div class="msg-body-row">' +
        '<div class="msg-body">' +
          '<div class="msg-content">' + formatContent(msg.content) + '</div>' +
          filesHtml +
        '</div>' +
        '<div class="msg-footer">' +
          '<button type="button" class="msg-reply-btn" data-msg-id="' + msg.id + '" title="Reply">\\u21A9</button>' +
          replyCountHtml +
          '<span class="msg-receipts-wrap">' +
            '<button type="button" class="msg-receipts-inline" id="receipts-' + msg.id + '" title="' + escapeHtml(receiptsTitle) + '" aria-expanded="false" aria-controls="receipts-panel-' + msg.id + '">' + escapeHtml(receiptsText) + '</button>' +
            '<div class="msg-receipts-panel" id="receipts-panel-' + msg.id + '" role="dialog" aria-label="Receipt details"></div>' +
          '</span>' +
        '</div>' +
      '</div>';
    msgContentCache[msg.id] = { sender: msg.sender, content: msg.content };
    // Wrap msg in .msg-wrapper with a .msg-children container. Created early
    // so the collapse-caret handler below can reference it; the actual DOM
    // insert happens at the end of this function.
    var wrapper = document.createElement('div');
    wrapper.className = 'msg-wrapper';
    wrapper.setAttribute('data-wrapper-for', msg.id);
    wrapper.appendChild(div);
    var childrenContainer = document.createElement('div');
    childrenContainer.className = 'msg-children';
    wrapper.appendChild(childrenContainer);
    var chip = div.querySelector('.msg-reply-chip');
    if (chip) {
      chip.addEventListener('click', function() {
        var targetId = chip.getAttribute('data-reply-to');
        var preview = div.querySelector('.msg-reply-chip-preview');
        if (preview && preview.classList.contains('expanded')) {
          preview.classList.remove('expanded');
          return;
        }
        var cached = msgContentCache[targetId];
        if (cached && preview) {
          preview.textContent = cached.sender + ': ' + cached.content.slice(0, 240) + (cached.content.length > 240 ? '\\u2026' : '');
          preview.classList.add('expanded');
        }
        var target = messagesEl.querySelector('[data-msg-id="' + targetId + '"]');
        if (target) {
          target.scrollIntoView({ behavior: 'smooth', block: 'center' });
          target.style.background = '#1f2937';
          setTimeout(function() { target.style.background = ''; }, 1200);
        }
      });
    }
    var caret = div.querySelector('.collapse-caret');
    if (caret) {
      // Restore persisted collapse state from localStorage
      var collapseKey = 'sc-collapsed-' + msg.id;
      if (localStorage.getItem(collapseKey) === '1') {
        wrapper.classList.add('collapsed');
        caret.textContent = '\u25B8';
      }
      caret.addEventListener('click', function() {
        var isCollapsed = wrapper.classList.toggle('collapsed');
        caret.textContent = isCollapsed ? '\u25B8' : '\u25BE';
        if (isCollapsed) localStorage.setItem(collapseKey, '1');
        else localStorage.removeItem(collapseKey);
      });
    }
    var replyBtn = div.querySelector('.msg-reply-btn');
    if (replyBtn) {
      replyBtn.addEventListener('click', function() {
        setReplyingTo(msg.id, msg.sender, msg.content);
      });
    }
    var replyCountBtn = div.querySelector('.msg-reply-count');
    if (replyCountBtn) {
      replyCountBtn.addEventListener('click', function() {
        var firstReply = messagesEl.querySelector('.msg-reply-chip[data-reply-to="' + msg.id + '"]');
        if (firstReply) {
          var wrapper = firstReply.closest('.msg');
          if (wrapper) {
            wrapper.scrollIntoView({ behavior: 'smooth', block: 'center' });
            wrapper.style.background = '#1f2937';
            setTimeout(function() { wrapper.style.background = ''; }, 1200);
          }
        }
      });
    }
    var receiptsBtn = div.querySelector('.msg-receipts-inline');
    if (receiptsBtn) {
      receiptsBtn.addEventListener('click', function(e) {
        if (!receiptsBtn.textContent) return;
        e.stopPropagation();
        var wrap = receiptsBtn.parentElement;
        var panel = document.getElementById('receipts-panel-' + msg.id);
        var willOpen = !wrap.classList.contains('open');
        var openWraps = document.querySelectorAll('.msg-receipts-wrap.open');
        for (var j = 0; j < openWraps.length; j++) openWraps[j].classList.remove('open');
        if (willOpen) {
          var r = msgReceipts[msg.id] || { readBy: [], engagedBy: [], deliveredTo: [] };
          if (panel) panel.innerHTML = buildReceiptPanelHtml(r.readBy, r.engagedBy, r.deliveredTo);
          wrap.classList.add('open');
          receiptsBtn.setAttribute('aria-expanded', 'true');
        } else {
          receiptsBtn.setAttribute('aria-expanded', 'false');
        }
      });
    }
    var mdPreviews = div.querySelectorAll('details.md-preview');
    for (var i = 0; i < mdPreviews.length; i++) attachMdPreview(mdPreviews[i]);

    // Append wrapper to parent's children container or to the top-level feed.
    var parentWrapper = msg.reply_to_id
      ? messagesEl.querySelector('.msg-wrapper[data-wrapper-for="' + msg.reply_to_id + '"]')
      : null;
    if (parentWrapper) {
      parentWrapper.querySelector('.msg-children').appendChild(wrapper);
    } else {
      messagesEl.appendChild(wrapper);
    }
    readObserver.observe(div);
    if (!documentVisible || userScrolled) addUnreadMention(msg);
    if (!userScrolled) messagesEl.scrollTop = messagesEl.scrollHeight;
  }

  // Browser notifications
  if ('Notification' in window && Notification.permission === 'default') {
    Notification.requestPermission();
  }

  function notifyMention(msg) {
    if (!currentUser) return;
    if (msg.sender === currentUser) return;
    var mentions = msg.mentions || [];
    if (mentions.indexOf(currentUser) === -1) return;
    if ('Notification' in window && Notification.permission === 'granted') {
      var preview = msg.content.length > 100 ? msg.content.slice(0, 100) + '...' : msg.content;
      new Notification('SideChat — @' + currentUser, {
        body: msg.sender + ': ' + preview,
        tag: 'sidechat-' + msg.id
      });
    }
  }

  // Fetch user list for autocomplete
  fetch('/users', { credentials: 'same-origin' })
    .then(function(r) { return r.json(); })
    .then(function(data) { allUsers = data.users || []; })
    .catch(function() {});

  // History window state. Initial load fetches the last 8 wall-clock hours,
  // falling back to the 8h window ending at the most recent message when the
  // channel's been quiet. oldestLoadedTimestamp is the lower bound of the
  // currently-rendered window; older messages are fetched on demand via the
  // calendar or scroll-to-top trigger.
  var oldestLoadedTimestamp = new Date(Date.now() - 8 * 3600 * 1000);
  var loadingOlder = false;

  function loadMessagesSince(sinceDate) {
    if (loadingOlder) return Promise.resolve();
    loadingOlder = true;
    var topMsg = messagesEl.querySelector('.msg');
    var topMsgId = topMsg ? topMsg.getAttribute('data-msg-id') : null;
    var sinceISO = sinceDate.toISOString();
    return fetch('/messages?since=' + encodeURIComponent(sinceISO), { credentials: 'same-origin' })
      .then(function(r) { if (!r.ok) throw new Error(r.status); return r.json(); })
      .then(function(data) {
        seen.clear();
        lastRenderedDate = '';
        messagesEl.innerHTML = '';
        oldestLoadedTimestamp = sinceDate;
        data.messages.forEach(renderMessage);
        // Anchor the scroll to where the user was looking, if possible.
        if (topMsgId) {
          var el = document.querySelector('[data-msg-id="' + topMsgId + '"]');
          if (el) el.scrollIntoView({ behavior: 'auto', block: 'start' });
        } else {
          messagesEl.scrollTop = messagesEl.scrollHeight;
        }
      })
      .finally(function() { loadingOlder = false; });
  }

  // Initial load: past 8 hours (with fallback to last 8h of activity if quiet)
  fetch('/messages?lookback_hours=8', { credentials: 'same-origin' })
    .then(function(r) { if (!r.ok) throw new Error(r.status); return r.json(); })
    .then(function(data) {
      data.messages.forEach(renderMessage);
      if (data.messages.length > 0) {
        var oldest = new Date(data.messages[0].timestamp);
        if (oldest < oldestLoadedTimestamp) oldestLoadedTimestamp = oldest;
      }
      initialLoadDone = true;
    })
    .catch(function(err) { messagesEl.innerHTML = '<div style="color:#f85149;">Failed to load messages: ' + err.message + '</div>'; });

  // Scroll-to-top: when the user scrolls to the top of the message list,
  // extend the loaded window 8 hours further back.
  messagesEl.addEventListener('scroll', function() {
    if (loadingOlder) return;
    if (messagesEl.scrollTop > 60) return;
    var newSince = new Date(oldestLoadedTimestamp.getTime() - 8 * 3600 * 1000);
    loadMessagesSince(newSince);
  });

  // Autocomplete logic
  function getACWord() {
    var val = msgInput.value;
    var pos = msgInput.selectionStart;
    var before = val.slice(0, pos);
    var match = before.match(/@(\\w*)$/);
    return match ? { prefix: match[1].toLowerCase(), start: before.length - match[0].length } : null;
  }

  function showAC() {
    var w = getACWord();
    if (!w) { autocompleteEl.style.display = 'none'; acIndex = -1; return; }
    var filtered = allUsers.filter(function(u) {
      return u.toLowerCase().indexOf(w.prefix) === 0 && u !== currentUser;
    });
    if (filtered.length === 0) { autocompleteEl.style.display = 'none'; acIndex = -1; return; }
    autocompleteEl.innerHTML = '';
    filtered.forEach(function(u, i) {
      var item = document.createElement('div');
      item.className = 'ac-item' + (i === acIndex ? ' selected' : '');
      item.textContent = '@' + u;
      item.addEventListener('mousedown', function(e) {
        e.preventDefault();
        completeAC(u);
      });
      autocompleteEl.appendChild(item);
    });
    autocompleteEl.style.display = 'block';
  }

  function completeAC(username) {
    var w = getACWord();
    if (!w) return;
    var val = msgInput.value;
    var before = val.slice(0, w.start);
    var after = val.slice(msgInput.selectionStart);
    msgInput.value = before + '@' + username + ' ' + after;
    msgInput.focus();
    var newPos = before.length + username.length + 2;
    msgInput.setSelectionRange(newPos, newPos);
    autocompleteEl.style.display = 'none';
    acIndex = -1;
  }

  function getACItems() {
    return autocompleteEl.querySelectorAll('.ac-item');
  }

  msgInput.addEventListener('input', function() { acIndex = -1; showAC(); });
  msgInput.addEventListener('blur', function() {
    setTimeout(function() { autocompleteEl.style.display = 'none'; }, 150);
  });

  msgInput.addEventListener('keydown', function(e) {
    var items = getACItems();
    if (autocompleteEl.style.display === 'block' && items.length > 0) {
      if (e.key === 'ArrowDown') {
        e.preventDefault();
        acIndex = Math.min(acIndex + 1, items.length - 1);
        items.forEach(function(el, i) { el.className = 'ac-item' + (i === acIndex ? ' selected' : ''); });
      } else if (e.key === 'ArrowUp') {
        e.preventDefault();
        acIndex = Math.max(acIndex - 1, 0);
        items.forEach(function(el, i) { el.className = 'ac-item' + (i === acIndex ? ' selected' : ''); });
      } else if (e.key === 'Tab' || e.key === 'Enter') {
        if (acIndex >= 0 && acIndex < items.length) {
          e.preventDefault();
          var text = items[acIndex].textContent.slice(1); // remove @
          completeAC(text);
          return;
        }
      } else if (e.key === 'Escape') {
        autocompleteEl.style.display = 'none';
        acIndex = -1;
      }
    }
  });

  // File attach
  function fmtSize(n) {
    if (n < 1024) return n + ' B';
    if (n < 1048576) return (n / 1024).toFixed(1) + ' KB';
    return (n / 1048576).toFixed(1) + ' MB';
  }

  function renderPendingFiles() {
    if (pendingFiles.length === 0) { pendingFilesEl.style.display = 'none'; return; }
    pendingFilesEl.style.display = 'flex';
    pendingFilesEl.innerHTML = '';
    pendingFiles.forEach(function(pf, idx) {
      var chip = document.createElement('span');
      chip.className = 'pending-chip';
      chip.innerHTML = escapeHtml(pf.filename) + ' <span class="file-size">(' + fmtSize(pf.size) + ')</span>' +
        ' <span class="remove-chip" data-idx="' + idx + '">x</span>';
      chip.querySelector('.remove-chip').addEventListener('click', function() {
        pendingFiles.splice(idx, 1);
        renderPendingFiles();
      });
      pendingFilesEl.appendChild(chip);
    });
  }

  attachBtn.addEventListener('click', function() { fileInput.click(); });

  fileInput.addEventListener('change', function() {
    var files = fileInput.files;
    if (!files || files.length === 0) return;
    var uploading = 0;
    attachBtn.style.opacity = '0.5';
    for (var i = 0; i < files.length; i++) {
      (function(f) {
        uploading++;
        var fd = new FormData();
        fd.append('file', f);
        fetch('/files/upload', {
          method: 'POST',
          credentials: 'same-origin',
          headers: SC_TOKEN ? { 'Authorization': 'Bearer ' + SC_TOKEN } : {},
          body: fd
        })
        .then(function(r) {
          if (!r.ok) return r.json().then(function(d) { throw new Error(d.error || r.status); });
          return r.json();
        })
        .then(function(data) {
          pendingFiles.push({ id: data.id, filename: data.filename, size: data.size });
          renderPendingFiles();
        })
        .catch(function(err) { alert('Upload failed: ' + err.message); })
        .finally(function() { uploading--; if (uploading === 0) attachBtn.style.opacity = '1'; });
      })(files[i]);
    }
    fileInput.value = '';
  });

  // Send message
  msgForm.addEventListener('submit', function(e) {
    e.preventDefault();
    var content = msgInput.value.trim();
    if (!content && pendingFiles.length === 0) return;
    if (!content && pendingFiles.length > 0) content = pendingFiles.map(function(f) { return f.filename; }).join(', ');
    msgSend.disabled = true;
    var payload = { content: content };
    if (pendingFiles.length > 0) {
      payload.file_ids = pendingFiles.map(function(f) { return f.id; });
    }
    if (replyingToId != null) {
      payload.reply_to_id = replyingToId;
    }
    fetch('/message', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      credentials: 'same-origin',
      body: JSON.stringify(payload)
    })
    .then(function(r) {
      if (!r.ok) return r.json().then(function(d) { throw new Error(d.error || r.status); });
      msgInput.value = '';
      pendingFiles = [];
      renderPendingFiles();
      clearReplyingTo();
    })
    .catch(function(err) {
      alert('Failed to send: ' + err.message);
    })
    .finally(function() { msgSend.disabled = false; msgInput.focus(); });
  });

  // SSE
  function connectSSE() {
    var es = new EventSource('/events?token=' + encodeURIComponent(SC_TOKEN));

    es.addEventListener('connected', function(e) {
      dot.className = 'dot connected';
      statusText.textContent = 'Connected';
    });

    es.addEventListener('message', function(e) {
      try {
        var msg = JSON.parse(e.data);
        renderMessage(msg);
        notifyMention(msg);
        if (msg.files && msg.files.length && window.__refreshFiles) window.__refreshFiles();
      } catch(err) {}
    });

    es.addEventListener('delivered', function(e) {
      try {
        var data = JSON.parse(e.data);
        updateReceipts(data.id, 'delivered', data.bot);
      } catch(err) {}
    });

    es.addEventListener('read', function(e) {
      try {
        var data = JSON.parse(e.data);
        updateReceipts(data.id, 'read', data.reader);
      } catch(err) {}
    });

    es.addEventListener('engaged', function(e) {
      try {
        var data = JSON.parse(e.data);
        updateReceipts(data.id, 'engaged', data.engager);
      } catch(err) {}
    });

    es.addEventListener('activity', function(e) {
      try { var d = JSON.parse(e.data); if (d && d.date && window.__calMarkDay) window.__calMarkDay(d.date); } catch(_) {}
    });

    es.addEventListener('deleted', function(e) {
      try {
        var data = JSON.parse(e.data);
        if (!data || !Array.isArray(data.ids)) return;
        data.ids.forEach(function(id) {
          var el = messagesEl.querySelector('[data-msg-id="' + id + '"]');
          if (el && el.parentNode) el.parentNode.removeChild(el);
          seen.delete(id);
          var chips = messagesEl.querySelectorAll('.msg-reply-chip[data-reply-to="' + id + '"]');
          for (var i = 0; i < chips.length; i++) {
            chips[i].textContent = '\\u21B3 replied to #' + id + ' (deleted)';
            chips[i].style.cursor = 'default';
            chips[i].style.color = '#6e7681';
          }
        });
      } catch(_) {}
    });

    es.addEventListener('ping', function() {});

    es.onerror = function() {
      if (es.readyState === EventSource.CLOSED) {
        dot.className = 'dot disconnected';
        statusText.textContent = 'Disconnected (reconnecting...)';
        setTimeout(connectSSE, 5000);
      } else {
        dot.className = 'dot disconnected';
        statusText.textContent = 'Reconnecting...';
      }
    };
  }

  connectSSE();

  var sidebar = document.getElementById('sidebar');
  var sidebarToggle = document.getElementById('sidebar-toggle');
  sidebarToggle.addEventListener('click', function() {
    sidebar.classList.toggle('collapsed');
    sidebarToggle.innerHTML = sidebar.classList.contains('collapsed') ? '&raquo;' : '&laquo;';
  });
  var sidebarMobileToggle = document.getElementById('sidebar-mobile-toggle');
  var sidebarBackdrop = document.getElementById('sidebar-backdrop');
  function closeMobileSidebar() {
    sidebar.classList.remove('mobile-open');
    sidebarBackdrop.classList.remove('open');
  }
  sidebarMobileToggle.addEventListener('click', function() {
    var opening = !sidebar.classList.contains('mobile-open');
    sidebar.classList.toggle('mobile-open', opening);
    sidebarBackdrop.classList.toggle('open', opening);
  });
  sidebarBackdrop.addEventListener('click', closeMobileSidebar);
  // Close sidebar after clicking a calendar day or file row on mobile
  document.addEventListener('click', function(e) {
    if (window.innerWidth > 700) return;
    var t = e.target;
    if (t.closest && (t.closest('.cal-day.has-activity') || t.closest('.file-row'))) {
      setTimeout(closeMobileSidebar, 150);
    }
  });

  document.getElementById('signout-btn').addEventListener('click', function() {
    fetch('/watch/logout', { method: 'POST', credentials: 'same-origin' })
      .then(function() { window.location.href = '/watch/login'; })
      .catch(function() { window.location.href = '/watch/login'; });
  });
})();
</script>
</body>
</html>`;
}

// --- Watch Login Page ---

const watchLoginPage = (csrfToken: string, nonce: string) => `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<meta name="csrf" content="${csrfToken}">
<title>SideChat — Login</title>
<link rel="icon" href="data:image/svg+xml,<svg xmlns='http://www.w3.org/2000/svg' viewBox='0 0 100 100'><g fill='rgb(126,231,135)'><ellipse cx='50' cy='15' rx='13' ry='20'/><ellipse cx='84' cy='40' rx='13' ry='20' transform='rotate(72 84 40)'/><ellipse cx='71' cy='82' rx='13' ry='20' transform='rotate(144 71 82)'/><ellipse cx='29' cy='82' rx='13' ry='20' transform='rotate(216 29 82)'/><ellipse cx='16' cy='40' rx='13' ry='20' transform='rotate(288 16 40)'/></g><circle cx='50' cy='50' r='26' fill='rgb(56,139,253)'/><path d='M34 45 h32 a3 3 0 0 1 3 3 v10 a3 3 0 0 1 -3 3 h-20 l-7 6 v-6 h-5 a3 3 0 0 1 -3 -3 v-10 a3 3 0 0 1 3 -3 z' fill='white'/></svg>">
<style>
  * { margin: 0; padding: 0; box-sizing: border-box; }
  body {
    background: #0d1117;
    color: #c9d1d9;
    font-family: 'SF Mono', 'Cascadia Code', 'Fira Code', 'Consolas', monospace;
    font-size: 14px;
    height: 100vh;
    display: flex;
    align-items: center;
    justify-content: center;
  }
  .login-card {
    border: 1px solid #21262d;
    border-radius: 8px;
    padding: 32px 40px;
    max-width: 360px;
    width: 100%;
  }
  .login-card h1 {
    font-size: 18px;
    color: #e6edf3;
    margin-bottom: 24px;
    font-weight: 600;
  }
  .field { margin-bottom: 16px; }
  .field label {
    display: block;
    color: #8b949e;
    font-size: 12px;
    margin-bottom: 6px;
    text-transform: uppercase;
    letter-spacing: 0.5px;
  }
  .field input {
    width: 100%;
    padding: 8px 12px;
    background: #010409;
    border: 1px solid #30363d;
    border-radius: 6px;
    color: #c9d1d9;
    font-family: inherit;
    font-size: 14px;
    outline: none;
  }
  .field input:focus { border-color: #58a6ff; }
  button[type="submit"] {
    width: 100%;
    padding: 10px;
    background: #238636;
    border: 1px solid #2ea043;
    border-radius: 6px;
    color: #fff;
    font-family: inherit;
    font-size: 14px;
    font-weight: 600;
    cursor: pointer;
    margin-top: 8px;
  }
  button[type="submit"]:hover { background: #2ea043; }
  .error-msg {
    color: #f85149;
    font-size: 13px;
    margin-bottom: 12px;
    display: none;
  }
  .admin-link {
    display: block;
    text-align: right;
    font-size: 12px;
    color: #8b949e;
    text-decoration: none;
    margin-bottom: 12px;
    text-transform: uppercase;
    letter-spacing: 0.5px;
  }
  .admin-link:hover { color: #58a6ff; }
</style>
</head>
<body>
<div class="login-card">
  <a class="admin-link" href="/admin">Admin Console →</a>
  <h1>SideChat</h1>
  <div class="error-msg" id="error"></div>
  <form id="login-form">
    <div class="field">
      <label>Username</label>
      <input type="text" id="username" name="username" autocomplete="username" required />
    </div>
    <div class="field">
      <label>Password</label>
      <input type="password" id="password" name="password" autocomplete="current-password" required />
    </div>
    <button type="submit">Sign In</button>
  </form>
</div>
<script nonce="${nonce}">
(function() {
  var form = document.getElementById('login-form');
  var errEl = document.getElementById('error');
  form.addEventListener('submit', function(e) {
    e.preventDefault();
    errEl.style.display = 'none';
    var username = document.getElementById('username').value;
    var password = document.getElementById('password').value;
    var csrf = document.querySelector('meta[name="csrf"]').getAttribute('content');
    fetch('/watch/login', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'X-CSRF-Token': csrf },
      credentials: 'same-origin',
      body: JSON.stringify({ username: username, password: password })
    }).then(function(r) {
      if (!r.ok) return r.json().then(function(d) { throw new Error(d.error || 'Login failed'); });
      window.location.href = '/';
    }).catch(function(err) {
      errEl.textContent = err.message;
      errEl.style.display = 'block';
    });
  });
})();
</script>
</body>
</html>`;

// --- App ---

const app = new Hono();

// --- Server-Timing middleware ---
// Emits Server-Timing response headers with per-request total duration.
// Visible in browser DevTools Network tab and scrapable by downstream tools.
app.use("*", timing());

// --- Per-request CSP nonce ---
// Generate a fresh base64 nonce per request and stash it on the context.
// HTML responses interpolate it into every inline <script nonce="..."> so
// the strict CSP below can drop 'unsafe-inline' from script-src.
app.use("*", async (c, next) => {
  c.set("cspNonce", crypto.randomUUID().replace(/-/g, ""));
  await next();
});

// --- Content-Security-Policy (enforcing) ---
// script-src uses a per-request nonce ('unsafe-inline' removed, #11).
// style-src keeps 'unsafe-inline' for now — separate cleanup.
// Flipped from Report-Only to enforcing after #11 + adversarial soak (#4).
// Violations still report to /csp-report so Loki keeps an audit trail.
function cspPolicy(nonce: string): string {
  return [
    "default-src 'self'",
    `script-src 'self' 'nonce-${nonce}'`,
    "style-src 'self' 'unsafe-inline'",
    "img-src 'self' data:",
    "font-src 'self' data:",
    "connect-src 'self'",
    "frame-ancestors 'none'",
    "base-uri 'self'",
    "form-action 'self'",
    "report-uri /csp-report",
  ].join("; ");
}
app.use("*", async (c, next) => {
  await next();
  c.header("Content-Security-Policy", cspPolicy(c.get("cspNonce") as string));
  c.header("X-Content-Type-Options", "nosniff");
  c.header("X-Frame-Options", "DENY");
  c.header("Referrer-Policy", "strict-origin-when-cross-origin");
});

// POST /csp-report — CSP violation reporter
app.post("/csp-report", async (c) => {
  try {
    const body = await c.req.json().catch(() => null);
    const report = body?.["csp-report"] ?? body;
    logEvent("csp.violation", {
      ip: getClientIP(c),
      directive: report?.["violated-directive"] ?? report?.["effective-directive"],
      blocked: report?.["blocked-uri"],
      document: report?.["document-uri"],
      source: report?.["source-file"],
      line: report?.["line-number"],
    });
  } catch (e) {
    logEvent("csp.violation.parse_err", { ip: getClientIP(c), err: String(e) });
  }
  return c.body(null, 204);
});

// --- Canonical URL redirect ---
// Redirect HTTP / short hostname requests to the HTTPS FQDN
const CANONICAL_HOST = Bun.env.CANONICAL_HOST ?? "";
if (CANONICAL_HOST) {
  app.use("*", async (c, next) => {
    const host = c.req.header("host")?.split(":")[0] ?? "";
    if (host && host !== CANONICAL_HOST && host !== "localhost" && host !== "127.0.0.1") {
      const url = new URL(c.req.url);
      url.protocol = "https:";
      url.hostname = CANONICAL_HOST;
      url.port = "";
      return c.redirect(url.toString(), 301);
    }
    return next();
  });
}

// GET /watch/login — observer login page
app.get("/watch/login", (c) => {
  // If already authenticated, redirect to /
  const token = getCookie(c, "observer_session");
  if (token) {
    const session = db.query(
      `SELECT os.*, o.status FROM observer_sessions os
       JOIN observers o ON o.id = os.observer_id
       WHERE os.token = ? AND o.status = 'active'
       AND (os.expires_at IS NULL OR os.expires_at > datetime('now'))`
    ).get(token);
    if (session) return c.redirect("/");
  }
  const csrfToken = issueCsrfToken(c);
  return c.html(watchLoginPage(csrfToken, c.get("cspNonce") as string));
});

// POST /watch/login — observer authentication
app.post("/watch/login", async (c) => {
  if (!verifyCsrfToken(c)) {
    logEvent("observer.login.fail", { ip: getClientIP(c), reason: "csrf_invalid" });
    return c.json({ error: "CSRF verification failed" }, 403);
  }
  const limited = checkAuthRateLimit(c);
  if (limited) { logEvent("observer.login.fail", { username_attempted: "unknown", ip: getClientIP(c), reason: "rate_limit" }); return limited; }
  const ip = getClientIP(c);
  const parsed = await parseJsonBody<{ username: string; password: string }>(c);
  if (!parsed.ok) { logEvent("observer.login.fail", { ip, reason: "bad_request_body" }); return parsed.res; }
  const body = parsed.body;

  const observer = db.query(
    "SELECT * FROM observers WHERE username = ?"
  ).get(body.username) as any;
  if (!observer) {
    authAttemptsFailedTotal++;
    recordAuthFailure(c);
    logEvent("observer.login.fail", { username_attempted: body.username, ip, reason: "no_such_user" });
    await Bun.sleep(500);
    return c.json({ error: "Invalid credentials" }, 401);
  }
  if (observer.status === "revoked") {
    authAttemptsFailedTotal++;
    recordAuthFailure(c);
    logEvent("observer.login.fail", { username_attempted: body.username, ip, reason: "revoked" });
    return c.json({ error: "Account has been revoked" }, 403);
  }

  const valid = await Bun.password.verify(body.password, observer.password_hash);
  if (!valid) {
    authAttemptsFailedTotal++;
    recordAuthFailure(c);
    logEvent("observer.login.fail", { username_attempted: body.username, ip, reason: "bad_password" });
    await Bun.sleep(500);
    return c.json({ error: "Invalid credentials" }, 401);
  }

  authAttemptsTotal++;
  logEvent("observer.login.ok", { username: observer.username, ip });
  const token = crypto.randomUUID().replace(/-/g, "") + crypto.randomUUID().replace(/-/g, "");
  const expiresAt = new Date(Date.now() + 30 * 24 * 60 * 60 * 1000).toISOString();
  db.run(
    "INSERT INTO observer_sessions (token, observer_id, created_at, expires_at) VALUES (?, ?, ?, ?)",
    [token, observer.id, new Date().toISOString(), expiresAt]
  );

  setCookie(c, "observer_session", token, {
    httpOnly: true,
    secure: isRequestSecure(c),
    sameSite: "Strict",
    path: "/",
  });

  return c.json({ ok: true });
});

// POST /watch/logout — observer logout
app.post("/watch/logout", requireObserver, async (c) => {
  const token = getCookie(c, "observer_session");
  const observer = c.get("observer") as any;
  if (token) db.run("DELETE FROM observer_sessions WHERE token = ?", [token]);
  deleteCookie(c, "observer_session", { path: "/" });
  logEvent("observer.logout", { username: observer?.username, ip: getClientIP(c) });
  return c.redirect("/watch/login");
});

// GET / — Web frontend (observer auth required)
app.get("/", requireObserver, (c) => {
  const obs = c.get("observer") as any;
  const token = getCookie(c, "observer_session")!;
  return c.html(buildChatPage(obs.username, !!obs.can_post, token, c.get("cspNonce") as string));
});

// GET /metrics — Prometheus exposition format.
// If METRICS_TOKEN is set, requires Authorization: Bearer <token>.
// Otherwise stays open for backwards compatibility (startup warns).
const METRICS_TOKEN = Bun.env.METRICS_TOKEN ?? "";
app.get("/metrics", (c) => {
  if (METRICS_TOKEN) {
    const auth = c.req.header("authorization") ?? "";
    const expected = `Bearer ${METRICS_TOKEN}`;
    // Constant-time compare so a timing side-channel can't leak the token.
    if (
      auth.length !== expected.length ||
      !timingSafeEqual(Buffer.from(auth), Buffer.from(expected))
    ) {
      return c.json({ error: "Unauthorized" }, 401);
    }
  }
  const uptime = process.uptime();
  const mem = process.memoryUsage();
  const lines = [
    "# HELP sidechat_messages_posted_total Total messages posted",
    "# TYPE sidechat_messages_posted_total counter",
    `sidechat_messages_posted_total ${messagesPostedTotal}`,
    "",
    "# HELP sidechat_messages_total Total messages in SQLite",
    "# TYPE sidechat_messages_total gauge",
    `sidechat_messages_total ${(db.query("SELECT COUNT(*) as n FROM messages").get() as { n: number }).n}`,
    "",
    "# HELP sidechat_sse_clients_active Active SSE connections",
    "# TYPE sidechat_sse_clients_active gauge",
    `sidechat_sse_clients_active ${sseClients.size}`,
    "",
    "# HELP sidechat_webhook_subscribers_active Active clients with a registered webhook URL",
    "# TYPE sidechat_webhook_subscribers_active gauge",
    `sidechat_webhook_subscribers_active ${(db.query("SELECT COUNT(*) as n FROM clients WHERE status='active' AND webhook_url IS NOT NULL").get() as any).n}`,
    "",
    "# HELP sidechat_webhook_deliveries_total Total webhook deliveries",
    "# TYPE sidechat_webhook_deliveries_total counter",
    `sidechat_webhook_deliveries_total{status="success"} ${webhookDeliveriesTotal}`,
    `sidechat_webhook_deliveries_total{status="failed"} ${webhookDeliveriesFailedTotal}`,
    "",
    "# HELP sidechat_auth_attempts_total Total auth attempts",
    "# TYPE sidechat_auth_attempts_total counter",
    `sidechat_auth_attempts_total{status="success"} ${authAttemptsTotal}`,
    `sidechat_auth_attempts_total{status="failed"} ${authAttemptsFailedTotal}`,
    "",
    "# HELP sidechat_file_uploads_total Total file uploads",
    "# TYPE sidechat_file_uploads_total counter",
    `sidechat_file_uploads_total ${fileUploadsTotal}`,
    "",
    "# HELP sidechat_file_storage_bytes Current file storage usage",
    "# TYPE sidechat_file_storage_bytes gauge",
    `sidechat_file_storage_bytes ${getTotalFileStorage()}`,
    "",
    "# HELP process_heap_bytes Process heap size in bytes",
    "# TYPE process_heap_bytes gauge",
    `process_heap_bytes ${mem.heapUsed}`,
    "",
    "# HELP process_rss_bytes Process RSS in bytes",
    "# TYPE process_rss_bytes gauge",
    `process_rss_bytes ${mem.rss}`,
    "",
    "# HELP process_uptime_seconds Process uptime in seconds",
    "# TYPE process_uptime_seconds gauge",
    `process_uptime_seconds ${uptime}`,
    "",
  ];
  return new Response(lines.join("\n"), {
    headers: { "Content-Type": "text/plain; version=0.0.4; charset=utf-8" },
  });
});

// GET /health — no auth
// GET /version — current release version + build SHA, no auth, machine-readable
app.get("/version", (c) => {
  return c.json({ version: SERVER_VERSION, sha: SERVER_SHA });
});

// GET /install/version — version string as text/plain so sc-update.sh can curl
// it and compare against installed sc-version.txt. Bots send this in the
// X-SideChat-Client-Version header on /auth/token to populate the admin badge.
app.get("/install/version", (c) => {
  return c.text(SERVER_VERSION + "\n");
});

// GET /install/mcp-version — JSON companion to /install/version for MCP clients.
// Callers (the `mcp__sidechat__version` probe tool) compare their own build
// sha to expected_client_build_sha and raise drift warnings when off.
// schema_rev is the coarser "client must reconnect" signal, bumped only when
// the MCP tool surface changes.
app.get("/install/mcp-version", (c) => {
  return c.json({
    server_version: SERVER_VERSION,
    schema_rev: MCP_SCHEMA_REV,
    expected_client_build_sha: MCP_EXPECTED_CLIENT_BUILD_SHA,
  });
});

app.get("/health", (c) => {
  const accept = c.req.header("Accept") ?? "";
  const uptime = process.uptime();
  const days = Math.floor(uptime / 86400);
  const hours = Math.floor((uptime % 86400) / 3600);
  const mins = Math.floor((uptime % 3600) / 60);
  const secs = Math.floor(uptime % 60);
  const uptimeStr = days > 0
    ? `${days}d ${hours}h ${mins}m`
    : hours > 0
    ? `${hours}h ${mins}m ${secs}s`
    : `${mins}m ${secs}s`;

  // Return JSON for programmatic consumers
  if (accept.includes("application/json")) {
    const messageCount = (db.query("SELECT COUNT(*) as n FROM messages").get() as { n: number }).n;
    return c.json({ status: "ok", messageCount, uptime, sseClients: sseClients.size });
  }

  return c.html(`<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>SideChat — Health</title>
<link rel="icon" href="data:image/svg+xml,<svg xmlns='http://www.w3.org/2000/svg' viewBox='0 0 100 100'><g fill='rgb(126,231,135)'><ellipse cx='50' cy='15' rx='13' ry='20'/><ellipse cx='84' cy='40' rx='13' ry='20' transform='rotate(72 84 40)'/><ellipse cx='71' cy='82' rx='13' ry='20' transform='rotate(144 71 82)'/><ellipse cx='29' cy='82' rx='13' ry='20' transform='rotate(216 29 82)'/><ellipse cx='16' cy='40' rx='13' ry='20' transform='rotate(288 16 40)'/></g><circle cx='50' cy='50' r='26' fill='rgb(56,139,253)'/><path d='M34 45 h32 a3 3 0 0 1 3 3 v10 a3 3 0 0 1 -3 3 h-20 l-7 6 v-6 h-5 a3 3 0 0 1 -3 -3 v-10 a3 3 0 0 1 3 -3 z' fill='white'/></svg>">
<style>
  * { margin: 0; padding: 0; box-sizing: border-box; }
  body {
    background: #0d1117;
    color: #c9d1d9;
    font-family: 'SF Mono', 'Cascadia Code', 'Fira Code', 'Consolas', monospace;
    font-size: 14px;
    height: 100vh;
    display: flex;
    flex-direction: column;
  }
  #header {
    padding: 12px 16px;
    border-bottom: 1px solid #21262d;
    display: flex;
    justify-content: space-between;
    align-items: center;
    flex-shrink: 0;
  }
  #header h1 { font-size: 16px; font-weight: 600; color: #e6edf3; }
  .status-badge {
    font-size: 12px;
    display: flex;
    align-items: center;
    gap: 6px;
  }
  .dot {
    width: 8px; height: 8px;
    border-radius: 50%;
    display: inline-block;
    background: #3fb950;
  }
  .dot.error { background: #f85149; }
  .content {
    flex: 1;
    display: flex;
    align-items: center;
    justify-content: center;
  }
  .card {
    border: 1px solid #21262d;
    border-radius: 8px;
    padding: 32px 48px;
    max-width: 420px;
    width: 100%;
  }
  .metric {
    margin-bottom: 20px;
  }
  .metric:last-child { margin-bottom: 0; }
  .metric-label {
    color: #484f58;
    font-size: 12px;
    text-transform: uppercase;
    letter-spacing: 0.5px;
    margin-bottom: 4px;
  }
  .metric-value {
    color: #e6edf3;
    font-size: 20px;
    font-weight: 600;
  }
  .metric-value.ok { color: #3fb950; }
  .metric-value.error { color: #f85149; }
  .metric-value.purple { color: #d2a8ff; }
  .metric-value.blue { color: #79c0ff; }
</style>
</head>
<body>
  <div id="header">
    <h1>SideChat</h1>
    <div class="status-badge"><span class="dot" id="dot"></span> <span id="status-text">Healthy</span></div>
  </div>
  <div class="content">
    <div class="card">
      <div class="metric">
        <div class="metric-label">Status</div>
        <div class="metric-value ok" id="v-status">OK</div>
      </div>
      <div class="metric">
        <div class="metric-label">Messages</div>
        <div class="metric-value purple" id="v-messages">-</div>
      </div>
      <div class="metric">
        <div class="metric-label">Uptime</div>
        <div class="metric-value blue" id="v-uptime">-</div>
      </div>
      <div class="metric">
        <div class="metric-label">SSE Clients</div>
        <div class="metric-value blue" id="v-sse">-</div>
      </div>
    </div>
  </div>
<script nonce="${c.get("cspNonce")}">
(function() {
  var dot = document.getElementById('dot');
  var statusText = document.getElementById('status-text');
  var vStatus = document.getElementById('v-status');
  var vMessages = document.getElementById('v-messages');
  var vUptime = document.getElementById('v-uptime');
  var vSse = document.getElementById('v-sse');

  function fmtUptime(s) {
    var d = Math.floor(s / 86400);
    var h = Math.floor((s % 86400) / 3600);
    var m = Math.floor((s % 3600) / 60);
    var sec = Math.floor(s % 60);
    if (d > 0) return d + 'd ' + h + 'h ' + m + 'm';
    if (h > 0) return h + 'h ' + m + 'm ' + sec + 's';
    return m + 'm ' + sec + 's';
  }

  function refresh() {
    fetch('/health', { headers: { 'Accept': 'application/json' } })
      .then(function(r) { return r.json(); })
      .then(function(data) {
        dot.className = 'dot';
        statusText.textContent = 'Healthy';
        vStatus.textContent = 'OK';
        vStatus.className = 'metric-value ok';
        vMessages.textContent = data.messageCount;
        vUptime.textContent = fmtUptime(data.uptime);
        vSse.textContent = data.sseClients;
      })
      .catch(function() {
        dot.className = 'dot error';
        statusText.textContent = 'Unreachable';
        vStatus.textContent = 'ERROR';
        vStatus.className = 'metric-value error';
      });
  }

  refresh();
  setInterval(refresh, 3000);
})();
</script>
</body>
</html>`);
});

// GET /install/* — serve client install scripts (no auth)
const INSTALL_DIR = Bun.env.INSTALL_DIR ?? `${import.meta.dir}/install`;

app.get("/install/commands/:file", async (c) => {
  const file = c.req.param("file");

  if (!/^[a-z0-9_-]+\.md$/.test(file)) {
    return c.json({ error: "Not found" }, 404);
  }

  const filepath = `${INSTALL_DIR}/commands/${file}`;
  const f = Bun.file(filepath);
  if (!(await f.exists())) {
    return c.json({ error: "Not found" }, 404);
  }

  return new Response(f, {
    headers: { "Content-Type": "text/plain; charset=utf-8" },
  });
});

app.get("/install/hooks/:script", async (c) => {
  const script = c.req.param("script");

  if (!/^[a-z0-9_-]+\.sh$/.test(script)) {
    return c.json({ error: "Not found" }, 404);
  }

  const filepath = `${INSTALL_DIR}/hooks/${script}`;
  const file = Bun.file(filepath);
  if (!(await file.exists())) {
    return c.json({ error: "Not found" }, 404);
  }

  return new Response(file, {
    headers: { "Content-Type": "text/plain; charset=utf-8" },
  });
});

// Serve the Claude Code plugin marketplace manifest for sidechat-monitor.
// Consumed by install-mcp.sh via `claude plugin marketplace add <url>` then
// `claude plugin install sidechat-monitor@sidechat-oss` — persistent plugin
// install across CC sessions with no per-bot launcher patching. Served at
// /install/marketplace.json (not /.claude-plugin/marketplace.json) so it's
// a single clean install URL the operator pastes.
app.get("/install/marketplace.json", async (c) => {
  const filepath = `${import.meta.dir}/.claude-plugin/marketplace.json`;
  const f = Bun.file(filepath);
  if (!(await f.exists())) {
    return c.json({ error: "Not found" }, 404);
  }
  return new Response(f, {
    headers: { "Content-Type": "application/json; charset=utf-8" },
  });
});

// Serve the canonical SideChat CLAUDE.md block. Single source of truth for
// the per-bot CLAUDE.md ## SideChat section — consumed by install/client.sh
// on first install and install/sc-update.sh on subsequent refreshes. Keeps
// the bot-runtime guidance in sync with the server version without
// requiring a re-install. Pre-2.6.10 this content was duplicated as an
// embedded bash heredoc in client.sh; bots frozen at install never saw
// refreshes. Keep the route specific (not under /install/:script) so the
// strict filename regex there doesn't have to grow a .md exception.
app.get("/install/claude-md-block", async (c) => {
  const filepath = `${INSTALL_DIR}/claude-md-block.md`;
  const f = Bun.file(filepath);
  if (!(await f.exists())) {
    return c.json({ error: "Not found" }, 404);
  }
  return new Response(f, {
    headers: { "Content-Type": "text/plain; charset=utf-8" },
  });
});

app.get("/install/:script", async (c) => {
  const script = c.req.param("script");

  // Only allow known script filenames — prevent directory traversal
  if (!/^[a-z0-9_-]+\.(sh|py)$/.test(script)) {
    return c.json({ error: "Not found" }, 404);
  }

  const filepath = `${INSTALL_DIR}/${script}`;
  const file = Bun.file(filepath);
  if (!(await file.exists())) {
    return c.json({ error: "Not found" }, 404);
  }

  return new Response(file, {
    headers: { "Content-Type": "text/plain; charset=utf-8" },
  });
});

// --- Session Auth Middleware ---

async function requireSession(c: Context, next: Next) {
  const token = c.req.header("Authorization")?.replace("Bearer ", "") ?? c.req.query("token");
  if (!token) { logEvent("session.denied", { ip: getClientIP(c), reason: "no_bearer", path: c.req.path }); return c.json({ error: "Unauthorized" }, 401); }

  const session = db.query(
    "SELECT * FROM sessions WHERE token = ? AND expires_at > ?"
  ).get(token, new Date().toISOString()) as any;
  if (!session) { logEvent("session.denied", { ip: getClientIP(c), reason: "bad_bearer_or_expired", path: c.req.path }); return c.json({ error: "Invalid or expired session" }, 401); }

  const scope = (session.scope ?? "full") as string;
  if (scope === "mcp" && !mcpScopeAllows(c.req.method, c.req.path)) {
    logEvent("session.denied", { ip: getClientIP(c), reason: "scope_denied", scope, path: c.req.path, method: c.req.method });
    return c.json({ error: "Token scope does not permit this endpoint" }, 403);
  }

  const client = db.query(
    "SELECT * FROM clients WHERE fingerprint = ? AND status = 'active'"
  ).get(session.fingerprint) as any;
  if (!client) { logEvent("session.denied", { ip: getClientIP(c), reason: "client_revoked", path: c.req.path }); return c.json({ error: "Client revoked" }, 401); }

  db.run(
    "UPDATE clients SET last_seen = ?, last_ip = ? WHERE fingerprint = ?",
    [new Date().toISOString(), getClientIP(c), session.fingerprint]
  );

  c.set("client", client);
  c.set("sessionScope", scope);
  await next();
}

async function requirePostSession(c: Context, next: Next) {
  // Try bot bearer token first
  const token = c.req.header("Authorization")?.replace("Bearer ", "") ?? c.req.query("token");
  if (token) {
    const botSession = db.query(
      "SELECT * FROM sessions WHERE token = ? AND expires_at > ?"
    ).get(token, new Date().toISOString()) as any;
    if (botSession) {
      const scope = (botSession.scope ?? "full") as string;
      if (scope === "mcp" && !mcpScopeAllows(c.req.method, c.req.path)) {
        logEvent("session.denied", { ip: getClientIP(c), reason: "scope_denied", scope, path: c.req.path, method: c.req.method });
        return c.json({ error: "Token scope does not permit this endpoint" }, 403);
      }
      const client = db.query(
        "SELECT * FROM clients WHERE fingerprint = ? AND status = 'active'"
      ).get(botSession.fingerprint) as any;
      if (client) {
        if (!client.can_post) return c.json({ error: "Client not authorized to post" }, 403);
        c.set("client", client);
        c.set("sender", client.name);
        c.set("sessionScope", scope);
        await next();
        return;
      }
    }
  }

  // Try observer session cookie
  const observerToken = getCookie(c, "observer_session");
  if (observerToken) {
    const obsSession = db.query(
      `SELECT os.*, o.username, o.status, o.can_post
       FROM observer_sessions os
       JOIN observers o ON o.id = os.observer_id
       WHERE os.token = ? AND o.status = 'active'`
    ).get(observerToken) as any;
    if (obsSession) {
      if (!obsSession.can_post) return c.json({ error: "Observer not authorized to post" }, 403);
      c.set("observer", obsSession);
      c.set("sender", obsSession.username);
      await next();
      return;
    }
  }

  logEvent("session.denied", { ip: getClientIP(c), reason: token ? "bad_bearer_or_expired" : (observerToken ? "bad_observer_session" : "no_bearer"), path: c.req.path });
  return c.json({ error: "Unauthorized" }, 401);
}

async function requireSessionOrObserver(c: Context, next: Next) {
  const token = c.req.header("Authorization")?.replace("Bearer ", "") ?? c.req.query("token");
  if (token) {
    // Check bot sessions
    const botSession = db.query(
      "SELECT * FROM sessions WHERE token = ? AND expires_at > ?"
    ).get(token, new Date().toISOString()) as any;
    if (botSession) {
      const scope = (botSession.scope ?? "full") as string;
      if (scope === "mcp" && !mcpScopeAllows(c.req.method, c.req.path)) {
        logEvent("session.denied", { ip: getClientIP(c), reason: "scope_denied", scope, path: c.req.path, method: c.req.method });
        return c.json({ error: "Token scope does not permit this endpoint" }, 403);
      }
      const client = db.query(
        "SELECT * FROM clients WHERE fingerprint = ? AND status = 'active'"
      ).get(botSession.fingerprint) as any;
      if (client) {
        db.run("UPDATE clients SET last_seen = ?, last_ip = ? WHERE fingerprint = ?",
          [new Date().toISOString(), getClientIP(c), botSession.fingerprint]);
        c.set("client", client);
        c.set("sessionScope", scope);
        await next();
        return;
      }
    }
    // Check observer sessions (token passed as query param for SSE)
    const obsSession = db.query(
      `SELECT os.*, o.username, o.status, o.can_post
       FROM observer_sessions os
       JOIN observers o ON o.id = os.observer_id
       WHERE os.token = ? AND o.status = 'active'`
    ).get(token) as any;
    if (obsSession) {
      db.run("UPDATE observers SET last_seen = ?, last_ip = ? WHERE id = ?",
        [new Date().toISOString(), getClientIP(c), obsSession.observer_id]);
      c.set("observer", obsSession);
      await next();
      return;
    }
  }

  // Also check observer cookie (for fetch requests from web UI)
  const cookieToken = getCookie(c, "observer_session");
  if (cookieToken) {
    const obsSession = db.query(
      `SELECT os.*, o.username, o.status, o.can_post
       FROM observer_sessions os
       JOIN observers o ON o.id = os.observer_id
       WHERE os.token = ? AND o.status = 'active'`
    ).get(cookieToken) as any;
    if (obsSession) {
      db.run("UPDATE observers SET last_seen = ?, last_ip = ? WHERE id = ?",
        [new Date().toISOString(), getClientIP(c), obsSession.observer_id]);
      c.set("observer", obsSession);
      await next();
      return;
    }
  }

  logEvent("session.denied", { ip: getClientIP(c), reason: (token || cookieToken) ? "bad_bearer_or_expired" : "no_bearer", path: c.req.path });
  return c.json({ error: "Unauthorized" }, 401);
}

async function requireObserver(c: Context, next: Next) {
  const token = getCookie(c, "observer_session");
  if (!token) return c.redirect("/watch/login");

  const session = db.query(
    `SELECT os.*, o.username, o.status, o.can_post
     FROM observer_sessions os
     JOIN observers o ON o.id = os.observer_id
     WHERE os.token = ?`
  ).get(token) as any;
  if (!session || session.status === "revoked") return c.redirect("/watch/login");

  db.run("UPDATE observers SET last_seen = ?, last_ip = ? WHERE id = ?",
    [new Date().toISOString(), getClientIP(c), session.observer_id]);

  c.set("observer", session);
  await next();
}

// --- Admin Auth Middleware ---
//
// Admin auth is now backed by the observers table with role='admin'. The
// session cookie is observer_session (set by /admin/login with a shorter
// ADMIN_SESSION_TTL_HOURS lifetime than /watch/login's 30-day default).
// Per fenbot's R2: re-query observers.role on every request so a demoted
// admin loses access immediately, no session invalidation needed.
// Stale legacy admin_session cookies log admin.session.legacy and redirect
// (response shape identical to no-session — no fingerprinting).
async function requireAdmin(c: Context, next: Next) {
  const token = getCookie(c, "observer_session");
  if (token) {
    const session = db.query(
      `SELECT os.observer_id, os.expires_at, o.username, o.role, o.status
       FROM observer_sessions os
       JOIN observers o ON o.id = os.observer_id
       WHERE os.token = ? AND (os.expires_at IS NULL OR os.expires_at > ?)`
    ).get(token, new Date().toISOString()) as any;
    if (session && session.role === "admin" && session.status === "active") {
      c.set("admin_observer_id", session.observer_id);
      c.set("admin_username", session.username);
      c.set("admin_session_token", token);
      await next();
      return;
    }
  }
  // Legacy admin_session cookie path — log and clear, then fall through to
  // standard "no session" redirect so response shape is indistinguishable.
  const legacy = getCookie(c, "admin_session");
  if (legacy) {
    logEvent("admin.session.legacy", { ip: getClientIP(c) });
    deleteCookie(c, "admin_session", { path: "/" });
  }
  return c.redirect("/admin/login");
}

// --- Registration ---

// POST /register — no auth required
app.post("/register", async (c) => {
  const body = await c.req.json<{ name: string; public_key: string }>();

  // Validate name
  if (!body.name || typeof body.name !== "string" || body.name.length > 64 || !/^[a-zA-Z0-9._-]+$/.test(body.name)) {
    return c.json({ error: "Invalid name: must be 1-64 chars, alphanumeric, hyphens, dots, underscores" }, 400);
  }

  // Validate key type
  if (!body.public_key || !body.public_key.startsWith("ssh-ed25519")) {
    return c.json({ error: "Only Ed25519 keys are supported (ssh-ed25519)" }, 400);
  }

  let fingerprint: string;
  try {
    fingerprint = computeFingerprint(body.public_key);
  } catch (err) {
    return c.json({ error: "Invalid public key format" }, 400);
  }

  // Check if fingerprint already exists
  const existing = db.query("SELECT status FROM clients WHERE fingerprint = ?").get(fingerprint) as any;
  if (existing) {
    if (existing.status === "active") return c.json({ error: "Already registered" }, 409);
    if (existing.status === "pending") return c.json({ status: "pending", fingerprint }, 200);
    if (existing.status === "revoked") {
      // Allow re-registration: reset to pending with new name
      db.run(
        "UPDATE clients SET name = ?, status = 'pending', approved_at = NULL, source_ip = ?, registered_at = ? WHERE fingerprint = ?",
        [body.name, getClientIP(c), new Date().toISOString(), fingerprint]
      );
      return c.json({ status: "pending", fingerprint, message: "Re-registration received. Await admin approval." }, 201);
    }
  }

  db.run(
    `INSERT INTO clients (name, public_key, fingerprint, source_ip, registered_at)
     VALUES (?, ?, ?, ?, ?)`,
    [body.name, body.public_key, fingerprint, getClientIP(c), new Date().toISOString()]
  );

  logEvent("client.pending", { fingerprint, username: body.name, ip: getClientIP(c) });
  return c.json({
    status: "pending",
    fingerprint,
    message: "Registration received. Await admin approval before authenticating.",
  }, 201);
});

// --- Challenge-Response Auth ---

// GET /auth/challenge?fingerprint=<hex> — no auth required
app.get("/auth/challenge", (c) => {
  const limited = checkAuthRateLimit(c);
  if (limited) return limited;
  const ip = getClientIP(c);
  const fingerprint = c.req.query("fingerprint");
  if (!fingerprint) { recordAuthFailure(c); return c.json({ error: "Missing fingerprint" }, 400); }

  const client = db.query("SELECT * FROM clients WHERE fingerprint = ?").get(fingerprint) as any;
  if (!client) { recordAuthFailure(c); return c.json({ error: "Client not found" }, 404); }
  if (client.status !== "active") { recordAuthFailure(c); return c.json({ error: "Client not approved" }, 403); }

  logEvent("auth.challenge.requested", { fingerprint, ip });
  const nonce = crypto.randomUUID().replace(/-/g, "") + crypto.randomUUID().replace(/-/g, "");
  const expiresAt = new Date(Date.now() + NONCE_TTL_SECONDS * 1000).toISOString();

  db.run(
    "INSERT INTO nonces (value, fingerprint, expires_at) VALUES (?, ?, ?)",
    [nonce, fingerprint, expiresAt]
  );

  return c.json({ nonce, expires_in: NONCE_TTL_SECONDS });
});

// POST /auth/token — no auth required
app.post("/auth/token", async (c) => {
  const limited = checkAuthRateLimit(c);
  if (limited) { logEvent("auth.token.denied", { fingerprint: "unknown", ip: getClientIP(c), reason: "rate_limit" }); return limited; }
  const ip = getClientIP(c);
  const parsed = await parseJsonBody<{ fingerprint: string; nonce: string; signature: string }>(c);
  if (!parsed.ok) { logEvent("auth.token.denied", { fingerprint: "unknown", ip, reason: "bad_request_body" }); return parsed.res; }
  const body = parsed.body;

  const client = db.query(
    "SELECT * FROM clients WHERE fingerprint = ? AND status = 'active'"
  ).get(body.fingerprint) as any;
  if (!client) { authAttemptsFailedTotal++; recordAuthFailure(c); logEvent("auth.token.denied", { fingerprint: body.fingerprint, ip, reason: "not_approved" }); return c.json({ error: "Client not approved" }, 403); }

  const nonce = db.query(
    "SELECT * FROM nonces WHERE value = ? AND fingerprint = ? AND used = 0 AND expires_at > ?"
  ).get(body.nonce, body.fingerprint, new Date().toISOString()) as any;
  if (!nonce) { authAttemptsFailedTotal++; recordAuthFailure(c); logEvent("auth.token.denied", { fingerprint: body.fingerprint, ip, reason: "bad_nonce" }); return c.json({ error: "Invalid or expired nonce" }, 401); }

  const valid = await verifySignature(client.public_key, body.nonce, body.signature);
  if (!valid) { authAttemptsFailedTotal++; recordAuthFailure(c); logEvent("auth.token.denied", { fingerprint: body.fingerprint, ip, reason: "bad_signature" }); return c.json({ error: "Signature verification failed" }, 401); }

  // Mark nonce as used
  db.run("UPDATE nonces SET used = 1 WHERE value = ?", [body.nonce]);

  // Create session. Optional ?scope=mcp narrows the token to the MCP endpoint
  // whitelist (see MCP_SCOPE_ALLOWED) and gets MCP_SESSION_TTL_HOURS lifetime
  // (default 720h = 30d) instead of the 24h full-scope default.
  const token = crypto.randomUUID().replace(/-/g, "") + crypto.randomUUID().replace(/-/g, "");
  const now = new Date();
  const scope = c.req.query("scope") === "mcp" ? "mcp" : "full";
  const ttlHours = scope === "mcp" ? MCP_SESSION_TTL_HOURS : SESSION_TTL_HOURS;
  const expiresAt = new Date(now.getTime() + ttlHours * 3600 * 1000);

  db.run(
    "INSERT INTO sessions (token, fingerprint, expires_at, created_at, scope) VALUES (?, ?, ?, ?, ?)",
    [token, body.fingerprint, expiresAt.toISOString(), now.toISOString(), scope]
  );

  const clientVersion = c.req.header("X-SideChat-Client-Version") ?? null;
  db.run("UPDATE clients SET last_seen = ?, last_ip = ?, last_known_version = COALESCE(?, last_known_version) WHERE fingerprint = ?",
    [now.toISOString(), getClientIP(c), clientVersion, body.fingerprint]);

  authAttemptsTotal++;
  logEvent("auth.token.issued", { fingerprint: body.fingerprint, username: client.name, ip, client_version: clientVersion, scope });
  return c.json({ token, expires_at: expiresAt.toISOString(), scope });
});

// --- Admin Pages ---

// GET /admin/login — admin login page
app.get("/admin/login", (c) => {
  const csrfToken = issueCsrfToken(c);
  return c.html(`<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<meta name="csrf" content="${csrfToken}">
<title>SideChat — Admin Login</title>
<link rel="icon" href="data:image/svg+xml,<svg xmlns='http://www.w3.org/2000/svg' viewBox='0 0 100 100'><g fill='rgb(126,231,135)'><ellipse cx='50' cy='15' rx='13' ry='20'/><ellipse cx='84' cy='40' rx='13' ry='20' transform='rotate(72 84 40)'/><ellipse cx='71' cy='82' rx='13' ry='20' transform='rotate(144 71 82)'/><ellipse cx='29' cy='82' rx='13' ry='20' transform='rotate(216 29 82)'/><ellipse cx='16' cy='40' rx='13' ry='20' transform='rotate(288 16 40)'/></g><circle cx='50' cy='50' r='26' fill='rgb(56,139,253)'/><path d='M34 45 h32 a3 3 0 0 1 3 3 v10 a3 3 0 0 1 -3 3 h-20 l-7 6 v-6 h-5 a3 3 0 0 1 -3 -3 v-10 a3 3 0 0 1 3 -3 z' fill='white'/></svg>">
<style>
  * { margin: 0; padding: 0; box-sizing: border-box; }
  body {
    background: #0d1117;
    color: #c9d1d9;
    font-family: 'SF Mono', 'Cascadia Code', 'Fira Code', 'Consolas', monospace;
    font-size: 14px;
    height: 100vh;
    display: flex;
    align-items: center;
    justify-content: center;
  }
  .login-card {
    border: 1px solid #21262d;
    border-radius: 8px;
    padding: 32px 40px;
    max-width: 360px;
    width: 100%;
  }
  .login-card h1 { font-size: 18px; color: #e6edf3; margin-bottom: 4px; font-weight: 600; }
  .login-card .subtitle { color: #484f58; font-size: 12px; margin-bottom: 24px; }
  .field { margin-bottom: 16px; }
  .field label { display: block; color: #8b949e; font-size: 12px; margin-bottom: 6px; text-transform: uppercase; letter-spacing: 0.5px; }
  .field input { width: 100%; padding: 8px 12px; background: #010409; border: 1px solid #30363d; border-radius: 6px; color: #c9d1d9; font-family: inherit; font-size: 14px; outline: none; }
  .field input:focus { border-color: #58a6ff; }
  button[type="submit"] { width: 100%; padding: 10px; background: #238636; border: 1px solid #2ea043; border-radius: 6px; color: #fff; font-family: inherit; font-size: 14px; font-weight: 600; cursor: pointer; margin-top: 8px; }
  button[type="submit"]:hover { background: #2ea043; }
  .error-msg { color: #f85149; font-size: 13px; margin-bottom: 12px; display: none; }
</style>
</head>
<body>
<div class="login-card">
  <h1>SideChat</h1>
  <div class="subtitle">Admin Console</div>
  <div class="error-msg" id="error"></div>
  <form id="login-form">
    <div class="field"><label>Username</label><input type="text" id="username" autocomplete="username" required /></div>
    <div class="field"><label>Password</label><input type="password" id="password" autocomplete="current-password" required /></div>
    <button type="submit">Sign In</button>
  </form>
</div>
<script nonce="${c.get("cspNonce")}">
(function() {
  var form = document.getElementById('login-form');
  var errEl = document.getElementById('error');
  form.addEventListener('submit', function(e) {
    e.preventDefault();
    errEl.style.display = 'none';
    var csrf = document.querySelector('meta[name="csrf"]').getAttribute('content');
    fetch('/admin/login', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'X-CSRF-Token': csrf },
      credentials: 'same-origin',
      body: JSON.stringify({ username: document.getElementById('username').value, password: document.getElementById('password').value })
    }).then(function(r) {
      if (!r.ok) return r.json().then(function(d) { throw new Error(d.error || 'Login failed'); });
      window.location.href = '/admin';
    }).catch(function(err) {
      errEl.textContent = err.message;
      errEl.style.display = 'block';
    });
  });
})();
</script>
</body>
</html>`);
});

// GET /admin — admin dashboard
app.get("/admin", requireAdmin, (c) => {
  return c.html(`<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>SideChat — Admin</title>
<link rel="icon" href="data:image/svg+xml,<svg xmlns='http://www.w3.org/2000/svg' viewBox='0 0 100 100'><g fill='rgb(126,231,135)'><ellipse cx='50' cy='15' rx='13' ry='20'/><ellipse cx='84' cy='40' rx='13' ry='20' transform='rotate(72 84 40)'/><ellipse cx='71' cy='82' rx='13' ry='20' transform='rotate(144 71 82)'/><ellipse cx='29' cy='82' rx='13' ry='20' transform='rotate(216 29 82)'/><ellipse cx='16' cy='40' rx='13' ry='20' transform='rotate(288 16 40)'/></g><circle cx='50' cy='50' r='26' fill='rgb(56,139,253)'/><path d='M34 45 h32 a3 3 0 0 1 3 3 v10 a3 3 0 0 1 -3 3 h-20 l-7 6 v-6 h-5 a3 3 0 0 1 -3 -3 v-10 a3 3 0 0 1 3 -3 z' fill='white'/></svg>">
<style>
  * { margin: 0; padding: 0; box-sizing: border-box; }
  body {
    background: #0d1117;
    color: #c9d1d9;
    font-family: 'SF Mono', 'Cascadia Code', 'Fira Code', 'Consolas', monospace;
    font-size: 14px;
  }
  #header {
    padding: 12px 16px;
    border-bottom: 1px solid #21262d;
    display: flex;
    justify-content: space-between;
    align-items: center;
  }
  #header h1 { font-size: 16px; font-weight: 600; color: #e6edf3; display: flex; align-items: baseline; gap: 8px; }
  #header h1 .version { font-size: 11px; font-weight: 400; color: #6e7681; letter-spacing: 0.3px; cursor: help; }
  #header .nav { display: flex; gap: 12px; align-items: center; }
  #header .nav a { color: #58a6ff; text-decoration: none; font-size: 13px; }
  #header .nav a:hover { text-decoration: underline; }
  .btn-logout { background: none; border: 1px solid #30363d; border-radius: 6px; color: #c9d1d9; padding: 4px 12px; font-family: inherit; font-size: 12px; cursor: pointer; }
  .btn-logout:hover { border-color: #8b949e; }
  .container { max-width: 960px; margin: 0 auto; padding: 24px 16px; }
  .section { margin-bottom: 32px; }
  .section h2 { font-size: 14px; font-weight: 600; color: #e6edf3; margin-bottom: 12px; text-transform: uppercase; letter-spacing: 0.5px; }
  .section h2 .count { color: #484f58; font-weight: 400; }
  table { width: 100%; border-collapse: collapse; }
  th { text-align: left; padding: 8px 12px; border-bottom: 1px solid #21262d; color: #484f58; font-size: 11px; text-transform: uppercase; letter-spacing: 0.5px; font-weight: 600; }
  td { padding: 8px 12px; border-bottom: 1px solid #161b22; font-size: 13px; vertical-align: middle; }
  tr:hover td { background: #161b22; }
  .fp { color: #8b949e; font-size: 12px; }
  .badge { display: inline-block; padding: 2px 8px; border-radius: 10px; font-size: 11px; font-weight: 600; }
  .badge.active { background: #0d4429; color: #3fb950; }
  .badge.pending { background: #3d2e00; color: #d29922; }
  .badge.revoked { background: #3d1a1a; color: #f85149; }
  .badge.role-admin { background: #1f2d4a; color: #79c0ff; }
  .badge.role-observer { background: #21262d; color: #8b949e; }
  .btn { padding: 4px 12px; border-radius: 6px; font-family: inherit; font-size: 12px; cursor: pointer; border: 1px solid; }
  .btn-approve { background: #238636; border-color: #2ea043; color: #fff; }
  .btn-approve:hover { background: #2ea043; }
  .btn-reject { background: none; border-color: #30363d; color: #c9d1d9; }
  .btn-reject:hover { border-color: #8b949e; }
  .btn-revoke { background: none; border-color: #da3633; color: #f85149; }
  .btn-revoke:hover { background: #3d1a1a; }
  .create-form { border: 1px solid #21262d; border-radius: 8px; padding: 16px; margin-bottom: 16px; display: flex; gap: 12px; align-items: flex-end; flex-wrap: wrap; }
  .create-form .field { display: flex; flex-direction: column; gap: 4px; }
  .create-form label { color: #8b949e; font-size: 11px; text-transform: uppercase; letter-spacing: 0.3px; }
  .create-form input { padding: 6px 10px; background: #010409; border: 1px solid #30363d; border-radius: 6px; color: #c9d1d9; font-family: inherit; font-size: 13px; outline: none; width: 160px; }
  .create-form input:focus, .create-form select:focus { border-color: #58a6ff; }
  .create-form select { padding: 6px 10px; background: #010409; border: 1px solid #30363d; border-radius: 6px; color: #c9d1d9; font-family: inherit; font-size: 13px; outline: none; }
  .btn-create { background: #238636; border: 1px solid #2ea043; border-radius: 6px; color: #fff; padding: 6px 16px; font-family: inherit; font-size: 13px; font-weight: 600; cursor: pointer; }
  .btn-create:hover { background: #2ea043; }
  .toast { position: fixed; bottom: 16px; right: 16px; background: #161b22; border: 1px solid #30363d; border-radius: 6px; padding: 10px 16px; font-size: 13px; display: none; z-index: 100; }
  .toast.error { border-color: #da3633; color: #f85149; }
  .toast.ok { border-color: #2ea043; color: #3fb950; }
  #og-mascot { position: fixed; bottom: 8px; right: 10px; font-size: 18px; opacity: 0.15; cursor: pointer; user-select: none; transition: opacity 0.3s; }
  #og-mascot:hover { opacity: 0.85; }
  .dim { color: #484f58; }
  .empty { color: #484f58; padding: 16px 12px; font-style: italic; }
  .install-cmd { background: #010409; border: 1px solid #21262d; border-radius: 6px; padding: 10px 14px; margin-bottom: 8px; display: flex; align-items: center; justify-content: space-between; gap: 12px; }
  .install-cmd code { color: #79c0ff; font-size: 13px; word-break: break-all; flex: 1; }
  .install-cmd .label { color: #484f58; font-size: 11px; text-transform: uppercase; letter-spacing: 0.3px; min-width: 70px; }
  .btn-copy { background: none; border: 1px solid #30363d; border-radius: 4px; color: #8b949e; padding: 3px 8px; font-family: inherit; font-size: 11px; cursor: pointer; white-space: nowrap; }
  .btn-copy:hover { border-color: #58a6ff; color: #58a6ff; }
</style>
</head>
<body>
<div id="header">
  <h1>SideChat Admin <span class="version" title="build ${SERVER_SHA}">v${SERVER_VERSION}</span></h1>
  <div class="nav">
    <a href="/">Chat</a>
    <button class="btn-logout">Logout</button>
  </div>
</div>
<div class="container">
  <div class="section" id="sec-pending"><h2>Pending Clients <span class="count" id="pending-count"></span></h2><div id="pending-body"></div></div>
  <div class="section" id="sec-active"><h2>Active Clients <span class="count" id="active-count"></span></h2><div id="active-body"></div></div>
  <div class="section" id="sec-observers">
    <h2>Observers <span class="count" id="obs-count"></span></h2>
    <div class="create-form" id="create-obs-form">
      <div class="field"><label>Username</label><input id="obs-user" type="text" /></div>
      <div class="field"><label>Password</label><input id="obs-pass" type="password" /></div>
      <div class="field"><label>Confirm</label><input id="obs-confirm" type="password" /></div>
      <div class="field"><label>Can Post</label><select id="obs-can-post"><option value="true" selected>Yes</option><option value="false">No</option></select></div>
      <button class="btn-create" id="obs-create-btn">Create Observer</button>
    </div>
    <div id="obs-body"></div>
  </div>
  <div class="section" id="sec-files">
    <h2>File Storage</h2>
    <div id="file-stats" class="empty">Loading...</div>
    <div class="create-form" id="file-settings-form">
      <div class="field"><label>Max File Size (MB)</label><input id="fs-max-file" type="number" min="1" style="width:100px" /></div>
      <div class="field"><label>Per-User Quota (MB)</label><input id="fs-max-user" type="number" min="1" style="width:100px" /></div>
      <div class="field"><label>Global Quota (MB)</label><input id="fs-max-total" type="number" min="1" style="width:100px" /></div>
      <button class="btn-create" id="fs-save-btn">Save</button>
    </div>
  </div>
  <div class="section" id="sec-install">
    <h2>Client Install</h2>
    <div id="install-body" class="empty">Loading...</div>
  </div>
</div>
<div class="toast" id="toast"></div>
<script nonce="${c.get("cspNonce")}">
(function() {
  var SERVER_VERSION_FOR_UI = '${SERVER_VERSION}';
  var SERVER_SHA_FOR_UI = '${SERVER_SHA}';
  function relTime(iso) {
    if (!iso) return '<span class="dim">never</span>';
    var d = new Date(iso);
    var diff = (Date.now() - d.getTime()) / 1000;
    if (diff < 60) return Math.floor(diff) + 's ago';
    if (diff < 3600) return Math.floor(diff / 60) + 'm ago';
    if (diff < 86400) return Math.floor(diff / 3600) + 'h ago';
    return Math.floor(diff / 86400) + 'd ago';
  }
  function esc(s) { var d = document.createElement('div'); d.textContent = s; return d.innerHTML; }
  function toast(msg, type) {
    var t = document.getElementById('toast');
    t.textContent = msg;
    t.className = 'toast ' + (type || 'ok');
    t.style.display = 'block';
    setTimeout(function() { t.style.display = 'none'; }, 3000);
  }
  function adminAction(url, cb) {
    fetch(url, { method: 'POST', credentials: 'same-origin' })
      .then(function(r) { if (r.redirected) { window.location.href = r.url; return; } return r.json(); })
      .then(function(d) { if (d) { toast(JSON.stringify(d)); if (cb) cb(); } })
      .catch(function(e) { toast(e.message, 'error'); });
  }

  function renderPending(clients) {
    document.getElementById('pending-count').textContent = '(' + clients.length + ')';
    if (!clients.length) { document.getElementById('pending-body').innerHTML = '<div class="empty">No pending clients</div>'; return; }
    var html = '<table><tr><th>Name</th><th>Fingerprint</th><th>Source IP</th><th>Registered</th><th>Actions</th></tr>';
    clients.forEach(function(c) {
      html += '<tr><td>' + esc(c.name) + '</td><td class="fp">' + esc(c.fingerprint.slice(0,16)) + '&hellip;</td><td>' + esc(c.source_ip || '') + '</td><td>' + relTime(c.registered_at) + '</td>';
      html += '<td><button class="btn btn-approve" data-admin-action="approve" data-fingerprint="' + esc(c.fingerprint) + '">Approve</button> ';
      html += '<button class="btn btn-reject" data-admin-action="reject" data-fingerprint="' + esc(c.fingerprint) + '">Reject</button></td></tr>';
    });
    html += '</table>';
    document.getElementById('pending-body').innerHTML = html;
  }

  function renderActive(clients) {
    document.getElementById('active-count').textContent = '(' + clients.length + ')';
    if (!clients.length) { document.getElementById('active-body').innerHTML = '<div class="empty">No active clients</div>'; return; }
    var html = '<table><tr><th>Name</th><th>Fingerprint</th><th>Can Post</th><th>Last Seen</th><th>Last IP</th><th>Webhook</th><th>Version</th><th>Actions</th></tr>';
    clients.forEach(function(c) {
      var ver = c.last_known_version || '';
      var verBadge = '';
      if (ver) {
        var match = SERVER_VERSION_FOR_UI && ver === SERVER_VERSION_FOR_UI;
        var tip = 'client: ' + ver + ' / server: ' + SERVER_VERSION_FOR_UI + ' (' + SERVER_SHA_FOR_UI + ')';
        verBadge = '<span title="' + esc(tip) + '" style="color:' + (match ? '#3fb950' : '#f85149') + ';font-size:11px;">' + (match ? '\u25cf ' : '\u25cb ') + esc(ver) + '</span>';
      } else {
        verBadge = '<span style="color:#484f58;font-style:italic;font-size:11px;">unknown</span>';
      }
      html += '<tr><td>' + esc(c.name) + '</td><td class="fp">' + esc(c.fingerprint.slice(0,16)) + '&hellip;</td><td>' + (c.can_post ? 'yes' : 'no') + '</td><td>' + relTime(c.last_seen) + '</td><td>' + esc(c.last_ip || '') + '</td>';
      html += '<td>' + (c.webhook_url ? '<span class="fp" title="' + esc(c.webhook_url) + '">webhook</span> ' : '') + '</td>';
      html += '<td>' + verBadge + '</td>';
      html += '<td><button class="btn btn-revoke" data-admin-action="revoke" data-fingerprint="' + esc(c.fingerprint) + '">Revoke</button>';
      if (c.webhook_url) html += ' <button class="btn" data-admin-action="clear-webhook" data-fingerprint="' + esc(c.fingerprint) + '">Clear Webhook</button>';
      html += '</td></tr>';
    });
    html += '</table>';
    document.getElementById('active-body').innerHTML = html;
  }

  function renderObservers(observers) {
    document.getElementById('obs-count').textContent = '(' + observers.length + ')';
    if (!observers.length) { document.getElementById('obs-body').innerHTML = '<div class="empty">No observers</div>'; return; }
    var html = '<table><tr><th>Username</th><th>Role</th><th>Status</th><th>Can Post</th><th>Last Seen</th><th>Last IP</th><th>Actions</th></tr>';
    observers.forEach(function(o) {
      var statusBadge = '<span class="badge ' + o.status + '">' + o.status + '</span>';
      var role = o.role || 'observer';
      var roleBadge = '<span class="badge ' + (role === 'admin' ? 'role-admin' : 'role-observer') + '">' + role + '</span>';
      html += '<tr><td>' + esc(o.username) + '</td><td>' + roleBadge + '</td><td>' + statusBadge + '</td><td>' + (o.can_post ? 'yes' : 'no') + '</td><td>' + relTime(o.last_seen) + '</td><td>' + esc(o.last_ip || '') + '</td>';
      if (o.status === 'active') {
        var actions = '';
        if (role === 'admin') {
          actions += '<button class="btn" data-admin-action="observer-demote" data-observer-id="' + esc(String(o.id)) + '">Demote</button> ';
        } else {
          actions += '<button class="btn" data-admin-action="observer-promote" data-observer-id="' + esc(String(o.id)) + '">Promote</button> ';
        }
        actions += '<button class="btn btn-revoke" data-admin-action="observer-revoke" data-observer-id="' + esc(String(o.id)) + '">Revoke</button>';
        html += '<td>' + actions + '</td>';
      } else {
        html += '<td></td>';
      }
      html += '</tr>';
    });
    html += '</table>';
    document.getElementById('obs-body').innerHTML = html;
  }

  function copyCmd(btn) {
    var code = btn.parentNode.querySelector('code');
    navigator.clipboard.writeText(code.textContent);
    btn.textContent = 'Copied';
    setTimeout(function() { btn.textContent = 'Copy'; }, 1500);
  }
  window.copyCmd = copyCmd;

  function renderInstall(urls) {
    var el = document.getElementById('install-body');
    if (!urls.length) { el.innerHTML = '<div class="empty">No network interfaces detected</div>'; return; }
    var html = '';
    urls.forEach(function(url) {
      var isTS = url.indexOf('.ts.net') !== -1;
      var label = isTS ? 'Tailscale' : url.replace('https://', '').replace('http://', '').split(':')[0];
      var cmd = 'curl -fsSL ' + url + '/install/client.sh | bash -s -- ' + url;
      html += '<div class="install-cmd"><span class="label">' + esc(label) + '</span><code>' + esc(cmd) + '</code><button class="btn-copy">Copy</button></div>';
    });
    el.innerHTML = html;
  }

  function fmtBytes(n) {
    if (n < 1024) return n + ' B';
    if (n < 1048576) return (n / 1024).toFixed(1) + ' KB';
    if (n < 1073741824) return (n / 1048576).toFixed(1) + ' MB';
    return (n / 1073741824).toFixed(1) + ' GB';
  }

  function renderFileStorage(fs) {
    var s = fs.settings;
    var pct = s.max_total_storage > 0 ? ((fs.used / s.max_total_storage) * 100).toFixed(1) : 0;
    document.getElementById('file-stats').innerHTML =
      '<div style="margin-bottom:12px">' + fmtBytes(fs.used) + ' used / ' + fmtBytes(s.max_total_storage) + ' global (' + pct + '%) — ' + fs.fileCount + ' file(s)</div>';
    document.getElementById('fs-max-file').value = Math.round(s.max_file_size / 1048576);
    document.getElementById('fs-max-user').value = Math.round(s.max_user_storage / 1048576);
    document.getElementById('fs-max-total').value = Math.round(s.max_total_storage / 1048576);
  }

  function refresh() {
    fetch('/admin/data', { credentials: 'same-origin' })
      .then(function(r) {
        if (r.redirected) { window.location.href = r.url; return null; }
        if (!r.ok) { window.location.href = '/admin/login'; return null; }
        return r.json();
      })
      .then(function(data) {
        if (!data) return;
        renderPending(data.clients.pending);
        renderActive(data.clients.active);
        renderObservers(data.observers);
        renderInstall(data.installURLs || []);
        if (data.fileStorage) renderFileStorage(data.fileStorage);
      })
      .catch(function(e) { toast(e.message, 'error'); });
  }
  // Delegated click handler for dynamically generated buttons (CSP-friendly:
  // no inline onclick handlers needed). Buttons declare intent via data-*.
  document.addEventListener('click', function(e) {
    var t = e.target;
    if (!t || t.nodeName !== 'BUTTON') return;
    var action = t.getAttribute('data-admin-action');
    if (action) {
      var fp = t.getAttribute('data-fingerprint');
      var oid = t.getAttribute('data-observer-id');
      if ((action === 'observer-revoke' || action === 'observer-promote' || action === 'observer-demote') && oid) {
        var verb = action.split('-')[1];  // revoke | promote | demote
        adminAction('/admin/observers/' + encodeURIComponent(oid) + '/' + verb, refresh);
      } else if (fp) {
        adminAction('/admin/clients/' + encodeURIComponent(fp) + '/' + action, refresh);
      }
      return;
    }
    if (t.classList.contains('btn-copy')) { copyCmd(t); return; }
    if (t.classList.contains('btn-logout')) {
      fetch('/admin/logout', { method: 'POST', redirect: 'follow' })
        .then(function(r) { window.location.href = r.redirected ? r.url : '/admin/login'; });
      return;
    }
  });

  document.getElementById('obs-create-btn').addEventListener('click', function() {
    var user = document.getElementById('obs-user').value.trim();
    var pass = document.getElementById('obs-pass').value;
    var confirm = document.getElementById('obs-confirm').value;
    var canPost = document.getElementById('obs-can-post').value === 'true';
    if (!user || !pass) { toast('Username and password required', 'error'); return; }
    fetch('/admin/observers', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      credentials: 'same-origin',
      body: JSON.stringify({ username: user, password: pass, confirm_password: confirm, can_post: canPost })
    })
    .then(function(r) { return r.json().then(function(d) { return { ok: r.ok, data: d }; }); })
    .then(function(res) {
      if (!res.ok) { toast(res.data.error || 'Failed', 'error'); return; }
      toast('Observer "' + res.data.username + '" created');
      document.getElementById('obs-user').value = '';
      document.getElementById('obs-pass').value = '';
      document.getElementById('obs-confirm').value = '';
      refresh();
    })
    .catch(function(e) { toast(e.message, 'error'); });
  });

  document.getElementById('fs-save-btn').addEventListener('click', function() {
    var maxFile = parseInt(document.getElementById('fs-max-file').value) * 1048576;
    var maxUser = parseInt(document.getElementById('fs-max-user').value) * 1048576;
    var maxTotal = parseInt(document.getElementById('fs-max-total').value) * 1048576;
    if (!maxFile || !maxUser || !maxTotal) { toast('All values must be positive numbers', 'error'); return; }
    fetch('/admin/settings/files', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      credentials: 'same-origin',
      body: JSON.stringify({ max_file_size: maxFile, max_user_storage: maxUser, max_total_storage: maxTotal })
    })
    .then(function(r) { return r.json(); })
    .then(function(d) { toast('File settings saved'); refresh(); })
    .catch(function(e) { toast(e.message, 'error'); });
  });

  refresh();
  setInterval(refresh, 10000);
})();
</script>
<div id="og-mascot" title="The true north star of the project. Everything else was just scaffolding to deliver that favicon. (click to toggle favicon)">&#x1F33D;&#x1F4A9;</div>
<script nonce="${c.get("cspNonce")}">
(function(){
  var mascot = document.getElementById('og-mascot');
  if (!mascot) return;
  var flowerLink = document.querySelector('link[rel="icon"]');
  if (!flowerLink) return;
  var flower = flowerLink.getAttribute('href');
  var corn = "data:image/svg+xml," + encodeURIComponent(
    "<svg xmlns='http://www.w3.org/2000/svg' viewBox='0 0 100 100'>" +
    "<text y='90' font-size='90'>&#x1F4A9;</text>" +
    "<text y='50' x='30' font-size='25'>&#x1F33D;</text>" +
    "<text y='75' x='15' font-size='20'>&#x1F33D;</text>" +
    "<text y='65' x='50' font-size='22'>&#x1F33D;</text></svg>"
  );
  var showingCorn = false;
  function setFav(href) {
    var existing = document.querySelectorAll('link[rel="icon"], link[rel="shortcut icon"]');
    for (var i = 0; i < existing.length; i++) existing[i].remove();
    var link = document.createElement('link');
    link.rel = 'icon';
    link.type = 'image/svg+xml';
    link.href = href;
    document.head.appendChild(link);
  }
  mascot.addEventListener('click', function() {
    showingCorn = !showingCorn;
    setFav(showingCorn ? corn : flower);
  });
})();
</script>
</body>
</html>`);
});

// --- Admin Login/Logout ---

// POST /admin/login — no auth required
app.post("/admin/login", async (c) => {
  if (!verifyCsrfToken(c)) {
    logEvent("admin.login.fail", { ip: getClientIP(c), reason: "csrf_invalid" });
    return c.json({ error: "CSRF verification failed" }, 403);
  }
  const limited = checkAuthRateLimit(c);
  if (limited) { logEvent("admin.login.fail", { ip: getClientIP(c), reason: "rate_limit" }); return limited; }
  const ip = getClientIP(c);
  const parsed = await parseJsonBody<{ username: string; password: string }>(c);
  if (!parsed.ok) { logEvent("admin.login.fail", { ip, reason: "bad_request_body" }); return parsed.res; }
  const body = parsed.body;

  // Auth backed by observers table with role='admin' (env-bootstrapped admin
  // is now just an observer row — see bootstrap block near top of file).
  const observer = db.query(
    "SELECT * FROM observers WHERE username = ?"
  ).get(body.username) as any;
  if (!observer || observer.status !== "active" || observer.role !== "admin") {
    recordAuthFailure(c);
    logEvent("admin.login.fail", {
      ip,
      reason: !observer ? "no_such_user" : observer.status !== "active" ? "inactive" : "not_admin",
      username_attempted: body.username,
    });
    await Bun.sleep(500);
    return c.json({ error: "Invalid credentials" }, 401);
  }

  const valid = await Bun.password.verify(body.password, observer.password_hash);
  if (!valid) {
    recordAuthFailure(c);
    logEvent("admin.login.fail", { ip, reason: "bad_password", username_attempted: body.username });
    await Bun.sleep(500);
    return c.json({ error: "Invalid credentials" }, 401);
  }

  const token = crypto.randomUUID().replace(/-/g, "") + crypto.randomUUID().replace(/-/g, "");
  const now = new Date();
  const expires = new Date(now.getTime() + ADMIN_SESSION_TTL_HOURS * 3600 * 1000);
  db.run(
    "INSERT INTO observer_sessions (token, observer_id, created_at, expires_at) VALUES (?, ?, ?, ?)",
    [token, observer.id, now.toISOString(), expires.toISOString()]
  );
  db.run("UPDATE observers SET last_seen = ?, last_ip = ? WHERE id = ?", [now.toISOString(), ip, observer.id]);

  setCookie(c, "observer_session", token, {
    httpOnly: true,
    secure: isRequestSecure(c),
    sameSite: "Strict",
    path: "/",
  });

  logEvent("admin.login.ok", { ip, observer_id: observer.id, username: observer.username, admin_session_id: adminSessionIdShort(token) });
  return c.json({ ok: true });
});

// POST /admin/logout — admin auth required
app.post("/admin/logout", requireAdmin, async (c) => {
  const token = getCookie(c, "observer_session");
  if (token) db.run("DELETE FROM observer_sessions WHERE token = ?", [token]);
  deleteCookie(c, "observer_session", { path: "/" });
  // Also clear any stale legacy admin_session cookie (defense in depth).
  deleteCookie(c, "admin_session", { path: "/" });
  logEvent("admin.logout", { ip: getClientIP(c), observer_id: c.get("admin_observer_id"), username: c.get("admin_username") });
  return c.redirect("/admin/login");
});

// --- Admin API Routes ---

import { networkInterfaces } from "os";
import { execSync } from "child_process";

function getInstallURLs(): string[] {
  // Containerized deploys should set PUBLIC_URL — network discovery inside a
  // Docker container only sees the bridge network and produces unreachable
  // URLs. When PUBLIC_URL is set we trust it and skip discovery entirely.
  const publicUrl = Bun.env.PUBLIC_URL?.trim();
  if (publicUrl) return [publicUrl.replace(/\/+$/, "")];

  const port = Bun.env.PORT ?? "3000";
  const urls: string[] = [];

  // Check for Tailscale hostname (bare-metal dev only; the CLI isn't present
  // in our prod image and this silently fails there)
  try {
    const tsStatus = execSync("tailscale status --json 2>/dev/null", { timeout: 3000 });
    const ts = JSON.parse(tsStatus.toString());
    if (ts.Self?.DNSName) {
      const hostname = ts.Self.DNSName.replace(/\.$/, "");
      urls.push(`https://${hostname}`);
    }
  } catch {}

  // Network adapter IPs
  const ifaces = networkInterfaces();
  for (const [name, addrs] of Object.entries(ifaces)) {
    if (!addrs) continue;
    for (const addr of addrs) {
      if (addr.internal) continue;
      if (addr.family === "IPv4") {
        urls.push(`http://${addr.address}:${port}`);
      }
    }
  }

  return urls;
}

// GET /admin/data — admin auth required
app.get("/admin/data", requireAdmin, async (c) => {
  const CLIENT_COLS = "id, name, fingerprint, status, can_post, source_ip, registered_at, approved_at, last_seen, last_ip, webhook_url, last_known_version";
  const pending = db.query(`SELECT ${CLIENT_COLS} FROM clients WHERE status = 'pending' ORDER BY registered_at DESC`).all();
  const active = db.query(`SELECT ${CLIENT_COLS} FROM clients WHERE status = 'active' ORDER BY last_seen DESC`).all();
  const revoked = db.query(`SELECT ${CLIENT_COLS} FROM clients WHERE status = 'revoked'`).all();
  const observersList = db.query("SELECT id, username, status, can_post, role, created_at, last_seen, last_ip FROM observers ORDER BY created_at DESC").all();
  const installURLs = getInstallURLs();

  const fileStorageUsed = getTotalFileStorage();
  const fileCount = (db.query("SELECT COUNT(*) as count FROM files").get() as any).count;
  const fileLimits = getFileSettings();

  return c.json({
    clients: { pending, active, revoked },
    observers: observersList,
    installURLs,
    fileStorage: {
      used: fileStorageUsed,
      fileCount,
      settings: fileLimits,
    },
  });
});

// POST /admin/clients/:fingerprint/approve
app.post("/admin/clients/:fingerprint/approve", requireAdmin, async (c) => {
  const fp = c.req.param("fingerprint");
  const row = db.query("SELECT name FROM clients WHERE fingerprint = ?").get(fp) as any;
  db.run(
    "UPDATE clients SET status = 'active', approved_at = ? WHERE fingerprint = ? AND status = 'pending'",
    [new Date().toISOString(), fp]
  );
  logEvent("client.approved", { fingerprint: fp, username: row?.name, admin_session_id: adminSessionIdShort(c.get("admin_session_token") as string) });
  return c.json({ status: "approved" });
});

// POST /admin/clients/:fingerprint/reject
app.post("/admin/clients/:fingerprint/reject", requireAdmin, async (c) => {
  const fp = c.req.param("fingerprint");
  db.run("DELETE FROM clients WHERE fingerprint = ? AND status = 'pending'", [fp]);
  logEvent("client.rejected", { fingerprint: fp, admin_session_id: adminSessionIdShort(c.get("admin_session_token") as string) });
  return c.json({ status: "rejected" });
});

// POST /admin/clients/:fingerprint/revoke
app.post("/admin/clients/:fingerprint/revoke", requireAdmin, async (c) => {
  const fp = c.req.param("fingerprint");
  const row = db.query("SELECT name FROM clients WHERE fingerprint = ?").get(fp) as any;
  db.run("UPDATE clients SET status = 'revoked' WHERE fingerprint = ?", [fp]);
  db.run("DELETE FROM sessions WHERE fingerprint = ?", [fp]);
  logEvent("client.revoked", { fingerprint: fp, username: row?.name, admin_session_id: adminSessionIdShort(c.get("admin_session_token") as string) });
  return c.json({ status: "revoked" });
});

// POST /admin/clients/:fingerprint/clear-webhook
app.post("/admin/clients/:fingerprint/clear-webhook", requireAdmin, async (c) => {
  const fp = c.req.param("fingerprint");
  db.run("UPDATE clients SET webhook_url = NULL, webhook_secret = NULL WHERE fingerprint = ?", [fp]);
  logEvent("webhook.cleared", { fingerprint: fp, admin_session_id: adminSessionIdShort(c.get("admin_session_token") as string) });
  return c.json({ status: "webhook_cleared" });
});

// POST /admin/observers — create observer
app.post("/admin/observers", requireAdmin, async (c) => {
  const body = await c.req.json<{ username: string; password: string; confirm_password: string; can_post?: boolean }>();

  if (!body.username || typeof body.username !== "string" || body.username.length > 64 || !/^[a-zA-Z0-9_-]+$/.test(body.username)) {
    return c.json({ error: "Invalid username: must be 1-64 chars, alphanumeric, hyphens, underscores" }, 400);
  }
  if (body.password !== body.confirm_password) {
    return c.json({ error: "Passwords do not match" }, 400);
  }
  if (!body.password || body.password.length < 8) {
    return c.json({ error: "Password must be at least 8 characters" }, 400);
  }

  const existing = db.query("SELECT id, status FROM observers WHERE username = ?").get(body.username) as any;
  if (existing && existing.status === "active") return c.json({ error: "Username already exists" }, 409);

  const passwordHash = await Bun.password.hash(body.password, { algorithm: "bcrypt" });
  const canPost = body.can_post !== false ? 1 : 0;

  const adminSid = adminSessionIdShort(c.get("admin_session_token") as string);
  if (existing) {
    // Re-activate revoked observer with new password
    db.run(
      "UPDATE observers SET password_hash = ?, can_post = ?, status = 'active', last_seen = NULL, last_ip = NULL WHERE id = ?",
      [passwordHash, canPost, existing.id]
    );
    logEvent("observer.created", { username: body.username, can_post: canPost === 1, reactivated: true, admin_session_id: adminSid });
    return c.json({ id: existing.id, username: body.username, can_post: canPost === 1 }, 201);
  }

  const result = db.run(
    "INSERT INTO observers (username, password_hash, can_post, created_at) VALUES (?, ?, ?, ?)",
    [body.username, passwordHash, canPost, new Date().toISOString()]
  );

  logEvent("observer.created", { username: body.username, can_post: canPost === 1, admin_session_id: adminSid });
  return c.json({ id: Number(result.lastInsertRowid), username: body.username, can_post: canPost === 1 }, 201);
});

// POST /admin/observers/:id/revoke
app.post("/admin/observers/:id/revoke", requireAdmin, async (c) => {
  const id = parseInt(c.req.param("id"), 10);
  if (!Number.isFinite(id)) return c.json({ error: "Invalid id" }, 400);
  const ip = getClientIP(c);
  const actorId = c.get("admin_observer_id");
  const actorUsername = c.get("admin_username");
  const target = db.query("SELECT id, username, role, status FROM observers WHERE id = ?").get(id) as any;
  if (!target) {
    logEvent("observer.revoke.fail", { actor_observer_id: actorId, target_id: id, ip, reason: "target_not_found" });
    return c.json({ error: "Observer not found" }, 404);
  }
  // Atomic last-admin guard: refuse to revoke if target is admin AND would
  // leave fewer than one remaining admin. Single conditional UPDATE so
  // concurrent revokes can't both pass the count check.
  const result = db.run(
    `UPDATE observers SET status = 'revoked'
     WHERE id = ? AND status = 'active'
       AND (role <> 'admin' OR (SELECT COUNT(*) FROM observers WHERE role = 'admin' AND status = 'active') > 1)`,
    [id]
  );
  if (result.changes === 0) {
    if (target.role === "admin") {
      logEvent("observer.revoke.fail", { actor_observer_id: actorId, target_id: id, target_username: target.username, ip, reason: "last_admin" });
      return c.json({ error: "Cannot revoke the last admin" }, 409);
    }
    // Already revoked / inactive — idempotent success
    return c.json({ status: "revoked" });
  }
  db.run("DELETE FROM observer_sessions WHERE observer_id = ?", [id]);
  logEvent("observer.revoke.ok", {
    actor_observer_id: actorId,
    actor_username: actorUsername,
    target_id: target.id,
    target_username: target.username,
    role_before: target.role,
    ip,
  });
  return c.json({ status: "revoked" });
});

// POST /admin/observers/:id/promote — make observer an admin
app.post("/admin/observers/:id/promote", requireAdmin, async (c) => {
  const id = parseInt(c.req.param("id"), 10);
  if (!Number.isFinite(id)) return c.json({ error: "Invalid id" }, 400);
  const ip = getClientIP(c);
  const actorId = c.get("admin_observer_id");
  const actorUsername = c.get("admin_username");
  const target = db.query("SELECT id, username, role, status FROM observers WHERE id = ?").get(id) as any;
  if (!target) {
    logEvent("observer.promote.fail", { actor_observer_id: actorId, target_id: id, ip, reason: "target_not_found" });
    return c.json({ error: "Observer not found" }, 404);
  }
  if (target.status !== "active") {
    logEvent("observer.promote.fail", { actor_observer_id: actorId, target_id: id, target_username: target.username, ip, reason: "not_active" });
    return c.json({ error: "Cannot promote a revoked observer" }, 409);
  }
  if (target.role === "admin") {
    return c.json({ ok: true, role: "admin", message: "Already admin" });
  }
  db.run("UPDATE observers SET role = 'admin' WHERE id = ?", [id]);
  logEvent("observer.promote.ok", {
    actor_observer_id: actorId,
    actor_username: actorUsername,
    target_id: target.id,
    target_username: target.username,
    role_before: "observer",
    role_after: "admin",
    ip,
  });
  return c.json({ ok: true, role: "admin" });
});

// POST /admin/observers/:id/demote — strip admin role
app.post("/admin/observers/:id/demote", requireAdmin, async (c) => {
  const id = parseInt(c.req.param("id"), 10);
  if (!Number.isFinite(id)) return c.json({ error: "Invalid id" }, 400);
  const ip = getClientIP(c);
  const actorId = c.get("admin_observer_id");
  const actorUsername = c.get("admin_username");
  const target = db.query("SELECT id, username, role FROM observers WHERE id = ?").get(id) as any;
  if (!target) {
    logEvent("observer.demote.fail", { actor_observer_id: actorId, target_id: id, ip, reason: "target_not_found" });
    return c.json({ error: "Observer not found" }, 404);
  }
  if (target.role !== "admin") {
    return c.json({ ok: true, role: "observer", message: "Already observer" });
  }
  // Atomic last-admin guard — single conditional UPDATE.
  const result = db.run(
    `UPDATE observers SET role = 'observer'
     WHERE id = ? AND role = 'admin'
       AND (SELECT COUNT(*) FROM observers WHERE role = 'admin' AND status = 'active') > 1`,
    [id]
  );
  if (result.changes === 0) {
    logEvent("observer.demote.fail", { actor_observer_id: actorId, target_id: id, target_username: target.username, ip, reason: "last_admin" });
    return c.json({ error: "Cannot demote the last admin" }, 409);
  }
  logEvent("observer.demote.ok", {
    actor_observer_id: actorId,
    actor_username: actorUsername,
    target_id: target.id,
    target_username: target.username,
    role_before: "admin",
    role_after: "observer",
    ip,
  });
  return c.json({ ok: true, role: "observer" });
});

// POST /admin/settings/files — update file transfer limits
app.post("/admin/settings/files", requireAdmin, async (c) => {
  const body = await c.req.json<{ max_file_size?: number; max_user_storage?: number; max_total_storage?: number }>();
  const adminSid = adminSessionIdShort(c.get("admin_session_token") as string);
  const updated: string[] = [];
  if (body.max_file_size != null && body.max_file_size > 0) {
    setSetting("max_file_size", body.max_file_size);
    updated.push("max_file_size");
    logEvent("settings.updated", { key: "max_file_size", new_value_summary: body.max_file_size, admin_session_id: adminSid });
  }
  if (body.max_user_storage != null && body.max_user_storage > 0) {
    setSetting("max_user_storage", body.max_user_storage);
    updated.push("max_user_storage");
    logEvent("settings.updated", { key: "max_user_storage", new_value_summary: body.max_user_storage, admin_session_id: adminSid });
  }
  if (body.max_total_storage != null && body.max_total_storage > 0) {
    setSetting("max_total_storage", body.max_total_storage);
    updated.push("max_total_storage");
    logEvent("settings.updated", { key: "max_total_storage", new_value_summary: body.max_total_storage, admin_session_id: adminSid });
  }
  return c.json({ updated, settings: getFileSettings() });
});

// GET /messages/:id/replies — return child messages threaded to this id.
// Used by the web UI to expand a "↳ N replies" badge on a parent into
// its inline thread. Ascending by id (oldest reply first).
app.get("/messages/:id/replies", requireSessionOrObserver, (c) => {
  const id = parseInt(c.req.param("id"), 10);
  if (isNaN(id)) return c.json({ error: "Invalid message ID" }, 400);
  const rows = db
    .query(
      "SELECT id, timestamp, sender, content, mentions, reply_to_id FROM messages WHERE reply_to_id = ? ORDER BY id"
    )
    .all(id) as MessageRow[];
  return c.json({ parent_id: id, messages: withReceipts(dbRowsToMessages(rows)), count: rows.length });
});

// DELETE /admin/messages — bulk-delete messages by id. Admin-only.
// Body: { ids: number[] } (1..100 positive integers).
// Nulls reply_to_id on children + message_id on files before delete so
// orphaned references don't show stale chips or dangling links.
// Receipts: foreign_keys is off so ON DELETE CASCADE is a no-op — we
// explicitly DELETE from message_receipts first.
// Broadcasts "deleted" SSE event with the ids actually removed so
// connected clients can drop the rendered rows.
app.delete("/admin/messages", requireAdmin, async (c) => {
  const body = await c.req.json<{ ids?: number[] }>().catch(() => ({} as any));
  const ids = body.ids;
  if (!Array.isArray(ids) || ids.length === 0) {
    return c.json({ error: "ids must be a non-empty array of positive integers" }, 400);
  }
  if (ids.length > 100) {
    return c.json({ error: "ids may not exceed 100 per request" }, 400);
  }
  if (!ids.every((n) => Number.isInteger(n) && n > 0)) {
    return c.json({ error: "ids must all be positive integers" }, 400);
  }
  const placeholders = ids.map(() => "?").join(",");
  const existing = (db
    .query(`SELECT id FROM messages WHERE id IN (${placeholders})`)
    .all(...ids) as Array<{ id: number }>).map((r) => r.id);
  if (existing.length === 0) {
    return c.json({ deleted: 0, ids: [] });
  }
  const deletedIds = existing;
  const delPlaceholders = deletedIds.map(() => "?").join(",");
  const tx = db.transaction(() => {
    db.run(`UPDATE messages SET reply_to_id = NULL WHERE reply_to_id IN (${delPlaceholders})`, deletedIds);
    db.run(`UPDATE files SET message_id = NULL WHERE message_id IN (${delPlaceholders})`, deletedIds);
    db.run(`DELETE FROM message_receipts WHERE message_id IN (${delPlaceholders})`, deletedIds);
    db.run(`DELETE FROM messages WHERE id IN (${delPlaceholders})`, deletedIds);
  });
  tx();
  const adminSid = adminSessionIdShort(c.get("admin_session_token") as string);
  logEvent("admin.messages.bulk_delete", {
    admin_session_id: adminSid,
    count: deletedIds.length,
    ids: deletedIds,
  });
  broadcastEvent("deleted", { ids: deletedIds });
  return c.json({ deleted: deletedIds.length, ids: deletedIds });
});

// GET /users — session or observer auth required
app.get("/users", requireSessionOrObserver, (c) => {
  const botNames = (db.query("SELECT name FROM clients WHERE status = 'active'").all() as any[]).map(r => r.name);
  const observerNames = (db.query("SELECT username FROM observers WHERE status = 'active'").all() as any[]).map(r => r.username);
  return c.json({ users: [...botNames, ...observerNames, ADMIN_USER] });
});

// --- Static assets (vendored JS libraries served from /static/) ---

// Allowlist of vendored static files. Prevents path traversal and keeps the
// attack surface tiny — any unknown filename 404s immediately.
const STATIC_ASSETS: Record<string, string> = {
  "marked.min.js": "application/javascript; charset=utf-8",
  "dompurify.min.js": "application/javascript; charset=utf-8",
};

app.get("/static/:filename", async (c) => {
  const filename = c.req.param("filename");
  const mime = STATIC_ASSETS[filename];
  if (!mime) return c.json({ error: "Not found" }, 404);
  const file = Bun.file(`${import.meta.dir}/static/${filename}`);
  if (!(await file.exists())) return c.json({ error: "Not found" }, 404);
  return new Response(file, {
    headers: {
      "Content-Type": mime,
      "Cache-Control": "public, max-age=86400",
      "X-Content-Type-Options": "nosniff",
    },
  });
});

// --- File Transfer ---

// Safe MIME types served back verbatim on download. Everything else gets
// forced to application/octet-stream so browsers won't auto-render an
// attacker-chosen Content-Type (e.g. text/html with inline script).
const ALLOWED_DOWNLOAD_MIME = new Set([
  "image/png", "image/jpeg", "image/gif", "image/webp",
  "application/pdf",
  "text/plain", "text/csv", "text/markdown",
  "application/json", "application/zip", "application/gzip", "application/x-tar",
  "video/mp4", "video/webm",
  "audio/mpeg", "audio/ogg", "audio/wav",
]);

// POST /files/upload — upload a file (multipart form data)
app.post("/files/upload", requirePostSession, async (c) => {
  const sender = c.get("sender") as string;
  const limits = getFileSettings();

  // Reject oversized requests before buffering the body into memory.
  // Multipart overhead can push Content-Length a bit above the file size,
  // so allow a 64 KiB margin for form-data framing.
  const contentLength = parseInt(c.req.header("content-length") ?? "0", 10);
  if (contentLength > limits.max_file_size + 65536) {
    return c.json({ error: `File too large (max ${limits.max_file_size / 1024 / 1024}MB)` }, 413);
  }

  const body = await c.req.parseBody();
  const file = body["file"];
  if (!file || !(file instanceof File)) {
    return c.json({ error: "Missing file field" }, 400);
  }

  if (file.size > limits.max_file_size) {
    return c.json({ error: `File too large (max ${limits.max_file_size / 1024 / 1024}MB)` }, 413);
  }

  const userUsage = getUserFileStorage(sender);
  if (userUsage + file.size > limits.max_user_storage) {
    return c.json({ error: `User storage quota exceeded (${Math.round(limits.max_user_storage / 1024 / 1024)}MB per user)` }, 507);
  }

  const totalUsage = getTotalFileStorage();
  if (totalUsage + file.size > limits.max_total_storage) {
    return c.json({ error: "Global storage quota exceeded" }, 507);
  }

  const id = crypto.randomUUID();
  const ext = extname(file.name || "").toLowerCase() || "";
  const storedName = `${id}${ext}`;
  const declared = (file.type || "").toLowerCase().split(";")[0].trim();
  const mimeType = ALLOWED_DOWNLOAD_MIME.has(declared) ? declared : "application/octet-stream";

  const arrayBuf = await file.arrayBuffer();
  await Bun.write(`${FILES_DIR}/${storedName}`, arrayBuf);

  db.run(
    "INSERT INTO files (id, filename, stored_name, size, mime_type, uploader, uploaded_at) VALUES (?, ?, ?, ?, ?, ?, ?)",
    [id, file.name || "unnamed", storedName, file.size, mimeType, sender, new Date().toISOString()]
  );

  fileUploadsTotal++;
  logEvent("file.uploaded", { uploader: sender, size: file.size, mime: mimeType.split("/")[0], id });
  return c.json({ id, filename: file.name, size: file.size, mime_type: mimeType }, 201);
});

// GET /files/storage — get current storage usage (any authenticated user)
app.get("/files/storage", requireSessionOrObserver, (c) => {
  const sender = c.get("sender") as string || c.get("client")?.name || c.get("observer")?.username || "unknown";
  const limits = getFileSettings();
  const totalUsed = getTotalFileStorage();
  const userUsed = getUserFileStorage(sender);
  return c.json({
    user: { used: userUsed, limit: limits.max_user_storage },
    global: { used: totalUsed, limit: limits.max_total_storage },
    max_file_size: limits.max_file_size,
  });
});

// GET /files/:id/download — download a file
app.get("/files/:id/download", requireSessionOrObserver, async (c) => {
  const fileId = c.req.param("id");
  const row = db.query("SELECT stored_name, filename, mime_type, size FROM files WHERE id = ?").get(fileId) as any;
  if (!row) return c.json({ error: "File not found" }, 404);

  const filepath = `${FILES_DIR}/${row.stored_name}`;
  const file = Bun.file(filepath);
  if (!(await file.exists())) return c.json({ error: "File not found on disk" }, 404);

  // Re-validate against the allowlist on the way out: legacy rows stored
  // before the upload-side allowlist may still hold attacker-chosen types.
  const safeMime = ALLOWED_DOWNLOAD_MIME.has((row.mime_type || "").toLowerCase())
    ? row.mime_type
    : "application/octet-stream";

  return new Response(file, {
    headers: {
      "Content-Type": safeMime,
      "Content-Disposition": `attachment; filename="${row.filename.replace(/"/g, '\\"')}"`,
      "Content-Length": String(row.size),
      "X-Content-Type-Options": "nosniff",
    },
  });
});

// POST /message — post session required (bot bearer or observer cookie)
// Server-side message dedup: reject identical content from same sender within window
const recentMessages = new Map<string, number>(); // "sender:content" -> timestamp
const DEDUP_WINDOW_MS = 5000; // 5 seconds

app.post("/message", requirePostSession, async (c) => {
  const body = await c.req.json<{ content: string; file_ids?: string[]; reply_to_id?: number | null }>();
  if (!body.content || typeof body.content !== "string") {
    return c.json({ error: "Missing content" }, 400);
  }
  if (body.content.length > 4096) {
    return c.json({ error: "Message too long (max 4096 chars)" }, 400);
  }

  let replyToId: number | null = null;
  if (body.reply_to_id != null) {
    if (!Number.isInteger(body.reply_to_id) || body.reply_to_id <= 0) {
      return c.json({ error: "reply_to_id must be a positive integer" }, 400);
    }
    const parent = db.query("SELECT 1 FROM messages WHERE id = ?").get(body.reply_to_id);
    if (!parent) return c.json({ error: `reply_to_id ${body.reply_to_id} not found` }, 404);
    replyToId = body.reply_to_id;
  }

  const sender = c.get("sender") as string;
  const dedupKey = `${sender}:${body.content}`;
  const now = Date.now();
  const lastSent = recentMessages.get(dedupKey);

  if (lastSent && now - lastSent < DEDUP_WINDOW_MS) {
    return c.json({ error: "Duplicate message", deduplicated: true }, 429);
  }

  recentMessages.set(dedupKey, now);

  // Prune old entries periodically
  if (recentMessages.size > 500) {
    for (const [key, ts] of recentMessages) {
      if (now - ts > DEDUP_WINDOW_MS) recentMessages.delete(key);
    }
  }

  // Resolve file attachments
  let files: FileAttachment[] | undefined;
  if (body.file_ids && Array.isArray(body.file_ids) && body.file_ids.length > 0) {
    files = [];
    for (const fid of body.file_ids) {
      const row = db.query(
        "SELECT id, filename, size, mime_type, uploader FROM files WHERE id = ? AND uploader = ? AND message_id IS NULL"
      ).get(fid, sender) as any;
      if (!row) {
        return c.json({ error: `Invalid file_id: ${fid}` }, 400);
      }
      files.push({ id: row.id, filename: row.filename, size: row.size, mime_type: row.mime_type });
    }
  }

  const mentions = parseMentions(body.content);
  // Reply implicitly @-mentions the parent's author (default-on, per-user opt-out).
  if (replyToId) {
    const parentRow = db.query(
      "SELECT sender FROM messages WHERE id = ?"
    ).get(replyToId) as { sender: string } | null;
    const parentSender = parentRow?.sender;
    if (parentSender && parentSender !== sender && !isAutoMentionOptedOut(parentSender)) {
      const lower = parentSender.toLowerCase();
      if (!mentions.some(m => m.toLowerCase() === lower)) {
        mentions.push(parentSender);
      }
    }
  }
  const msg: Message = {
    id: ++messageCounter,
    timestamp: new Date().toISOString(),
    sender,
    content: body.content,
    mentions,
    files,
    reply_to_id: replyToId,
  };

  if (files) {
    for (const f of files) {
      db.run("UPDATE files SET message_id = ? WHERE id = ?", [msg.id, f.id]);
    }
  }

  db.run(
    "INSERT INTO messages (id, timestamp, sender, content, mentions, reply_to_id) VALUES (?, ?, ?, ?, ?, ?)",
    [msg.id, msg.timestamp, msg.sender, msg.content, JSON.stringify(msg.mentions), replyToId]
  );
  messagesPostedTotal++;
  broadcastEvent("message", msg);
  const md = new Date(msg.timestamp);
  const mdKey = `${md.getFullYear()}-${String(md.getMonth()+1).padStart(2,'0')}-${String(md.getDate()).padStart(2,'0')}`;
  broadcastEvent("activity", { date: mdKey });
  logEvent("message.posted", { sender, length: msg.content.length, has_files: !!msg.files?.length, files_count: msg.files?.length ?? 0, mentions_count: msg.mentions?.length ?? 0 });
  deliverWebhooks(msg);

  return c.json({ id: msg.id, timestamp: msg.timestamp }, 201);
});

// POST /messages/:id/read — mark message as read (Claude finished processing)
app.post("/messages/:id/read", requirePostSession, (c) => {
  const id = parseInt(c.req.param("id"), 10);
  if (isNaN(id)) return c.json({ error: "Invalid message ID" }, 400);
  const exists = db.query("SELECT 1 FROM messages WHERE id = ?").get(id);
  if (!exists) return c.json({ error: "Message not found" }, 404);
  const reader = c.get("sender") as string;
  const result = db.run(
    "INSERT OR IGNORE INTO message_receipts (message_id, username, kind, created_at) VALUES (?, ?, ?, ?)",
    [id, reader, "read", new Date().toISOString()]
  );
  const wasNew = result.changes > 0;
  if (wasNew) broadcastEvent("read", { id, reader });
  return c.json({ status: "ok" }, 200);
});

app.post("/messages/:id/engaged", requirePostSession, (c) => {
  const id = parseInt(c.req.param("id"), 10);
  if (isNaN(id)) return c.json({ error: "Invalid message ID" }, 400);
  const exists = db.query("SELECT 1 FROM messages WHERE id = ?").get(id);
  if (!exists) return c.json({ error: "Message not found" }, 404);
  const engager = c.get("sender") as string;
  const result = db.run(
    "INSERT OR IGNORE INTO message_receipts (message_id, username, kind, created_at) VALUES (?, ?, ?, ?)",
    [id, engager, "engaged", new Date().toISOString()]
  );
  const wasNew = result.changes > 0;
  if (wasNew) {
    broadcastEvent("engaged", { id, engager });
    logEvent("message.engaged", { id, engager });
  }
  return c.json({ status: "ok" }, 200);
});

// --- Webhook Registration (client self-service) ---

const TAILNET_URL_RE = /^https?:\/\/(100\.(6[4-9]|[7-9]\d|1[01]\d|12[0-7])\.\d{1,3}\.\d{1,3}|[\w.-]+\.ts\.net)(:\d+)?(\/|$)/;

app.post("/webhook", requirePostSession, async (c) => {
  const body = await c.req.json<{ url: string }>();
  if (!body.url || !TAILNET_URL_RE.test(body.url)) {
    return c.json({ error: "Invalid webhook URL — must be a Tailnet address" }, 400);
  }
  const client = c.get("client") as any;
  if (!client) return c.json({ error: "Webhook registration is only available to bot clients" }, 403);
  const secret = crypto.randomUUID();
  db.query("UPDATE clients SET webhook_url = ?, webhook_secret = ? WHERE fingerprint = ?")
    .run(body.url, secret, client.fingerprint);
  logEvent("webhook.registered", { fingerprint: client.fingerprint, url_host_hash: await hashUrlHostShort(body.url) });
  return c.json({ url: body.url, secret }, 200);
});

app.get("/webhook", requirePostSession, (c) => {
  const client = c.get("client") as any;
  if (!client) return c.json({ error: "Webhook registration is only available to bot clients" }, 403);
  const row = db.query("SELECT webhook_url FROM clients WHERE fingerprint = ?").get(client.fingerprint) as any;
  return c.json({ url: row?.webhook_url ?? null }, 200);
});

app.delete("/webhook", requirePostSession, (c) => {
  const client = c.get("client") as any;
  if (!client) return c.json({ error: "Webhook registration is only available to bot clients" }, 403);
  db.query("UPDATE clients SET webhook_url = NULL, webhook_secret = NULL WHERE fingerprint = ?")
    .run(client.fingerprint);
  return c.json({ cleared: true }, 200);
});

// 2.4.0-dev receipt read-path: source receipts from SQLite
// `message_receipts` in a single batched SELECT keyed by the incoming
// message ids. Returns the same shape the prior in-memory version did
// (readBy / deliveredTo / engagedBy string arrays per message). Write-
// through from the prior commit keeps message_receipts current on every
// POST so this is live-correct, not stale.
function withReceipts(msgs: Message[]) {
  if (msgs.length === 0) return [];
  const ids = msgs.map(m => m.id);
  const placeholders = ids.map(() => "?").join(",");
  const rows = db
    .query(
      `SELECT message_id, username, kind FROM message_receipts WHERE message_id IN (${placeholders})`
    )
    .all(...ids) as Array<{ message_id: number; username: string; kind: "delivered" | "engaged" | "read" }>;
  const byMsg = new Map<number, { read: string[]; delivered: string[]; engaged: string[] }>();
  for (const id of ids) byMsg.set(id, { read: [], delivered: [], engaged: [] });
  for (const r of rows) {
    const b = byMsg.get(r.message_id)!;
    if (r.kind === "read") b.read.push(r.username);
    else if (r.kind === "delivered") b.delivered.push(r.username);
    else if (r.kind === "engaged") b.engaged.push(r.username);
  }
  return msgs.map(m => {
    const b = byMsg.get(m.id)!;
    return { ...m, readBy: b.read, deliveredTo: b.delivered, engagedBy: b.engaged };
  });
}

// 2.4.0-dev read-path helpers. `dbRowsToMessages` converts SQLite rows
// into the in-memory Message shape (incl. files-table enrichment).
// `dbAllMessages` is the convenience wrapper for "all messages"; other
// handlers pass their own filtered row sets.
interface MessageRow {
  id: number;
  timestamp: string;
  sender: string;
  content: string;
  mentions: string;
  reply_to_id: number | null;
}

function dbRowsToMessages(rows: MessageRow[]): Message[] {
  if (rows.length === 0) return [];
  const ids = rows.map(r => r.id);
  const placeholders = ids.map(() => "?").join(",");
  const fileRows = db
    .query(
      `SELECT id, filename, size, mime_type, message_id FROM files WHERE message_id IN (${placeholders})`
    )
    .all(...ids) as Array<{ id: string; filename: string; size: number; mime_type: string; message_id: number }>;
  const filesByMsg = new Map<number, FileAttachment[]>();
  for (const fr of fileRows) {
    if (!filesByMsg.has(fr.message_id)) filesByMsg.set(fr.message_id, []);
    filesByMsg.get(fr.message_id)!.push({
      id: fr.id,
      filename: fr.filename,
      size: fr.size,
      mime_type: fr.mime_type,
    });
  }
  const replyCountRows = db
    .query(
      `SELECT reply_to_id, COUNT(*) AS n FROM messages WHERE reply_to_id IN (${placeholders}) GROUP BY reply_to_id`
    )
    .all(...ids) as Array<{ reply_to_id: number; n: number }>;
  const replyCounts = new Map<number, number>();
  for (const r of replyCountRows) replyCounts.set(r.reply_to_id, r.n);
  return rows.map(r => ({
    id: r.id,
    timestamp: r.timestamp,
    sender: r.sender,
    content: r.content,
    mentions: JSON.parse(r.mentions),
    files: filesByMsg.get(r.id) ?? [],
    reply_to_id: r.reply_to_id,
    reply_count: replyCounts.get(r.id) ?? 0,
  }));
}

function dbAllMessages(): Message[] {
  const rows = db
    .query(
      "SELECT id, timestamp, sender, content, mentions, reply_to_id FROM messages ORDER BY id"
    )
    .all() as MessageRow[];
  return dbRowsToMessages(rows);
}

// GET /messages — session or observer auth required
// Supports ?since=<ISO> (exclusive lower bound), ?until=<ISO> (inclusive
// upper bound), or both together for a back-window fetch (used by the chat
// client's load-older flow). ?lookback_hours=<N> returns the last N wall-clock
// hours of messages; if that window is empty (user returns after a long quiet
// period), falls back to the N-hour window ending at the most recent message.
// With no args, returns the last 50.
app.get("/messages", requireSessionOrObserver, (c) => {
  const since = c.req.query("since");
  const until = c.req.query("until");
  const lookbackHours = c.req.query("lookback_hours");
  let rows: MessageRow[];

  if (since || until) {
    const params: any[] = [];
    let where = "1=1";
    if (since) { where += " AND timestamp > ?"; params.push(since); }
    if (until) { where += " AND timestamp <= ?"; params.push(until); }
    rows = db
      .query(`SELECT id, timestamp, sender, content, mentions, reply_to_id FROM messages WHERE ${where} ORDER BY id`)
      .all(...params) as MessageRow[];
  } else if (lookbackHours) {
    const hours = Number(lookbackHours);
    if (!Number.isFinite(hours) || hours <= 0) {
      return c.json({ error: "lookback_hours must be a positive number" }, 400);
    }
    const windowMs = hours * 3600 * 1000;
    const wallCutoff = new Date(Date.now() - windowMs).toISOString();
    rows = db
      .query("SELECT id, timestamp, sender, content, mentions, reply_to_id FROM messages WHERE timestamp > ? ORDER BY id")
      .all(wallCutoff) as MessageRow[];
    if (rows.length === 0) {
      // Fallback: window ending at the most recent message timestamp.
      const latest = db
        .query("SELECT timestamp FROM messages ORDER BY id DESC LIMIT 1")
        .get() as { timestamp: string } | null;
      if (latest) {
        const fallbackCutoff = new Date(new Date(latest.timestamp).getTime() - windowMs).toISOString();
        rows = db
          .query("SELECT id, timestamp, sender, content, mentions, reply_to_id FROM messages WHERE timestamp > ? ORDER BY id")
          .all(fallbackCutoff) as MessageRow[];
      }
    }
  } else {
    // No args: last 50 in chronological order.
    const recent = db
      .query("SELECT id, timestamp, sender, content, mentions, reply_to_id FROM messages ORDER BY id DESC LIMIT 50")
      .all() as MessageRow[];
    rows = recent.reverse();
  }

  const result = dbRowsToMessages(rows);
  return c.json({ messages: withReceipts(result), count: result.length });
});

// GET /messages/all — session or observer auth required.
// 2.4.0-dev: second read-path migration. Source switched from the in-memory
// `messages` array to SQLite via dbAllMessages() (includes file-attachment
// enrichment). Receipts still come from the in-memory Maps via
// withReceipts() since the map-backing is still canonical for reads; those
// migrate in a subsequent commit.
app.get("/messages/all", requireSessionOrObserver, (c) => {
  const all = dbAllMessages();
  return c.json({ messages: withReceipts(all), count: all.length });
});

// GET /messages/pending-mentions — bot auth required (requireSession, which
// also handles the scope=mcp enforcement). Returns @-mentions for the
// authenticated bot that the bot has NOT yet marked read. Side effect: every
// returned message is marked `engaged` for this bot before the response is
// sent (idempotent — repeat calls are no-ops). This is the per-contract
// behavior of the MCP `list_pending_mentions()` tool, but the endpoint is
// generic enough to serve any client that wants "what do I still owe a
// reply on?" semantics.
app.get("/messages/pending-mentions", requireSession, (c) => {
  const client = c.get("client") as any;
  const me = client.name as string;
  let sinceRaw = c.req.query("since");
  // Convenience alias: `?since_hours=N` → since = now - N hours. Lets shell
  // clients avoid cross-platform date math (GNU vs BSD date syntax). Non-
  // positive values disable the filter (matches MCP tool semantics).
  if (!sinceRaw) {
    const sinceHoursRaw = c.req.query("since_hours");
    if (sinceHoursRaw != null) {
      const n = Number(sinceHoursRaw);
      if (Number.isFinite(n) && n > 0) {
        sinceRaw = new Date(Date.now() - n * 3600 * 1000).toISOString();
      }
    }
  }

  // 2.4.0-dev fifth read-path migration: SQL anti-join to find un-read mentions.
  // `json_each(m.mentions)` unpacks the JSON array per message; the DISTINCT
  // collapses duplicates when a bot is @-ed multiple times in one message.
  // `NOT EXISTS` handles the "read receipt doesn't exist for me" condition
  // efficiently via the message_receipts_msg_kind index (per fenbot).
  const params: any[] = [me, me, me];
  let where =
    "je.value = ? AND m.sender != ? AND NOT EXISTS (SELECT 1 FROM message_receipts r WHERE r.message_id = m.id AND r.username = ? AND r.kind = 'read')";
  if (sinceRaw) {
    where += " AND m.timestamp > ?";
    params.push(sinceRaw);
  }
  const rows = db
    .query(
      `SELECT DISTINCT m.id, m.timestamp, m.sender, m.content, m.mentions, m.reply_to_id
       FROM messages m, json_each(m.mentions) je
       WHERE ${where}
       ORDER BY m.id`
    )
    .all(...params) as MessageRow[];
  const pending = dbRowsToMessages(rows);

  // Side effect: auto-mark engaged. Still mirrors into the in-memory Map for
  // the legacy write-side .has() idempotency checks; write-through persists
  // to message_receipts. INSERT OR IGNORE handles concurrent callers.
  let newEngagements = 0;
  const engagedTs = new Date().toISOString();
  for (const m of pending) {
    const result = db.run(
      "INSERT OR IGNORE INTO message_receipts (message_id, username, kind, created_at) VALUES (?, ?, ?, ?)",
      [m.id, me, "engaged", engagedTs]
    );
    if (result.changes > 0) {
      newEngagements++;
      broadcastEvent("engaged", { id: m.id, engager: me });
    }
  }
  if (newEngagements > 0) {
    logEvent("message.engaged.batch", { engager: me, count: newEngagements });
  }
  return c.json({ messages: withReceipts(pending), count: pending.length });
});

// GET /files-list — enriched file listing for the sidebar files panel
app.get("/files-list", requireSessionOrObserver, (c) => {
  const rows = db.query(
    "SELECT id, filename, size, mime_type, uploader, message_id, uploaded_at FROM files WHERE message_id IS NOT NULL ORDER BY uploaded_at DESC LIMIT 500"
  ).all() as any[];
  const msgIds = [...new Set(rows.map(r => r.message_id))];
  const mentionsByMsg = new Map<number, string[]>();
  if (msgIds.length > 0) {
    const placeholders = msgIds.map(() => "?").join(",");
    const msgRows = db.query(
      `SELECT id, mentions FROM messages WHERE id IN (${placeholders})`
    ).all(...msgIds) as Array<{ id: number; mentions: string }>;
    for (const m of msgRows) {
      try { mentionsByMsg.set(m.id, JSON.parse(m.mentions || "[]")); } catch { mentionsByMsg.set(m.id, []); }
    }
  }
  const files = rows.map(r => ({
    id: r.id,
    filename: r.filename,
    size: r.size,
    mime_type: r.mime_type,
    uploader: r.uploader,
    message_id: r.message_id,
    uploaded_at: r.uploaded_at,
    mentions: mentionsByMsg.get(r.message_id) ?? [],
  }));
  return c.json({ files });
});

// GET /dates — per-day message counts for the calendar sidebar.
// 2.4.0-dev: first read-path migration — source switched from the in-memory
// `messages` array to SQLite. Date keys are still computed in JS to preserve
// the existing local-timezone bucketing behavior (server TZ=America/New_York
// via the container env). SQLite's date() is UTC-only without a 'localtime'
// modifier, and the current UI behavior assumes local-date keys, so we keep
// the JS-side bucketing unchanged.
app.get("/dates", requireSessionOrObserver, (c) => {
  const counts: Record<string, number> = {};
  const rows = db.query("SELECT timestamp FROM messages").all() as Array<{ timestamp: string }>;
  for (const r of rows) {
    const d = new Date(r.timestamp);
    const key = `${d.getFullYear()}-${String(d.getMonth()+1).padStart(2,'0')}-${String(d.getDate()).padStart(2,'0')}`;
    counts[key] = (counts[key] ?? 0) + 1;
  }
  const dates = Object.entries(counts)
    .map(([date, count]) => ({ date, count }))
    .sort((a, b) => a.date.localeCompare(b.date));
  return c.json({ dates });
});

// GET /events — SSE, session or observer auth required
app.get("/events", requireSessionOrObserver, (c) => {
  // Determine username/canPost from whichever principal authenticated
  const client = c.get("client") as any;
  const observer = c.get("observer") as any;
  const username = client?.name ?? observer?.username ?? "unknown";
  const userCanPost = client ? !!client.can_post : (observer ? !!observer.can_post : false);

  const openCount = sseConnectionsPerSender.get(username) ?? 0;
  if (openCount >= MAX_SSE_CONNECTIONS_PER_SENDER) {
    logEvent("sse.rejected", { username, reason: "rate_limit" });
    return c.json({ error: "Too many open SSE connections for this user" }, 429);
  }
  sseConnectionsPerSender.set(username, openCount + 1);
  if (LOG_VERBOSE) logEvent("sse.connected", { username, connection_count: openCount + 1 });

  let cleanup: () => void;
  const stream = new ReadableStream({
    type: "direct",
    async pull(controller) {
      const messageCount = (db.query("SELECT COUNT(*) as n FROM messages").get() as { n: number }).n;
      controller.write(`event: connected\ndata: ${JSON.stringify({ messageCount, username, canPost: userCanPost })}\n\n`);
      controller.flush();

      const send = (event: string, data: any) => {
        try {
          controller.write(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`);
          controller.flush();
        } catch {}
      };

      sseClients.add(send);

      const heartbeat = setInterval(() => {
        try {
          controller.write(`event: ping\ndata: keepalive\n\n`);
          controller.flush();
        } catch {
          clearInterval(heartbeat);
          sseClients.delete(send);
        }
      }, 15000);

      cleanup = () => {
        clearInterval(heartbeat);
        sseClients.delete(send);
        const n = (sseConnectionsPerSender.get(username) ?? 1) - 1;
        if (n <= 0) sseConnectionsPerSender.delete(username);
        else sseConnectionsPerSender.set(username, n);
      };

      // Keep the stream open until the client disconnects
      await new Promise<void>((resolve) => {
        c.req.raw.signal.addEventListener("abort", () => {
          cleanup();
          resolve();
        });
      });
    },
  });

  return new Response(stream, {
    headers: {
      "Content-Type": "text/event-stream",
      "Cache-Control": "no-cache, no-transform",
      "Connection": "keep-alive",
      "X-Accel-Buffering": "no",
    },
  });
});

// --- Start ---

const port = parseInt(Bun.env.PORT ?? "3000");

// HTTP redirect server — redirects all HTTP traffic to canonical HTTPS URL
if (CANONICAL_HOST) {
  const httpPort = parseInt(Bun.env.HTTP_REDIRECT_PORT ?? "80");
  Bun.serve({
    port: httpPort,
    fetch(req) {
      const url = new URL(req.url);
      return Response.redirect(`https://${CANONICAL_HOST}${url.pathname}${url.search}`, 301);
    },
  });
  console.log(`HTTP redirect on :${httpPort} → https://${CANONICAL_HOST}`);
}

console.log(`SideChat v2 running
  Local:   http://localhost:${port}
  DB:      ${DB_PATH}
  Admin:   ${ADMIN_USER}
  Archive: ${ARCHIVE_DIR} (every 15 min)`);

if (!METRICS_TOKEN) {
  console.warn("  WARN: /metrics is public — set METRICS_TOKEN to gate it behind a bearer token");
}

export default {
  port,
  fetch: app.fetch,
  idleTimeout: 0,
};
