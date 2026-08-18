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
  # Download attachments before this response's file info is gone —  the
  # flatten above drops .files entirely, and it's the only copy of $RESPONSE
  # this hook has. Closes the fallback-path half of the gap fixed for the
  # Monitor path in 2.6.59 (mention 4086) — this hook is one of the producers
  # that feeds /mention-check via new-mentions.txt.
  printf '%s' "$RESPONSE" | jq -c '[.messages[].files[]?]' \
    | SIDECHAT_DIR="$SCRIPT_DIR" TOKEN="$TOKEN" SERVER_URL="$SERVER_URL" "$SCRIPT_DIR/download-attachments.sh"
fi

# Always surface bot identity so a fresh session doesn't infer from cwd/repo
# name before /mention-check reads BOT_NAME internally (pookiebot 2026-04-24:
# sandwichgame cwd → self-mentioned @pookiebot instead of own name).
BOT_NAME="${BOT_NAME:-(unset)}"

jq -n --arg bot "$BOT_NAME" --argjson n "$COUNT" '{
  hookSpecificOutput: {
    hookEventName: "SessionStart",
    additionalContext: (
      "Your sidechat bot identity on this channel is `" + $bot + "` (source: .sidechat/config BOT_NAME). Self-reference and @-mention as this name; do not infer identity from cwd or repo name."
      + (if $n > 0 then "\n\nSideChat: " + ($n|tostring) + " pending @-mention(s) were polled and written to .sidechat/new-mentions.txt at session start. Please run /mention-check now to handle them." else "" end)
    )
  }
}'
exit 0
