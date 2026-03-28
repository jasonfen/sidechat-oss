#!/usr/bin/env bash
# Background monitor for @mentions
# Polls every 3s, appends to .sidechat/notifications when mentioned
# Usage: ./sc-notify.sh (runs in foreground, use & or systemd to background)

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
CONFIG="$SCRIPT_DIR/config"

if [[ ! -f "$CONFIG" ]]; then
  echo "ERROR: No .sidechat/config found" >&2
  exit 1
fi

source "$CONFIG"

NOTIFY_FILE="$SCRIPT_DIR/notifications"
CURSOR_FILE="/tmp/.sc-notify-cursor-$BOT_NAME"
PID_FILE="/tmp/.sc-notify-pid-$BOT_NAME"

# Check if already running
if [[ -f "$PID_FILE" ]] && kill -0 "$(cat "$PID_FILE")" 2>/dev/null; then
  echo "Monitor already running (PID $(cat "$PID_FILE"))"
  exit 0
fi

echo $$ > "$PID_FILE"
trap "rm -f $PID_FILE $CURSOR_FILE" EXIT

echo "Monitoring @${BOT_NAME} mentions → $NOTIFY_FILE"

while true; do
  if [[ -f "$CURSOR_FILE" ]]; then
    SINCE=$(cat "$CURSOR_FILE")
    URL="$SERVER_URL/messages?since=$SINCE"
  else
    # Start from now, don't notify on old messages
    SINCE=$(date -u +"%Y-%m-%dT%H:%M:%S.000Z")
    echo "$SINCE" > "$CURSOR_FILE"
    URL="$SERVER_URL/messages?since=$SINCE"
  fi

  RESPONSE=$(curl -s \
    -H "Authorization: Bearer $TOKEN" \
    "$URL" 2>/dev/null)

  if [[ -n "$RESPONSE" ]]; then
    COUNT=$(echo "$RESPONSE" | jq -r '.count // 0' 2>/dev/null)

    if [[ "$COUNT" -gt 0 ]]; then
      # Update cursor
      LATEST=$(echo "$RESPONSE" | jq -r '.messages[-1].timestamp // empty')
      if [[ -n "$LATEST" ]]; then
        echo "$LATEST" > "$CURSOR_FILE"
      fi

      # Check each message for @mention
      echo "$RESPONSE" | jq -c '.messages[]' 2>/dev/null | while read -r msg; do
        content=$(echo "$msg" | jq -r '.content')
        sender=$(echo "$msg" | jq -r '.sender')
        timestamp=$(echo "$msg" | jq -r '.timestamp')
        mentions=$(echo "$msg" | jq -r '.mentions // [] | .[]' 2>/dev/null)

        if echo "$mentions" | grep -qi "^${BOT_NAME}$" || echo "$content" | grep -qi "@${BOT_NAME}"; then
          time_short=$(echo "$timestamp" | sed 's/T/ /' | sed 's/\..*//')
          echo "[$time_short] $sender: $content" >> "$NOTIFY_FILE"
        fi
      done
    fi
  fi

  sleep 3
done
