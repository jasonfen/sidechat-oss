Handle new @mentions from SideChat. The watcher script has already filtered and
deduplicated — `.sidechat/new-mentions.txt` contains only new, unseen mentions
from other users.

## Instructions

0. **Resolve SIDECHAT_DIR, self-heal, and mark engaged.** One combined Bash
   block so cross-shell state isn't a concern (CC spawns a fresh shell per
   Bash tool call — separate blocks leaked `SIDECHAT_DIR` in 2.6.6; fenbot
   caught this on canary 2026-04-22). Claude Code may be launched from any
   CWD (especially when woken by a plugin monitor, not a shell script); the
   inline resolver below handles `$SIDECHAT_DIR` env override, repo-local
   `$PWD/.sidechat`, and home-dir `$HOME/.sidechat` in that order.
   ```bash
   for d in "${SIDECHAT_DIR:-}" "$PWD/.sidechat" "$HOME/.sidechat"; do
     [ -n "$d" ] && [ -f "$d/config" ] && { export SIDECHAT_DIR="$d"; break; }
   done
   [ -z "${SIDECHAT_DIR:-}" ] && { echo "No sidechat config found; skipping /mention-check"; exit 0; }
   # Self-heal if server has rolled a new version. Empty local version is
   # treated as "outdated" — triggers first-boot auto-update rather than the
   # silent no-op that kept canary pinned pre-2.6.7 (fenbot 2026-04-22).
   L=$(cat "$SIDECHAT_DIR/sc-version.txt" 2>/dev/null)
   R=$(curl -fsS --max-time 3 "$(grep ^SERVER_URL "$SIDECHAT_DIR/config" | cut -d= -f2)/install/version" 2>/dev/null | tr -d "\r\n")
   [ -n "$R" ] && [ "$L" != "$R" ] && bash "$SIDECHAT_DIR/sc-update.sh" >/dev/null 2>&1 || true
   # Mark engaged — visible to other users as "Claude opened this mention"
   "$SIDECHAT_DIR/sc-receipt.sh" engaged
   ```
   From here on, use `$SIDECHAT_DIR/...` for sidechat files — never bare
   `.sidechat/...`. Each subsequent Bash tool call should include
   `SIDECHAT_DIR=<resolved-value>` inline because exports don't persist
   across separate Bash tool invocations.
1. Read `$SIDECHAT_DIR/new-mentions.txt`. If it doesn't exist or is empty, say "No new mentions" and stop.
2. Read BOT_NAME from `$SIDECHAT_DIR/config`.
3. For each line (format: `[YYYY-MM-DD HH:MM:SS] sender: content`), classify and handle:

### Read-only response — prefer MCP tool, fall back to file
- Pings, status checks, "are you online/there?" → reply with current status
- Questions about what you're working on → check `git log --oneline -5` and reply with real summary
- Informational questions → answer from context (git history, file state, recent chat)
- Thanks/acknowledgments → skip, no reply needed

**How to reply (in preference order):**
1. **If `mcp__sidechat__post_reply` is available** (MCP registered + tool visible), call it with `mention_id` from `$SIDECHAT_DIR/new-mention-ids.txt` and the reply text. One call — it posts threaded AND marks the mention read server-side. No receipt.sh / reply-to.txt sidecar needed.
2. **Fallback** (no MCP tools): write the parent id to `$SIDECHAT_DIR/reply-to.txt` **first**, then Write to `$SIDECHAT_DIR/message.txt`. Hook order matters — sidecar must exist before the write fires the post-message hook.

Format: `@sender Your response here`

### Action proposal (queue for user approval)
- Requests to change code, fix bugs, deploy, refactor, create files, run commands
- Anything that would modify the repo, infrastructure, or external state

For proposals:
1. Reply via `$SIDECHAT_DIR/message.txt`: `@sender Understood — drafting a proposal for review.`
2. Append to `$SIDECHAT_DIR/pending-actions.txt`:
```
=== PROPOSAL [YYYY-MM-DD HH:MM:SS] ===
FROM: sender
REQUEST: their original message
ANALYSIS: what you think they want and how you'd approach it
PLAN:
- step 1
- step 2
STATUS: pending
===
```
3. Tell the user (in your output, not on chat) that a new proposal is pending.

## After processing

4. Delete `$SIDECHAT_DIR/new-mentions.txt` so the watcher can write fresh next time.
5. Mark the mentions as `read` so other users see Claude has finished: run `"$SIDECHAT_DIR/sc-receipt.sh" read` (this also clears `$SIDECHAT_DIR/new-mention-ids.txt`).
6. Briefly summarize what you handled.

## Important
- **Prefer `mcp__sidechat__post_reply` when the MCP tool surface is available** — one call, auto-marks read, clean threading. The Write-to-message.txt path is the fallback when MCP isn't registered.
- Do NOT call sc-post.sh directly.
- Be concise in chat replies — one or two sentences max.
- For status questions, give real answers from actual git/file state.
