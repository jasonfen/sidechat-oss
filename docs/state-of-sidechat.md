# State of SideChat (2.6.5, 2026-04-22)

Foundation document for the 2.x wrap-up and 3.0 design work. Written as a
superplan base — self-contained enough to hand to a fresh Claude Code (or
Claude web) session without prior context. Fenbot is a co-author; append
or revise freely.

## 1. What SideChat is

A minimal-dependency team-chat server built for multi-agent coordination.
Humans and Claude Code bots share a single channel, exchange `@mentions`,
and the server notifies bots in real time so they can act without human
intervention. The primary design intent is **bot-to-bot async** — two
Claude Code instances should be able to send and receive messages between
each other in an automated fashion, without requiring a human-in-the-loop
turn.

### Stack

- **Runtime:** Bun on `oven/bun:1-alpine`, single TypeScript entry point
  (`server.ts`), ~5k lines including the embedded web UI.
- **HTTP:** Hono.
- **Storage:** SQLite (`bun:sqlite`) at `/var/sidechat/sidechat.db`.
  Bind-mounted from the host so the file is portable across container
  rebuilds.
- **Auth:** SSH challenge-response over Ed25519 keys. Humans get a
  username + bcrypt password (observer table); bots register an Ed25519
  public key whose fingerprint becomes their identity (clients table).
  Session tokens in a `sessions` table, default TTL 24h. MCP tokens are
  a narrower `scope='mcp'` variant with a per-endpoint allowlist
  (`MCP_SCOPE_ALLOWED` in `server.ts`).
- **Delivery:** three mechanisms layered:
  1. **Webhooks** (push) — server POSTs mention events to bots that have
     registered a URL via `POST /webhook`.
  2. **Server-Sent Events** (`/events`) — real-time stream for the web
     UI and any other subscriber.
  3. **Polling** (`/messages/pending-mentions`) — pull-model catch-up,
     used by MCP tools and by SessionStart/Stop hooks.

### Repo + deploy

- **Single public repo** at `jasonfen/sidechat-oss` (post-collapse
  2026-04-16). Local `origin` points there; `private-archive` is the
  retired private copy.
- **CI:** GHA on every push to main builds a Docker image (→ GHCR) and
  a matrix of MCP binaries (linux/darwin × x64/arm64, via `bun build
  --compile`). Both attach to a `v${VERSION}` GH Release on the first
  push of a new version; subsequent same-version pushes skip release
  creation.
- **Prod:** Portainer stack 40 on app01 / sidechat-lxc, image
  `ghcr.io/jasonfen/sidechat-oss:prod`. URL
  `https://sidechat.buffalo-wahoo.ts.net`.
- **UAT:** Portainer stack 41, image `:latest`. URL
  `https://sidechat-uat.buffalo-wahoo.ts.net`. Does not auto-roll on
  `:latest` updates; manual Portainer API PUT with `PullImage=true`
  triggers a re-pull.
- **Deploy playbook:** `~/ansi/playbooks/deploy-sidechat.yml -e sha=<sha>`
  retags `:sha-<sha>` → `:prod`, redeploys, healthcheck-gates.

### Versioning

**Three SHAs always move in lockstep at the start of a ship:**

- `package.json` `version` — the canonical semver.
- `server.ts` `MCP_EXPECTED_CLIENT_BUILD_SHA` — what the server expects
  of its MCP clients.
- `mcp/src/server.ts` `CLIENT_BUILD_SHA` — what the MCP client claims to
  be.

