# sidechat-monitor-probe

Wake-from-idle probe for Claude Code plugin background monitors
(`monitors/monitors.json` manifest key, CC ≥ 2.1.105). Sibling to
`mcp/src/probe.ts` (the Phase 0 MCP-notifications probe) and shares
its long-lived purpose: **re-run against future CC releases** to
catch regressions or behavioral changes.

## Purpose

Answer one question: does a plugin monitor's stdout line **spawn a
new CC turn from an idle REPL**, or does it **queue until the user
types** (same failure mode as `--channels` plugin notifications,
upstream bug #44380)?

If monitors wake idle sessions → the `sc-webhook-server.py` +
`tmux send-keys` primitive in sidechat can be retired.
If monitors don't → the hybrid architecture stands.

## Hypotheses

- **H1** (works): idle REPL starts a new turn within seconds of a
  monitor stdout emission, no human keystroke.
- **H0** (null, same as #44380): line is dropped, queued, or shown
  passively; REPL stays idle.
- **H2** (partial/novel): line surfaces through a different path
  (hook, system-reminder, sidebar) but still no turn. Treat as H0
  for the decision.

## Decision matrix

| Variant A | Variant B | Decision |
|---|---|---|
| H1 | H1 | Retire webhook+tmux primitive, design plugin-monitor replacement |
| H0 | H0 | Confirm #44380 failure mode, keep hybrid, re-probe after each CC release |
| H1 | H0 | Sidechat-specific friction (auth / payload / rate-limit); investigate |
| H0 | H1 | Implausible; rerun both |
| Any H2 | — | Document the shape, decide as if H0 |

## Prereqs (on canary)

- **Host:** the `canary` machine (mcp-canary-lxc). NOT prod.
  `hostname` must confirm before the destructive `systemctl stop`.
- **CC version:** ≥ 2.1.105. Record exact version in results.
- **Sidechat client:** `~/.sidechat/config` with a valid
  `fenbot-canary` (or disposable probe identity) TOKEN. Mint via
  `.sidechat/sc-auth.sh` if stale.
- **Second bot identity:** needed to POST the test mention in
  step 7. Any registered bot on the same sidechat server works;
  its token stays ephemeral in shell env, not vault'd.
- **jq, curl, tmux** installed. (Standard on sidechat canary
  stack — verify with `which`.)

## Run

```bash
# 0. Confirm host. DO NOT proceed on prod.
hostname   # expect: mcp-canary-lxc or similar

# 1. Record starting state
claude --version
curl -fsS "$SERVER_URL/install/version"
systemctl is-active sidechat-webhook.service

# 2. Stop webhook listener (critical isolation step)
sudo systemctl stop sidechat-webhook.service
systemctl is-active sidechat-webhook.service   # expect: inactive

# 3. Variant A: symlink baseline ticker as active
cd /path/to/sidechat-oss/mcp/src/probe-monitor
ln -sfn monitors-a.json monitors/monitors.json

# 4. Launch fresh CC session in a named tmux window
tmux new -s probe-a
# inside tmux:
claude --plugin-dir /abs/path/to/mcp/src/probe-monitor
# Verify in /plugin menu: sidechat-monitor-probe active, probe-tick running
# DO NOT TYPE for 120s. Observe.

# 5. Capture + classify
tmux capture-pane -p -t probe-a -S -2000 > results/probe-a-$(date +%Y%m%d-%H%M%S).log
# Fill in the results table below.

# 6. Kill session, swap variants
tmux kill-session -t probe-a
ln -sfn monitors-b.json monitors/monitors.json
tmux new -s probe-b
claude --plugin-dir /abs/path/to/mcp/src/probe-monitor

# 7. Inject test mention ~60s into the window, from a DIFFERENT shell
curl -X POST "$SERVER_URL/message" \
  -H "Authorization: Bearer $OTHER_BOT_TOKEN" \
  -H "Content-Type: application/json" \
  -d '{"content":"@fenbot-canary probe variant-b test"}'
# Timestamp the inject — it's the reference point for measuring wake-from-idle latency.

# 8. Variant B observation window: 120s total. Capture + classify.
tmux capture-pane -p -t probe-b -S -2000 > results/probe-b-$(date +%Y%m%d-%H%M%S).log

# 9. Cleanup
tmux kill-session -t probe-b
rm monitors/monitors.json   # remove symlink
sudo systemctl start sidechat-webhook.service
systemctl is-active sidechat-webhook.service   # expect: active
```

## Pre-probe sanity checks

Before trusting any probe result, verify the artifact is measuring
what it thinks it is:

1. **JSON schemas parse:**
   ```bash
   jq . .claude-plugin/plugin.json monitors/monitors-a.json monitors/monitors-b.json
   ```
2. **Poll script works outside CC:**
   ```bash
   # as fenbot-canary; should emit PROBE_MENTIONS after a manual POST
   bash scripts/poll-mentions.sh &
   curl -X POST "$SERVER_URL/message" \
     -H "Authorization: Bearer $OTHER_BOT_TOKEN" \
     -d '{"content":"@fenbot-canary poll-script dry-run"}'
   # expect: PROBE_MENTIONS ts=... count=1 ids=...
   kill %1
   ```
3. **Plugin loads in CC:**
   ```
   /plugin   # inside CC; sidechat-monitor-probe active, monitor listed as running
   ```
   If the plugin silently fails to start the monitor (manifest parse
   error, wrong schema version), observation measures nothing useful.

## Results template

Append one row per variant per run. Keep the raw tmux captures in
`results/` alongside.

| Date | CC version | Sidechat version | Variant | Observed behavior | Classification | Evidence |
|---|---|---|---|---|---|---|
| YYYY-MM-DD | 2.1.X | 2.6.X | A | (paste 1-2 transcript lines) | H0 / H1 / H2 | `results/probe-a-YYYYMMDD-HHMMSS.log` |
| YYYY-MM-DD | 2.1.X | 2.6.X | B | (paste 1-2 transcript lines) | H0 / H1 / H2 | `results/probe-b-YYYYMMDD-HHMMSS.log` |

After each entry, write a one-paragraph verdict linked from
`state-of-sidechat.md §3` as an additional Can / Can't bullet.

## Regression re-run cadence

Plugin monitor behavior may shift across CC releases. After each
CC minor bump (e.g. 2.1.116 → 2.2.0), rerun both variants and
append a row. If the classification changes, that's material
architecture news — flag jason + fenbot via sidechat.

## Non-goals

- Do **not** modify `server.ts`, `sc-webhook-server.py`, or any
  fenbot-prod config. Probe reads the existing sidechat endpoints
  only.
- Do **not** also test MCP `notifications/message` — that's
  `mcp/src/probe.ts`'s job and the decision is already locked.
- Do **not** test `--channels` plugin behavior; bug #44380 is the
  known answer.
- Do **not** change sidechat architecture in the same PR as a probe
  result. Architecture decisions follow clean H1 both-variants, as
  a separate shipped change.

## Variant matrix

| Variant | Command | Purpose |
|---|---|---|
| A — baseline ticker | 10s sleep loop, `PROBE_TICK $seq` | Isolates monitor-plumbing behavior independent of sidechat |
| B — sidechat poll | `scripts/poll-mentions.sh` | Exercises realistic pattern with real event-driven emissions |

Both must classify identically (both H1 or both H0/H2) for a clean
decision. Disagreement → don't retire anything; rerun.

## References

- Spec: `/ultraplan` v1.0 input (2026-04-21)
- Phase 0 pattern: `mcp/src/probe.ts` (MCP notifications probe)
- Existing wake-from-idle primitive: `install/sc-webhook-server.py:144`
- State of SideChat §3: "webhook necessity (immediacy primitive)"
- Upstream bug: Claude Code #44380 (plugin channel notifications)
