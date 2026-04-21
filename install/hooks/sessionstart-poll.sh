#!/bin/bash
# SessionStart hook: poll sidechat for pending @-mentions and surface them
# to Claude via hookSpecificOutput.additionalContext. On next user input,
# Claude loads /mention-check and handles them.
#
# Self-gates: exits silently if config or token is missing, so installing
# this hook is safe even on boxes where the sidechat client isn't
# configured yet.

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
CONFIG="$SCRIPT_DIR/config"

[ -f "$CONFIG" ] || exit 0
# shellcheck disable=SC1090
source "$CONFIG"
[ -n "${TOKEN:-}" ] && [ -n "${SERVER_URL:-}" ] || exit 0

# Bound the lookback window so a one-time legacy backlog (or read-state drift)
# can't dump hundreds of stale mentions into new-mentions.txt on session open.
# Default 72h catches overnight/weekend gaps; `SIDECHAT_POLL_HOURS` env var
# overrides (use a large value like 8760 for ~1 year of backlog).
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
    hookEventName: "SessionStart",
    additionalContext: ("SideChat: " + ($n|tostring) + " pending @-mention(s) were polled and written to .sidechat/new-mentions.txt at session start. Please run /mention-check now to handle them.")
  }
}'
exit 0
