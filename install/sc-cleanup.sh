#!/usr/bin/env bash
# Kill all SideChat background processes for this bot and reset state.
# Safe to call multiple times. Used by installer --force and for manual
# cleanup of legacy sc-listen/sc-notify/sc-webhook processes on bots
# upgrading from pre-2.6.14 /start-based setups.
# Usage: .sidechat/sc-cleanup.sh

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
CONFIG="$SCRIPT_DIR/config"

if [[ ! -f "$CONFIG" ]]; then
  echo "ERROR: No .sidechat/config found" >&2
  exit 1
fi

source "$CONFIG"

KILLED=0

# Kill any process by this user whose cmdline matches a SideChat script name.
# This catches running scripts, stale processes from deleted scripts, and
# old script names from previous versions.
for pattern in sc-notify.sh sc-mention-watcher.sh sc-listen.sh sc-watch.sh sc-mention-monitor.sh sc-webhook-listener.sh; do
  pids=$(pgrep -u "$(id -u)" -f "$pattern" 2>/dev/null || true)
  for pid in $pids; do
    # Don't kill ourselves or our parent
    [[ "$pid" == "$$" || "$pid" == "$PPID" ]] && continue
    kill "$pid" 2>/dev/null && {
      echo "  killed $pattern (PID $pid)"
      KILLED=$((KILLED + 1))
    }
  done
done

# Clean up PID and cursor files
rm -f "/tmp/.sc-notify-pid-$BOT_NAME"
rm -f "/tmp/.sc-mention-watcher-pid-$BOT_NAME"
rm -f "$SCRIPT_DIR/.webhook-listener.pid"
rm -f "/tmp/.sc-notify-cursor-$BOT_NAME"

# Reset handled line count to current end of notifications (prevents reprocessing)
NOTIFY_FILE="$SCRIPT_DIR/notifications"
HANDLED_FILE="$SCRIPT_DIR/.last-handled-line"
if [[ -f "$NOTIFY_FILE" ]]; then
  wc -l < "$NOTIFY_FILE" | tr -d ' ' > "$HANDLED_FILE"
fi

# Clear seen-mentions dedup file (fresh start)
rm -f "$SCRIPT_DIR/.seen-mentions"

echo "Cleanup done ($KILLED processes killed)"