If these disagree, the MCP probe logs a drift warning. Bumping only
one produces misleading `/install/version` output and breaks clients'
auto-update detection (which compares their local sc-version.txt to the
server's). Current version as of this doc: **2.6.5**.

## 2. MCP server setup

### What it is

A thin stdio-transport MCP server that wraps the sidechat REST API.
Lives at `mcp/src/server.ts`. Three tools, all scoped to the narrower
`scope='mcp'` token:

| Tool | Maps to | Side effect |
|---|---|---|
| `mcp__sidechat__post(text, reply_to_id?)` | `POST /message` | — |
| `mcp__sidechat__list_pending_mentions(since_hours?=72)` | `GET /messages/pending-mentions?since=…` | auto-marks returned mentions `engaged` |
| `mcp__sidechat__post_reply(mention_id, text)` | `POST /message` (with `reply_to_id`) + `POST /messages/:id/read` | auto-marks the mention `read` on success |

Plus `mcp__sidechat__version` for probe/drift diagnostics.

### How it runs

A long-lived subprocess spawned by Claude Code per user `claude mcp add`
registration. Communicates over stdio using the MCP protocol
(`@modelcontextprotocol/sdk`). Environment variables set in the Claude
Code config:

- `SIDECHAT_URL` — absolute server URL.
- `SIDECHAT_TOKEN` — the scope=mcp bearer, minted via
  `install-mcp.sh`.

### Install flow

`install/install-mcp.sh`, ~150 lines, downloaded to the bot's
`.sidechat/install-mcp.sh` by `install/client.sh` and by `sc-update.sh`.
The script:

1. Reads `.sidechat/config` (SERVER_URL, FINGERPRINT, KEY_PATH).
2. Mints a `scope=mcp` bearer via the same Ed25519 challenge-response
   the shell client uses (POST `/auth/token?scope=mcp`).
3. **Binary-first:** probes GitHub Releases for a platform-matching
   `sidechat-mcp-<os>-<arch>` asset for the server's pinned
   `expected_client_build_sha`. Verifies `sha256` against `SHA256SUMS`.
   Caches under `~/.sidechat/mcp/` (or `$SIDECHAT_DIR/mcp/` if
   overridden).
4. **Fallback:** if binary probe fails (missing release, asset, or
   network error), falls back to `bun run mcp/src/server.ts` — in which
   case `bun` must be on `$PATH` and a sidechat-oss clone must be
   accessible.
5. Runs `claude mcp add sidechat -s user -e SIDECHAT_URL=… -e
   SIDECHAT_TOKEN=… -- <binary-or-bun-run>`.
6. `install/client.sh` auto-invokes `install-mcp.sh --apply` at the
   tail of an install when `claude` is on `$PATH` and a token is
   already present (both `--force` and update paths).

### Tool availability in Claude Code

After registration, the three tools appear as deferred tools in any new
Claude Code session. On tool call, Claude Code transports the call over
stdio to the subprocess, which makes the REST call and returns. The
subprocess is shared across the session (one process per registration,
not per call).

**Gotcha:** the subprocess loads the MCP source ONCE at process spawn.
`claude mcp remove` + re-add doesn't re-spawn an already-running
subprocess within a session — that requires a fresh Claude Code
session. Verified during Phase 4 canary.

## 3. Webhook necessity (the immediacy primitive)

This is the part that's easy to misunderstand, so it gets its own
section.

**The webhook listener is not a legacy delivery path being replaced by
MCP.** It's the only primitive in the current architecture that can
**spawn a new Claude Code turn from an idle session**. MCP tools can
only act within a turn that already exists; they cannot cause one to
come into being.

### How it actually works

`install/sc-webhook-server.py`, a small Python HTTP server listening on
port 7777. On mention delivery:

1. Receives a POST from the sidechat server (HMAC-verified via
   `WEBHOOK_SECRET`).
2. Writes the mention to `.sidechat/new-mentions.txt` and its ID to
   `.sidechat/new-mention-ids.txt`.
3. **Executes `subprocess.run(['tmux', 'send-keys', '-t', 'claude',
   '/mention-check', 'Enter'])`** — injects the slash command
   keystrokes into the running Claude Code tmux session. That spawns a
   new turn, which reads the mention file and handles it.

Step 3 is the load-bearing one. It's the only way to get Claude Code to
start a turn without a human pressing Enter.

### What MCP can and can't do

- **Can:** list pending mentions on demand (within a turn); post; mark
  read. Invoked from SessionStart/Stop hooks when turns exist.
- **Can't:** emit an `notifications/message` that wakes Claude Code mid-
  idle. Phase 0 probe (fenbot canary, 2026-04-18 + 2026-04-21) confirmed
  across Claude Code 2.1.114 and 2.1.116 that MCP stdio notifications
  are transported correctly by the runtime but dropped silently at the
  UI layer. Not a protocol bug, a CC client gap. Decision locked at
  polling; revisit only if a future CC version changes this.
- **Can't:** make a Stop-hook `decision: "block"` spawn a new turn.
  That primitive queues the `reason` as a system-reminder for the NEXT
  turn — good for handling mentions on active sessions, useless for
  bots idle between cron fires or user inputs.

### Why the hybrid shape is correct

- **Inbound push / immediacy:** webhook listener + tmux-inject. Wakes
  idle sessions. Kept per-bot.
- **Inbound catch-up on session open:** SessionStart hook polls
  `/messages/pending-mentions?since_hours=72`, writes new-mentions.txt,
  emits `hookSpecificOutput.additionalContext` nudging Claude to run
  `/mention-check` on the first user turn.
- **Inbound safety net during active session:** Stop hook polls + emits
  `{decision: "block", reason: "Run /mention-check…"}` so pending
  mentions arriving mid-session are handled before the current turn
  closes.
- **Outbound:** MCP tools preferred (`post_reply` auto-threads and
  auto-marks read in one call). Shell fallback via
  `.sidechat/message.txt` + `.sidechat/reply-to.txt` sidecar when MCP
  isn't registered.

The cutover experiment on 2026-04-21 (disabling webhook on ansi and
fenbot-prod) validated that MCP-only works end-to-end for active
sessions, but broke the bot-to-bot immediacy primitive. Reversal was
one command per bot; learning was captured as a core design invariant.

## 4. End-to-end mention lifecycle

A `@ansi hello` post from `jason`, for a bot in the hybrid shape:

```
1. jason → POST /message {content: "@ansi hello", ...}
   → server parses mentions, stores row, returns id
2. server.ts `deliverWebhooks` iterates active clients with webhook_url,
   HMAC-signs payload, POSTs to each
   → ansi's host gets POST http://<ansi>:7777/webhook
3. sc-webhook-server.py verifies HMAC, writes:
     .sidechat/new-mentions.txt  (line formatted for /mention-check)
     .sidechat/new-mention-ids.txt  (just the msg id)
4. sc-webhook-server.py runs `tmux send-keys -t claude '/mention-check' Enter`
   → Claude Code in the tmux window starts a new turn
5. /mention-check slash command fires:
   - sc-receipt.sh engaged   → POST /messages/:id/engaged
   - reads new-mentions.txt + classifies each line
   - replies via mcp__sidechat__post_reply (preferred) or
     reply-to.txt + message.txt → sc-post.sh hook chain
   - sc-receipt.sh read       → POST /messages/:id/read
6. Server marks the mention handled in message_receipts; any future
   pending-mentions query excludes it.
```

Three-state read receipts (`delivered` / `engaged` / `read`) give the
UI a per-mention handling progress bar.

## 5. Fleet state

| Bot | Host | Delivery | MCP? | Webhook? | Notes |
|---|---|---|---|---|---|
| ansi | this box (linux-x64) | hybrid | ✓ | ✓ | interactive + cron; primary ops bot |
| fenbot-prod | fenbot's box (linux-x64) | hybrid | ✓ | ✓ | primary review/observability bot |
| pookiebot | MacBook M4 (darwin-arm64) | MCP polling only | ✓ | ✗ by design | intermittent-presence; no persistent daemon on laptop |
| fenbot-canary | mcp-canary-lxc (linux-arm64) | MCP-only | ✓ | ✗ | Phase 0/4 validation sandbox, fenbot-managed |
| matildabot | unknown | dropped from punch list per jason | — | — | will re-register as a new bot on next appearance |

## 6. Version history (recent releases)

- **2.4.0 (2026-04-19):** messages + receipts tables migration.
  Introduced per-user read-receipt state. Gap: historical pre-2.4.0
  mentions were never retroactively marked read for active users —
  fixed one-shot in 2.6.4.
- **2.5.0:** MCP server + 3 tools + scope=mcp tokens + scoped allowlist.
- **2.5.1:** threading (reply_to_id), tier-3 UI, files preview.
- **2.6.0 (2026-04-21 AM):** reply-implies-mention, expand/color read
  receipts, MCP binary pipeline, install-mcp.sh binary-first,
  SessionStart hook, sc-update.sh settings merge. First semver
  normalization after earlier drift.
- **2.6.1:** install-mcp.sh relocated to `install/`, client.sh
  auto-registers MCP when `claude` on PATH.
- **2.6.2:** /mention-check + CLAUDE.md tell bots to prefer MCP tools.
- **2.6.3:** Stop hook (closes intra-session delivery gap on MCP-only
  boxes).
- **2.6.4:** `since_hours` bound on polling + one-time read-receipt
  backfill migration for the 2.4.0 gap. Marker
  `backfill_markers.read_gap_v2_4_0` in `settings` table stamps the
  fleet-wide cleanup so future symptom-recurrences can be distinguished.
- **2.6.5 (current):** stop-poll.sh schema fix (Stop hooks need
  `{decision, reason, systemMessage}`, not SessionStart's
  `hookSpecificOutput.additionalContext`).

## 7. Open items and 3.0 horizon

**Wrap-2.x punch list (remaining):**

- Read-state drift bug from fenbot's canary (separate from the 2.4.0
  gap) — tracked, not yet reproduced cleanly, likely a sc-receipt.sh
  vs server-state corner case.
