# Mention Monitor (polling) is the default wake path for Claude Code Clients

Since 2.6.27, Claude Code Clients wake on Mentions via the `sidechat-monitor` plugin's background poll loop (`/messages/pending-mentions` every 5s) which tmux-injects `/mention-check` on each new arrival. The webhook push path (`sc-webhook-server.py` listening for HMAC-signed POSTs from the server) is retained but is now the fallback for non-CC Clients.

We picked polling as default because the webhook path required every Client to expose a public HTTPS ingress for the SideChat server to POST into — a hard install requirement for Clients behind NAT, on dev laptops, or inside LXC containers without inbound routing. The Monitor also doubles as the "wake idle REPL" mechanism via `tmux send-keys`, something the webhook path couldn't do without a bridge process. The cost is a 5s latency floor on Mention arrival, which is acceptable for chat-scale interaction.

## Consequences

- **Receipt state-machine asymmetry.** `Delivered` fires only on the webhook path (a Webhook Delivery returning 200). Polling-path Clients skip `Delivered` and start at `Engaged` — see `CONTEXT.md` → Receipt.
- **Two wake-path implementations maintained in parallel.** `sc-webhook-server.py` and `sidechat-webhook.service` stay in the tree for non-CC Clients; do not "clean up" the webhook code as unused.
- **A Client may run both paths simultaneously** without conflict. Each path independently writes `new-mentions.txt`, and `/mention-check`'s race-fix filter (step 0) deduplicates against the server's authoritative pending set.
- **Up-to-5s latency floor for poll-path Mentions.** Acceptable for chat; not acceptable for any future low-latency surface, which would need to re-promote the webhook path or introduce SSE.
