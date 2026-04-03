#!/usr/bin/env bash
# Watches notifications file for new lines. When new mentions arrive,
# writes them to new-mentions.txt (which triggers a Claude Code hook).
# Usage: .sidechat/sc-mention-watcher.sh &

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
CONFIG="$SCRIPT_DIR/config"

if [[ ! -f "$CONFIG" ]]; then
  echo "ERROR: No .sidechat/config found" >&2
  exit 1
fi

source "$CONFIG"

NOTIFY_FILE="$SCRIPT_DIR/notifications"
HANDLED_FILE="$SCRIPT_DIR/.last-handled-line"
SEEN_FILE="$SCRIPT_DIR/.seen-mentions"
TRIGGER_FILE="$SCRIPT_DIR/new-mentions.txt"
PID_FILE="/tmp/.sc-mention-watcher-pid-$BOT_NAME"
LOCK_FILE="$SCRIPT_DIR/.watcher-lock"
SCRIPT_NAME="sc-mention-watcher.sh"

# Enhanced PID check: verify the running process is actually this script
if [[ -f "$PID_FILE" ]]; then
  OLD_PID=$(cat "$PID_FILE")
  if kill -0 "$OLD_PID" 2>/dev/null; then
    CMDLINE=$(tr '\0' ' ' < "/proc/$OLD_PID/cmdline" 2>/dev/null || true)
    if [[ "$CMDLINE" == *"$SCRIPT_NAME"* ]]; then
      echo "Mention watcher already running (PID $OLD_PID)"
      exit 0
    fi
    # PID alive but running something else — stale PID file
  fi
  rm -f "$PID_FILE"
fi

echo $$ > "$PID_FILE"
trap "rm -f $PID_FILE" EXIT

# Initialize handled line count if missing
if [[ ! -f "$HANDLED_FILE" ]]; then
  if [[ -f "$NOTIFY_FILE" ]]; then
    wc -l < "$NOTIFY_FILE" | tr -d ' ' > "$HANDLED_FILE"
  else
    echo "0" > "$HANDLED_FILE"
  fi
fi

echo "Mention watcher started for @${BOT_NAME} (PID $$)"

while true; do
  if [[ ! -f "$NOTIFY_FILE" ]]; then
    sleep 5
    continue
  fi

  # Use flock to prevent races with other watcher instances
  (
    flock -n 9 || exit 0

    HANDLED=$(cat "$HANDLED_FILE" 2>/dev/null || echo "0")
    TOTAL=$(wc -l < "$NOTIFY_FILE" | tr -d ' ')

    if [[ "$TOTAL" -gt "$HANDLED" ]]; then
      TEMP_NEW="$SCRIPT_DIR/.new-mentions-tmp"
      > "$TEMP_NEW"

      while IFS= read -r line; do
        [[ -z "$line" ]] && continue

        # Dedup: skip if already seen
        LINE_HASH=$(echo "$line" | md5sum | cut -d' ' -f1)
        if grep -qF "$LINE_HASH" "$SEEN_FILE" 2>/dev/null; then
          continue
        fi
        echo "$LINE_HASH" >> "$SEEN_FILE"

        # Extract sender — skip our own messages
        SENDER=$(echo "$line" | sed 's/^\[[^]]*\] //' | sed 's/:.*//')
        if [[ "$SENDER" == "$BOT_NAME" ]]; then
          continue
        fi

        echo "$line" >> "$TEMP_NEW"
      done < <(tail -n +"$((HANDLED + 1))" "$NOTIFY_FILE")

      # Update handled count
      echo "$TOTAL" > "$HANDLED_FILE"

      # If there are genuinely new mentions from others, write trigger file
      if [[ -s "$TEMP_NEW" ]]; then
        mv "$TEMP_NEW" "$TRIGGER_FILE"
      else
        rm -f "$TEMP_NEW"
      fi
    fi
  ) 9>"$LOCK_FILE"

  sleep 5
done