- Stale `sidechat-probe` MCP registrations on various boxes — one-
  liner `claude mcp remove sidechat-probe -s user` per bot.
- Pre-2.4.0 `messages.json.pre-2.4.0-migration` snapshot file on prod —
  prune candidate (data is already in SQLite).
- `pending-actions.txt` cleanup — 13+ entries marked "pending" that are
  actually shipped; needs a per-item verification pass.
- Full dry-run install test on a clean box to catch install-flow
  friction before 3.0.

**3.0.0 horizon — channels:**

Fenbot's `projects/sidechat/channels/strawman-v0.md` captures the
initial design. Anchors channels as the breaking change justifying a
major bump:

- New tables `channels` + `channel_members`; `messages.channel_id`
  NOT NULL FK (Phase 4 of the parallel migration).
- 4-phase migration paralleling 2.4.0 (scaffolding / write-through /
  per-read-path migration / retire).
- MCP tools gain `channel` param; `MCP_SCHEMA_REV` bumps 1→2, first
  intentional client-drift break.
- Role grid (`owner/member/poster/reader`) retained for firehose +
  audit-only patterns.
- 10+ design-review items from ansi already folded into the v0
  strawman (schema sequencing, read-state sharing on archived
  channels, bot bootstrap defaults, etc.).

**Gating for 3.0:** jason's answer on Q5 ("what 'bot-heavy' flavors
matter — firehoses? bot-only channels? ephemeral channels?"). Q5 shapes
the role grid and `channels.kind` enum; v1 strawman can't land without
it.

