// Channel push logic (2.8.0): flag detection, SSE parsing, which messages get
// pushed, and reconcile/reminder behaviour. Run: bun test (from mcp/)

import { describe, it, expect } from "bun:test";
import { channelEnabled, createChannel, mentionsMe, sseParser } from "../src/channel.ts";

describe("channelEnabled", () => {
  it("needs a channel flag naming this server", () => {
    expect(channelEnabled("claude --dangerously-load-development-channels server:sidechat --continue")).toBe(true);
    expect(channelEnabled("claude --channels plugin:sidechat@mk")).toBe(true);
    expect(channelEnabled("claude --continue -- prompt mentioning server:sidechat")).toBe(false);
    expect(channelEnabled("claude --dangerously-load-development-channels server:other")).toBe(false);
    expect(channelEnabled("claude --dangerously-load-development-channels server:sidechat-uat")).toBe(false);
  });
});

describe("sseParser", () => {
  it("joins events split across chunks and multi-line data", () => {
    const got: Array<[string, string]> = [];
    const feed = sseParser((e, d) => got.push([e, d]));
    feed("event: connected\ndata: {\"username\":");
    feed("\"ansi\"}\n\nevent: ping\r\ndata: keepalive\r\n\r\ndata: a\ndata: b\n\n");
    expect(got).toEqual([["connected", '{"username":"ansi"}'], ["ping", "keepalive"], ["message", "a\nb"]]);
  });
});

describe("mentionsMe", () => {
  const m = (sender: string, mentions: string[]) => ({ id: 1, sender, content: "", timestamp: "", mentions });
  it("matches case-insensitively and skips own messages", () => {
    expect(mentionsMe(m("fenbot", ["Ansi"]), "ansi")).toBe(true);
    expect(mentionsMe(m("ansi", ["ansi"]), "ansi")).toBe(false);
    expect(mentionsMe(m("fenbot", ["jason"]), "ansi")).toBe(false);
  });
});

function harness(pending: any[], nowMs: number) {
  const pushes: Array<{ content: string; meta: Record<string, string> }> = [];
  const calls: string[] = [];
  const fetch = async (path: string, init?: RequestInit) => {
    calls.push(`${init?.method ?? "GET"} ${path}`);
    if (path.startsWith("/messages/pending-mentions")) return new Response(JSON.stringify({ messages: pending }));
    return new Response("{}");
  };
  const ch = createChannel({
    fetch,
    notify: async (content, meta) => { pushes.push({ content, meta }); },
    log: () => {},
    now: () => nowMs,
  });
  return { ch, pushes, calls };
}

describe("createChannel", () => {
  const t0 = Date.parse("2026-10-18T12:00:00Z");
  const old = { id: 7, sender: "fenbot", content: "old ask", timestamp: "2026-10-18T11:00:00Z", mentions: ["ansi"] };

  it("pushes pending on connect, then live mentions once, and marks them delivered", async () => {
    const { ch, pushes, calls } = harness([old], t0);
    await ch.onEvent("connected", JSON.stringify({ username: "ansi" }));
    const live = { id: 8, sender: "jason", content: "hi @ansi", timestamp: "2026-10-18T12:00:00Z", mentions: ["ansi"], reply_to_id: 5 };
    await ch.onEvent("message", JSON.stringify(live));
    await ch.onEvent("message", JSON.stringify(live));
    await ch.onEvent("message", JSON.stringify({ ...live, id: 9, mentions: ["fenbot"] }));
    await ch.onEvent("ping", "keepalive");
    expect(pushes.map((p) => p.meta)).toEqual([
      { kind: "mention", msg_id: "7", sender: "fenbot" },
      { kind: "mention", msg_id: "8", sender: "jason", reply_to: "5" },
    ]);
    expect(calls).toContain("POST /messages/7/delivered");
    expect(calls).toContain("POST /messages/8/delivered");
  });

  it("re-surfaces a mention unanswered for 30 min exactly once", async () => {
    const { ch, pushes } = harness([old], t0);
    await ch.onEvent("connected", JSON.stringify({ username: "ansi" }));
    await ch.reconcile();
    await ch.reconcile();
    expect(pushes.map((p) => p.meta.kind)).toEqual(["mention", "reminder"]);
    expect(pushes[1].content).toStartWith("Still unanswered after 60 min:");
  });

  it("ignores messages before it knows who it is, and survives bad data", async () => {
    const { ch, pushes } = harness([], t0);
    await ch.onEvent("message", JSON.stringify(old));
    await ch.onEvent("message", "not json");
    expect(pushes).toEqual([]);
  });
});
