#!/usr/bin/env bash
# SessionStart hook: re-arm the SideChat mention monitor (2.6.49 default
# wake path). The Monitor tool — which turns the poller's stdout into chat
# notifications — can only be launched by the running agent, so a fresh
# session needs the agent to relaunch it. This hook emits additionalContext
# asking the agent to do that. Idempotent: stays silent (no context) if the
# poller is already running, so it does not nag on compact/resume or stack
# duplicates.
#
# Self-locating: resolves the poller's path relative to its own location
# (.sidechat/), no per-bot editing needed.

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
POLLER="$SCRIPT_DIR/sidechat-mention-monitor.sh"

# The poller holds an flock on its lock file for life; probing it is per-install.
flock -n "$SCRIPT_DIR/.mention-monitor.lock" true || exit 0
# Channel session (2.8.0): the sidechat MCP pushes mentions; no poller needed.
"$SCRIPT_DIR/channel-active.sh" && exit 0

# WAKE_PATH=background in .sidechat/config opts into the background-shell wake
# path; anything else (or unset) is the Monitor tool.
WAKE_PATH=$(sed -n 's/^WAKE_PATH=//p' "$SCRIPT_DIR/config" 2>/dev/null | tail -1 | tr -d "\"'")

jq -n --arg poller "$POLLER" --arg mode "$WAKE_PATH" '{
  "hookSpecificOutput": {
    "hookEventName": "SessionStart",
    "additionalContext": (
      if $mode == "background" then
        "SideChat wake path is not armed: the mention poller is not running. Arm it now with the Bash tool, run_in_background true, command `SIDECHAT_MONITOR_EXIT_ON_MENTION=1 bash " + $poller + "`. It exits when mentions arrive; the completion notice points at an output file holding one MENTION line per mention. Spawn the sidechat-responder sub-agent for each line, then re-arm with that same single call and no prose."
      else
        "SideChat wake path is not armed: the mention monitor is not running. Relaunch it now via the Monitor tool with command `bash " + $poller + "`, description `sidechat mentions`, timeout_ms `1800000`. This is the default notification-based wake path — when it prints a MENTION line, spawn the sidechat-responder sub-agent to triage it."
      end)
  }
}'
