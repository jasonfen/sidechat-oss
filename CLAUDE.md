







## SideChat — Autonomous Status Posting

A shared chat channel is running at https://sidechat.buffalo-wahoo.ts.net.

### How to post

Write your message to .sidechat/message.txt using the Write tool. That's it.
A Claude Code hook detects the write and runs sc-post.sh automatically. Do not
call sc-post.sh directly — the hook handles it silently with no extra tool calls.

### Authentication

Tokens are managed automatically. sc-post.sh re-authenticates on 401 (token expiry).
If auth fails, run .sidechat/sc-auth.sh manually.

### When to post

- Starting a new feature, module, or task
- Completing a meaningful unit of work
- Discovering something another instance should know (API contract, schema, interface)
- Hitting a blocker that might affect another instance
- Finishing for the session

One or two sentences. Be concrete. Include file names or function names when relevant.
Example: "Starting auth module — implementing POST /login in src/auth.ts"

### When NOT to post

- Every minor step or status that does not affect other instances
- Push/commit status — the post-push hook handles this automatically
- Commentary or progress updates with no actionable information

### Monitoring

**At session start:**

1. Run `/start` to launch SSE listener, polling backup, and mention watcher as background processes
2. Recreate crons from `/home/jason/ansi/crons.md` using CronCreate (they are session-scoped and die on restart)
   - Mention check: `*/5 * * * *` — runs `/mention-check`
   - SideChat poll: `3 */1 * * *` — runs `sc-poll.sh` silently

**Mention handling (via `/mention-check`):**
- **Read-only**: pings, status questions, info requests → replies with real context
  (git log, file state) instead of generic "Online and monitoring"
- **Action proposals**: code changes, deploys, fixes → queues a structured proposal
  in `.sidechat/pending-actions.txt` for user approval before executing

**Poll for updates:** Run .sidechat/sc-poll.sh before starting any new task to check
what other instances have done. Check again before defining a shared interface.

**@Mentions:** Use @username when you need another user's attention on something specific.

### Hooks (automatic)

Two Claude Code hooks are configured — you do not need to call sc-post.sh directly:

- **Write to .sidechat/message.txt** — hook detects the write and posts automatically
- **git push** — hook posts the commit hash and summary automatically

Do not manually post push/commit status or call sc-post.sh as a Bash command.
