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
# Run via the Monitor tool (30 min cap per run; re-arm on expiry). Stop via TaskStop.
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
NAG_AFTER="${SIDECHAT_MONITOR_NAG_AFTER:-900}"
# Reload ourselves when sc-update.sh rewrites this file, so a running Monitor
# never keeps stale code. exec keeps the PID, so the Monitor task is unaffected.
SELF_HASH=$(sha256sum "${BASH_SOURCE[0]}" | cut -d' ' -f1)

# Singleton guard — only one poller at a time no matter how many times armed
# (SessionStart auto-arm must never stack a second instance onto a manual
# launch). fd 9 holds the exclusive lock for the life of the process.
#
# 2026-08-12 (fenbot, hit live): every `sleep "$POLL_INTERVAL"` below spawns
# a child process that INHERITS fd 9 by default (bash doesn't mark exec'd
# fds close-on-exec). flock is held per open-file-description, not per PID
# -- so `pkill -f 'sidechat-mention-monitor\.sh'` kills this parent (whose
# argv matches) but not the orphaned sleep child (whose argv is just "sleep
# N"), which keeps fd 9 open and the lock held for up to $POLL_INTERVAL
# after the parent is gone. A fresh arm in that window silently flock-exits
# thinking a real instance is still running. Every `sleep "$POLL_INTERVAL"`
# call below is `9>&-` (fd 9 closed for that child only, parent's copy
# unaffected) specifically to prevent this -- do not drop it.
exec 9>"$LOCK_FILE"
if ! flock -n 9; then
  echo "ALREADY-RUNNING — another sidechat-mention-monitor holds $LOCK_FILE; this arm exits."
  exit 0
fi

# The process that owns this poller's lifetime: the claude session that armed
# it. Under both the Monitor tool and Bash run_in_background the poller sits
# under a `bash -c` wrapper, and a background shell task survives a session end
# when the user picks "Move to background and exit", leaving that wrapper alive
# under init. So $PPID is not enough: walk up to the `claude` process and watch
# that. Falls back to $PPID when there is no claude ancestor (manual run).
# SIDECHAT_OWNER_COMM names the process to look for (tests use it).
find_owner() {
  local p=$$ comm
  while [[ -n "$p" && "$p" -gt 1 ]]; do
    comm=$(cat "/proc/$p/comm" 2>/dev/null) || break
    [[ "$comm" == "${SIDECHAT_OWNER_COMM:-claude}" ]] && { echo "$p"; return; }
    p=$(ps -o ppid= -p "$p" 2>/dev/null | tr -d ' ')
  done
  echo "$PPID"
}
OWNER_PID=$(find_owner)

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

