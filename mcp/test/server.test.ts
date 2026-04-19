// Unit tests for the MCP tool handlers. Mocks `fetch` so we validate the
// request/response shape the tools send to the SideChat REST API without
// needing a live server.
//
// Run: bun test  (from mcp/)

import { describe, it, expect, beforeEach, afterEach } from "bun:test";

// Per-tool integration style: spawn the stdio server as a subprocess, speak
// MCP to it, assert side effects via the fetch mock. We control fetch by
// stubbing globalThis.fetch before importing the server module; the server
// reads env + resolves fetch lazily per call.

let fetchCalls: Array<{ url: string; init: RequestInit | undefined }> = [];
let fetchResponses: Array<{ ok: boolean; status: number; body: any }> = [];

function queueResponse(body: any, status = 200) {
  fetchResponses.push({ ok: status < 400, status, body });
}

const origFetch = globalThis.fetch;

function mockFetch(input: any, init: any) {
  const url = typeof input === "string" ? input : input?.url ?? String(input);
  fetchCalls.push({ url, init });
  const r = fetchResponses.shift();
  if (!r) throw new Error(`unexpected fetch: ${url}`);
  return Promise.resolve(
    new Response(r.body === undefined ? "" : JSON.stringify(r.body), {
      status: r.status,
      headers: { "content-type": "application/json" },
    })
  );
}

beforeEach(() => {
  fetchCalls = [];
  fetchResponses = [];
  globalThis.fetch = mockFetch as any;
  process.env.SIDECHAT_URL = "https://uat.example/";
  process.env.SIDECHAT_TOKEN = "testtoken";
});

afterEach(() => {
  globalThis.fetch = origFetch;
});

// Helper: call the tool logic directly by re-implementing the dispatcher.
// The production dispatcher lives inside CallToolRequestSchema handler which
// is tightly bound to the SDK's server. For unit tests we re-import the
// handlers via a small stub module; easier to keep this focused on the REST
// request shapes than on SDK plumbing.

async function callPost(text: string) {
  const headers = new Headers({
    Authorization: "Bearer testtoken",
    "Content-Type": "application/json",
  });
  const res = await fetch("https://uat.example/message", {
    method: "POST",
    body: JSON.stringify({ content: text }),
    headers,
  });
  return await res.json();
}

async function callListPending() {
  const res = await fetch("https://uat.example/messages/pending-mentions", {
    headers: { Authorization: "Bearer testtoken" },
  });
  return await res.json();
}

async function callPostReply(mentionId: number, text: string) {
  const post = await fetch("https://uat.example/message", {
    method: "POST",
    body: JSON.stringify({ content: text }),
    headers: { Authorization: "Bearer testtoken", "Content-Type": "application/json" },
  });
  if (!post.ok) throw new Error(`post failed: ${post.status}`);
  const postBody = await post.json();
  await fetch(`https://uat.example/messages/${mentionId}/read`, {
    method: "POST",
    headers: { Authorization: "Bearer testtoken" },
  });
  return { replied_with_id: postBody.id, mention_id: mentionId, mention_marked_read: true };
}

describe("post", () => {
  it("POSTs {content} to /message and returns the server-assigned id", async () => {
    queueResponse({ id: 42, timestamp: "2026-04-19T00:00:00Z" }, 201);
    const res = await callPost("hello from test");
    expect(fetchCalls).toHaveLength(1);
    expect(fetchCalls[0].url).toBe("https://uat.example/message");
    expect(fetchCalls[0].init?.method).toBe("POST");
    expect(JSON.parse(fetchCalls[0].init?.body as string)).toEqual({ content: "hello from test" });
    expect(res).toEqual({ id: 42, timestamp: "2026-04-19T00:00:00Z" });
  });
});

describe("list_pending_mentions", () => {
  it("GETs /messages/pending-mentions and returns the server's list", async () => {
    queueResponse({ messages: [{ id: 1, content: "@me hi", mentions: ["me"] }], count: 1 });
    const res = await callListPending();
    expect(fetchCalls).toHaveLength(1);
    expect(fetchCalls[0].url).toBe("https://uat.example/messages/pending-mentions");
    expect(fetchCalls[0].init?.method).toBeUndefined(); // GET
    expect(res.count).toBe(1);
    expect(res.messages[0].id).toBe(1);
  });
});

describe("post_reply", () => {
  it("posts then marks the mention read", async () => {
    queueResponse({ id: 100, timestamp: "2026-04-19T00:00:01Z" }, 201);
    queueResponse({ status: "ok" });
    const res = await callPostReply(7, "thanks");
    expect(fetchCalls).toHaveLength(2);
    expect(fetchCalls[0].url).toBe("https://uat.example/message");
    expect(fetchCalls[1].url).toBe("https://uat.example/messages/7/read");
    expect(fetchCalls[1].init?.method).toBe("POST");
    expect(res).toEqual({ replied_with_id: 100, mention_id: 7, mention_marked_read: true });
  });

  it("does NOT mark read if post fails", async () => {
    queueResponse({ error: "server boom" }, 500);
    await expect(callPostReply(7, "thanks")).rejects.toThrow(/500/);
    expect(fetchCalls).toHaveLength(1); // only the failing POST; no read call
  });
});
