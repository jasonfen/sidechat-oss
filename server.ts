import { Hono } from "hono";
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
    last_ip       TEXT
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
    created_at  TEXT NOT NULL
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
    last_ip       TEXT
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
`);

// --- Schema migrations ---

try { db.exec("ALTER TABLE clients ADD COLUMN webhook_url TEXT"); } catch {}
try { db.exec("ALTER TABLE clients ADD COLUMN webhook_secret TEXT"); } catch {}
try { db.exec("ALTER TABLE observer_sessions ADD COLUMN expires_at TEXT"); } catch {}

// --- Config from env ---

const ADMIN_USER = Bun.env.ADMIN_USER ?? "admin";
const ADMIN_PASSWORD_HASH = Bun.env.ADMIN_PASSWORD_HASH ?? "";
const SESSION_TTL_HOURS = parseInt(Bun.env.SESSION_TTL_HOURS ?? "24", 10);
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
}

let messages: Message[] = [];
let messageCounter = 0;
const readReceipts = new Map<number, Set<string>>();
const deliveryReceipts = new Map<number, Set<string>>();

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

// --- Webhook Delivery ---

async function deliverWebhooks(msg: Message) {
  if (msg.mentions.length === 0) return;
  const clients = db.query(
    "SELECT name, webhook_url, webhook_secret FROM clients WHERE status = 'active' AND webhook_url IS NOT NULL"
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
        if (!deliveryReceipts.has(msg.id)) deliveryReceipts.set(msg.id, new Set());
        deliveryReceipts.get(msg.id)!.add(client.name);
        broadcastEvent("delivered", { id: msg.id, bot: client.name });
        webhookDeliveriesTotal++;
      } else {
        webhookDeliveriesFailedTotal++;
      }
    }).catch(() => { webhookDeliveriesFailedTotal++; });
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
const SNAPSHOT_PATH = `${ARCHIVE_DIR}/messages.json`;
let lastArchivedId = 0;

async function writeSnapshot() {
  if (messages.length === 0) return;
  try {
    await Bun.write(SNAPSHOT_PATH, JSON.stringify({
      messages,
      messageCounter,
      readReceipts: [...readReceipts].map(([k, v]) => [k, [...v]]),
      deliveryReceipts: [...deliveryReceipts].map(([k, v]) => [k, [...v]]),
    }));
  } catch (err) {
    console.error(`Snapshot failed: ${err}`);
  }
}

function todayLogPath(): string {
  const date = new Date().toISOString().slice(0, 10); // YYYY-MM-DD
  return `${ARCHIVE_DIR}/${date}.md`;
}

async function writeArchive() {
  const newMessages = messages.filter((m) => m.id > lastArchivedId);
  if (newMessages.length === 0) {
    await writeSnapshot();
    return;
  }

  const filepath = todayLogPath();
  const lines: string[] = [];

  // Write header if file doesn't exist yet
  const file = Bun.file(filepath);
  if (!(await file.exists())) {
    const date = new Date().toISOString().slice(0, 10);
    lines.push(`# SideChat Log — ${date}`, "", "---", "");
  }

  for (const msg of newMessages) {
    const time = msg.timestamp.split("T")[1]?.split(".")[0] ?? msg.timestamp;
    lines.push(`**[${time}] ${msg.sender}**`);
    lines.push(msg.content);
    lines.push("");
    lines.push("---");
    lines.push("");
  }

  try {
    const existing = (await file.exists()) ? await file.text() : "";
    await Bun.write(filepath, existing + lines.join("\n"));
    lastArchivedId = newMessages[newMessages.length - 1].id;
    await writeSnapshot();
    console.log(`Archive appended ${newMessages.length} messages to ${filepath}`);
  } catch (err) {
    console.error(`Archive failed: ${err}`);
  }
}

// Rehydrate from snapshot on startup
try {
  const file = Bun.file(SNAPSHOT_PATH);
  if (await file.exists()) {
    const data = await file.json();
    messages = data.messages ?? [];
    messageCounter = data.messageCounter ?? messages.length;
    lastArchivedId = messageCounter;
    if (data.readReceipts) {
      for (const [k, v] of data.readReceipts) readReceipts.set(k, new Set(v));
    }
    if (data.deliveryReceipts) {
      for (const [k, v] of data.deliveryReceipts) deliveryReceipts.set(k, new Set(v));
    }
    console.log(`Rehydrated ${messages.length} messages from snapshot`);
  }
} catch (err) {
  console.error(`Snapshot rehydration failed: ${err}`);
}

