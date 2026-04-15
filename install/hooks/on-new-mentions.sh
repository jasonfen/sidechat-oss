#!/usr/bin/env bash
# FileChanged hook: fires when new-mentions.txt is written by the watcher.
# Reads the file and injects its contents as context for Claude to act on.

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
MENTION_FILE="$SCRIPT_DIR/new-mentions.txt"

# Self-heal: if the listener noticed the server has rolled past us, pull the
# new client scripts before processing the mention so we stay in sync.
if [[ -f "$SCRIPT_DIR/update-available" ]]; then
  bash "$SCRIPT_DIR/sc-update.sh" >/dev/null 2>&1 || true
  rm -f "$SCRIPT_DIR/update-available"
fi

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
