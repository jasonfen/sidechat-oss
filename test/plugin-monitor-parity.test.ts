// Payload-parity regression test for the webhook ↔ plugin-monitor cutover.
//
// The sidechat-monitor plugin's poll-mentions.sh and the sc-webhook-server.py
// listener both write to .sidechat/new-mentions.txt in a format that
// /mention-check consumes. When the skill reads a mention with file
// attachments, both paths must produce the same output — otherwise
// "@bot review this file" works on webhook-delivered bots and fails
// silently on plugin-delivered bots.
//
// This test spins a mock sidechat server (pending-mentions + file download),
// runs the plugin poll script once against it, and asserts the emitted lines
// match the shape sc-webhook-server.py emits: content line followed by one
// "  [file] NAME -> LOCAL_PATH" line per attachment.
//
// Run: bun test test/plugin-monitor-parity.test.ts
//
// Background: payload parity was re-gated as a retirement blocker on
// 2026-04-22 after audit found poll-mentions.sh:94's jq selector silently
// dropped files[]. This test is the close-the-gate insurance that any
// future regression (or channels/3.0 schema addition) gets caught in CI.

import { describe, it, expect, beforeAll, afterAll } from "bun:test";
import { mkdtempSync, writeFileSync, readFileSync, existsSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { spawn } from "node:child_process";

const REPO_ROOT = new URL("..", import.meta.url).pathname;
const SCRIPT = join(REPO_ROOT, "install/plugins/sidechat-monitor/scripts/poll-mentions.sh");

// Fixture: one mention with two attachments, exactly what a
// "@ansi review these files" message looks like server-side.
const FIXTURE_MESSAGE = {
  id: 9001,
  timestamp: "2026-04-22T14:00:00.000Z",
  sender: "jason",
  content: "@ansi review these files",
  mentions: ["ansi"],
  files: [
    { id: "abc-111", filename: "audit.md" },
    { id: "def-222", filename: "spec.txt" },
  ],
};
const FILE_BODIES: Record<string, string> = {
  "abc-111": "# audit body\n",
  "def-222": "spec body\n",
};

let server: ReturnType<typeof Bun.serve>;
let serverUrl: string;
let tmpDir: string;

beforeAll(async () => {
  server = Bun.serve({
    port: 0,
    fetch(req) {
      const url = new URL(req.url);
      if (url.pathname === "/messages/pending-mentions") {
        return Response.json({ messages: [FIXTURE_MESSAGE], count: 1 });
      }
      const dl = url.pathname.match(/^\/files\/([^/]+)\/download$/);
      if (dl) {
        const body = FILE_BODIES[dl[1]];
        if (body == null) return new Response("not found", { status: 404 });
        return new Response(body);
      }
      return new Response("not found", { status: 404 });
    },
  });
  serverUrl = `http://localhost:${server.port}`;

  tmpDir = mkdtempSync(join(tmpdir(), "sidechat-parity-"));
  writeFileSync(
    join(tmpDir, "config"),
    `SERVER_URL=${serverUrl}\nTOKEN=test-token\nBOT_NAME=ansi\n`
  );
});

afterAll(() => {
  server?.stop();
  if (tmpDir) rmSync(tmpDir, { recursive: true, force: true });
});

describe("poll-mentions.sh payload parity", () => {
  it("emits content line + [file] lines + downloads attachments", async () => {
    const mentionsFile = join(tmpDir, "new-mentions.txt");
    const idsFile = join(tmpDir, "new-mention-ids.txt");
    const filesDir = join(tmpDir, "files");

    // Run the poll script long enough for one iteration (interval=1s),
    // then kill it. SIDECHAT_POLL_INTERVAL_SEC controls the sleep.
    const child = spawn("bash", [SCRIPT], {
      env: {
        ...process.env,
        SIDECHAT_DIR: tmpDir,
        SIDECHAT_POLL_INTERVAL_SEC: "1",
        SIDECHAT_POLL_HOURS: "72",
      },
    });

    // Give it time: HTTP roundtrip + two file downloads + file writes.
    await new Promise((r) => setTimeout(r, 2500));
    child.kill("SIGTERM");

    expect(existsSync(mentionsFile)).toBe(true);
    const body = readFileSync(mentionsFile, "utf8");
    const lines = body.split("\n").filter(Boolean);

    // Line 1: content line. Timestamp rewritten to space format per
    // sc-webhook-server.py:113, "[ts] sender: content".
    expect(lines[0]).toBe("[2026-04-22 14:00:00] jason: @ansi review these files");

    // Lines 2+3: file lines. Order matches files[] array. Local path
    // is $SIDECHAT_DIR/files/${fid}_${basename}, mirror of
    // sc-webhook-server.py's FILES_DIR + naming scheme at line 81.
    expect(lines[1]).toBe(`  [file] audit.md -> ${filesDir}/abc-111_audit.md`);
    expect(lines[2]).toBe(`  [file] spec.txt -> ${filesDir}/def-222_spec.txt`);

    // Downloads actually happened and content matches what the mock
    // server returned. Catches "we emit the line but skip the HTTP call"
    // regressions.
    expect(readFileSync(`${filesDir}/abc-111_audit.md`, "utf8")).toBe("# audit body\n");
    expect(readFileSync(`${filesDir}/def-222_spec.txt`, "utf8")).toBe("spec body\n");

    // ids file tracked the mention so /mention-check's sc-receipt.sh read
    // can post receipts. Parity with webhook which does the same at
    // sc-webhook-server.py:135-137.
    const ids = readFileSync(idsFile, "utf8").trim().split("\n");
    expect(ids).toEqual(["9001"]);
  });
});