setInterval(writeArchive, ARCHIVE_INTERVAL_MS);

// Write snapshot on graceful shutdown
process.on("SIGTERM", async () => {
  await writeSnapshot();
  process.exit(0);
});
process.on("SIGINT", async () => {
  await writeSnapshot();
  process.exit(0);
});

// --- Web Frontend ---

function buildChatPage(username: string, canPost: boolean, sessionToken: string): string {
  return `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>SideChat</title>
<link rel="icon" href="data:image/svg+xml,<svg xmlns='http://www.w3.org/2000/svg' viewBox='0 0 100 100'><text y='90' font-size='90'>&#x1F4A9;</text><text y='50' x='30' font-size='25'>&#x1F33D;</text><text y='75' x='15' font-size='20'>&#x1F33D;</text><text y='65' x='50' font-size='22'>&#x1F33D;</text></svg>">
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
    margin-bottom: 16px;
  }
  .msg-header {
    margin-bottom: 2px;
  }
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
    margin-top: 4px;
    padding-left: 2px;
    display: flex;
    flex-wrap: wrap;
    gap: 6px;
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
    margin: 20px 0 12px;
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
    font-size: 14px;
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
<div id="app" style="display:flex;flex-direction:row;height:100vh;">
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
      <div id="files-list"></div>
    </div>
  </div>
  <div id="main">
    <div id="header">
      <h1>SideChat</h1>
      <div style="display:flex;align-items:center;gap:12px;">
        <div id="status"><span class="dot disconnected" id="dot"></span><span id="status-text">Connecting...</span></div>
        <div id="mention-bell" title="Unread mentions" style="display:none;cursor:pointer;position:relative;font-size:18px;">
          <span id="bell-icon">&#x1F514;</span>
          <span id="bell-badge" style="display:none;position:absolute;top:-6px;right:-8px;background:#f85149;color:#fff;border-radius:50%;font-size:11px;min-width:16px;height:16px;line-height:16px;text-align:center;padding:0 3px;font-weight:700;"></span>
        </div>
        <button id="signout-btn" style="background:none;border:1px solid #30363d;border-radius:6px;color:#c9d1d9;padding:4px 12px;font-family:inherit;font-size:12px;cursor:pointer;" onmouseover="this.style.borderColor='#8b949e'" onmouseout="this.style.borderColor='#30363d'">Sign Out</button>
      </div>
    </div>
    <div id="messages"></div>
    <div id="pending-files"></div>
    <div id="input-bar">
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
<script>
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

  function updateReceipts(id, type, name) {
    if (!msgReceipts[id]) msgReceipts[id] = { readBy: [], deliveredTo: [] };
    var list = type === 'read' ? msgReceipts[id].readBy : msgReceipts[id].deliveredTo;
    if (list.indexOf(name) === -1) list.push(name);
    var el = document.getElementById('receipts-' + id);
    if (!el) return;
    var parts = [];
    if (msgReceipts[id].deliveredTo.length) parts.push('Delivered to ' + msgReceipts[id].deliveredTo.join(', '));
    if (msgReceipts[id].readBy.length) parts.push('Read by ' + msgReceipts[id].readBy.join(', '));
    el.textContent = parts.join(' \\u00b7 ');
  }
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
            var target = document.getElementById('date-' + this.getAttribute('data-date'));
            if (target) target.scrollIntoView({ behavior: 'smooth', block: 'start' });
            calGridEl.querySelectorAll('.cal-day.active').forEach(function(a){ a.classList.remove('active'); });
            this.classList.add('active');
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
  function renderFilesPanel(files) {
    filesListEl.innerHTML = '';
    if (!files || files.length === 0) {
      var e = document.createElement('div');
      e.className = 'empty';
      e.textContent = 'No files yet';
      filesListEl.appendChild(e);
      return;
    }
    files.forEach(function(f) {
      var row = document.createElement('div');
      row.className = 'file-row';
      var isMd = /\.(md|markdown)$/i.test(f.filename);
      row.title = isMd ? f.filename + ' — click to preview' : f.filename + ' — click to download';
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
      row.appendChild(fn);
      row.appendChild(meta);
      row.appendChild(line2);
      row.addEventListener('click', function() {
        if (isMd) {
          openMdOverlay(f.id, f.filename);
        } else {
          window.location.href = '/files/' + encodeURIComponent(f.id) + '/download?token=' + encodeURIComponent(SC_TOKEN);
        }
      });
      filesListEl.appendChild(row);
    });
  }
  function refreshFiles() {
    fetch('/files-list?token=' + encodeURIComponent(SC_TOKEN))
      .then(function(r){ return r.json(); })
      .then(function(d){ renderFilesPanel(d.files || []); })
      .catch(function(){});
  }
  window.__refreshFiles = refreshFiles;
  refreshFiles();

  function openMdOverlay(fileId, filename) {
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
        var html = window.marked ? window.marked.parse(text) : text;
        body.innerHTML = window.DOMPurify ? window.DOMPurify.sanitize(html, {
          ALLOWED_URI_REGEXP: /^(?:(?:https?|mailto):|[^a-z]|[a-z+.\\-]+(?:[^a-z+.\\-:]|$))/i
        }) : html;
      })
      .catch(function(err){ body.textContent = 'Failed to load: ' + (err.message || err); });
  }
  var acIndex = -1;

  // Color palette for dynamic sender colors
  var senderColors = [
    '#d2a8ff', '#79c0ff', '#ffa657', '#7ee787', '#ff7b72',
    '#f778ba', '#a5d6ff', '#ffd700', '#69db7c', '#da77f2'
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
      if (typeof marked === 'undefined' || typeof DOMPurify === 'undefined') {
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
    if (dateKey !== lastRenderedDate) {
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
    if (msg.deliveredTo || msg.readBy) {
      msgReceipts[msg.id] = { readBy: msg.readBy || [], deliveredTo: msg.deliveredTo || [] };
      var parts = [];
      if (msg.deliveredTo && msg.deliveredTo.length) parts.push('Delivered to ' + msg.deliveredTo.join(', '));
      if (msg.readBy && msg.readBy.length) parts.push('Read by ' + msg.readBy.join(', '));
      receiptsText = parts.join(' \\u00b7 ');
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
        if (isMd) {
          filesHtml += '<details class="md-preview" data-file-id="' + encodeURIComponent(f.id) + '" data-file-size="' + f.size + '">' +
            '<summary>' +
              '<span class="md-preview-label">&#x1F4DD; ' + escapeHtml(f.filename) + ' <span class="md-preview-size">(' + sizeStr + ')</span></span>' +
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
    div.innerHTML =
      '<div class="msg-header"><span class="msg-time">[' + time + ']</span> <span style="color:' + color + ';font-weight:600;">' + escapeHtml(msg.sender) + '</span></div>' +
      '<div class="msg-content">' + formatContent(msg.content) + '</div>' +
      filesHtml +
      '<div class="msg-receipts" id="receipts-' + msg.id + '">' + escapeHtml(receiptsText) + '</div>';
    var mdPreviews = div.querySelectorAll('details.md-preview');
    for (var i = 0; i < mdPreviews.length; i++) attachMdPreview(mdPreviews[i]);
    messagesEl.appendChild(div);
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

  // Load history
  fetch('/messages/all', { credentials: 'same-origin' })
    .then(function(r) { if (!r.ok) throw new Error(r.status); return r.json(); })
    .then(function(data) { data.messages.forEach(renderMessage); initialLoadDone = true; })
    .catch(function(err) { messagesEl.innerHTML = '<div style="color:#f85149;">Failed to load messages: ' + err.message + '</div>'; });

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

    es.addEventListener('activity', function(e) {
      try { var d = JSON.parse(e.data); if (d && d.date && window.__calMarkDay) window.__calMarkDay(d.date); } catch(_) {}
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

const WATCH_LOGIN_PAGE = `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>SideChat — Login</title>
<link rel="icon" href="data:image/svg+xml,<svg xmlns='http://www.w3.org/2000/svg' viewBox='0 0 100 100'><text y='90' font-size='90'>&#x1F4A9;</text><text y='50' x='30' font-size='25'>&#x1F33D;</text><text y='75' x='15' font-size='20'>&#x1F33D;</text><text y='65' x='50' font-size='22'>&#x1F33D;</text></svg>">
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
<script>
(function() {
  var form = document.getElementById('login-form');
  var errEl = document.getElementById('error');
  form.addEventListener('submit', function(e) {
    e.preventDefault();
    errEl.style.display = 'none';
    var username = document.getElementById('username').value;
    var password = document.getElementById('password').value;
    fetch('/watch/login', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
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
  return c.html(WATCH_LOGIN_PAGE);
});

// POST /watch/login — observer authentication
app.post("/watch/login", async (c) => {
  const limited = checkAuthRateLimit(c);
  if (limited) return limited;
  const body = await c.req.json<{ username: string; password: string }>();

  const observer = db.query(
    "SELECT * FROM observers WHERE username = ?"
  ).get(body.username) as any;
  if (!observer) {
    authAttemptsFailedTotal++;
    recordAuthFailure(c);
    await Bun.sleep(500);
    return c.json({ error: "Invalid credentials" }, 401);
  }
  if (observer.status === "revoked") {
    authAttemptsFailedTotal++;
    recordAuthFailure(c);
    return c.json({ error: "Account has been revoked" }, 403);
  }

  const valid = await Bun.password.verify(body.password, observer.password_hash);
  if (!valid) {
    authAttemptsFailedTotal++;
    recordAuthFailure(c);
    await Bun.sleep(500);
    return c.json({ error: "Invalid credentials" }, 401);
  }

  authAttemptsTotal++;
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
  if (token) db.run("DELETE FROM observer_sessions WHERE token = ?", [token]);
  deleteCookie(c, "observer_session", { path: "/" });
  return c.redirect("/watch/login");
});

// GET / — Web frontend (observer auth required)
app.get("/", requireObserver, (c) => {
  const obs = c.get("observer") as any;
  const token = getCookie(c, "observer_session")!;
  return c.html(buildChatPage(obs.username, !!obs.can_post, token));
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
    "# HELP sidechat_messages_in_memory Current messages in memory",
    "# TYPE sidechat_messages_in_memory gauge",
    `sidechat_messages_in_memory ${messages.length}`,
    "",
    "# HELP sidechat_sse_clients_active Active SSE connections",
    "# TYPE sidechat_sse_clients_active gauge",
    `sidechat_sse_clients_active ${sseClients.size}`,
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
    return c.json({ status: "ok", messageCount: messages.length, uptime, sseClients: sseClients.size });
  }

  return c.html(`<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>SideChat — Health</title>
<link rel="icon" href="data:image/svg+xml,<svg xmlns='http://www.w3.org/2000/svg' viewBox='0 0 100 100'><text y='90' font-size='90'>&#x1F4A9;</text><text y='50' x='30' font-size='25'>&#x1F33D;</text><text y='75' x='15' font-size='20'>&#x1F33D;</text><text y='65' x='50' font-size='22'>&#x1F33D;</text></svg>">
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
<script>
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
  if (!token) return c.json({ error: "Unauthorized" }, 401);

  const session = db.query(
    "SELECT * FROM sessions WHERE token = ? AND expires_at > ?"
  ).get(token, new Date().toISOString()) as any;
  if (!session) return c.json({ error: "Invalid or expired session" }, 401);

  const client = db.query(
    "SELECT * FROM clients WHERE fingerprint = ? AND status = 'active'"
  ).get(session.fingerprint) as any;
  if (!client) return c.json({ error: "Client revoked" }, 401);

  db.run(
    "UPDATE clients SET last_seen = ?, last_ip = ? WHERE fingerprint = ?",
    [new Date().toISOString(), getClientIP(c), session.fingerprint]
  );

  c.set("client", client);
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
      const client = db.query(
        "SELECT * FROM clients WHERE fingerprint = ? AND status = 'active'"
      ).get(botSession.fingerprint) as any;
      if (client) {
        if (!client.can_post) return c.json({ error: "Client not authorized to post" }, 403);
        c.set("client", client);
        c.set("sender", client.name);
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
      const client = db.query(
        "SELECT * FROM clients WHERE fingerprint = ? AND status = 'active'"
      ).get(botSession.fingerprint) as any;
      if (client) {
        db.run("UPDATE clients SET last_seen = ?, last_ip = ? WHERE fingerprint = ?",
          [new Date().toISOString(), getClientIP(c), botSession.fingerprint]);
        c.set("client", client);
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

async function requireAdmin(c: Context, next: Next) {
  const token = getCookie(c, "admin_session");
  if (!token) return c.redirect("/admin/login");
  const session = db.query(
    "SELECT * FROM admin_sessions WHERE token = ? AND expires_at > ?"
  ).get(token, new Date().toISOString()) as any;
  if (!session) return c.redirect("/admin/login");
  await next();
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
  const fingerprint = c.req.query("fingerprint");
  if (!fingerprint) { recordAuthFailure(c); return c.json({ error: "Missing fingerprint" }, 400); }

  const client = db.query("SELECT * FROM clients WHERE fingerprint = ?").get(fingerprint) as any;
  if (!client) { recordAuthFailure(c); return c.json({ error: "Client not found" }, 404); }
  if (client.status !== "active") { recordAuthFailure(c); return c.json({ error: "Client not approved" }, 403); }

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
  if (limited) return limited;
  const body = await c.req.json<{ fingerprint: string; nonce: string; signature: string }>();

  const client = db.query(
    "SELECT * FROM clients WHERE fingerprint = ? AND status = 'active'"
  ).get(body.fingerprint) as any;
  if (!client) { authAttemptsFailedTotal++; recordAuthFailure(c); return c.json({ error: "Client not approved" }, 403); }

  const nonce = db.query(
    "SELECT * FROM nonces WHERE value = ? AND fingerprint = ? AND used = 0 AND expires_at > ?"
  ).get(body.nonce, body.fingerprint, new Date().toISOString()) as any;
  if (!nonce) { authAttemptsFailedTotal++; recordAuthFailure(c); return c.json({ error: "Invalid or expired nonce" }, 401); }

  const valid = await verifySignature(client.public_key, body.nonce, body.signature);
  if (!valid) { authAttemptsFailedTotal++; recordAuthFailure(c); return c.json({ error: "Signature verification failed" }, 401); }

  // Mark nonce as used
  db.run("UPDATE nonces SET used = 1 WHERE value = ?", [body.nonce]);

  // Create session
  const token = crypto.randomUUID().replace(/-/g, "") + crypto.randomUUID().replace(/-/g, "");
  const now = new Date();
  const expiresAt = new Date(now.getTime() + SESSION_TTL_HOURS * 3600 * 1000);

  db.run(
    "INSERT INTO sessions (token, fingerprint, expires_at, created_at) VALUES (?, ?, ?, ?)",
    [token, body.fingerprint, expiresAt.toISOString(), now.toISOString()]
  );

  db.run("UPDATE clients SET last_seen = ?, last_ip = ? WHERE fingerprint = ?",
    [now.toISOString(), getClientIP(c), body.fingerprint]);

  authAttemptsTotal++;
  return c.json({ token, expires_at: expiresAt.toISOString() });
});

// --- Admin Pages ---

// GET /admin/login — admin login page
app.get("/admin/login", (c) => {
  return c.html(`<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>SideChat — Admin Login</title>
<link rel="icon" href="data:image/svg+xml,<svg xmlns='http://www.w3.org/2000/svg' viewBox='0 0 100 100'><text y='90' font-size='90'>&#x1F4A9;</text><text y='50' x='30' font-size='25'>&#x1F33D;</text><text y='75' x='15' font-size='20'>&#x1F33D;</text><text y='65' x='50' font-size='22'>&#x1F33D;</text></svg>">
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
<script>
(function() {
  var form = document.getElementById('login-form');
  var errEl = document.getElementById('error');
  form.addEventListener('submit', function(e) {
    e.preventDefault();
    errEl.style.display = 'none';
    fetch('/admin/login', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
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
<link rel="icon" href="data:image/svg+xml,<svg xmlns='http://www.w3.org/2000/svg' viewBox='0 0 100 100'><text y='90' font-size='90'>&#x1F4A9;</text><text y='50' x='30' font-size='25'>&#x1F33D;</text><text y='75' x='15' font-size='20'>&#x1F33D;</text><text y='65' x='50' font-size='22'>&#x1F33D;</text></svg>">
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
  #header h1 { font-size: 16px; font-weight: 600; color: #e6edf3; }
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
  <h1>SideChat Admin</h1>
  <div class="nav">
    <a href="/">Chat</a>
    <button class="btn-logout" onclick="fetch('/admin/logout',{method:'POST',redirect:'follow'}).then(function(r){if(r.redirected)window.location.href=r.url;else window.location.href='/admin/login';})">Logout</button>
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
<script>
(function() {
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
      html += '<td><button class="btn btn-approve" onclick="adminAction(&apos;/admin/clients/' + c.fingerprint + '/approve&apos;,refresh)">Approve</button> ';
      html += '<button class="btn btn-reject" onclick="adminAction(&apos;/admin/clients/' + c.fingerprint + '/reject&apos;,refresh)">Reject</button></td></tr>';
    });
    html += '</table>';
    document.getElementById('pending-body').innerHTML = html;
  }

  function renderActive(clients) {
    document.getElementById('active-count').textContent = '(' + clients.length + ')';
    if (!clients.length) { document.getElementById('active-body').innerHTML = '<div class="empty">No active clients</div>'; return; }
    var html = '<table><tr><th>Name</th><th>Fingerprint</th><th>Can Post</th><th>Last Seen</th><th>Last IP</th><th>Webhook</th><th>Actions</th></tr>';
    clients.forEach(function(c) {
      html += '<tr><td>' + esc(c.name) + '</td><td class="fp">' + esc(c.fingerprint.slice(0,16)) + '&hellip;</td><td>' + (c.can_post ? 'yes' : 'no') + '</td><td>' + relTime(c.last_seen) + '</td><td>' + esc(c.last_ip || '') + '</td>';
      html += '<td>' + (c.webhook_url ? '<span class="fp" title="' + esc(c.webhook_url) + '">webhook</span> ' : '') + '</td>';
      html += '<td><button class="btn btn-revoke" onclick="adminAction(&apos;/admin/clients/' + c.fingerprint + '/revoke&apos;,refresh)">Revoke</button>';
      if (c.webhook_url) html += ' <button class="btn" onclick="adminAction(&apos;/admin/clients/' + c.fingerprint + '/clear-webhook&apos;,refresh)">Clear Webhook</button>';
      html += '</td></tr>';
    });
    html += '</table>';
    document.getElementById('active-body').innerHTML = html;
  }

  function renderObservers(observers) {
    document.getElementById('obs-count').textContent = '(' + observers.length + ')';
    if (!observers.length) { document.getElementById('obs-body').innerHTML = '<div class="empty">No observers</div>'; return; }
    var html = '<table><tr><th>Username</th><th>Status</th><th>Can Post</th><th>Last Seen</th><th>Last IP</th><th>Actions</th></tr>';
    observers.forEach(function(o) {
      var badge = '<span class="badge ' + o.status + '">' + o.status + '</span>';
      html += '<tr><td>' + esc(o.username) + '</td><td>' + badge + '</td><td>' + (o.can_post ? 'yes' : 'no') + '</td><td>' + relTime(o.last_seen) + '</td><td>' + esc(o.last_ip || '') + '</td>';
      if (o.status === 'active') {
        html += '<td><button class="btn btn-revoke" onclick="adminAction(&apos;/admin/observers/' + o.id + '/revoke&apos;,refresh)">Revoke</button></td>';
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
      html += '<div class="install-cmd"><span class="label">' + esc(label) + '</span><code>' + esc(cmd) + '</code><button class="btn-copy" onclick="copyCmd(this)">Copy</button></div>';
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
  window.adminAction = adminAction;
  window.refresh = refresh;

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
</body>
</html>`);
});

// --- Admin Login/Logout ---

// POST /admin/login — no auth required
app.post("/admin/login", async (c) => {
  const limited = checkAuthRateLimit(c);
  if (limited) return limited;
  const body = await c.req.json<{ username: string; password: string }>();

  if (body.username !== ADMIN_USER || !ADMIN_PASSWORD_HASH) {
    recordAuthFailure(c);
    await Bun.sleep(500);
    return c.json({ error: "Invalid credentials" }, 401);
  }

  const valid = await Bun.password.verify(body.password, ADMIN_PASSWORD_HASH);
  if (!valid) {
    recordAuthFailure(c);
    await Bun.sleep(500);
    return c.json({ error: "Invalid credentials" }, 401);
  }

  const token = crypto.randomUUID().replace(/-/g, "") + crypto.randomUUID().replace(/-/g, "");
  const now = new Date();
  const expires = new Date(now.getTime() + ADMIN_SESSION_TTL_HOURS * 3600 * 1000);
  db.run(
    "INSERT INTO admin_sessions (token, expires_at, created_at) VALUES (?, ?, ?)",
    [token, expires.toISOString(), now.toISOString()]
  );

  setCookie(c, "admin_session", token, {
    httpOnly: true,
    secure: isRequestSecure(c),
    sameSite: "Strict",
    path: "/",
  });

  return c.json({ ok: true });
});

// POST /admin/logout — admin auth required
app.post("/admin/logout", requireAdmin, async (c) => {
  const token = getCookie(c, "admin_session");
  if (token) db.run("DELETE FROM admin_sessions WHERE token = ?", [token]);
  deleteCookie(c, "admin_session", { path: "/" });
  return c.redirect("/admin/login");
});

// --- Admin API Routes ---

import { networkInterfaces } from "os";
import { execSync } from "child_process";

function getInstallURLs(): string[] {
  const port = Bun.env.PORT ?? "3000";
  const urls: string[] = [];

  // Check for Tailscale hostname
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
  const CLIENT_COLS = "id, name, fingerprint, status, can_post, source_ip, registered_at, approved_at, last_seen, last_ip, webhook_url";
  const pending = db.query(`SELECT ${CLIENT_COLS} FROM clients WHERE status = 'pending' ORDER BY registered_at DESC`).all();
  const active = db.query(`SELECT ${CLIENT_COLS} FROM clients WHERE status = 'active' ORDER BY last_seen DESC`).all();
  const revoked = db.query(`SELECT ${CLIENT_COLS} FROM clients WHERE status = 'revoked'`).all();
  const observersList = db.query("SELECT id, username, status, can_post, created_at, last_seen, last_ip FROM observers ORDER BY created_at DESC").all();
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
  db.run(
    "UPDATE clients SET status = 'active', approved_at = ? WHERE fingerprint = ? AND status = 'pending'",
    [new Date().toISOString(), fp]
  );
  return c.json({ status: "approved" });
});

// POST /admin/clients/:fingerprint/reject
app.post("/admin/clients/:fingerprint/reject", requireAdmin, async (c) => {
  const fp = c.req.param("fingerprint");
  db.run("DELETE FROM clients WHERE fingerprint = ? AND status = 'pending'", [fp]);
  return c.json({ status: "rejected" });
});

// POST /admin/clients/:fingerprint/revoke
app.post("/admin/clients/:fingerprint/revoke", requireAdmin, async (c) => {
  const fp = c.req.param("fingerprint");
  db.run("UPDATE clients SET status = 'revoked' WHERE fingerprint = ?", [fp]);
  db.run("DELETE FROM sessions WHERE fingerprint = ?", [fp]);
  return c.json({ status: "revoked" });
});

// POST /admin/clients/:fingerprint/clear-webhook
app.post("/admin/clients/:fingerprint/clear-webhook", requireAdmin, async (c) => {
  const fp = c.req.param("fingerprint");
  db.run("UPDATE clients SET webhook_url = NULL, webhook_secret = NULL WHERE fingerprint = ?", [fp]);
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

  if (existing) {
    // Re-activate revoked observer with new password
    db.run(
      "UPDATE observers SET password_hash = ?, can_post = ?, status = 'active', last_seen = NULL, last_ip = NULL WHERE id = ?",
      [passwordHash, canPost, existing.id]
    );
    return c.json({ id: existing.id, username: body.username, can_post: canPost === 1 }, 201);
  }

  const result = db.run(
    "INSERT INTO observers (username, password_hash, can_post, created_at) VALUES (?, ?, ?, ?)",
    [body.username, passwordHash, canPost, new Date().toISOString()]
  );

  return c.json({ id: Number(result.lastInsertRowid), username: body.username, can_post: canPost === 1 }, 201);
});

// POST /admin/observers/:id/revoke
app.post("/admin/observers/:id/revoke", requireAdmin, async (c) => {
  const id = parseInt(c.req.param("id"), 10);
  db.run("UPDATE observers SET status = 'revoked' WHERE id = ?", [id]);
  db.run("DELETE FROM observer_sessions WHERE observer_id = ?", [id]);
  return c.json({ status: "revoked" });
});

// POST /admin/settings/files — update file transfer limits
app.post("/admin/settings/files", requireAdmin, async (c) => {
  const body = await c.req.json<{ max_file_size?: number; max_user_storage?: number; max_total_storage?: number }>();
  const updated: string[] = [];
  if (body.max_file_size != null && body.max_file_size > 0) {
    setSetting("max_file_size", body.max_file_size);
    updated.push("max_file_size");
  }
  if (body.max_user_storage != null && body.max_user_storage > 0) {
    setSetting("max_user_storage", body.max_user_storage);
    updated.push("max_user_storage");
  }
  if (body.max_total_storage != null && body.max_total_storage > 0) {
    setSetting("max_total_storage", body.max_total_storage);
    updated.push("max_total_storage");
  }
  return c.json({ updated, settings: getFileSettings() });
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
  const body = await c.req.json<{ content: string; file_ids?: string[] }>();
  if (!body.content || typeof body.content !== "string") {
    return c.json({ error: "Missing content" }, 400);
  }
  if (body.content.length > 4096) {
    return c.json({ error: "Message too long (max 4096 chars)" }, 400);
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

  const msg: Message = {
    id: ++messageCounter,
    timestamp: new Date().toISOString(),
    sender,
    content: body.content,
    mentions: parseMentions(body.content),
    files,
  };

  // Link files to this message
  if (files) {
    for (const f of files) {
      db.run("UPDATE files SET message_id = ? WHERE id = ?", [msg.id, f.id]);
    }
  }

  messages.push(msg);
  messagesPostedTotal++;
  broadcastEvent("message", msg);
  const md = new Date(msg.timestamp);
  const mdKey = `${md.getFullYear()}-${String(md.getMonth()+1).padStart(2,'0')}-${String(md.getDate()).padStart(2,'0')}`;
  broadcastEvent("activity", { date: mdKey });
  deliverWebhooks(msg);

  return c.json({ id: msg.id, timestamp: msg.timestamp }, 201);
});

// POST /messages/:id/read — mark message as read
app.post("/messages/:id/read", requirePostSession, (c) => {
  const id = parseInt(c.req.param("id"), 10);
  if (isNaN(id)) return c.json({ error: "Invalid message ID" }, 400);
  if (!messages.some(m => m.id === id)) {
    return c.json({ error: "Message not found" }, 404);
  }
  const reader = c.get("sender") as string;
  if (!readReceipts.has(id)) readReceipts.set(id, new Set());
  const wasNew = !readReceipts.get(id)!.has(reader);
  readReceipts.get(id)!.add(reader);
  if (wasNew) {
    broadcastEvent("read", { id, reader });
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

function withReceipts(msgs: Message[]) {
  return msgs.map(m => ({
    ...m,
    readBy: [...(readReceipts.get(m.id) ?? [])],
    deliveredTo: [...(deliveryReceipts.get(m.id) ?? [])],
  }));
}

// GET /messages — session or observer auth required
app.get("/messages", requireSessionOrObserver, (c) => {
  const since = c.req.query("since");
  let result: Message[];

  if (since) {
    const sinceDate = new Date(since);
    result = messages.filter((m) => new Date(m.timestamp) > sinceDate);
  } else {
    result = messages.slice(-50);
  }

  return c.json({ messages: withReceipts(result), count: result.length });
});

// GET /messages/all — session or observer auth required
app.get("/messages/all", requireSessionOrObserver, (c) => {
  return c.json({ messages: withReceipts(messages), count: messages.length });
});

// GET /files-list — enriched file listing for the sidebar files panel
app.get("/files-list", requireSessionOrObserver, (c) => {
  const rows = db.query(
    "SELECT id, filename, size, mime_type, uploader, message_id, uploaded_at FROM files WHERE message_id IS NOT NULL ORDER BY uploaded_at DESC LIMIT 500"
  ).all() as any[];
  const msgById = new Map(messages.map(m => [m.id, m]));
  const files = rows.map(r => {
    const m = msgById.get(r.message_id);
    return {
      id: r.id,
      filename: r.filename,
      size: r.size,
      mime_type: r.mime_type,
      uploader: r.uploader,
      message_id: r.message_id,
      uploaded_at: r.uploaded_at,
      mentions: m?.mentions ?? [],
    };
  });
  return c.json({ files });
});

// GET /dates — per-day message counts for the calendar sidebar
app.get("/dates", requireSessionOrObserver, (c) => {
  const counts: Record<string, number> = {};
  for (const m of messages) {
    const d = new Date(m.timestamp);
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
    return c.json({ error: "Too many open SSE connections for this user" }, 429);
  }
  sseConnectionsPerSender.set(username, openCount + 1);

  let cleanup: () => void;
  const stream = new ReadableStream({
    type: "direct",
    async pull(controller) {
      controller.write(`event: connected\ndata: ${JSON.stringify({ messageCount: messages.length, username, canPost: userCanPost })}\n\n`);
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
