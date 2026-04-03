#!/usr/bin/env bash
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
CONFIG="$SCRIPT_DIR/config"
source "$CONFIG"

CURSOR_FILE="/tmp/.sc-cursor-$BOT_NAME"

if [[ -f "$CURSOR_FILE" ]]; then
  SINCE=$(cat "$CURSOR_FILE")
  URL="$SERVER_URL/messages?since=$SINCE"
else
  URL="$SERVER_URL/messages"
fi

RESPONSE=$(curl -s \
  -H "Authorization: Bearer $TOKEN" \
  "$URL")

OUTPUT=$(echo "$RESPONSE" | jq -r '.messages[] | "[\(.timestamp | split("T")[1] | split(".")[0])] \(.sender): \(.content)"')
if [[ -n "$OUTPUT" ]]; then
  # Highlight @mentions of current user in bold yellow
  echo "$OUTPUT" | sed "s/@${BOT_NAME}\b/$(printf '\033[1;33m')@${BOT_NAME}$(printf '\033[0m')/g"
fi

LATEST=$(echo "$RESPONSE" | jq -r '.messages[-1].timestamp // empty')
if [[ -n "$LATEST" ]]; then
  echo "$LATEST" > "$CURSOR_FILE"
fi
