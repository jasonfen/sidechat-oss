#!/bin/bash
# SideChat mention monitor — the default notification-based wake path
# (2.6.49). Replaces the sidechat-monitor plugin's `tmux send-keys
# /mention-check` injection, which stole keystrokes from the operator's
# live pane on every mention.
#
# This is a CHEAP shell poller (0 tokens) meant to run under Claude Code's
# Monitor tool: each line it prints to stdout arrives in the main session as
# a NOTIFICATION (not a pasted command), including mid-turn — closing the
# in-turn-arrival gap that `stop-poll.sh`'s hard block existed to patch.
# When the main session sees a "MENTION ..." line it should spawn the
# `sidechat-responder` sub-agent (installed to .claude/agents/) to triage
# it: HANDLE simple read-only replies on Haiku, ESCALATE anything needing
# main-agent judgment, infra access, or approval.
#
# Self-locating: lives at .sidechat/sidechat-mention-monitor.sh for every
# bot, and resolves SIDECHAT_DIR from its own location — no per-bot path
# editing needed. Only USES the sidechat install (config + sc-auth.sh); does
# not modify any server/plugin/MCP code.
#
# Run via the Monitor tool (persistent:true). Stop via TaskStop.
# Origin: proven in production on fenbot's own bot before being adopted as
# the installer default 2026-08-12.
#
# Also carries the version self-heal check that used to live in
# /mention-check step 0 / on-new-mentions.sh (2.6.50) — this is now the one
# thing that runs continuously in steady state, so it is the only reliable
# place left to detect a new server version and tell the operator/agent.

set -uo pipefail

SIDECHAT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
SEEN_FILE="$SIDECHAT_DIR/.mention-monitor-seen"
POLL_INTERVAL="${SIDECHAT_MONITOR_INTERVAL:-60}"
LOOKBACK_HOURS="${SIDECHAT_MONITOR_HOURS:-72}"
LOCK_FILE="$SIDECHAT_DIR/.mention-monitor.lock"

# Singleton guard — only one poller at a time no matter how many times armed
# (SessionStart auto-arm must never stack a second instance onto a manual
# launch). fd 9 holds the exclusive lock for the life of the process.
exec 9>"$LOCK_FILE"
if ! flock -n 9; then
  echo "sidechat-mention-monitor: another instance already holds $LOCK_FILE — exiting" >&2
  exit 0
fi

# Belt-and-suspenders: reap any tmux-inject plugin poller that respawns
# (e.g. `claude plugin enable` run out of band, or a fresh session before
# this monitor gets armed). Since 2.6.48, install-mcp.sh respects a
# `claude plugin disable sidechat-monitor` state and won't silently
# re-enable it, but this stays as a backstop so any injection window is
# bounded to one poll interval.
reap_plugin_poller() { pkill -f 'sidechat-monitor/.*/scripts/poll-mentions\.sh' 2>/dev/null || true; }
reap_plugin_poller

touch "$SEEN_FILE"

load_config() { set -a; . "$SIDECHAT_DIR/config"; set +a; }
load_config

# Version self-heal. Historically this lived in /mention-check's step 0 and
# on-new-mentions.sh's FileChanged trigger — but once this poller is the
# steady-state wake path, neither fires routinely (stop-poll.sh no-ops once
# this poller is confirmed running, so it stops writing new-mentions.txt;
# the sidechat-responder subagent bypasses /mention-check's step 0
# entirely). Without a check here, a fully-migrated bot has no remaining
# automatic version-detection heartbeat — this closes that gap. Emits a
# notification (not a silent self-update — this script would be rewriting
# its own currently-running file) only once per newly-detected remote
# version, so it does not spam every cycle while the operator gets to it.
LAST_NOTIFIED_VERSION=""
check_version() {
  local local_ver remote_ver
  local_ver=$(cat "$SIDECHAT_DIR/sc-version.txt" 2>/dev/null || echo "")
  remote_ver=$(curl -fsS --max-time 3 "${SERVER_URL}/install/version" 2>/dev/null | tr -d '\r\n')
  [[ -n "$remote_ver" && "$local_ver" != "$remote_ver" && "$remote_ver" != "$LAST_NOTIFIED_VERSION" ]] || return 0
  LAST_NOTIFIED_VERSION="$remote_ver"
  echo "UPDATE-AVAILABLE — SideChat server is on ${remote_ver}, this bot is on ${local_ver:-<unknown>}. Run sc-update.sh to pick up the new client/wake-path files."
}

# Fetch pending mentions JSON. Reauth once on failure. Echoes JSON on success,
# nothing on failure; returns 0/1.
fetch_pending() {
  local out rc
  out=$(curl -fsS --max-time 8 -H "Authorization: Bearer ${TOKEN}" \
    "${SERVER_URL}/messages/pending-mentions?since_hours=${LOOKBACK_HOURS}" 2>/dev/null)
  rc=$?
  if [[ $rc -ne 0 ]]; then
    # Likely expired token — reauth, re-source, retry once.
    bash "$SIDECHAT_DIR/sc-auth.sh" >/dev/null 2>&1 || true
    load_config
    out=$(curl -fsS --max-time 8 -H "Authorization: Bearer ${TOKEN}" \
      "${SERVER_URL}/messages/pending-mentions?since_hours=${LOOKBACK_HOURS}" 2>/dev/null)
    rc=$?
  fi
  [[ $rc -eq 0 ]] || return 1
  printf '%s' "$out"
}

fail_streak=0

while true; do
  reap_plugin_poller
  check_version
  json=$(fetch_pending)
  if [[ $? -ne 0 || -z "$json" ]]; then
    fail_streak=$((fail_streak + 1))
    # Emit once on entering a failure streak — auth broken must NOT masquerade
    # as "no mentions" (the silent-failure trap).
    if [[ $fail_streak -eq 1 ]]; then
      echo "POLL-FAIL — SideChat pending-mentions poll failing (auth or network); sc-auth.sh retry did not recover. Fix before trusting silence."
    fi
    sleep "$POLL_INTERVAL"
    continue
  fi
  if [[ $fail_streak -gt 0 ]]; then
    echo "POLL-RECOVERED — SideChat mention poll healthy again after ${fail_streak} failed cycle(s)."
    fail_streak=0
  fi

  # Emit one line per NEW pending mention, then record it seen.
  while IFS=$'\t' read -r id sender content files; do
    [[ -n "$id" ]] || continue
    if grep -qxF "$id" "$SEEN_FILE" 2>/dev/null; then
      continue
    fi
    preview=$(printf '%s' "$content" | tr '\n' ' ' | cut -c1-140)
    attach=""
    [[ "$files" != "[]" && -n "$files" ]] && attach=" [has attachment]"
    echo "MENTION ${id} from ${sender}${attach}: ${preview}"
    echo "$id" >> "$SEEN_FILE"
  done < <(printf '%s' "$json" | jq -r '(.messages // [])[] | [.id, (.sender // "?"), (.content // ""), ((.files // []) | @json)] | @tsv' 2>/dev/null)

  sleep "$POLL_INTERVAL"
done
