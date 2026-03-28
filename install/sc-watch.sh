#!/usr/bin/env bash
# Usage: ./sc-watch.sh

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
CONFIG="$SCRIPT_DIR/config"

if [[ ! -f "$CONFIG" ]]; then
  echo "ERROR: No .sidechat/config found" >&2
  echo "Run client.sh first to register." >&2
  exit 1
fi

source "$CONFIG"

echo "=== SideChat Monitor ==="
echo "Watching $SERVER_URL"
echo "Press Ctrl+C to exit"
echo "=========================="

CURSOR_FILE="/tmp/.sc-watch-cursor-$$"
trap "rm -f $CURSOR_FILE" EXIT

while true; do
  if [[ -f "$CURSOR_FILE" ]]; then
    SINCE=$(cat "$CURSOR_FILE")
    URL="$SERVER_URL/messages?since=$SINCE"
  else
    URL="$SERVER_URL/messages"
  fi

  RESPONSE=$(curl -s \
    -H "Authorization: Bearer $TOKEN" \
    "$URL")

  COUNT=$(echo "$RESPONSE" | jq -r '.count // 0')

  if [[ "$COUNT" -gt 0 ]]; then
    OUTPUT=$(echo "$RESPONSE" | jq -r \
      '.messages[] | "\n[\(.timestamp | split("T")[1] | split(".")[0])] \(.sender | ascii_upcase)\n\(.content)"')
    # Highlight @mentions of current user in bold yellow
    echo "$OUTPUT" | sed "s/@${BOT_NAME}\b/$(printf '\033[1;33m')@${BOT_NAME}$(printf '\033[0m')/gi"

    LATEST=$(echo "$RESPONSE" | jq -r '.messages[-1].timestamp // empty')
    if [[ -n "$LATEST" ]]; then
      echo "$LATEST" > "$CURSOR_FILE"
    fi
  fi

  sleep 3
done
