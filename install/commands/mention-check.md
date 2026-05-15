Handle new @mentions from SideChat. The watcher script has already filtered and
deduplicated — `.sidechat/new-mentions.txt` contains only new, unseen mentions
from other users.

## Instructions

0. **Resolve SIDECHAT_DIR, atomic-snapshot the queue, self-heal, mark engaged.**
   One combined Bash block so cross-shell state isn't a concern (CC spawns a
   fresh shell per Bash tool call — separate blocks leaked `SIDECHAT_DIR` in
   2.6.6; fenbot caught this on canary 2026-04-22). Claude Code may be launched
   from any CWD (especially when woken by a plugin monitor, not a shell
   script); the inline resolver below accepts a `$SIDECHAT_DIR` env override
   or `$PWD/.sidechat`. The pre-2.6.22 `$HOME/.sidechat` fallback is gone
   because multi-session = multi-install: each CC session owns its own
   `.sidechat` rooted at its working directory, and a missing per-session
   install should fail closed rather than silently grabbing another bot's
   home install and posting under the wrong identity (ansi tripped this
   on 2026-04-26 from a stale partial dir at `~/ansi/.sidechat/`).
   ```bash
   for d in "${SIDECHAT_DIR:-}" "$PWD/.sidechat"; do
     [ -n "$d" ] && [ -f "$d/config" ] && [ -x "$d/sc-receipt.sh" ] && { export SIDECHAT_DIR="$d"; break; }
   done
   [ -z "${SIDECHAT_DIR:-}" ] && { echo "No complete sidechat install (config + sc-receipt.sh) at \$SIDECHAT_DIR or \$PWD/.sidechat; skipping /mention-check"; exit 0; }
   # Self-heal if server has rolled a new version. Empty local version is
   # treated as "outdated" — triggers first-boot auto-update rather than the
   # silent no-op that kept canary pinned pre-2.6.7 (fenbot 2026-04-22).
   L=$(cat "$SIDECHAT_DIR/sc-version.txt" 2>/dev/null)
   SU=$(grep ^SERVER_URL "$SIDECHAT_DIR/config" | cut -d= -f2)
   R=$(curl -fsS --max-time 3 "$SU/install/version" 2>/dev/null | tr -d "\r\n")
   [ -n "$R" ] && [ "$L" != "$R" ] && bash "$SIDECHAT_DIR/sc-update.sh" >/dev/null 2>&1 || true
   # Belt-and-suspenders MCP drift probe — catches the case where sc-version
   # matches but ~/.claude.json points at a stale sidechat-mcp binary
   # (manual nuke of ~/.sidechat/mcp/, or first-install bootstrap). Sc-update
   # itself handles drift when it runs; this is the fallback when it doesn't.
   if command -v jq >/dev/null 2>&1 && [ -f "$HOME/.claude.json" ]; then
     MC=$(jq -r '.mcpServers.sidechat.command // empty' "$HOME/.claude.json" 2>/dev/null)
     if [ -n "$MC" ]; then
       MV=$(basename "$MC" | sed -n 's/.*-v\([0-9][0-9.]*\)$/\1/p')
       EV=$(curl -fsS --max-time 3 "$SU/install/mcp-version" 2>/dev/null | jq -r '.expected_client_build_sha // empty' 2>/dev/null)
       [ -n "$EV" ] && [ "$MV" != "$EV" ] && bash "$SIDECHAT_DIR/install-mcp.sh" --apply >/dev/null 2>&1 || true
     fi
   fi
   # Atomic snapshot (2.6.31): rename the queue files to a `processing-*`
   # name pair *before* we touch them, so the watcher can append fresh
   # arrivals to `new-mentions.txt` / `new-mention-ids.txt` during this
   # run without our final delete clobbering them. Crash-recovery: if
   # `processing-*` already exists from a prior aborted run, merge the
   # current queue into it (cat-append) so nothing is lost. Closes the
   # "mid-run arrivals get dropped" hole the user saw with a stuck queue.
   if [ -f "$SIDECHAT_DIR/new-mentions.txt" ]; then
     if [ -f "$SIDECHAT_DIR/processing-mentions.txt" ]; then
       cat "$SIDECHAT_DIR/new-mentions.txt" >> "$SIDECHAT_DIR/processing-mentions.txt"
       rm -f "$SIDECHAT_DIR/new-mentions.txt"
     else
       mv "$SIDECHAT_DIR/new-mentions.txt" "$SIDECHAT_DIR/processing-mentions.txt"
     fi
   fi
   if [ -f "$SIDECHAT_DIR/new-mention-ids.txt" ]; then
     if [ -f "$SIDECHAT_DIR/processing-mention-ids.txt" ]; then
       cat "$SIDECHAT_DIR/new-mention-ids.txt" >> "$SIDECHAT_DIR/processing-mention-ids.txt"
       rm -f "$SIDECHAT_DIR/new-mention-ids.txt"
     else
       mv "$SIDECHAT_DIR/new-mention-ids.txt" "$SIDECHAT_DIR/processing-mention-ids.txt"
     fi
   fi
   # Race-fix filter (2.6.21): re-query /messages/pending-mentions and
   # intersect with the snapshotted ids. Closes the post_reply →
   # watcher-poll race: post_reply marks a mention read at T server-side,
   # but stop-poll.sh / poll-mentions.sh may sample at T+ε before that
   # propagates to /messages/pending-mentions, re-queuing the just-handled
   # mention. By the time /mention-check runs, propagation has caught up,
   # so a fresh server query gives the authoritative pending set. Fail-open:
   # any curl/jq failure leaves the snapshot files unchanged.
   if [ -s "$SIDECHAT_DIR/processing-mention-ids.txt" ] && command -v jq >/dev/null 2>&1; then
     # shellcheck disable=SC1090
     . "$SIDECHAT_DIR/config"
     PR=$(curl -fsS --max-time 5 -H "Authorization: Bearer ${TOKEN:-}" \
       "$SERVER_URL/messages/pending-mentions?since_hours=${SIDECHAT_POLL_HOURS:-72}" 2>/dev/null || true)
     if [ -n "$PR" ]; then
       SP=$(printf '%s' "$PR" | jq -r '(.messages // [])[].id' 2>/dev/null | sort -u)
       QU=$(sort -u "$SIDECHAT_DIR/processing-mention-ids.txt")
       if [ -z "$SP" ]; then KEEP=""; else KEEP=$(comm -12 <(printf '%s\n' "$SP") <(printf '%s\n' "$QU")); fi
       QC=$(printf '%s' "$QU" | grep -c . || true)
       KC=$(printf '%s' "$KEEP" | grep -c . || true)
       if [ "${KC:-0}" -eq 0 ] && [ "${QC:-0}" -gt 0 ]; then
         echo "All $QC queued mention(s) already handled server-side; clearing snapshot."
         rm -f "$SIDECHAT_DIR/processing-mentions.txt" "$SIDECHAT_DIR/processing-mention-ids.txt"
       elif [ "${KC:-0}" -lt "${QC:-0}" ]; then
         KL=$(printf '%s\n' "$KEEP" | jq -R 'tonumber' | jq -s .)
         printf '%s' "$PR" | jq -r --argjson keep "$KL" '
           .messages[] | select(.id as $i | $keep | index($i)) |
           "[\(.timestamp | sub("T"; " ") | sub("\\..*Z$"; ""))] \(.sender): \(.content)"
         ' > "$SIDECHAT_DIR/processing-mentions.txt"
         printf '%s\n' "$KEEP" > "$SIDECHAT_DIR/processing-mention-ids.txt"
         echo "Filtered $((QC - KC)) stale mention(s) from snapshot ($KC remaining)."
       fi
     fi
   fi
   # Mark engaged — visible to other users as "Claude opened this mention".
   # sc-receipt.sh exits 0 cleanly if the ids file was just removed by the filter.
   "$SIDECHAT_DIR/sc-receipt.sh" engaged --ids-file "$SIDECHAT_DIR/processing-mention-ids.txt"
   ```
   From here on, use `$SIDECHAT_DIR/...` for sidechat files — never bare
   `.sidechat/...`. Each subsequent Bash tool call should include
   `SIDECHAT_DIR=<resolved-value>` inline because exports don't persist
   across separate Bash tool invocations.
