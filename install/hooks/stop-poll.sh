#!/bin/bash
# Stop hook: after each Claude turn, poll sidechat for pending @-mentions
# and surface them via hookSpecificOutput.additionalContext. The plugin
# monitor wakes the next turn within ~5s of a new mention, and the
# FileChanged hook on new-mentions.txt fires /mention-check directly —
# this hook is the cross-session safety net for either path missing a beat.
#
# Pre-2.6.20 this used `decision: "block"` to force /mention-check before
# the turn could end, but CC frames any block as "Stop hook blocking error
# from command: ..." — alarmist UX for a routine condition. Switched to
# the same hookSpecificOutput shape sessionstart-poll uses; plugin +
# FileChanged paths still drive in-turn handling.

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
CONFIG="$SCRIPT_DIR/config"

[ -f "$CONFIG" ] || exit 0
# shellcheck disable=SC1090
source "$CONFIG"
[ -n "${TOKEN:-}" ] && [ -n "${SERVER_URL:-}" ] || exit 0

HOURS="${SIDECHAT_POLL_HOURS:-72}"
RESPONSE="$(curl -sf --max-time 5 -H "Authorization: Bearer $TOKEN" \
  "$SERVER_URL/messages/pending-mentions?since_hours=${HOURS}" 2>/dev/null)" || RESPONSE=""

COUNT=0
if [ -n "$RESPONSE" ]; then
  COUNT="$(printf '%s' "$RESPONSE" | jq -r '.count // 0' 2>/dev/null || echo 0)"
fi

if [ "$COUNT" -gt 0 ]; then
  printf '%s' "$RESPONSE" | jq -r '
    .messages[] | "[\(.timestamp | sub("T"; " ") | sub("\\..*Z$"; ""))] \(.sender): \(.content)"
  ' > "$SCRIPT_DIR/new-mentions.txt"
  printf '%s' "$RESPONSE" | jq -r '.messages[].id' > "$SCRIPT_DIR/new-mention-ids.txt"
fi

# No pending → exit silently so the turn ends with no extra output.
[ "$COUNT" -gt 0 ] || exit 0

jq -n --argjson n "$COUNT" '{
  systemMessage: ("SideChat: " + ($n|tostring) + " new @-mention(s) pending."),
  hookSpecificOutput: {
    hookEventName: "Stop",
    additionalContext: ("SideChat: " + ($n|tostring) + " new @-mention(s) were polled and written to .sidechat/new-mentions.txt. Run /mention-check to handle them.")
  }
}'
exit 0
