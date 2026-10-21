#!/usr/bin/env bash
# Usage:
#   sc-receipt.sh engaged                # POST .../engaged for each id in default ids file
#   sc-receipt.sh read                   # POST .../read   for each id, then delete that ids file
#   sc-receipt.sh engaged --ids-file F   # use F instead of the default new-mention-ids.txt
#   sc-receipt.sh read    --ids-file F   # use F; on success, delete F (not the default)
#   sc-receipt.sh engaged --id <msg-id>  # one id, single POST, no files touched
#   sc-receipt.sh read    --id <msg-id>  # one id, single POST, no files touched
#
# Multi-id source (default new-mention-ids.txt) is populated by the watcher. Pairs with the
# three-state receipt model: delivered -> engaged (slash command starts) -> read (slash
# command finishes). The --ids-file flag exists so /mention-check can rename the queue to
# processing-mention-ids.txt at step 0 (atomic-processing pattern, v2.6.31) and have this
# script act on the renamed file. The --id flag exists for the per-mention read-on-reply
# pattern — emit a `read` the moment a single reply lands, instead of batching at step 6.
#
# Full reference (all three receipt states, when each fires): ../sc-cheatsheet.md
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
CONFIG="$SCRIPT_DIR/config"

if [[ ! -f "$CONFIG" ]]; then echo "ERROR: config not found at $CONFIG" >&2; exit 1; fi
source "$CONFIG"

KIND="${1:-}"
shift || true

if [[ "$KIND" == "-h" || "$KIND" == "--help" ]]; then
  sed -n '2,17p' "${BASH_SOURCE[0]}" | sed 's/^# \{0,1\}//'
  exit 0
fi

if [[ "$KIND" != "engaged" && "$KIND" != "read" ]]; then
  echo "Usage: $0 {engaged|read} [--ids-file PATH | --id MSG_ID]" >&2
  echo "Run '$0 --help' for details." >&2
  exit 2
fi

IDS_FILE="$SCRIPT_DIR/new-mention-ids.txt"
SINGLE_ID=""
while [[ $# -gt 0 ]]; do
  case "$1" in
    --ids-file) IDS_FILE="${2:-}"; shift 2 ;;
    --id)       SINGLE_ID="${2:-}"; shift 2 ;;
    *)          echo "Unknown arg: $1" >&2; exit 2 ;;
  esac
done

post_receipt() {
  local id="$1" code
  [[ -z "$id" ]] && return 0
  code=$(curl -sS -o /dev/null -w '%{http_code}' -X POST -H "Authorization: Bearer ${TOKEN}" \
    "${SERVER_URL}/messages/${id}/${KIND}" 2>/dev/null) || code=000
  # Expired token: re-auth once and retry, like sc-post.sh. On the channel wake
  # path the MCP does the posting, so nothing else refreshes this token (2.8.5).
  if [[ "$code" == 401 && -z "${REAUTHED:-}" ]]; then
    REAUTHED=1
    if "$SCRIPT_DIR/sc-auth.sh" >/dev/null 2>&1; then
      source "$CONFIG"
      post_receipt "$id"
      return
    fi
  fi
  [[ "$code" == 2?? ]] && return 0
  echo "sc-receipt: $KIND $id failed (HTTP $code)" >&2
  return 1
}

# A failed `read` exits 1 so the caller knows the mention is still unread.
# `engaged` stays best-effort: it warns but exits 0.
FAILED=0
if [[ -n "$SINGLE_ID" ]]; then
  # Single-id mode: one POST, no file involvement. Used by /mention-check
  # to mark each mention `read` immediately after its reply lands, so
  # partial-run progress is durable across crashes.
  post_receipt "$SINGLE_ID" || FAILED=1
else
  [[ -f "$IDS_FILE" ]] || exit 0
  while IFS= read -r ID || [[ -n "$ID" ]]; do
    [[ -z "$ID" ]] && continue
    post_receipt "$ID" || FAILED=1
  done < "$IDS_FILE"

  # After 'read' phase, clear the ids file so the next batch starts fresh.
  # (Only the file we actually consumed — not any other queue.) A mention whose
  # read failed is still unread server-side, so pending-mentions re-surfaces it.
  if [[ "$KIND" == "read" ]]; then
    rm -f "$IDS_FILE"
  fi
fi
[[ "$KIND" == "read" && "$FAILED" == 1 ]] && exit 1
exit 0