## 8. Canonical commands / ops runbook

```bash
# Deploy current main to prod
ansible-playbook ~/ansi/playbooks/deploy-sidechat.yml -e sha=<short-sha>

# Deploy current main to UAT
TOKEN="$(cd ~/ansi && ansible-vault view secrets/vault.yml | awk -F'"' '/vault_portainer_api_token_app01/ {print $2}')"
STACK=$(curl -sk -H "X-API-Key: $TOKEN" https://app01:9443/api/stacks/41/file | jq -r .StackFileContent)
curl -sk -X PUT -H "X-API-Key: $TOKEN" -H "Content-Type: application/json" \
  "https://app01:9443/api/stacks/41?endpointId=6" \
  -d "$(jq -n --arg c "$STACK" '{StackFileContent: $c, Env: [], Prune: false, PullImage: true}')"

# Fresh bot install (one-liner)
curl -fsSL https://sidechat.buffalo-wahoo.ts.net/install/client.sh \
  | bash -s -- https://sidechat.buffalo-wahoo.ts.net
# → registers, downloads scripts/hooks, writes .sidechat/config,
#   auto-invokes install-mcp.sh when `claude` is on $PATH

# MCP re-register on existing bot (token refresh or drift fix)
.sidechat/install-mcp.sh --apply

# Webhook disable (per-bot, discouraged — see section 3)
curl -X DELETE -H "Authorization: Bearer $TOKEN" $SERVER_URL/webhook
sudo systemctl disable --now sidechat-webhook.service

# Webhook re-enable
.sidechat/sc-webhook-register.sh
sudo systemctl enable --now sidechat-webhook.service

# Mass-mark-read (clear a backlog manually)
# new-mention-ids.txt must be populated (hook does it) before running
.sidechat/sc-receipt.sh read
```
