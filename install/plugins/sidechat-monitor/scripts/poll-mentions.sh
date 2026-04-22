#!/usr/bin/env bash
# sidechat-monitor plugin's poll loop.
#
# Runs as a Claude Code plugin background monitor. Polls
# /messages/pending-mentions on the bot's sidechat server every
# SIDECHAT_POLL_INTERVAL_SEC (default 5). For each new mention id
# (deduped against a lifetime tmpfile), writes to
# .sidechat/new-mentions.txt + .sidechat/new-mention-ids.txt and emits
# a wake line that directs Claude to run /mention-check.
#
# Designed to replace the sc-webhook-server.py + tmux send-keys path
# on bots where plugin monitors are confirmed to wake idle REPLs (see
# mcp/src/probe-monitor for the regression probe). Can coexist with
# the webhook listener during cutover — the existing mention-check
# flow deduplicates on the server side via read receipts, so
# double-delivery is an extra no-op poll, not a doubled reply.
#
# Config resolution (first match wins):
#   1. $SIDECHAT_DIR         — explicit plugin-side override
#   2. $PWD/.sidechat        — repo-local install (most bots)
#   3. $HOME/.sidechat       — home install (install-server.sh default)
#
# Required in config: SERVER_URL, TOKEN.

set -euo pipefail

# Config resolution is shared with /mention-check via resolve-sidechat-dir.sh —
# single source of truth means plugin and slash command agree on which install
# they're talking to regardless of where Claude Code was launched from.
# Try the resolver from likely install dirs ($PWD-relative, then $HOME); exit
# 0 if nothing found (background monitor — keep plugin registration intact,
# next restart resolves once config exists).
for _resolver in "$PWD/.sidechat/resolve-sidechat-dir.sh" "$HOME/.sidechat/resolve-sidechat-dir.sh"; do
  if [[ -x "$_resolver" ]]; then
    eval "$("$_resolver" 2>/dev/null)" && break || true
  fi
done
if [[ -z "${SIDECHAT_DIR:-}" ]]; then
  echo "sidechat-monitor: no .sidechat/config found in \$PWD or \$HOME; set SIDECHAT_DIR env to override" >&2
  exit 0
fi

CONFIG="$SIDECHAT_DIR/config"
# shellcheck disable=SC1090
source "$CONFIG"

: "${SERVER_URL:?sidechat-monitor: SERVER_URL missing from $CONFIG}"
: "${TOKEN:?sidechat-monitor: TOKEN missing from $CONFIG}"

POLL_INTERVAL="${SIDECHAT_POLL_INTERVAL_SEC:-5}"
POLL_LOOKBACK_HOURS="${SIDECHAT_POLL_HOURS:-72}"

MENTIONS_FILE="$SIDECHAT_DIR/new-mentions.txt"
IDS_FILE="$SIDECHAT_DIR/new-mention-ids.txt"

# Dedup strategy: the on-disk new-mention-ids.txt file IS the state.
# Checking against it directly (instead of a plugin-private tmpfile)
# handles three cases a SEEN_FILE approach gets wrong:
#
#   1. Webhook and plugin race on the same mention. If webhook POST
#      arrives between plugin polls, webhook writes the id first;
#      plugin's next poll sees it already present, skips. No double
#      /mention-check fire.
#   2. Plugin restart. A SEEN_FILE in mktemp resets every start,
#      which would re-emit pending mentions still in the file. Using
#      the file itself means restart sees existing state.
#   3. /mention-check clearing the ids file. sc-receipt.sh read
#      deletes new-mention-ids.txt after posting read receipts
#      server-side; pending-mentions then excludes those ids, so the
#      next poll naturally treats the (now empty) file as the
#      baseline. No stale-state leaks.
#
# Thanks to fenbot for flagging the race-window shape before UAT.

while true; do
  body=$(curl -sf -H "Authorization: Bearer $TOKEN" \
    "$SERVER_URL/messages/pending-mentions?since_hours=${POLL_LOOKBACK_HOURS}" \
    2>/dev/null || echo '{}')

  # Extract new mentions (id + formatted line), dedup against the
  # on-disk IDS_FILE. Format lines the same way the webhook listener
  # does so /mention-check reads them without adapter code.
  new_ids=()
  new_lines=()
  while IFS=$'\t' read -r id ts sender content; do
    [[ -z "$id" ]] && continue
    if ! grep -qxF "$id" "$IDS_FILE" 2>/dev/null; then
      new_ids+=("$id")
      # Timestamp formatting matches sc-webhook-server.py + sessionstart-poll.sh
      # ("[YYYY-MM-DD HH:MM:SS] sender: content") so /mention-check parses it.
      pretty_ts="$(echo "$ts" | sed -e 's/T/ /' -e 's/\..*Z$//' -e 's/Z$//')"
      new_lines+=("[$pretty_ts] $sender: $content")
    fi
  done < <(echo "$body" | jq -r '(.messages // [])[] | [.id, .timestamp, .sender, .content] | @tsv' 2>/dev/null)

  if (( ${#new_ids[@]} > 0 )); then
    # Append to the existing new-mentions files so /mention-check picks
    # up the same pipeline webhook delivery uses. `>>` not `>`: the
    # webhook listener may also be appending during the hybrid period;
    # dedup-in-/mention-check handles overlap.
    for line in "${new_lines[@]}"; do
      printf '%s\n' "$line" >> "$MENTIONS_FILE"
    done
    for id in "${new_ids[@]}"; do
      printf '%s\n' "$id" >> "$IDS_FILE"
    done
    # Wake line directing Claude to /mention-check. The stdout emission
    # is what wakes the idle REPL (confirmed H1 on CC 2.1.116 + 2.1.117,
    # see mcp/src/probe-monitor/results/). Claude sees this line and
    # runs the slash command against the just-updated files.
    joined=$(IFS=,; echo "${new_ids[*]}")
    echo "SideChat: ${#new_ids[@]} new @-mention(s) pending (ids=$joined). Run /mention-check to handle them."
  fi

  sleep "$POLL_INTERVAL"
done
