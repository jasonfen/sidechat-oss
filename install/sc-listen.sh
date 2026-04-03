#!/usr/bin/env bash
# SSE listener — real-time message stream (same as web UI)
# Auto-reconnects on connection drop.
# Usage: ./sc-listen.sh

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
CONFIG="$SCRIPT_DIR/config"

if [[ ! -f "$CONFIG" ]]; then
  echo "ERROR: No .sidechat/config found" >&2
  exit 1
fi

source "$CONFIG"

if [[ -z "$TOKEN" ]]; then
  echo "No session token. Running sc-auth.sh..." >&2
  if "$SCRIPT_DIR/sc-auth.sh" 2>/dev/null; then
    source "$CONFIG"
  else
    echo "ERROR: Authentication failed" >&2
    exit 1
  fi
fi

NOTIFY_FILE="$SCRIPT_DIR/notifications"
BOT_LOWER=$(echo "$BOT_NAME" | tr '[:upper:]' '[:lower:]')

echo "=== SideChat Live (SSE) ==="
echo "Connected to $SERVER_URL"
echo "Press Ctrl+C to exit"
echo "==========================="

while true; do
  curl -sN \
    -H "Accept: text/event-stream" \
    "$SERVER_URL/events?token=$TOKEN" 2>/dev/null | \
  while IFS= read -r line; do
    if [[ "$line" == data:* ]]; then
      DATA="${line#data: }"

      if [[ "$DATA" == "keepalive" ]]; then
        continue
      fi

      SENDER=$(echo "$DATA" | jq -r '.sender // empty' 2>/dev/null)
      CONTENT=$(echo "$DATA" | jq -r '.content // empty' 2>/dev/null)
      TIMESTAMP=$(echo "$DATA" | jq -r '.timestamp // empty' 2>/dev/null)

      if [[ -n "$SENDER" && -n "$CONTENT" ]]; then
        TIME=$(echo "$TIMESTAMP" | sed 's/.*T//' | sed 's/\..*//')
        printf "\n[%s] %s\n%s\n" "$TIME" "$(echo "$SENDER" | tr '[:lower:]' '[:upper:]')" "$CONTENT"

        # Notifications are written by sc-notify.sh only (single writer)
      fi
    fi
  done

  # Connection dropped — wait before reconnecting
  echo "[$(date +%H:%M:%S)] SSE connection lost, reconnecting in 3s..."
  sleep 3
done
