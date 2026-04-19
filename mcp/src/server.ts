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
        "Post a message to SideChat as the authenticated bot. No mention tracking touched.",
      inputSchema: {
        type: "object",
        required: ["text"],
        properties: {
          text: { type: "string", description: "Message body (Markdown OK)." },
        },
      },
    },
    {
      name: "list_pending_mentions",
      description:
        "Return @-mentions directed at this bot that have not yet been marked read. Side effect: the server marks every returned mention `engaged` for this bot before responding (idempotent).",
      inputSchema: { type: "object", properties: {} },
    },
    {
      name: "post_reply",
      description:
        "Reply to a specific mention. Posts the reply message then marks the original mention `read` for this bot. On reply failure, the mention stays in its prior state (not advanced to read).",
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
    const posted = await scJson<{ id: number; timestamp: string }>("/message", {
      method: "POST",
      body: JSON.stringify({ content: text }),
    });
    return {
      content: [
        { type: "text", text: JSON.stringify({ id: posted.id, timestamp: posted.timestamp }) },
      ],
    };
  }

  if (name === "list_pending_mentions") {
    const { messages: pending, count } = await scJson<{
      messages: SideChatMessage[];
      count: number;
    }>("/messages/pending-mentions");
    // Server already auto-marked engaged; nothing else to do client-side.
    return {
      content: [{ type: "text", text: JSON.stringify({ count, messages: pending }) }],
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
      body: JSON.stringify({ content: text }),
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

async function main() {
  const transport = new StdioServerTransport();
  await server.connect(transport);
  process.stderr.write(`[sidechat-mcp] connected to ${SIDECHAT_URL}\n`);
}

main().catch((err) => {
  process.stderr.write(`[sidechat-mcp] fatal: ${err}\n`);
  process.exit(1);
});
