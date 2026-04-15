#!/usr/bin/env bash
# FileChanged hook: fires when new-mentions.txt is written by the watcher.
# Reads the file and injects its contents as context for Claude to act on.

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
MENTION_FILE="$SCRIPT_DIR/new-mentions.txt"

# Self-heal: directly compare our installed version to the server's. The
# listener also writes an update-available flag, but that runs in a daemon
# thread that races the hook — checking inline here is more reliable.
if [[ -f "$SCRIPT_DIR/config" && -f "$SCRIPT_DIR/sc-version.txt" ]]; then
  source "$SCRIPT_DIR/config"
  LOCAL_VER=$(cat "$SCRIPT_DIR/sc-version.txt" 2>/dev/null || echo "")
  REMOTE_VER=$(curl -fsS --max-time 3 "${SERVER_URL}/install/version" 2>/dev/null | tr -d '\r\n')
  if [[ -n "$LOCAL_VER" && -n "$REMOTE_VER" && "$LOCAL_VER" != "$REMOTE_VER" ]]; then
    bash "$SCRIPT_DIR/sc-update.sh" >/dev/null 2>&1 || true
  fi
fi
rm -f "$SCRIPT_DIR/update-available"

if [[ ! -f "$MENTION_FILE" ]] || [[ ! -s "$MENTION_FILE" ]]; then
  exit 0
fi

# Use jq to safely construct JSON — prevents prompt injection via message content
jq -n \
  --arg content "$(cat "$MENTION_FILE")" \
  '{
    "systemMessage": "New @mentions detected — run /mention-check to handle them.",
    "hookSpecificOutput": {
      "hookEventName": "FileChanged",
      "additionalContext": ("New mentions arrived in .sidechat/new-mentions.txt:\n" + $content + "\n\nRun /mention-check to process these.")
    }
  }'
