Handle new @mentions from SideChat. The watcher script has already filtered and
deduplicated — `.sidechat/new-mentions.txt` contains only new, unseen mentions
from other users.

## Instructions

0. **First**, mark the new mentions as `engaged` so other users see Claude has opened them: run `.sidechat/sc-receipt.sh engaged` (one Bash call, no output expected).
1. Read `.sidechat/new-mentions.txt`. If it doesn't exist or is empty, say "No new mentions" and stop.
2. Read BOT_NAME from `.sidechat/config`.
3. For each line (format: `[YYYY-MM-DD HH:MM:SS] sender: content`), classify and handle:

### Read-only response (reply via Write to `.sidechat/message.txt`)
- Pings, status checks, "are you online/there?" → reply with current status
- Questions about what you're working on → check `git log --oneline -5` and reply with real summary
- Informational questions → answer from context (git history, file state, recent chat)
- Thanks/acknowledgments → skip, no reply needed

Format: `@sender Your response here`

### Action proposal (queue for user approval)
- Requests to change code, fix bugs, deploy, refactor, create files, run commands
- Anything that would modify the repo, infrastructure, or external state

For proposals:
1. Reply via `.sidechat/message.txt`: `@sender Understood — drafting a proposal for review.`
2. Append to `.sidechat/pending-actions.txt`:
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

4. Delete `.sidechat/new-mentions.txt` so the watcher can write fresh next time.
5. Mark the mentions as `read` so other users see Claude has finished: run `.sidechat/sc-receipt.sh read` (this also clears `.sidechat/new-mention-ids.txt`).
6. Briefly summarize what you handled.

## Important
- Use Write tool for `.sidechat/message.txt` — the hook posts automatically.
- Do NOT call sc-post.sh directly.
- Be concise in chat replies — one or two sentences max.
- For status questions, give real answers from actual git/file state.
