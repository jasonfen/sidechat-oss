#!/bin/bash
# sc-webhook-listener.sh — receives webhook POSTs from SideChat server
# Writes mentions to new-mentions.txt, triggering the FileChanged hook.
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
PROJECT_DIR="$(dirname "$SCRIPT_DIR")"
CONFIG="$SCRIPT_DIR/config"
PID_FILE="$SCRIPT_DIR/.webhook-listener.pid"
PORT="${WEBHOOK_PORT:-7777}"

if [[ ! -f "$CONFIG" ]]; then echo "Missing config"; exit 1; fi
source "$CONFIG"

WEBHOOK_SECRET="${WEBHOOK_SECRET:-}"

# Check for existing instance
if [[ -f "$PID_FILE" ]]; then
  OLD_PID=$(cat "$PID_FILE")
  if kill -0 "$OLD_PID" 2>/dev/null; then
    exit 0
  fi
  rm -f "$PID_FILE"
fi

python3 "$SCRIPT_DIR/sc-webhook-server.py" &

LISTENER_PID=$!
echo "$LISTENER_PID" > "$PID_FILE"
disown "$LISTENER_PID"
echo "Webhook listener started (PID $LISTENER_PID, port $PORT)"
