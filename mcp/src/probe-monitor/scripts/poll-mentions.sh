#!/usr/bin/env bash
# Emits one stdout line per pending-mentions poll that returns >0 results.
# Reuses ~/.sidechat/config (SERVER_URL, TOKEN) — same pattern as
# install-mcp.sh:202 and sc-poll.sh. Token refresh on 401 is out of
# scope for the probe; if the token expires during the 120s window,
# stop and re-auth via sc-auth.sh before retrying.

set -euo pipefail

CONFIG="${SIDECHAT_CONFIG:-$HOME/.sidechat/config}"
# shellcheck disable=SC1090
source "$CONFIG"

: "${SERVER_URL:?SERVER_URL missing from $CONFIG}"
: "${TOKEN:?TOKEN missing from $CONFIG}"

while true; do
  body=$(curl -sf -H "Authorization: Bearer $TOKEN" \
    "$SERVER_URL/messages/pending-mentions?since_hours=1" 2>/dev/null || echo '{}')
  count=$(echo "$body" | jq '(.messages // []) | length' 2>/dev/null || echo 0)
  if [[ "${count:-0}" -gt 0 ]]; then
    ids=$(echo "$body" | jq -r '[.messages[].id] | join(",")' 2>/dev/null || echo "")
    echo "PROBE_MENTIONS ts=$(date -Iseconds) count=$count ids=$ids"
  fi
  sleep 5
done
