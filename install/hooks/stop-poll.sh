#!/bin/bash
# Stop hook: after each Claude turn, poll sidechat for pending @-mentions
# and surface them as additionalContext so the next user turn picks them
# up via /mention-check. Closes the mid-session delivery gap for bots
# without a webhook listener (e.g. laptops where sudo/systemd aren't
# available at install time).
#
# Mirrors sessionstart-poll.sh exactly except hookEventName: "Stop".
# Self-gates: exits silently when config or token is missing, so the hook
# is safe to install even on boxes where the sidechat client isn't
# configured.

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
CONFIG="$SCRIPT_DIR/config"

[ -f "$CONFIG" ] || exit 0
# shellcheck disable=SC1090
source "$CONFIG"
[ -n "${TOKEN:-}" ] && [ -n "${SERVER_URL:-}" ] || exit 0

# Bound the lookback window — defense-in-depth against receipt-table drift
# or legacy backlog dumps. Default 72h; `SIDECHAT_POLL_HOURS` env var overrides.
HOURS="${SIDECHAT_POLL_HOURS:-72}"
RESPONSE="$(curl -sf --max-time 5 -H "Authorization: Bearer $TOKEN" \
  "$SERVER_URL/messages/pending-mentions?since_hours=${HOURS}" 2>/dev/null)" || exit 0

COUNT="$(printf '%s' "$RESPONSE" | jq -r '.count // 0' 2>/dev/null || echo 0)"
[ "$COUNT" -gt 0 ] || exit 0

printf '%s' "$RESPONSE" | jq -r '
  .messages[] | "[\(.timestamp | sub("T"; " ") | sub("\\..*Z$"; ""))] \(.sender): \(.content)"
' > "$SCRIPT_DIR/new-mentions.txt"
printf '%s' "$RESPONSE" | jq -r '.messages[].id' > "$SCRIPT_DIR/new-mention-ids.txt"

jq -n --argjson n "$COUNT" '{
  hookSpecificOutput: {
    hookEventName: "Stop",
    additionalContext: ("SideChat: " + ($n|tostring) + " new @-mention(s) arrived during this session. Please run /mention-check now to handle them.")
  }
}'
exit 0
