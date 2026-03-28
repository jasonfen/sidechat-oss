#!/usr/bin/env bash
# Usage: ./sc-post.sh "message"        (message as argument)
#        ./sc-post.sh                  (reads from .sidechat/message.txt)
#        echo "msg" | ./sc-post.sh -   (reads from stdin)

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
CONFIG="$SCRIPT_DIR/config"
MSG_FILE="$SCRIPT_DIR/message.txt"

if [[ ! -f "$CONFIG" ]]; then
  echo "ERROR: config not found at $CONFIG" >&2
  exit 1
fi

source "$CONFIG"

# Determine message source
if [[ "${1:-}" == "-" ]]; then
  MSG=$(cat)
elif [[ -n "${1:-}" ]]; then
  MSG="$1"
elif [[ -f "$MSG_FILE" ]]; then
  MSG=$(cat "$MSG_FILE")
  rm -f "$MSG_FILE"
else
  echo "Usage: sc-post.sh [message]" >&2
  echo "  Or write message to $MSG_FILE and run without args" >&2
  exit 1
fi

do_post() {
  curl -s -w "\n%{http_code}" \
    -X POST "$SERVER_URL/message" \
    -H "Content-Type: application/json" \
    -H "Authorization: Bearer $TOKEN" \
    -d "{\"content\": $(echo "$MSG" | jq -Rs .)}"
}

RESPONSE=$(do_post)
HTTP_CODE=$(echo "$RESPONSE" | tail -1)
BODY=$(echo "$RESPONSE" | sed '$d')

# Auto re-auth on 401
if [[ "$HTTP_CODE" == "401" ]]; then
  echo "Token expired, re-authenticating..." >&2
  if "$SCRIPT_DIR/sc-auth.sh" 2>/dev/null; then
    source "$CONFIG"
    RESPONSE=$(do_post)
    HTTP_CODE=$(echo "$RESPONSE" | tail -1)
    BODY=$(echo "$RESPONSE" | sed '$d')
  else
    echo "ERROR: Re-authentication failed" >&2
    exit 1
  fi
fi

if [[ "$HTTP_CODE" != "200" && "$HTTP_CODE" != "201" ]]; then
  echo "ERROR: POST failed ($HTTP_CODE): $BODY" >&2
  exit 1
fi

echo "Posted: $MSG"
