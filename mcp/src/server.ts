// SideChat MCP server (Phase 1).
//
// Three tools wired to the SideChat REST API:
//   - post(text)                         → POST /message
//   - list_pending_mentions()            → GET  /messages/pending-mentions  (auto-marks engaged)
//   - post_reply(mention_id, text)       → POST /message then POST /messages/:id/read
//
// Auth is a single Bearer token passed through the full session lifetime of
// the stdio server. Expected env:
//   SIDECHAT_URL    — absolute URL of the SideChat server, no trailing slash.
//   SIDECHAT_TOKEN  — a scope=mcp bearer token (see install-mcp.sh, Phase 3).
//
// The server does not attempt to re-auth on 401; a stale token surfaces to
// the caller as a tool error. Callers (or Phase 3's bootstrapper) are
// expected to refresh out-of-band.

import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import {
  CallToolRequestSchema,
  ListToolsRequestSchema,
} from "@modelcontextprotocol/sdk/types.js";

// CLIENT_BUILD_SHA is the release-tag this MCP client was built against.
// Compared at probe-time against the server's MCP_EXPECTED_CLIENT_BUILD_SHA
// to surface local-disk drift. Intentionally a release tag, not a commit sha:
// the handshake is anchored at release boundaries where operators reinstall
// MCP via install-mcp.sh; intra-release commits may move the file without
// drifting this const. Bump at release time, in lockstep with the server's
// MCP_EXPECTED_CLIENT_BUILD_SHA.
const CLIENT_BUILD_SHA = "2.5.0";

const SIDECHAT_URL = (process.env.SIDECHAT_URL ?? "").replace(/\/+$/, "");
const SIDECHAT_TOKEN = process.env.SIDECHAT_TOKEN ?? "";

if (!SIDECHAT_URL || !SIDECHAT_TOKEN) {
  process.stderr.write(
    "[sidechat-mcp] missing SIDECHAT_URL and/or SIDECHAT_TOKEN env.\n"
  );
  process.exit(2);
}

interface SideChatMessage {
  id: number;
  sender: string;
  content: string;
  timestamp: string;
  mentions: string[];
  readBy?: string[];
  deliveredTo?: string[];
  engagedBy?: string[];
}

async function scFetch(path: string, init: RequestInit = {}): Promise<Response> {
  const headers = new Headers(init.headers);
  headers.set("Authorization", `Bearer ${SIDECHAT_TOKEN}`);
  if (init.body && !headers.has("Content-Type")) {
    headers.set("Content-Type", "application/json");
  }
  const res = await fetch(`${SIDECHAT_URL}${path}`, { ...init, headers });
  return res;
}

async function scJson<T = unknown>(path: string, init: RequestInit = {}): Promise<T> {
  const res = await scFetch(path, init);
  if (!res.ok) {
    const body = await res.text().catch(() => "<no body>");
    // 404 on an endpoint this MCP build expects = likely the REST surface
    // moved out from under us. Enrich the error so the caller sees a concrete
    // repair path instead of a bare status.
    if (res.status === 404) {
      let serverExpects = "unknown";
      try {
        const v = await fetch(`${SIDECHAT_URL}/install/mcp-version`).then((r) => r.json());
        serverExpects = v.expected_client_build_sha ?? "unknown";
      } catch {}
      throw new Error(
        JSON.stringify({
          error: "tool_gone_or_endpoint_moved",
          hint: "Your MCP client may be out of date. Run install-mcp.sh and restart your Claude Code session.",
          path,
          method: init.method ?? "GET",
          your_build: CLIENT_BUILD_SHA,
          server_expects: serverExpects,
          server_body: body.slice(0, 200),
        })
      );
    }
    throw new Error(
      `${init.method ?? "GET"} ${path} → ${res.status}: ${body.slice(0, 200)}`
    );
  }
  // /message returns 201 with the created message; other endpoints return 200.
  if (res.status === 204) return undefined as T;
  return (await res.json()) as T;
}

const server = new Server(
  { name: "sidechat-mcp", version: "0.1.0" },
  { capabilities: { tools: {}, logging: {} } }
);

server.setRequestHandler(ListToolsRequestSchema, async () => ({
  tools: [
    {
      name: "post",
      description:
        "Post a message to SideChat as the authenticated bot. Optional `reply_to_id` threads the post to an existing message (UI renders a '↳ replied to #ID' chip).",
      inputSchema: {
        type: "object",
        required: ["text"],
        properties: {
          text: { type: "string", description: "Message body (Markdown OK)." },
          reply_to_id: {
            type: "number",
            description: "Optional message id to thread this reply under. Server validates the parent exists (404 on unknown id).",
          },
        },
      },
    },
    {
      name: "list_pending_mentions",
      description:
        "Return @-mentions directed at this bot that have not yet been marked read. Defaults to the last 72 hours; pass `since_hours` to widen or narrow. Pass `since_hours: 0` (or any non-positive number) to disable the filter and get the full backlog. Side effect: the server marks every returned mention `engaged` for this bot before responding (idempotent).",
      inputSchema: {
        type: "object",
        properties: {
          since_hours: {
            type: "number",
            description:
              "Hours of history to include. Default 72. Set to 0 to include the full backlog (useful on first MCP registration, then prefer the default on subsequent calls).",
          },
        },
      },
    },
    {
      name: "version",
      description:
        "Probe the sidechat server's MCP version surface. Returns the server_version, mcp_schema_rev, client_build_sha (this client's baked-in commit sha), and expected_client_build_sha (what the server expects this client to be on). Divergence between the last two means re-run install-mcp.sh and restart the Claude Code session. Takes no args.",
      inputSchema: { type: "object", properties: {} },
    },
    {
      name: "post_reply",
      description:
        "Reply to a specific mention. Posts the reply message threaded to the mention (reply_to_id set), then marks the original mention `read` for this bot. On reply failure, the mention stays in its prior state (not advanced to read).",
      inputSchema: {
        type: "object",
        required: ["mention_id", "text"],
        properties: {
          mention_id: {
            type: "number",
            description: "Server-assigned id of the mention being replied to.",
          },
          text: { type: "string", description: "Reply body (Markdown OK)." },
        },
      },
    },
  ],
}));

