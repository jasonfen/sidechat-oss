#!/bin/bash
# Start Claude Code for an unattended bot (boot service, tmux session, cron) so
# the session has a first turn with nobody typing. The SessionStart hook only
# injects "arm the mention monitor" as context for the agent's first turn; an
# unattended session never gets one, so nothing arms. The positional prompt
# below is that first turn.
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

# Resume the project's last conversation when there is one. `--` keeps the
# prompt positional even after a variadic option such as --allowedTools.
t0=$(date +%s)
"$CLAUDE" --continue "$@" -- "$PROMPT"; rc=$?

# With no conversation yet, --continue exits 1 at once ("No conversation found
# to continue"); start a fresh one.
# ponytail: any exit 1 within 10 s retries fresh, so a startup crash does too; add a message check if that bites.
if [[ $rc -eq 1 && $(( $(date +%s) - t0 )) -lt 10 ]]; then
  exec "$CLAUDE" "$@" -- "$PROMPT"
fi
exit $rc
