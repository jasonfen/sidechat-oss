#!/usr/bin/env bash
# Hook: auto-post when .sidechat/message.txt is written via Write tool
# Triggered by Claude Code PostToolUse on Write

set -euo pipefail

INPUT=$(cat)

# Extract the file path that was written
FILE_PATH=$(echo "$INPUT" | jq -r '.tool_input.file_path // empty')

# Only act on writes to message.txt
if [[ "$FILE_PATH" != *".sidechat/message.txt" ]]; then
  exit 0
fi

SCRIPT_DIR="$(dirname "$FILE_PATH")"
SC_POST="$SCRIPT_DIR/sc-post.sh"

if [[ -x "$SC_POST" ]]; then
  "$SC_POST" >/dev/null 2>&1 &
fi

exit 0
