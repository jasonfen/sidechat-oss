// Phase 0 stub MCP server — notification-compat probe.
//
// Goal: determine whether the currently-installed Claude Code MCP client
// surfaces unsolicited `notifications/message` events to the user mid-session.
// The result gates Phase 2 of the SideChat MCP plan:
//   - If the client surfaces the notifications → Phase 2 ships push-based
//     `pending_mention` events via the MCP notification primitive.
//   - If the client ignores them (or only processes them on the next tool
//     call) → Phase 2 falls back to polling `list_pending_mentions()` from a
//     Stop/SessionStart hook.
//
// Behavior:
//   - Exposes one tool `probe_ping(message?)` so the operator can verify the
//     server is alive and the stdio transport is wired up.
//   - Every PROBE_INTERVAL_MS (default 30_000), emits a `notifications/message`
//     with a monotonic sequence number so we can spot whether Claude Code
//     drops, batches, or surfaces them in real time.
//   - Logs each emission to stderr so the human running the probe has a
//     ground-truth timeline independent of the MCP client's behavior.

import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import {
  CallToolRequestSchema,
  ListToolsRequestSchema,
} from "@modelcontextprotocol/sdk/types.js";

const PROBE_INTERVAL_MS = Number(process.env.PROBE_INTERVAL_MS ?? "30000");

const server = new Server(
  { name: "sidechat-mcp-probe", version: "0.0.1" },
  {
    capabilities: {
      tools: {},
      logging: {},
    },
  }
);

server.setRequestHandler(ListToolsRequestSchema, async () => ({
  tools: [
    {
      name: "probe_ping",
      description:
        "Returns a timestamped echo. Verifies the stdio MCP transport is live between Claude Code and this probe server.",
      inputSchema: {
        type: "object",
        properties: {
          message: { type: "string", description: "Optional echo string." },
        },
      },
    },
  ],
}));

server.setRequestHandler(CallToolRequestSchema, async (req) => {
  if (req.params.name !== "probe_ping") {
    throw new Error(`Unknown tool: ${req.params.name}`);
  }
  const msg = (req.params.arguments?.message as string | undefined) ?? "pong";
  return {
    content: [
      {
        type: "text",
        text: JSON.stringify({
          echo: msg,
          server_time: new Date().toISOString(),
        }),
      },
    ],
  };
});

async function main() {
  const transport = new StdioServerTransport();
  await server.connect(transport);
  process.stderr.write(
    `[probe] connected. Emitting notifications/message every ${PROBE_INTERVAL_MS}ms.\n`
  );

  let seq = 0;
  setInterval(() => {
    seq += 1;
    const payload = {
      level: "info",
      logger: "sidechat-probe",
      data: {
        seq,
        emitted_at: new Date().toISOString(),
        note: "Phase 0 notification-compat probe",
      },
    };
    // Spec: notifications/message has params {level, logger?, data}
    server.notification({ method: "notifications/message", params: payload }).catch(
      (err) => process.stderr.write(`[probe] notification send failed: ${err}\n`)
    );
    process.stderr.write(
      `[probe] emitted seq=${seq} at ${payload.data.emitted_at}\n`
    );
  }, PROBE_INTERVAL_MS);
}

main().catch((err) => {
  process.stderr.write(`[probe] fatal: ${err}\n`);
  process.exit(1);
});
