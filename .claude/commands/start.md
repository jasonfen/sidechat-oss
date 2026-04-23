Start SideChat monitors. First kill any stale processes from previous sessions,
then launch fresh background processes.

**Step 1**: Run `.sidechat/sc-cleanup.sh` to kill stale SideChat processes and reset state.

**Step 2**: Run two background shell processes (Bash with `&`):

1. `.sidechat/sc-listen.sh` — SSE real-time listener
2. `.sidechat/sc-notify.sh` — polling backup (catches SSE drops)

These populate the local chat-history file that `sc-poll.sh` tails. They do
NOT detect mentions — the `sidechat-monitor` plugin's `poll-mentions.sh`
owns that path and wakes the REPL automatically via `/mention-check`.

**IMPORTANT**: These background Bash commands may exit quickly — this is normal
and expected. They connect then detach, or detect existing instances and exit.
Do NOT investigate, restart, or comment on these exits.

Also run `.sidechat/sc-poll.sh` to check recent messages.
