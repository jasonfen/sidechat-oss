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
#   2. $PWD/.sidechat        — repo-local install
#
# 2.6.22 dropped the $HOME/.sidechat fallback so multi-session bots can't
# silently grab a sibling's install. See resolve-sidechat-dir.sh for the
# rationale.
#
# Required in config: SERVER_URL, TOKEN.

set -euo pipefail

# Config resolution is shared with /mention-check via resolve-sidechat-dir.sh —
# single source of truth means plugin and slash command agree on which install
# they're talking to regardless of where Claude Code was launched from.
# Try the resolver from $PWD/.sidechat. Pre-2.6.22 also probed $HOME but
# that path is gone — see resolve-sidechat-dir.sh. Exit 0 if nothing found
# (background monitor — keep plugin registration intact, next restart
# resolves once a complete install exists at $PWD/.sidechat).
_resolver="$PWD/.sidechat/resolve-sidechat-dir.sh"
if [[ -x "$_resolver" ]]; then
  eval "$("$_resolver" 2>/dev/null)" || true
fi
if [[ -z "${SIDECHAT_DIR:-}" ]]; then
  echo "sidechat-monitor: no complete install at \$PWD/.sidechat; set SIDECHAT_DIR env to override" >&2
  exit 0
fi

CONFIG="$SIDECHAT_DIR/config"
# shellcheck disable=SC1090
source "$CONFIG"

: "${SERVER_URL:?sidechat-monitor: SERVER_URL missing from $CONFIG}"
: "${TOKEN:?sidechat-monitor: TOKEN missing from $CONFIG}"

POLL_INTERVAL="${SIDECHAT_POLL_INTERVAL_SEC:-5}"
POLL_LOOKBACK_HOURS="${SIDECHAT_POLL_HOURS:-72}"

# 2.6.31: log silent-skip paths once per reason per process. Without this,
# a permanently-broken inject (no tmux on PATH, $TMUX never set, etc.)
# leaves the operator wondering why mid-turn wake never fires. With dedup,
# the reason surfaces once at the first skip and stays out of the way
# afterwards. The 4xx logging on the pending-mentions GET (above) stays
# per-poll because it's typically transient — token rotation cures it.
declare -A _logged_once
log_skip_once() {
  local key="$1" msg="$2"
  if [[ -z "${_logged_once[$key]:-}" ]]; then
    echo "sidechat-monitor: $msg" >&2
    _logged_once[$key]=1
  fi
}

MENTIONS_FILE="$SIDECHAT_DIR/new-mentions.txt"
IDS_FILE="$SIDECHAT_DIR/new-mention-ids.txt"
FILES_DIR="$SIDECHAT_DIR/files"
mkdir -p "$FILES_DIR"

# Download one attachment to FILES_DIR using the same naming scheme as
# sc-webhook-server.py (`${file_id}_${basename}`), so /mention-check and
# the webhook path produce identical on-disk layouts. Prints the local
# path on success, nothing on failure (caller skips the [file] line).
download_attachment() {
  local fid="$1" fname="$2"
  local safe_name="${fname##*/}"       # basename
  safe_name="${safe_name//../_}"        # defang traversal
  local local_path="$FILES_DIR/${fid}_${safe_name}"
  if curl -sf --max-time 30 -H "Authorization: Bearer $TOKEN" \
       -o "$local_path" "$SERVER_URL/files/${fid}/download"; then
    printf '%s' "$local_path"
  fi
}

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

PLUGIN_VERSION="0.1.4"
LAST_INJECT_MS=""

now_ms() { date +%s%3N; }

# 0.1.4 (sidechat 2.6.31): post liveness to /bots/heartbeat each iteration.
# Server upserts a single per-bot row so /admin/bot-health can render
# last-poll-ago / last-inject-ago / queue-size. Best-effort: silent on
# transport errors (the poll loop itself is the canonical heartbeat —
# if the server is unreachable the operator sees that by other means).
send_heartbeat() {
  local poll_ms="$1" queue_size="$2"
  local body
  body=$(jq -nc \
    --argjson p "$poll_ms" \
    --argjson q "$queue_size" \
    --arg v "$PLUGIN_VERSION" \
    --arg i "${LAST_INJECT_MS:-}" \
    '{last_poll_ms:$p, queue_size:$q, plugin_version:$v} + (if $i == "" then {} else {last_inject_ms: ($i|tonumber)} end)')
  curl -sf --max-time 3 -X POST \
    -H "Authorization: Bearer $TOKEN" \
    -H "Content-Type: application/json" \
    -d "$body" \
    "$SERVER_URL/bots/heartbeat" >/dev/null 2>&1 || true
}

