# Runbook: coordinator pi restart (zero-loss, tmux + bridge)

**What this automates**: restart the long-lived coordinator `pi` process so
extension code changes take effect, without losing in-flight subagent work or
the Telegram bridge. **Authorization basis**: coordinator-owned local operation
(tmux + bridge HTTP on the user's machine), user-approved after 3 live runs on
2026-11-13. **Evidence**: `/tmp/auto-restart-state.json` (success run,
19:16–19:22) and `/tmp/auto-reload-state.json` (failed `/reload`, 19:08–19:10).

## The rule this runbook exists for
- **Extension code changes need a full restart; config-file changes are live.**
  `/reload` does NOT swap extension module code in a long-lived process: the
  19:08 run sent `/reload`, reconnected, woke (HTTP 200) — yet a later `/tmp`
  write was still flagged `edit_write`, impossible under the new guard code
  whose allowlist excludes `/tmp` (log forensics; see state file above).
  After editing any extension source (`index.ts` etc.): run this procedure.
  Never trust `/reload` for code; it is for config-style changes only.

## Preconditions (checklist — all boxes before step 1)
- [ ] You know the tmux pane holding pi (record it) and the bridge port.
- [ ] Bridge `/stream` reads idle, or interrupting in-flight work is explicitly
      authorized by the user for this restart.
- [ ] `subagent_list` empty, or every id accounted for in the step-1 snapshot.
- [ ] Handoff snapshot exists on disk (step 1) — never restart without it.
- [ ] No installs, config edits, or tunnel repairs bundled into this run.

## Procedure (each step: command → PASS criterion)
1. **Snapshot in-flight state** (project root, e.g. /Users/yuyuan/PiAgents):
   `python3 tools/restart_handoff.py snapshot`
   → PASS: prints `.pi/restart-handoff-<ts>.json` + `.md`; the `.md` lists
   every not-done subagent id and the pre-restart process list. Keep the ts.
2. **Idle-detect via bridge**: poll `/stream` until idle on 3 consecutive
   checks (proven: `idle_confirmed checks=3`, 19:08:24).
   → PASS: 3 consecutive idle reads. FAIL → failure path "never-idle".
3. **Quit pi in the pane**: send `/quit` typed into the pi prompt via
   `tmux send-keys`. Ctrl-C/SIGINT is IGNORED at idle — 4 attempts left
   `pane_cmd=node` (`abort_still_node`, 19:18:02); only `/quit` worked and
   dropped the pane to a shell (`pane_cmd=zsh`, 19:22:01).
   → PASS: `tmux display-message -p '#{pane_current_command}'` → `zsh`.
   FAIL → failure path "quit-fails".
4. **Relaunch in the same pane**: `pi --continue` (resumes the session).
   → PASS: prompt up within ~5s (proven `pi_up after_5s`, 19:22:10).
   FAIL → failure path "pi-not-up".
5. **Reconnect bridge**: send `/telegram-connect coordinator` to the new pi.
   → PASS: bridge reports connected (proven 19:22:25).
6. **Wake**: POST the bridge `/message` endpoint with a short wake line.
   → PASS: HTTP 200 (proven `wake_sent status=200`, 19:22:50).
   FAIL → failure path "wake-fails".
7. **Reconcile**: `python3 tools/restart_handoff.py resume`
   → PASS: every not-done snapshot id is either RESOLVED (finished before the
   kill) or NEEDS-RELAUNCH; re-launch each listed id with its recorded brief.
   Never auto-replay a mutating task — reconcile first (completed-unverified).
   If the resume output reports non-terminal journal rows, also run step 7b.
7b. **Journal reconcile (A4)**: `python3 tools/journal_reconcile.py`
   → PASS: exit 0 (nothing to reconcile) or every candidate either closed with
   evidence or left flagged for a person; exit codes are machine-readable
   (0 clean, 1 attention needed, 2 error). See the section below.

## After restart: journal reconcile (Theme A4)

A restart can leave coordinator journal rows in non-terminal states
(received/queued/started, or settled unknown-outcome): the process that would
have appended the settled row is gone. The dispatch's true outcome lives on
disk (`.pi/subagents/<dir>/events.jsonl` + `result.md`). `restart_handoff.py
resume` prints a suggestion line when such rows exist; reconcile with:

    python3 tools/journal_reconcile.py            # dry-run (default): prints the plan, writes nothing
    python3 tools/journal_reconcile.py --apply    # writes append-only reconcile rows

Rules (full table in the tool docstring):
- Terminal subagent dir (result.md or terminal event) → row settles
  `completed-unverified` with `budget_spent` from the usage sidecar
  (`usage.json`, else summed `events.jsonl` message usage) — never `verified`;
  a prior unknown-outcome settlement additionally gets a `reconciled` row.
- Mutating task, no positive evidence (stale/missing dir) → settles
  `unknown-outcome` and STAYS flagged for a person; never auto-replayed.
- Read-only task, no positive evidence → settles `failed`.
- Worker possibly alive (fresh events) / ambiguous linkage (≥2 matching dirs) /
  never-dispatched queued row → no write, flagged for a human decision.
- Original row fields ride along in the new row's `audit={...}` JSON blob;
  the journal stays append-only (no UPDATE/DELETE ever).

Exit codes: 0 = clean or all candidates closed with evidence; 1 = candidates
found (dry-run) or left open needing a human (unknown-outcome/flagged/stranded);
2 = error. Runbook order: step 7 (`restart_handoff resume`) → step 7b
(journal reconcile) → verify, then re-launch what needs re-launching.

## Verification (what success looks like + evidence kept)
- New run's step records appended to `/tmp/auto-restart-state.json`
  (append-only array of `{ts, step, extra}`).
- Handoff `.json`/`.md` stay under `.pi/` (private; never committed).
- The code change that motivated the restart is verifiably live — a restart
  that "succeeds" but swaps nothing is a silent no-op. Test the actual change.

## Failure paths (symptom → diagnosis → remediation)
| Symptom | Diagnosis | Remediation |
| --- | --- | --- |
| Never-idle: `/stream` not idle after repeated checks | Background work still in flight; a restart would orphan it | Do NOT restart. Snapshot (step 1), let work drain, or get explicit user authorization to interrupt; retry from step 1 later |
| Quit-fails: pane still `node` after `/quit` | SIGINT ignored at idle; or `/quit` not delivered to the prompt | Re-send `/quit` via tmux send-keys; watch `pane_current_command` flip to `zsh`. Still `node` after 3 tries: STOP, re-snapshot, record pane state, escalate — never `kill -9` without user sign-off (unknown in-flight writes) |
| pi-not-up: no prompt ~5s after `pi --continue` | Wrong pane, missing session file, or slow start | Read pane output and `pi --continue` stderr; retry the relaunch once; if the session file is missing, locate the newest session before relaunching. Two failures → escalate |
| Wake-fails: POST `/message` non-200 | Bridge down or tunnel broken — pi up ≠ bridge up | Check the keepalive driver and tunnel processes (the handoff's process list shows what was running before); retry connect + wake once. Do not reinstall or auto-reconnect the tunnel → escalate |
| Post-restart behavior unchanged | Restart was a silent no-op, or the change needs more than a restart | Verify the code file on disk; re-read the rule above; if code is right and behavior is stale, capture evidence and escalate |

## Escalation (hand back to a human)
- Any unknown-outcome mutation (task was mid-write when killed): reconcile,
  mark completed-unverified, never auto-replay.
- Second consecutive failure of the same step: stop, record evidence, ask.
- Anything needing installs, tunnel repair, credential access, or killing a
  process that send-keys did not stop.
