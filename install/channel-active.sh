#!/usr/bin/env bash
# Exit 0 when the claude session running this hook was started with the
# SideChat channel flag (2.8.0), so the sidechat MCP pushes mentions into the
# session itself and the poller, Stop-hook block and session-start backlog
# would only duplicate it. Exit 1 otherwise, including when no claude ancestor
# is found. Same test the MCP applies to its own parent.
#
# Usage (from a hook): "$SIDECHAT_DIR/channel-active.sh" && exit 0
# SIDECHAT_OWNER_COMM names the process to look for (tests use it).

p=$PPID
while [[ -n "$p" && "$p" -gt 1 ]]; do
  read -r comm ppid < <(ps -o comm= -o ppid= -p "$p" 2>/dev/null) || exit 1
  if [[ "$(basename -- "$comm")" == "${SIDECHAT_OWNER_COMM:-claude}" ]]; then
    args=$(ps -ww -o args= -p "$p" 2>/dev/null)
    name="${SIDECHAT_MCP_NAME:-sidechat}"
    [[ "$args" =~ --(dangerously-load-development-)?channels([[:space:]]|=) ]] || exit 1
    [[ " $args " =~ [[:space:],=]server:${name}[[:space:],] || "$args" == *"plugin:${name}@"* ]]
    exit
  fi
  p=$ppid
done
exit 1
