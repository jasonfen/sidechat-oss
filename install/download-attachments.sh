#!/usr/bin/env bash
# Download SideChat message attachments to $SIDECHAT_DIR/files/, named
# ${file_id}_${basename} per CLAUDE.md's documented contract. Shared by
# every producer of a mention queue (sidechat-mention-monitor.sh,
# sessionstart-poll.sh, stop-poll.sh, /mention-check's step-0 race-fix
# re-query) so attachment fetching lives in exactly one place instead of
# drifting across N copies — post-push.sh nearly taught us that lesson
# the hard way (2.6.56/2.6.57, git -C dir-resolution gap).
#
# Usage: printf '%s' '<files-json-array>' | download-attachments.sh
#   <files-json-array> is a JSON array of {id, filename, ...} objects —
#   either one message's `.files` field, or a flattened array pooled
#   across several messages (e.g. `jq '[.messages[].files[]?]'`).
#
# Requires SIDECHAT_DIR, TOKEN, SERVER_URL already exported by the caller
# (every call site already sources config before reaching this point).
# Silently no-ops if any are missing rather than failing loud — matches
# this script's role as a best-effort helper, not a load-bearing step.
#
# Best-effort: a failed download must never abort the caller's mention
# loop, so this always exits 0 and swallows curl errors (leaving no
# partial file behind on failure). Idempotent: skips files already on
# disk, so re-processing the same mention (e.g. across a session restart)
# doesn't re-fetch.

set -uo pipefail

files_json="$(cat)"

[[ -n "${SIDECHAT_DIR:-}" && -n "${TOKEN:-}" && -n "${SERVER_URL:-}" ]] || exit 0

mkdir -p "$SIDECHAT_DIR/files"

while IFS=$'\t' read -r fid fname; do
  [[ -n "$fid" ]] || continue
  fname=$(basename -- "$fname")
  dest="$SIDECHAT_DIR/files/${fid}_${fname}"
  [[ -f "$dest" ]] && continue
  fetch() { curl -sS --max-time 20 -H "Authorization: Bearer ${TOKEN}" \
    "${SERVER_URL}/files/${fid}/download" -o "$dest" -w '%{http_code}' 2>/dev/null; }
  code=$(fetch) || code=000
  # Expired token: re-auth once and retry. On the channel wake path the MCP
  # hands downloads to this script, and nothing else refreshes TOKEN (2.8.7).
  if [[ "$code" == 401 && -z "${REAUTHED:-}" ]]; then
    REAUTHED=1
    if "$SIDECHAT_DIR/sc-auth.sh" >/dev/null 2>&1; then
      TOKEN=$(sed -n 's/^TOKEN=//p' "$SIDECHAT_DIR/config" | tail -1 | tr -d "\"'")
      code=$(fetch) || code=000
    fi
  fi
  [[ "$code" == 2?? ]] || rm -f "$dest"
done < <(printf '%s' "$files_json" | jq -r '(. // [])[] | [.id, .filename] | @tsv' 2>/dev/null)

exit 0
