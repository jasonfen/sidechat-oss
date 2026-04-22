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

SIDECHAT_DIR="${SIDECHAT_DIR:-}"
if [[ -z "$SIDECHAT_DIR" ]]; then
  if [[ -f "$PWD/.sidechat/config" ]]; then
    SIDECHAT_DIR="$PWD/.sidechat"
  elif [[ -f "$HOME/.sidechat/config" ]]; then
    SIDECHAT_DIR="$HOME/.sidechat"
  else
    echo "sidechat-monitor: no .sidechat/config found in \$PWD or \$HOME; set SIDECHAT_DIR env to override" >&2
    # Background monitor — exit cleanly rather than loop-failing. Plugin
    # registration stays intact; restart resolves config once it exists.
    exit 0
  fi
fi

CONFIG="$SIDECHAT_DIR/config"
# shellcheck disable=SC1090
source "$CONFIG"

: "${SERVER_URL:?sidechat-monitor: SERVER_URL missing from $CONFIG}"
: "${TOKEN:?sidechat-monitor: TOKEN missing from $CONFIG}"

POLL_INTERVAL="${SIDECHAT_POLL_INTERVAL_SEC:-5}"
POLL_LOOKBACK_HOURS="${SIDECHAT_POLL_HOURS:-72}"

# Dedup: track emitted ids in a lifetime tmpfile so the same mention
# isn't signaled on every poll (fenbot caught this in the 2026-04-21
# probe run — without dedup, a single pending mention fires a wake
# every POLL_INTERVAL seconds forever).
SEEN_FILE="$(mktemp -t sidechat-monitor-seen.XXXXXX)"
trap 'rm -f "$SEEN_FILE"' EXIT

MENTIONS_FILE="$SIDECHAT_DIR/new-mentions.txt"
IDS_FILE="$SIDECHAT_DIR/new-mention-ids.txt"

while true; do
  body=$(curl -sf -H "Authorization: Bearer $TOKEN" \
    "$SERVER_URL/messages/pending-mentions?since_hours=${POLL_LOOKBACK_HOURS}" \
    2>/dev/null || echo '{}')

  # Extract new mentions (id + formatted line), dedup against SEEN_FILE.
  # Format lines the same way the webhook listener does so /mention-check
  # reads them without adapter code.
  new_ids=()
  new_lines=()
  while IFS=$'\t' read -r id ts sender content; do
    [[ -z "$id" ]] && continue
    if ! grep -qxF "$id" "$SEEN_FILE" 2>/dev/null; then
      new_ids+=("$id")
      # Timestamp formatting matches sc-webhook-server.py + sessionstart-poll.sh
      # ("[YYYY-MM-DD HH:MM:SS] sender: content") so /mention-check parses it.
      pretty_ts="$(echo "$ts" | sed -e 's/T/ /' -e 's/\..*Z$//' -e 's/Z$//')"
      new_lines+=("[$pretty_ts] $sender: $content")
      echo "$id" >> "$SEEN_FILE"
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
