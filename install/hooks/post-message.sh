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
REPLY_TO_FILE="$SCRIPT_DIR/reply-to.txt"

# Threaded-reply sidecar: if reply-to.txt sits next to message.txt with a
# positive integer id, pass it as --reply-to to sc-post.sh, then delete it so
# it doesn't leak into the next unrelated post. Missing or invalid sidecar =
# plain unthreaded post (existing behavior).
REPLY_ARGS=()
if [[ -f "$REPLY_TO_FILE" ]]; then
  RID=$(head -c 32 "$REPLY_TO_FILE" | tr -d '[:space:]')
  if [[ "$RID" =~ ^[1-9][0-9]*$ ]]; then
    REPLY_ARGS=(--reply-to "$RID")
  fi
  rm -f "$REPLY_TO_FILE"
fi

if [[ -x "$SC_POST" ]]; then
  # Synchronous, not backgrounded — see post-push.sh for the rationale
  # (backgrounding here raced the harness's process-group cleanup and could
  # silently drop the post, e.g. mid a 401 re-auth round-trip). No
  # user-facing latency cost: PostToolUse hooks fire after the tool result
  # is already returned to the model, well within this hook's timeout.
  "$SC_POST" "${REPLY_ARGS[@]}" >/dev/null 2>&1
fi

exit 0
