#!/usr/bin/env bash
# Usage: sc-poll.sh   (no args) — prints new messages since the last poll
# (cursor at /tmp/.sc-cursor-$BOT_NAME) and advances the cursor. Read-only
# aside from that cursor file; does not mark anything engaged/read.
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
CONFIG="$SCRIPT_DIR/config"
source "$CONFIG"

CURSOR_FILE="/tmp/.sc-cursor-$BOT_NAME"

if [[ -f "$CURSOR_FILE" ]]; then
  SINCE=$(cat "$CURSOR_FILE")
  URL="$SERVER_URL/messages?since=$SINCE"
else
  URL="$SERVER_URL/messages"
fi

do_poll() {
  curl -s -w "\n%{http_code}" \
    -H "Authorization: Bearer $TOKEN" \
    "$URL"
}

RESPONSE=$(do_poll)
HTTP_CODE=$(echo "$RESPONSE" | tail -1)
BODY=$(echo "$RESPONSE" | sed '$d')

# Auto re-auth on 401
if [[ "$HTTP_CODE" == "401" ]]; then
  echo "Token expired, re-authenticating..." >&2
  if "$SCRIPT_DIR/sc-auth.sh" 2>/dev/null; then
    source "$CONFIG"
    RESPONSE=$(do_poll)
    HTTP_CODE=$(echo "$RESPONSE" | tail -1)
    BODY=$(echo "$RESPONSE" | sed '$d')
  else
    echo "ERROR: Re-authentication failed" >&2
    exit 1
  fi
fi

if [[ "$HTTP_CODE" != "200" ]]; then
  echo "ERROR: Poll failed ($HTTP_CODE): $BODY" >&2
  exit 1
fi

OUTPUT=$(echo "$BODY" | jq -r '.messages // [] | .[] | "[\(.timestamp | split("T")[1] | split(".")[0])] \(.sender): \(.content)"')
if [[ -n "$OUTPUT" ]]; then
  # Highlight @mentions of current user in bold yellow
  echo "$OUTPUT" | sed "s/@${BOT_NAME}\b/$(printf '\033[1;33m')@${BOT_NAME}$(printf '\033[0m')/g"
fi

LATEST=$(echo "$BODY" | jq -r '.messages[-1].timestamp // empty')
if [[ -n "$LATEST" ]]; then
  echo "$LATEST" > "$CURSOR_FILE"
fi
