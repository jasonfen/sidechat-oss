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

# Dedup state — fenbot's 2026-04-21 canary run caught this script re-emitting
# the same mention id on every 5s tick, conflating "new event" with "poll
# tick." Track emitted IDs in a tmpfile for the script's lifetime; reset
# across script restarts (intentional — a restart should treat its first
# poll as fresh). Swap $TMPDIR if probes need to share state across runs.
SEEN_FILE="$(mktemp -t probe-mentions-seen.XXXXXX)"
trap 'rm -f "$SEEN_FILE"' EXIT

while true; do
  body=$(curl -sf -H "Authorization: Bearer $TOKEN" \
    "$SERVER_URL/messages/pending-mentions?since_hours=1" 2>/dev/null || echo '{}')
  # Collect IDs that are NEW relative to SEEN_FILE.
  new_ids=()
  while IFS= read -r id; do
    [[ -z "$id" ]] && continue
    if ! grep -qxF "$id" "$SEEN_FILE" 2>/dev/null; then
      new_ids+=("$id")
      echo "$id" >> "$SEEN_FILE"
    fi
  done < <(echo "$body" | jq -r '(.messages // [])[].id' 2>/dev/null)
  if (( ${#new_ids[@]} > 0 )); then
    joined=$(IFS=,; echo "${new_ids[*]}")
    echo "PROBE_MENTIONS ts=$(date -Iseconds) count=${#new_ids[@]} ids=$joined"
  fi
  sleep 5
done
