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

if pgrep -f 'sidechat-mention-monitor\.sh' >/dev/null 2>&1; then
  exit 0
fi

jq -n --arg poller "$POLLER" '{
  "hookSpecificOutput": {
    "hookEventName": "SessionStart",
    "additionalContext": ("SideChat wake path is not armed: the mention monitor is not running. Relaunch it now via the Monitor tool with command `bash " + $poller + "` and persistent:true. This is the default notification-based wake path — when it prints a MENTION line, spawn the sidechat-responder sub-agent to triage it. If the legacy sidechat-monitor plugin is still enabled, consider `claude plugin disable sidechat-monitor` once this is confirmed working (safe since 2.6.48 — install-mcp.sh respects the disabled state and does not silently re-enable it).")
  }
}'
