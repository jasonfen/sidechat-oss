#!/bin/bash
# Start Claude Code for an unattended bot (boot service, tmux session, cron) so
# the session has a first turn with nobody typing. The SessionStart hook only
# injects "arm the mention monitor" as context for the agent's first turn; an
# unattended session never gets one, so nothing arms. The positional prompt
# below is that first turn.
#
# WAKE_PATH=channel in .sidechat/config (2.8.0) starts claude with the SideChat
# channel instead: the sidechat MCP pushes each mention into the session, so no
# first turn is needed and the prompt is dropped. Custom channels need
# --dangerously-load-development-channels, whose warning screen appears at every
# start; inside tmux this script presses Enter on it, only while it is showing.
#
# Usage: .sidechat/launch-claude.sh [claude options...]
#   tmux new-session -d -s claude -c ~/myproject \
#     '~/myproject/.sidechat/launch-claude.sh --permission-mode bypassPermissions'
# Options pass straight through to claude. Set SIDECHAT_ARM_PROMPT to change the
# prompt, CLAUDE_BIN to use a claude that is not on PATH. sc-update.sh rewrites
# this file, so customise through those, not by editing it.

set -u
cd "$(dirname "${BASH_SOURCE[0]}")/.." || exit 1
PROMPT="${SIDECHAT_ARM_PROMPT:-(session start: confirm the SideChat wake path is armed, catch up on any pending mentions)}"
CLAUDE="${CLAUDE_BIN:-claude}"
WAKE_PATH=$(sed -n 's/^WAKE_PATH=//p' .sidechat/config 2>/dev/null | tail -1 | tr -d "\"'")

TAIL=(-- "$PROMPT")
if [[ "$WAKE_PATH" == "channel" ]]; then
  set -- --dangerously-load-development-channels "server:${SIDECHAT_MCP_NAME:-sidechat}" "$@"
  TAIL=()
fi

# Press Enter on the development-channel warning once it is on screen (60 s max).
accept_channel_warning() {
  [[ "$WAKE_PATH" == "channel" && -n "${TMUX_PANE:-}" ]] || return 0
  (for _ in $(seq 1 60); do
     if tmux capture-pane -p -t "$TMUX_PANE" 2>/dev/null | grep -q 'I am using this for local development'; then
       tmux send-keys -t "$TMUX_PANE" Enter; exit 0
     fi
     sleep 1
   done) &
}

# Resume the project's last conversation when there is one. `--` keeps the
# prompt positional even after a variadic option such as --allowedTools.
t0=$(date +%s)
accept_channel_warning
"$CLAUDE" --continue "$@" "${TAIL[@]}"; rc=$?

# With no conversation yet, --continue exits 1 at once ("No conversation found
# to continue"); start a fresh one.
# ponytail: any exit 1 within 10 s retries fresh, so a startup crash does too; add a message check if that bites.
if [[ $rc -eq 1 && $(( $(date +%s) - t0 )) -lt 10 ]]; then
  accept_channel_warning
  exec "$CLAUDE" "$@" "${TAIL[@]}"
fi
exit $rc
