#!/usr/bin/env bash
# FileChanged hook: fires when new-mentions.txt is written by the watcher.
# Reads the file and injects its contents as context for Claude to act on.

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
MENTION_FILE="$SCRIPT_DIR/new-mentions.txt"

if [[ ! -f "$MENTION_FILE" ]] || [[ ! -s "$MENTION_FILE" ]]; then
  exit 0
fi

CONTENT=$(cat "$MENTION_FILE")

# Output JSON to inject context back to Claude
cat <<HOOKJSON
{
  "systemMessage": "New @mentions detected — run /mention-check to handle them.",
  "hookSpecificOutput": {
    "hookEventName": "FileChanged",
    "additionalContext": "New mentions arrived in .sidechat/new-mentions.txt:\n${CONTENT}\n\nRun /mention-check to process these."
  }
}
HOOKJSON