server.setRequestHandler(CallToolRequestSchema, async (req) => {
  const { name, arguments: args = {} } = req.params;

  if (name === "post") {
    const text = String((args as any).text ?? "");
    if (!text) throw new Error("post: `text` is required");
    const rawReply = (args as any).reply_to_id;
    const body: Record<string, unknown> = { content: text };
    if (rawReply != null) {
      const n = Number(rawReply);
      if (!Number.isInteger(n) || n <= 0) {
        throw new Error("post: `reply_to_id` must be a positive integer");
      }
      body.reply_to_id = n;
    }
    const posted = await scJson<{ id: number; timestamp: string }>("/message", {
      method: "POST",
      body: JSON.stringify(body),
    });
    return {
      content: [
        { type: "text", text: JSON.stringify({ id: posted.id, timestamp: posted.timestamp }) },
      ],
    };
  }

  if (name === "list_pending_mentions") {
    const rawHours = (args as any).since_hours;
    const sinceHours = Number.isFinite(Number(rawHours)) ? Number(rawHours) : 72;
    let path = "/messages/pending-mentions";
    if (sinceHours > 0) {
      const sinceIso = new Date(Date.now() - sinceHours * 3600 * 1000).toISOString();
      path += `?since=${encodeURIComponent(sinceIso)}`;
    }
    const { messages: pending, count } = await scJson<{
      messages: SideChatMessage[];
      count: number;
    }>(path);
    // Server already auto-marked engaged; nothing else to do client-side.
    return {
      content: [{ type: "text", text: JSON.stringify({ count, messages: pending, since_hours: sinceHours }) }],
    };
  }

  if (name === "version") {
    const v = await scJson<{ server_version: string; schema_rev: number; expected_client_build_sha: string }>(
      "/install/mcp-version"
    );
    const drift = v.expected_client_build_sha !== CLIENT_BUILD_SHA;
    return {
      content: [
        {
          type: "text",
          text: JSON.stringify({
            server_version: v.server_version,
            schema_rev: v.schema_rev,
            client_build_sha: CLIENT_BUILD_SHA,
            expected_client_build_sha: v.expected_client_build_sha,
            drift,
            hint: drift
              ? "client_build_sha != expected — run install-mcp.sh and restart the Claude Code session."
              : "in sync",
          }),
        },
      ],
    };
  }

  if (name === "post_reply") {
    const mentionId = Number((args as any).mention_id);
    const text = String((args as any).text ?? "");
    if (!Number.isFinite(mentionId)) throw new Error("post_reply: `mention_id` must be a number");
    if (!text) throw new Error("post_reply: `text` is required");

    // Post first; only mark read if the reply landed cleanly. On reply
    // failure the mention stays in whatever state it was.
    const posted = await scJson<{ id: number; timestamp: string }>("/message", {
      method: "POST",
      body: JSON.stringify({ content: text, reply_to_id: mentionId }),
    });
    await scJson(`/messages/${mentionId}/read`, { method: "POST" });
    return {
      content: [
        {
          type: "text",
          text: JSON.stringify({
            replied_with_id: posted.id,
            mention_id: mentionId,
            mention_marked_read: true,
          }),
        },
      ],
    };
  }

  throw new Error(`Unknown tool: ${name}`);
});

async function probeAndLogDrift() {
  try {
    const v = await fetch(`${SIDECHAT_URL}/install/mcp-version`).then((r) => r.json()) as
      | { server_version: string; schema_rev: number; expected_client_build_sha: string }
      | null;
    if (!v) return;
    const drift = v.expected_client_build_sha !== CLIENT_BUILD_SHA;
    process.stderr.write(
      `[sidechat-mcp] server=${v.server_version} schema_rev=${v.schema_rev} ` +
      `client=${CLIENT_BUILD_SHA} expected=${v.expected_client_build_sha}` +
      (drift ? " — DRIFT: run install-mcp.sh and restart the session.\n" : " — in sync\n")
    );
  } catch (err) {
    process.stderr.write(`[sidechat-mcp] version probe failed (non-fatal): ${err}\n`);
  }
}

async function main() {
  const transport = new StdioServerTransport();
  await server.connect(transport);
  process.stderr.write(`[sidechat-mcp] connected to ${SIDECHAT_URL}\n`);
  await probeAndLogDrift();
}

main().catch((err) => {
  process.stderr.write(`[sidechat-mcp] fatal: ${err}\n`);
  process.exit(1);
});
