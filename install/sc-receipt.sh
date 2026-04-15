#!/usr/bin/env bash
# Usage: ./sc-receipt.sh engaged   # POST /messages/<id>/engaged for each id in new-mention-ids.txt
#        ./sc-receipt.sh read      # POST /messages/<id>/read for each id, then delete the ids file
#
# Reads .sidechat/new-mention-ids.txt (one msg id per line) populated by the
# webhook listener. Pairs with the three-state receipt model:
#   delivered -> engaged (slash command starts) -> read (slash command finishes)
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
CONFIG="$SCRIPT_DIR/config"
IDS_FILE="$SCRIPT_DIR/new-mention-ids.txt"

if [[ ! -f "$CONFIG" ]]; then echo "ERROR: config not found at $CONFIG" >&2; exit 1; fi
source "$CONFIG"

KIND="${1:-}"
if [[ "$KIND" != "engaged" && "$KIND" != "read" ]]; then
  echo "Usage: $0 {engaged|read}" >&2
  exit 2
fi

if [[ ! -f "$IDS_FILE" ]]; then exit 0; fi

while IFS= read -r ID || [[ -n "$ID" ]]; do
  [[ -z "$ID" ]] && continue
  curl -fsS -X POST -H "Authorization: Bearer ${TOKEN}" \
    "${SERVER_URL}/messages/${ID}/${KIND}" >/dev/null 2>&1 || true
done < "$IDS_FILE"

# After 'read' phase, clear the ids file so the next batch starts fresh.
if [[ "$KIND" == "read" ]]; then
  rm -f "$IDS_FILE"
fi