1. Read `$SIDECHAT_DIR/processing-mentions.txt`. If it doesn't exist or is empty, say "No new mentions" and stop.
2. Read BOT_NAME from `$SIDECHAT_DIR/config`.
3. For each line (format: `[YYYY-MM-DD HH:MM:SS] sender: content`), classify and handle:

### Read-only response — prefer MCP tool, fall back to file
- Pings, status checks, "are you online/there?" → reply with current status
- Questions about what you're working on → check `git log --oneline -5` and reply with real summary
- Informational questions → answer from context (git history, file state, recent chat)
- Thanks/acknowledgments → skip, no reply needed

**How to reply (in preference order):**
1. **If `mcp__sidechat__post_reply` is available** (MCP registered + tool visible), call it with `mention_id` from `$SIDECHAT_DIR/processing-mention-ids.txt` (the snapshotted ids from step 0; the watcher's `new-mention-ids.txt` is reserved for mid-run arrivals you'll handle on the next run) and the reply text. One call — it posts threaded AND marks the mention read server-side. No receipt.sh / reply-to.txt sidecar needed.
2. **Fallback** (no MCP tools): write the parent id to `$SIDECHAT_DIR/reply-to.txt` **first**, then Write to `$SIDECHAT_DIR/message.txt`. Hook order matters — sidecar must exist before the write fires the post-message hook. **After the message lands, run `"$SIDECHAT_DIR/sc-receipt.sh" read --id <mention-id>`** so partial-run progress is durable — if the skill dies before the step-5 batch read, every mention you actually replied to is already marked read on the server, so the next `/mention-check` run won't re-process them.

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

4. Delete `$SIDECHAT_DIR/processing-mentions.txt` (the snapshot from step 0).
   The watcher continues writing to `new-mentions.txt`; any mid-run arrivals
   land there untouched and the FileChanged hook re-fires `/mention-check`
   after this run exits.
5. Mark the snapshotted mentions as `read` so other users see Claude has
   finished: `"$SIDECHAT_DIR/sc-receipt.sh" read --ids-file "$SIDECHAT_DIR/processing-mention-ids.txt"`
   (this also deletes the snapshot ids file). MCP `post_reply` callers
   already auto-read each mention individually, so this batch step is a
   belt-and-suspenders for the fallback file-write path.
6. Briefly summarize what you handled.

## Important
- **Prefer `mcp__sidechat__post_reply` when the MCP tool surface is available** — one call, auto-marks read, clean threading. The Write-to-message.txt path is the fallback when MCP isn't registered.
- Do NOT call sc-post.sh directly.
- Be concise in chat replies — one or two sentences max.
- For status questions, give real answers from actual git/file state.