# Heartbeat so /admin/bot-health has live data for bots on this wake path.
# Previously only the plugin's poll-mentions.sh called this — bots that
# migrated and disabled the plugin went dark on that dashboard (frozen
# last-seen, stale queue_size, or "no heartbeat" at all despite being fully
# alive on the new path). Best-effort: a failed heartbeat POST must never
# take down the mention loop itself, so errors are swallowed. No
# last_inject_ms — this path never injects, matching the dashboard's
# existing "null on non-tmux installs" handling.
#
# 2026-08-12: plugin_version carries "mention-monitor vX.Y.Z" (this bot's
# real sc-version.txt), not a bare hardcoded marker as first shipped in
# 2.6.52 — jason flagged that the original marker made every bot's dashboard
# entry read identically, losing the version-drift-at-a-glance visibility
# the old plugin's raw version number gave (e.g. "0.1.10" vs "0.1.9"). The
# "mention-monitor" prefix is kept so the column still reads as this wake
# path rather than a legacy plugin release at a glance; the version suffix
# restores the drift signal, now against the actual client version instead
# of a plugin-specific one.
send_heartbeat() {
  local queue_size="$1"
  local now_ms=$(( $(date +%s) * 1000 ))
  local ver; ver=$(cat "$SIDECHAT_DIR/sc-version.txt" 2>/dev/null || echo "?")
  curl -fsS --max-time 5 -H "Authorization: Bearer ${TOKEN}" -H "Content-Type: application/json" \
    -d "$(jq -cn --argjson t "$now_ms" --argjson q "$queue_size" --arg v "mention-monitor v${ver}" \
      '{last_poll_ms: $t, queue_size: $q, plugin_version: $v}')" \
    "${SERVER_URL}/bots/heartbeat" >/dev/null 2>&1 || true
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

# Download attachments for a mention into $SIDECHAT_DIR/files/. Delegates to
# the shared download-attachments.sh (2.6.60+) rather than an inline copy —
# sessionstart-poll.sh, stop-poll.sh, and /mention-check's step-0 re-query
# all need the same logic, and duplicating it four times is exactly the kind
# of drift post-push.sh already burned us on once (2.6.56/57).
download_attachments() {
  printf '%s' "$1" | "$SIDECHAT_DIR/download-attachments.sh"
}

fail_streak=0
# Mentions already re-announced as STILL-PENDING by this arm (once each).
declare -A nagged

while true; do
  # Orphan guard: once the claude session that armed us is gone, exit instead of
  # polling forever (see find_owner above).
  kill -0 "$OWNER_PID" 2>/dev/null || exit 0
  if [[ "$(sha256sum "${BASH_SOURCE[0]}" | cut -d' ' -f1)" != "$SELF_HASH" ]]; then
    echo "MONITOR-RELOADED — sidechat-mention-monitor.sh changed on disk; reloading."
    exec bash "${BASH_SOURCE[0]}"
  fi
  reap_plugin_poller
  check_version
  json=$(fetch_pending)
  if [[ $? -ne 0 || -z "$json" ]]; then
    fail_streak=$((fail_streak + 1))
    # Emit once on entering a failure streak — auth broken must NOT masquerade
    # as "no mentions" (the silent-failure trap).
    if [[ $fail_streak -eq 3 ]]; then
      echo "POLL-FAIL — SideChat pending-mentions poll failing (auth or network); sc-auth.sh retry did not recover. Fix before trusting silence."
    fi
    send_heartbeat 0
    sleep "$POLL_INTERVAL" 9>&-
    continue
  fi
  if [[ $fail_streak -gt 0 ]]; then
    echo "POLL-RECOVERED — SideChat mention poll healthy again after ${fail_streak} failed cycle(s)."
    fail_streak=0
  fi
  send_heartbeat "$(printf '%s' "$json" | jq -r '.count // 0' 2>/dev/null || echo 0)"

  # Emit one line per NEW pending mention, then record it seen.
  announced=""
  while IFS=$'\t' read -r id sender age content files; do
    [[ -n "$id" ]] || continue
    preview=$(printf '%s' "$content" | tr '\n' ' ' | cut -c1-140)
    if grep -qxF "$id" "$SEEN_FILE" 2>/dev/null; then
      # Announced earlier but still unread: the handler may have been lost
      # (two MENTION lines in one batch, dead sub-agent). Say so once per arm.
      if [[ "$age" -gt "$NAG_AFTER" && -z "${nagged[$id]:-}" ]]; then
        nagged[$id]=1
        echo "STILL-PENDING ${id} from ${sender} (unread ${age}s): ${preview}"
      fi
      continue
    fi
    attach=""
    if [[ "$files" != "[]" && -n "$files" ]]; then
      attach=" [has attachment]"
      download_attachments "$files"
    fi
    echo "MENTION ${id} from ${sender}${attach}: ${preview}"
    echo "$id" >> "$SEEN_FILE"
    announced=1
  done < <(printf '%s' "$json" | jq -r '
    def ts: sub("\\.[0-9]+Z$"; "Z") | fromdateiso8601;
    (if .server_now then (.server_now | ts) else now end) as $now
    | (.messages // [])[]
    | [.id, (.sender // "?"), (($now - (.timestamp | ts)) | floor), (.content // ""), ((.files // []) | @json)] | @tsv' 2>/dev/null)

  # WAKE_PATH=background: run under Bash run_in_background, so exiting is the
  # notification. Exit only after the whole batch is announced (one arm, one
  # turn); a STILL-PENDING line alone does not end the run, or a mention the
  # agent is holding would make every re-arm exit at once.
  [[ -z "${SIDECHAT_MONITOR_EXIT_ON_MENTION:-}" || -z "$announced" ]] || exit 0

  sleep "$POLL_INTERVAL" 9>&-
done
