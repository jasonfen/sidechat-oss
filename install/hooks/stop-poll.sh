#!/bin/bash
# Stop hook: after each Claude turn, poll sidechat for pending @-mentions
# and `decision: "block"` the turn-end so /mention-check runs before the
# REPL goes idle. Closes the in-turn-arrival gap that 2.6.20's passive
# hookSpecificOutput shape left open: plugin monitor only wakes idle CC,
# and FileChanged additionalContext is informational, so a mention
# arriving mid-turn could sit in the queue while the bot finished its
# current thread and ended the turn without ever running /mention-check.
#
# 2.6.20 dropped the block to avoid CC's "Stop hook blocking error from
# command: ..." framing — felt alarmist for a routine "you have mail"
# condition, and assumed plugin + FileChanged would substitute. In
# practice the substitute leaked: bots looked like they were "waiting
# for the current thread to resolve" before noticing new mentions.
# 2.6.23 (jason, 2026-04-28) restores the block; the alarmist UX is the
# accepted cost of guaranteed pickup, and topic-hijacking by an
# unrelated mention mid-conversation is acceptable.
#
# Loop safety: the 2.6.21 race-fix in /mention-check step 0 re-queries
# /messages/pending-mentions before processing, so once /mention-check
# replies + marks read, the next Stop poll sees count=0 and exits
# silently — no infinite block loop.

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
  decision: "block",
  reason: ("SideChat: " + ($n|tostring) + " new @-mention(s) pending in .sidechat/new-mentions.txt. Run /mention-check now to handle them before the turn ends."),
  systemMessage: ("SideChat: " + ($n|tostring) + " new @-mention(s) pending.")
}'
exit 0
