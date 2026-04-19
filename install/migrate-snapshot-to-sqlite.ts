#!/usr/bin/env bun
// One-shot migration: read a pre-2.4.0 messages.json snapshot and backfill
// messages + message_receipts into the SQLite DB used by 2.4.0+.
//
// Idempotent by empty-table guard: if `messages` already has rows, the
// script exits 0 without touching the DB. Safe to re-run.
//
// Usage:
//   bun run install/migrate-snapshot-to-sqlite.ts \
//     --snapshot /var/sidechat/archives/messages.json \
//     --db /var/sidechat/sidechat.db
//
// Expected snapshot shape (pre-2.4.0 writeSnapshot):
//   { messages: [...], messageCounter, readReceipts: [[id, [users]], ...],
//     deliveryReceipts: [...], engagedReceipts: [...] }
//
// Exit codes:
//   0 — success (or no-op because table already populated)
//   1 — bad args / snapshot shape / runtime error

import { Database } from "bun:sqlite";

const args = process.argv.slice(2);
let snapshotPath = "";
let dbPath = "";
for (let i = 0; i < args.length; i++) {
  if (args[i] === "--snapshot") snapshotPath = args[++i];
  else if (args[i] === "--db") dbPath = args[++i];
}
if (!snapshotPath || !dbPath) {
  console.error("Usage: bun migrate-snapshot-to-sqlite.ts --snapshot <path> --db <path>");
  process.exit(1);
}

const snapFile = Bun.file(snapshotPath);
if (!(await snapFile.exists())) {
  console.error(`snapshot not found: ${snapshotPath}`);
  process.exit(1);
}
const snap = await snapFile.json() as {
  messages?: Array<{
    id: number;
    timestamp: string;
    sender: string;
    content: string;
    mentions?: string[];
    reply_to_id?: number | null;
  }>;
  readReceipts?: Array<[number, string[]]>;
  deliveryReceipts?: Array<[number, string[]]>;
  engagedReceipts?: Array<[number, string[]]>;
};

const db = new Database(dbPath);
db.exec("PRAGMA journal_mode=WAL");
db.exec(`
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

const existing = (db.query("SELECT COUNT(*) AS n FROM messages").get() as { n: number }).n;
if (existing > 0) {
  console.log(`no-op: messages table already has ${existing} rows (idempotent exit)`);
  process.exit(0);
}

const messages = snap.messages ?? [];
if (messages.length === 0) {
  console.log("no-op: snapshot has zero messages");
  process.exit(0);
}

const insertMsg = db.prepare(
  "INSERT INTO messages (id, timestamp, sender, content, mentions, reply_to_id) VALUES (?, ?, ?, ?, ?, ?)"
);
const insertReceipt = db.prepare(
  "INSERT OR IGNORE INTO message_receipts (message_id, username, kind, created_at) VALUES (?, ?, ?, ?)"
);
const backfillTs = new Date().toISOString();

const tx = db.transaction(() => {
  for (const m of messages) {
    insertMsg.run(
      m.id,
      m.timestamp,
      m.sender,
      m.content,
      JSON.stringify(m.mentions ?? []),
      m.reply_to_id ?? null
    );
  }
  let r = 0, d = 0, e = 0;
  for (const [mid, users] of snap.readReceipts ?? []) {
    for (const u of users) { insertReceipt.run(mid, u, "read", backfillTs); r++; }
  }
  for (const [mid, users] of snap.deliveryReceipts ?? []) {
    for (const u of users) { insertReceipt.run(mid, u, "delivered", backfillTs); d++; }
  }
  for (const [mid, users] of snap.engagedReceipts ?? []) {
    for (const u of users) { insertReceipt.run(mid, u, "engaged", backfillTs); e++; }
  }
  return { r, d, e };
});

const start = Date.now();
const counts = tx();
const elapsed = Date.now() - start;

const msgCount = (db.query("SELECT COUNT(*) AS n FROM messages").get() as { n: number }).n;
const maxId = (db.query("SELECT COALESCE(MAX(id), 0) AS m FROM messages").get() as { m: number }).m;
const receiptCount = (db.query("SELECT COUNT(*) AS n FROM message_receipts").get() as { n: number }).n;

console.log(`backfill complete in ${elapsed}ms:`);
console.log(`  messages:  ${msgCount} (max id = ${maxId})`);
console.log(`  receipts:  ${receiptCount} (read=${counts.r} delivered=${counts.d} engaged=${counts.e})`);
console.log(`  snapshot:  ${snapshotPath}`);
console.log(`  db:        ${dbPath}`);
