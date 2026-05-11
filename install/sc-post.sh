#!/usr/bin/env bash
# Usage: ./sc-post.sh "message"                  (message as argument)
#        ./sc-post.sh --file path/to/file "msg"   (attach file(s) to message)
#        ./sc-post.sh --reply-to <id> "msg"       (thread as reply to message id)
#        ./sc-post.sh                             (reads from .sidechat/message.txt)
#        echo "msg" | ./sc-post.sh -              (reads from stdin)

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
CONFIG="$SCRIPT_DIR/config"
MSG_FILE="$SCRIPT_DIR/message.txt"

if [[ ! -f "$CONFIG" ]]; then
  echo "ERROR: config not found at $CONFIG" >&2
  exit 1
fi

source "$CONFIG"

# Parse arguments
FILES=()
MSG=""
REPLY_TO=""
POSITIONAL=()

while [[ $# -gt 0 ]]; do
  case "$1" in
    --file)
      if [[ -z "${2:-}" ]]; then
        echo "ERROR: --file requires a path argument" >&2
        exit 1
      fi
      FILES+=("$2")
      shift 2
      ;;
    --reply-to)
      if [[ -z "${2:-}" ]]; then
        echo "ERROR: --reply-to requires a message id" >&2
        exit 1
      fi
      if ! [[ "$2" =~ ^[1-9][0-9]*$ ]]; then
        echo "ERROR: --reply-to requires a positive integer" >&2
        exit 1
      fi
      REPLY_TO="$2"
      shift 2
      ;;
    *)
      POSITIONAL+=("$1")
      shift
      ;;
  esac
done

# Determine message source
if [[ ${#POSITIONAL[@]} -gt 0 && "${POSITIONAL[0]}" == "-" ]]; then
  MSG=$(cat)
elif [[ ${#POSITIONAL[@]} -gt 0 ]]; then
  MSG="${POSITIONAL[0]}"
elif [[ -f "$MSG_FILE" ]]; then
  MSG=$(cat "$MSG_FILE")
  rm -f "$MSG_FILE"
else
  echo "Usage: sc-post.sh [--file <path>]... [message]" >&2
  echo "  Or write message to $MSG_FILE and run without args" >&2
  exit 1
fi

# Upload files and collect IDs
FILE_IDS=()
for filepath in "${FILES[@]}"; do
  if [[ ! -f "$filepath" ]]; then
    echo "ERROR: File not found: $filepath" >&2
    exit 1
  fi

  UPLOAD_RESPONSE=$(curl -s -w "\n%{http_code}" \
    -X POST "$SERVER_URL/files/upload" \
    -H "Authorization: Bearer $TOKEN" \
    -F "file=@$filepath")

  UPLOAD_CODE=$(echo "$UPLOAD_RESPONSE" | tail -1)
  UPLOAD_BODY=$(echo "$UPLOAD_RESPONSE" | sed '$d')

  if [[ "$UPLOAD_CODE" != "200" && "$UPLOAD_CODE" != "201" ]]; then
    echo "ERROR: File upload failed ($UPLOAD_CODE): $UPLOAD_BODY" >&2
    exit 1
  fi

  FILE_ID=$(echo "$UPLOAD_BODY" | jq -r '.id')
  FILE_IDS+=("$FILE_ID")
  echo "Uploaded: $filepath -> $FILE_ID"
done

# Build JSON payload
if [[ ${#FILE_IDS[@]} -gt 0 ]]; then
  FILE_IDS_JSON=$(printf '%s\n' "${FILE_IDS[@]}" | jq -R . | jq -s .)
  PAYLOAD=$(jq -n --argjson file_ids "$FILE_IDS_JSON" --arg content "$MSG" '{ content: $content, file_ids: $file_ids }')
else
  PAYLOAD=$(jq -n --arg content "$MSG" '{ content: $content }')
fi
if [[ -n "$REPLY_TO" ]]; then
  PAYLOAD=$(echo "$PAYLOAD" | jq --argjson rid "$REPLY_TO" '. + { reply_to_id: $rid }')
fi

do_post() {
  curl -s -w "\n%{http_code}" \
    -X POST "$SERVER_URL/message" \
    -H "Content-Type: application/json" \
    -H "Authorization: Bearer $TOKEN" \
    -d "$PAYLOAD"
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

# Mark parent mention read so stop-poll.sh / poll-mentions.sh don't re-queue
# a thread we already replied to. Matches MCP post_reply semantics, which
# auto-marks read on success. Fire-and-forget — reply already landed, a
# failed read POST just means one possible stale wake (recoverable via the
# 2.6.21 race-filter in /mention-check step 0).
if [[ -n "$REPLY_TO" ]]; then
  curl -fsS -X POST -H "Authorization: Bearer $TOKEN" \
    "$SERVER_URL/messages/$REPLY_TO/read" >/dev/null 2>&1 || true
fi

echo "Posted: $MSG"
if [[ ${#FILE_IDS[@]} -gt 0 ]]; then
  echo "  with ${#FILE_IDS[@]} file(s) attached"
fi
