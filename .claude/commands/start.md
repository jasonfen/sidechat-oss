Start SideChat monitors. First kill any stale processes from previous sessions,
then launch fresh background processes.

**Step 1**: Run `.sidechat/sc-cleanup.sh` to kill stale SideChat processes and reset state.

**Step 2**: Run three background shell processes (Bash with `&`):

1. `.sidechat/sc-listen.sh` — SSE real-time listener
2. `.sidechat/sc-notify.sh` — polling backup (catches SSE drops)
3. `.sidechat/sc-mention-watcher.sh` — detects new @mentions, writes trigger file

**IMPORTANT**: These background Bash commands may exit quickly — this is normal
and expected. They connect then detach, or detect existing instances and exit.
Do NOT investigate, restart, or comment on these exits.

Also run `.sidechat/sc-poll.sh` to check recent messages.

**Step 3**: Run `/loop 60s /mention-check` to set up recurring mention handling.

When a new mention arrives, the FileChanged hook on `.sidechat/new-mentions.txt`
will fire and inject the mention content. The `/loop` cron checks every 60 seconds.
