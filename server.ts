import { Hono } from "hono";
import { Database } from "bun:sqlite";
import { createHash } from "crypto";
import { getCookie, setCookie, deleteCookie } from "hono/cookie";
import type { Context, Next } from "hono";

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
    created_at  TEXT NOT NULL
  );
`);

// --- Schema migrations ---

try { db.exec("ALTER TABLE clients ADD COLUMN webhook_url TEXT"); } catch {}
try { db.exec("ALTER TABLE clients ADD COLUMN webhook_secret TEXT"); } catch {}

// --- Config from env ---

const ADMIN_USER = Bun.env.ADMIN_USER ?? "admin";
const ADMIN_PASSWORD_HASH = Bun.env.ADMIN_PASSWORD_HASH ?? "";
const SESSION_TTL_HOURS = parseInt(Bun.env.SESSION_TTL_HOURS ?? "24", 10);
const NONCE_TTL_SECONDS = parseInt(Bun.env.NONCE_TTL_SECONDS ?? "60", 10);
const ADMIN_SESSION_TTL_HOURS = parseInt(Bun.env.ADMIN_SESSION_TTL_HOURS ?? "8", 10);

// --- Cleanup Loop (every 5 minutes) ---

function runCleanup() {
  const now = new Date().toISOString();
  db.run("DELETE FROM nonces WHERE expires_at < ? OR used = 1", [now]);
  db.run("DELETE FROM sessions WHERE expires_at < ?", [now]);
  db.run("DELETE FROM admin_sessions WHERE expires_at < ?", [now]);
  // NOTE: observer_sessions are NOT cleaned up on a timer — only on logout or admin revoke
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

// --- Data Structures ---

interface Message {
  id: number;
  timestamp: string;
  sender: string;
  content: string;
  mentions: string[];
}

let messages: Message[] = [];
let messageCounter = 0;

function parseMentions(content: string): string[] {
  const botNames = (db.query("SELECT name FROM clients WHERE status = 'active'").all() as any[]).map(r => r.name);
  const observerNames = (db.query("SELECT username FROM observers WHERE status = 'active'").all() as any[]).map(r => r.username);
  const allUsernames = [...botNames, ...observerNames, ADMIN_USER];
  return allUsernames.filter(username =>
    new RegExp(`@${username}\\b`, "i").test(content)
  );
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
    }).catch(() => {});
  }
}

// --- SSE Client Management ---

const sseClients = new Set<(message: Message) => void>();

function broadcast(message: Message) {
  sseClients.forEach((send) => send(message));
}

// --- Archive & Snapshot ---

const ARCHIVE_DIR = Bun.env.ARCHIVE_DIR ?? "/var/sidechat/archives";
const ARCHIVE_INTERVAL_MS = 15 * 60 * 1000;
const SNAPSHOT_PATH = `${ARCHIVE_DIR}/messages.json`;
let lastArchivedId = 0;

async function writeSnapshot() {
  if (messages.length === 0) return;
  try {
    await Bun.write(SNAPSHOT_PATH, JSON.stringify({ messages, messageCounter }));
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
    width: 180px;
    min-width: 180px;
    background: #010409;
    border-right: 1px solid #21262d;
    display: flex;
    flex-direction: column;
    height: 100vh;
    overflow: hidden;
  }
  #sidebar-header {
    padding: 12px 14px;
    font-size: 11px;
    font-weight: 600;
    color: #484f58;
    text-transform: uppercase;
    letter-spacing: 0.8px;
    border-bottom: 1px solid #21262d;
    flex-shrink: 0;
  }
  #date-list {
    flex: 1;
    overflow-y: auto;
    padding: 6px 0;
  }
  #date-list a {
    display: block;
    padding: 5px 14px;
    color: #8b949e;
    text-decoration: none;
    font-size: 13px;
    white-space: nowrap;
    overflow: hidden;
    text-overflow: ellipsis;
  }
  #date-list a:hover {
    color: #c9d1d9;
    background: #161b22;
  }
  #date-list a.active {
    color: #58a6ff;
    background: #0d1117;
  }
  #main {
    flex: 1;
    display: flex;
    flex-direction: column;
    min-width: 0;
    height: 100vh;
  }
  #header {
    padding: 12px 16px;
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
    <div id="sidebar-header">Dates</div>
    <div id="date-list"></div>
  </div>
  <div id="main">
    <div id="header">
      <h1>SideChat</h1>
      <div id="status"><span class="dot disconnected" id="dot"></span><span id="status-text">Connecting...</span></div>
    </div>
    <div id="messages"></div>
    <div id="input-bar">
      <div id="autocomplete"></div>
      <form id="msg-form">
        <input type="text" id="msg-input" placeholder="Type a message..." autocomplete="off" />
        <button type="submit" id="msg-send">Send</button>
      </form>
    </div>
  </div>
</div>
<script>
(function() {
  var SC_USER = '${username}';
  var SC_CAN_POST = ${canPost};
  var SC_TOKEN = '${sessionToken}';

  var messagesEl = document.getElementById('messages');
  var dateListEl = document.getElementById('date-list');
  var dot = document.getElementById('dot');
  var statusText = document.getElementById('status-text');
  var inputBar = document.getElementById('input-bar');
  var msgForm = document.getElementById('msg-form');
  var msgInput = document.getElementById('msg-input');
  var msgSend = document.getElementById('msg-send');
  var autocompleteEl = document.getElementById('autocomplete');
  var seen = new Set();
  var userScrolled = false;
  var currentUser = SC_USER;
  var canPost = SC_CAN_POST;
  var allUsers = [];

  if (canPost) { inputBar.style.display = 'block'; }
  else { inputBar.style.display = 'none'; }
  var sidebarDates = new Set();
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

  function renderMessage(msg) {
    if (seen.has(msg.id)) return;
    seen.add(msg.id);
    var d = new Date(msg.timestamp);
    var dateKey = d.getFullYear() + '-' + (d.getMonth()+1) + '-' + d.getDate();
    if (dateKey !== lastRenderedDate) {
      lastRenderedDate = dateKey;
      var divider = document.createElement('div');
      divider.className = 'date-divider';
      divider.id = 'date-' + dateKey;
      divider.textContent = formatDateLabel(d);
      messagesEl.appendChild(divider);
      if (!sidebarDates.has(dateKey)) {
        sidebarDates.add(dateKey);
        var link = document.createElement('a');
        link.href = '#date-' + dateKey;
        var pad = function(n) { return n < 10 ? '0' + n : '' + n; };
        link.textContent = d.getFullYear() + '-' + pad(d.getMonth()+1) + '-' + pad(d.getDate());
        link.setAttribute('data-date', dateKey);
        link.addEventListener('click', function(e) {
          e.preventDefault();
          var target = document.getElementById('date-' + this.getAttribute('data-date'));
          if (target) target.scrollIntoView({ behavior: 'smooth', block: 'start' });
          dateListEl.querySelectorAll('a').forEach(function(a) { a.classList.remove('active'); });
          this.classList.add('active');
        });
        dateListEl.appendChild(link);
      }
    }
    var div = document.createElement('div');
    div.className = 'msg';
    var time = d.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit', second: '2-digit', hour12: false });
    var color = getSenderColor(msg.sender);
    div.innerHTML =
      '<div class="msg-header"><span class="msg-time">[' + time + ']</span> <span style="color:' + color + ';font-weight:600;">' + escapeHtml(msg.sender) + '</span></div>' +
      '<div class="msg-content">' + formatContent(msg.content) + '</div>';
    messagesEl.appendChild(div);
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
    .then(function(data) { data.messages.forEach(renderMessage); })
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

  // Send message
  msgForm.addEventListener('submit', function(e) {
    e.preventDefault();
    var content = msgInput.value.trim();
    if (!content) return;
    msgSend.disabled = true;
    fetch('/message', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      credentials: 'same-origin',
      body: JSON.stringify({ content: content })
    })
    .then(function(r) {
      if (!r.ok) return r.json().then(function(d) { throw new Error(d.error || r.status); });
      msgInput.value = '';
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
      } catch(err) {}
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
</style>
</head>
<body>
<div class="login-card">
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

// GET /watch/login — observer login page
app.get("/watch/login", (c) => {
  // If already authenticated, redirect to /
  const token = getCookie(c, "observer_session");
  if (token) {
    const session = db.query(
      `SELECT os.*, o.status FROM observer_sessions os
       JOIN observers o ON o.id = os.observer_id
       WHERE os.token = ? AND o.status = 'active'`
    ).get(token);
    if (session) return c.redirect("/");
  }
  return c.html(WATCH_LOGIN_PAGE);
});

// POST /watch/login — observer authentication
app.post("/watch/login", async (c) => {
  const body = await c.req.json<{ username: string; password: string }>();

  const observer = db.query(
    "SELECT * FROM observers WHERE username = ?"
  ).get(body.username) as any;
  if (!observer) {
    await Bun.sleep(500);
    return c.json({ error: "Invalid credentials" }, 401);
  }
  if (observer.status === "revoked") {
    return c.json({ error: "Account has been revoked" }, 403);
  }

  const valid = await Bun.password.verify(body.password, observer.password_hash);
  if (!valid) {
    await Bun.sleep(500);
    return c.json({ error: "Invalid credentials" }, 401);
  }

  const token = crypto.randomUUID().replace(/-/g, "") + crypto.randomUUID().replace(/-/g, "");
  db.run(
    "INSERT INTO observer_sessions (token, observer_id, created_at) VALUES (?, ?, ?)",
    [token, observer.id, new Date().toISOString()]
  );

  setCookie(c, "observer_session", token, {
    httpOnly: true,
    secure: true,
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
  if (!/^[a-z0-9_-]+\.sh$/.test(script)) {
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
  const fingerprint = c.req.query("fingerprint");
  if (!fingerprint) return c.json({ error: "Missing fingerprint" }, 400);

  const client = db.query("SELECT * FROM clients WHERE fingerprint = ?").get(fingerprint) as any;
  if (!client) return c.json({ error: "Client not found" }, 404);
  if (client.status !== "active") return c.json({ error: "Client not approved" }, 403);

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
  const body = await c.req.json<{ fingerprint: string; nonce: string; signature: string }>();

  const client = db.query(
    "SELECT * FROM clients WHERE fingerprint = ? AND status = 'active'"
  ).get(body.fingerprint) as any;
  if (!client) return c.json({ error: "Client not approved" }, 403);

  const nonce = db.query(
    "SELECT * FROM nonces WHERE value = ? AND fingerprint = ? AND used = 0 AND expires_at > ?"
  ).get(body.nonce, body.fingerprint, new Date().toISOString()) as any;
  if (!nonce) return c.json({ error: "Invalid or expired nonce" }, 401);

  const valid = await verifySignature(client.public_key, body.nonce, body.signature);
  if (!valid) return c.json({ error: "Signature verification failed" }, 401);

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
  const body = await c.req.json<{ username: string; password: string }>();

  if (body.username !== ADMIN_USER || !ADMIN_PASSWORD_HASH) {
    await Bun.sleep(500);
    return c.json({ error: "Invalid credentials" }, 401);
  }

  const valid = await Bun.password.verify(body.password, ADMIN_PASSWORD_HASH);
  if (!valid) {
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
    secure: true,
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
  const pending = db.query("SELECT * FROM clients WHERE status = 'pending' ORDER BY registered_at DESC").all();
  const active = db.query("SELECT * FROM clients WHERE status = 'active' ORDER BY last_seen DESC").all();
  const revoked = db.query("SELECT * FROM clients WHERE status = 'revoked'").all();
  const observersList = db.query("SELECT * FROM observers ORDER BY created_at DESC").all();
  const installURLs = getInstallURLs();

  return c.json({
    clients: { pending, active, revoked },
    observers: observersList,
    installURLs,
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

// GET /users — session or observer auth required
app.get("/users", requireSessionOrObserver, (c) => {
  const botNames = (db.query("SELECT name FROM clients WHERE status = 'active'").all() as any[]).map(r => r.name);
  const observerNames = (db.query("SELECT username FROM observers WHERE status = 'active'").all() as any[]).map(r => r.username);
  return c.json({ users: [...botNames, ...observerNames, ADMIN_USER] });
});

// POST /message — post session required (bot bearer or observer cookie)
// Server-side message dedup: reject identical content from same sender within window
const recentMessages = new Map<string, number>(); // "sender:content" -> timestamp
const DEDUP_WINDOW_MS = 5000; // 5 seconds

app.post("/message", requirePostSession, async (c) => {
  const body = await c.req.json<{ content: string }>();
  if (!body.content || typeof body.content !== "string") {
    return c.json({ error: "Missing content" }, 400);
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

  const msg: Message = {
    id: ++messageCounter,
    timestamp: new Date().toISOString(),
    sender: c.get("sender") as string,
    content: body.content,
    mentions: parseMentions(body.content),
  };

  messages.push(msg);
  broadcast(msg);
  deliverWebhooks(msg);

  return c.json({ id: msg.id, timestamp: msg.timestamp }, 201);
});

// --- Webhook Registration (client self-service) ---

const TAILNET_URL_RE = /^https?:\/\/(100\.\d+\.\d+\.\d+|[\w.-]+\.ts\.net)(:\d+)?(\/|$)/;

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

  return c.json({ messages: result, count: result.length });
});

// GET /messages/all — session or observer auth required
app.get("/messages/all", requireSessionOrObserver, (c) => {
  return c.json({ messages, count: messages.length });
});

// GET /events — SSE, session or observer auth required
app.get("/events", requireSessionOrObserver, (c) => {
  // Determine username/canPost from whichever principal authenticated
  const client = c.get("client") as any;
  const observer = c.get("observer") as any;
  const username = client?.name ?? observer?.username ?? "unknown";
  const userCanPost = client ? !!client.can_post : (observer ? !!observer.can_post : false);

  let cleanup: () => void;
  const stream = new ReadableStream({
    type: "direct",
    async pull(controller) {
      controller.write(`event: connected\ndata: ${JSON.stringify({ messageCount: messages.length, username, canPost: userCanPost })}\n\n`);
      controller.flush();

      const send = (msg: Message) => {
        try {
          controller.write(`event: message\ndata: ${JSON.stringify(msg)}\n\n`);
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

console.log(`SideChat v2 running
  Local:   http://localhost:${port}
  DB:      ${DB_PATH}
  Admin:   ${ADMIN_USER}
  Archive: ${ARCHIVE_DIR} (every 15 min)`);

export default {
  port,
  fetch: app.fetch,
  idleTimeout: 0,
};
