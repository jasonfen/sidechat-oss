#!/usr/bin/env bash
# Hook: post sidechat status after git push
# Triggered by Claude Code PostToolUse on Bash

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
SC_POST="$SCRIPT_DIR/../sc-post.sh"

# Read hook input from stdin
INPUT=$(cat)

# Extract the command that was run
COMMAND=$(echo "$INPUT" | jq -r '.tool_input.command // empty')

# Only act on git push commands
if ! echo "$COMMAND" | grep -qE '^\s*git\s+push'; then
  exit 0
fi

# Get the latest commit info
HASH=$(git log -1 --format='%h' 2>/dev/null || echo "")
MSG=$(git log -1 --format='%s' 2>/dev/null || echo "")

if [[ -z "$HASH" || -z "$MSG" ]]; then
  exit 0
fi

# Run synchronously (not backgrounded). PostToolUse hooks fire after the
# tool result is already returned to the model, so there's no user-facing
# latency cost — and backgrounding here used to race the harness's process-
# group cleanup: if sc-post.sh (esp. on a 401 re-auth round-trip) hadn't
# finished by the time the parent hook exited, the orphaned child could get
# reaped mid-flight with zero trace (all output was silently swallowed).
# Well within the hook's 10s timeout for a plain POST.
"$SC_POST" "Pushed $HASH — $MSG" >/dev/null 2>&1

exit 0