while true; do
  # 0.1.2: re-source config each iteration so TOKEN rotations (via
  # sc-auth.sh or sc-update.sh re-auth) propagate within one poll
  # interval. Pre-0.1.2 we sourced once at startup (line 48), which
  # silently broke after every credential rotation until the watcher
  # was killed and respawned. Fenbot caught this 2026-05-12 with the
  # 24h-stale token. Cheap (~50µs reading a small file) vs. minutes
  # of silent miss on next rotation.
  # shellcheck disable=SC1090
  source "$CONFIG" 2>/dev/null || true
  # 0.1.3: replace `curl -sf … || echo '{}'` with a -w-coded fetch so 4xx
  # responses surface to stderr instead of silently degrading to an empty
  # body. Pre-0.1.3 a stale TOKEN returned 401, the silenced body fell
  # through to '{}', and the loop walked empty forever with no log line.
  # Only 4xx complains (auth/permission — operator-actionable); 5xx and
  # network errors stay quiet because they're transient and self-healing.
  response=$(curl -s -w '\n%{http_code}' -H "Authorization: Bearer $TOKEN" \
    "$SERVER_URL/messages/pending-mentions?since_hours=${POLL_LOOKBACK_HOURS}" \
    2>/dev/null)
  http_code=$(printf '%s' "$response" | tail -n1)
  body=$(printf '%s' "$response" | sed '$d')
  if [[ "$http_code" =~ ^4 ]]; then
    echo "sidechat-monitor: pending-mentions GET → HTTP $http_code (TOKEN stale? config rotated mid-run? re-source picks up the next-rotated value automatically)" >&2
  fi
  if [[ "$http_code" != "200" ]]; then
    body='{}'
  fi

  # Extract new mentions (id + formatted line), dedup against the
  # on-disk IDS_FILE. Format lines the same way the webhook listener
  # does so /mention-check reads them without adapter code.
  new_ids=()
  new_lines=()
  # files[] is shipped as compact JSON in a 5th tsv column so the bash
  # loop can iterate attachments per message without a second jq pass.
  # Matches the webhook listener's behavior (sc-webhook-server.py:114-126)
  # — download each attachment, append `  [file] name -> local` under the
  # message line. Closes the payload-parity gap for "@bot review this file"
  # mentions where the webhook path surfaced attachments but the plugin
  # poll path silently dropped them.
  while IFS=$'\t' read -r id ts sender content files_json; do
    [[ -z "$id" ]] && continue
    if ! grep -qxF "$id" "$IDS_FILE" 2>/dev/null; then
      new_ids+=("$id")
      # Timestamp formatting matches sc-webhook-server.py + sessionstart-poll.sh
      # ("[YYYY-MM-DD HH:MM:SS] sender: content") so /mention-check parses it.
      pretty_ts="$(echo "$ts" | sed -e 's/T/ /' -e 's/\..*Z$//' -e 's/Z$//')"
      line="[$pretty_ts] $sender: $content"
      if [[ -n "$files_json" && "$files_json" != "null" && "$files_json" != "[]" ]]; then
        while IFS=$'\t' read -r fid fname; do
          [[ -z "$fid" ]] && continue
          local_path="$(download_attachment "$fid" "$fname")"
          if [[ -n "$local_path" ]]; then
            line+=$'\n'"  [file] $fname -> $local_path"
          fi
        done < <(echo "$files_json" | jq -r '.[] | [.id, .filename] | @tsv' 2>/dev/null)
      fi
      new_lines+=("$line")
    fi
  done < <(echo "$body" | jq -r '(.messages // [])[] | [.id, .timestamp, .sender, .content, ((.files // []) | @json)] | @tsv' 2>/dev/null)

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
    # is what wakes the idle REPL on CC versions where plugin-monitor
    # stdout-wake works (H1 on CC 2.1.116 + 2.1.117; see
    # mcp/src/probe-monitor/results/). Claude sees this line and runs
    # the slash command against the just-updated files.
    joined=$(IFS=,; echo "${new_ids[*]}")
    echo "SideChat: ${#new_ids[@]} new @-mention(s) pending (ids=$joined). Run /mention-check to handle them."

    # 2.6.27: in-plugin tmux-inject. Absorbs sc-webhook-server.py's role
    # (line 144 of that file did the same send-keys) so bots don't need
    # a sibling sidechat-webhook.service for reliable idle-REPL wake.
    # When the stdout-wake above lands, this is harmless belt-and-
    # suspenders (the duplicate /mention-check turn hits the step-0
    # race filter and exits silently). When stdout-wake regresses on a
    # newer CC build, this is the load-bearing path.
    #
    # Session-name detection (no hardcoded "claude"):
    #   1. $SIDECHAT_TMUX_SESSION env override.
    #   2. $TMUX env (inherited from CC's tmux pane) + `tmux display-
    #      message -p '#S'` for the actual current session.
    # Silent-degrade contract: any failure (no tmux on PATH, $TMUX
    # unset, send-keys returns nonzero) → skip; stop-poll.sh is still
    # the turn-end safety net. Do not "clean up" this block as dead
    # code on non-tmux installs — it self-skips there.
    if command -v tmux >/dev/null 2>&1; then
      _sess="${SIDECHAT_TMUX_SESSION:-}"
      if [[ -z "$_sess" && -n "${TMUX:-}" ]]; then
        _sess="$(tmux display-message -p '#S' 2>/dev/null || true)"
      fi
      if [[ -n "$_sess" ]]; then
        if tmux send-keys -t "$_sess" '/mention-check' Enter 2>/dev/null; then
          LAST_INJECT_MS="$(now_ms)"
        else
          log_skip_once "tmux-sendkeys" "tmux send-keys failed against session '$_sess' — pane may be detached; stdout-wake is now load-bearing"
        fi
      else
        log_skip_once "tmux-nosess" "tmux inject skipped — no session resolvable (\$SIDECHAT_TMUX_SESSION and \$TMUX both empty); stdout-wake is now load-bearing"
      fi
    else
      log_skip_once "tmux-missing" "tmux inject skipped — 'tmux' not on PATH; stdout-wake is now load-bearing"
    fi
  fi

  # Liveness heartbeat — fire after the poll work, so queue_size reflects
  # post-poll state and last_inject_ms covers any inject we just did.
  queue_size=$(wc -l < "$IDS_FILE" 2>/dev/null | tr -d ' ' || echo 0)
  send_heartbeat "$(now_ms)" "${queue_size:-0}"

  sleep "$POLL_INTERVAL"
done
