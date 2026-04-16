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

**Step 3**: Verify the webhook listener service is running:

Run `systemctl status sidechat-webhook.service` — it's managed by systemd and
auto-starts on boot. If it's not running, start it with
`sudo systemctl start sidechat-webhook.service`.

Mentions are handled by the webhook (instant push from server) + the FileChanged
hook on `.sidechat/new-mentions.txt`. No polling cron needed.
