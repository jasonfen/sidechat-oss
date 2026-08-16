#!/usr/bin/env bash
# Hook: post sidechat status after a real `git push`.
#
# Detects the push from its actual output (the `<old>..<new>  branch ->
# branch` ref-update line git prints) rather than pattern-matching the
# command text. The old command-text guard (`^\s*git\s+push`) had two
# real failure modes: (1) any multi-line command that merely *mentioned*
# "git push" somewhere — a heredoc, a comment — matched, since grep
# checked the whole string line-by-line, not just the executed command;
# (2) on a host running the rtk proxy (which rewrites `git push` to
# `rtk git push` transparently), the anchored pattern never matched at
# all, so pushes silently stopped posting. Keying off the ref-update line
# in tool_response sidesteps both: text that only mentions a push never
# produces one, and the rewritten command still shows real push output.
#
# Directory resolution had a matching bug: `git log -1` ran in the hook's
# own cwd, which is the *session's* cwd, not necessarily where the push
# actually happened if the command did an inline `cd` first — so a push
# from another repo reported an unrelated, confidently-wrong commit. Fix:
# verify a resolved directory actually contains the pushed SHA before
# trusting it for the commit-message lookup; if no candidate directory
# checks out, still post the SHA (from the push output itself, so it's
# never wrong) without a message rather than guessing.
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
SC_POST="$SCRIPT_DIR/../sc-post.sh"

INPUT=$(cat)
HOOK_CWD=$(echo "$INPUT" | jq -r '.cwd // empty')
COMMAND=$(echo "$INPUT" | jq -r '.tool_input.command // empty')
OUTPUT=$(echo "$INPUT" | jq -r '(.tool_response.stdout // "") + "\n" + (.tool_response.stderr // "")')

# Require the command to at least mention "push" as a loose pre-filter
# (cheap, avoids running the heavier match below on unrelated commands)
# AND the output to contain a genuine-looking ref-update line. Only the
# existing-branch form (has an old..new SHA range) is handled — a brand
# new branch's first push (`* [new branch]  x -> x`) has no SHA to key
# off, and force-push/delete forms are ambiguous enough to skip rather
# than guess.
echo "$COMMAND" | grep -qi 'push' || exit 0
REF_LINE=$(echo "$OUTPUT" | grep -E '^[[:space:]]*[0-9a-f]{7,40}\.\.[0-9a-f]{7,40}[[:space:]]+[^[:space:]]+[[:space:]]+->[[:space:]]+[^[:space:]]+[[:space:]]*$' | head -1 || true)
[[ -z "$REF_LINE" ]] && exit 0

NEWSHA=$(echo "$REF_LINE" | sed -E 's/^[[:space:]]*[0-9a-f]+\.\.([0-9a-f]+).*/\1/')
BRANCH=$(echo "$REF_LINE" | sed -E 's/.*->[[:space:]]+([^[:space:]]+)[[:space:]]*$/\1/')

# Try the hook's own cwd first, then any `cd <dir>` or `git -C <dir>`
# candidate pulled from the command (either form, in whatever order they
# appear — the SHA check below is what actually picks the right one, so
# extraction order isn't load-bearing). Anchored to a command boundary so
# a word merely ending in "cd" (e.g. `abcd /etc`) can't match. Only trust
# a directory once we've confirmed it actually contains the pushed commit.
resolve_dir() {
  local dir="$1"
  [[ -n "$dir" && -d "$dir" ]] || return 1
  if git -C "$dir" cat-file -e "$NEWSHA" 2>/dev/null; then
    return 0
  else
    return 1
  fi
}

TARGET_DIR=""
if resolve_dir "$HOOK_CWD"; then
  TARGET_DIR="$HOOK_CWD"
else
  while IFS= read -r CAND_DIR; do
    [[ -z "$CAND_DIR" ]] && continue
    [[ "$CAND_DIR" != /* ]] && CAND_DIR="$HOOK_CWD/$CAND_DIR"
    if resolve_dir "$CAND_DIR"; then
      TARGET_DIR="$CAND_DIR"
      break
    fi
  done < <(echo "$COMMAND" \
    | grep -oE '(^|[[:space:]]|[&;|])(cd|git[[:space:]]+-C)[[:space:]]+("[^"]+"|'"'"'[^'"'"']+'"'"'|[^[:space:]&;|]+)' \
    | sed -E 's/^[[:space:]&;|]*//; s/^cd[[:space:]]+//; s/^git[[:space:]]+-C[[:space:]]+//' \
    | sed -E 's/^"//; s/"$//; s/^'"'"'//; s/'"'"'$//' \
    | sed -E 's/[[:space:]]+$//')
fi

HASH=$(echo "$NEWSHA" | cut -c1-7)
if [[ -n "$TARGET_DIR" ]]; then
  MSG=$(git -C "$TARGET_DIR" log -1 --format='%s' "$NEWSHA" 2>/dev/null || echo "")
else
  MSG=""
fi

# Run synchronously (not backgrounded). PostToolUse hooks fire after the
# tool result is already returned to the model, so there's no user-facing
# latency cost — and backgrounding here used to race the harness's process-
# group cleanup: if sc-post.sh (esp. on a 401 re-auth round-trip) hadn't
# finished by the time the parent hook exited, the orphaned child could get
# reaped mid-flight with zero trace (all output was silently swallowed).
# Well within the hook's 10s timeout for a plain POST.
if [[ -n "$MSG" ]]; then
  "$SC_POST" "Pushed $HASH — $MSG" >/dev/null 2>&1
else
  "$SC_POST" "Pushed $HASH to $BRANCH" >/dev/null 2>&1
fi

exit 0
