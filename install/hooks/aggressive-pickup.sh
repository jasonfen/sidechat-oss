#!/bin/bash
# PostToolUse hook (opt-in): poll sidechat after every tool call and
# `decision: "block"` mid-turn when @-mentions arrive, so the bot picks
# them up at the next tool-call boundary instead of waiting for the
# Stop-hook backstop at turn-end.
#
# Off by default. Opt-in by setting AGGRESSIVE_PICKUP=1 in the bot's
# .sidechat/config (or exporting it in the bot's launcher env). Only
# autonomous bots — which run long mid-turn threads and have no
# human-UX cost from "Stop hook blocking error" framing — typically
# want this on. Interactive bots should leave it off.
#
# Cost when enabled: one curl per tool call (~50ms typical). The 5s
# timeout is intentionally short so a slow server can't stall every
# tool call.
#
# Loop safety: same shape as stop-poll.sh — once /mention-check
# (re-)queries pending and replies+marks-read, the next PostToolUse
# poll sees count=0 and exits silently.
#
# 2.6.24: added per fenbot+ansi diagnosis (channel msg 2569) — Stop
# hook closes the gap at turn-end, but on dense-cron bots a mid-turn
# arrival could wait one full cron period before the next Stop fires.

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
CONFIG="$SCRIPT_DIR/config"

[ -f "$CONFIG" ] || exit 0
# shellcheck disable=SC1090
source "$CONFIG"

# Self-gate: silent no-op unless explicitly enabled.
[ "${AGGRESSIVE_PICKUP:-0}" = "1" ] || exit 0

[ -n "${TOKEN:-}" ] && [ -n "${SERVER_URL:-}" ] || exit 0

HOURS="${SIDECHAT_POLL_HOURS:-72}"
RESPONSE="$(curl -sf --max-time 5 -H "Authorization: Bearer $TOKEN" \
  "$SERVER_URL/messages/pending-mentions?since_hours=${HOURS}" 2>/dev/null)" || RESPONSE=""

COUNT=0
if [ -n "$RESPONSE" ]; then
  COUNT="$(printf '%s' "$RESPONSE" | jq -r '.count // 0' 2>/dev/null || echo 0)"
fi

[ "$COUNT" -gt 0 ] || exit 0

printf '%s' "$RESPONSE" | jq -r '
  .messages[] | "[\(.timestamp | sub("T"; " ") | sub("\\..*Z$"; ""))] \(.sender): \(.content)"
' > "$SCRIPT_DIR/new-mentions.txt"
printf '%s' "$RESPONSE" | jq -r '.messages[].id' > "$SCRIPT_DIR/new-mention-ids.txt"

jq -n --argjson n "$COUNT" '{
  decision: "block",
  reason: ("SideChat: " + ($n|tostring) + " new @-mention(s) pending in .sidechat/new-mentions.txt. Run /mention-check now before continuing — aggressive-pickup is enabled for this bot."),
  systemMessage: ("SideChat: " + ($n|tostring) + " new @-mention(s) pending.")
}'
exit 0
