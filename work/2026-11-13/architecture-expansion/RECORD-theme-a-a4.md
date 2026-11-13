# Theme A A4 (P2): coordinator session continuity — journal reconciliation for interrupted dispatch envelopes

Date: 2026-11-13
Task: [project:PiAgents] Theme A A4 (work/2026-11-13/architecture-expansion/PLAN.md) — journal reconciliation so a coordinator restart mid-dispatch (or a silently dead worker) leaves no permanently non-terminal journal row
Dispatched-by: main coordinator conversation (user brief, 2026-11-13, background coder dispatch)
Worker: background coder subagent (clean context, this dispatch)
Status: delivered-unverified

## Task brief

When the coordinator restarts mid-dispatch, journal rows can stay in non-terminal states forever — the process
that would have appended the settled row is gone, while the envelope's true outcome lives on disk
(`.pi/subagents/<dir>/events.jsonl` + `result.md`) — and nothing reconciles the journal to it.

Build a reconciliation tool (dry-run default, machine-readable exit codes, append-only writes with audit
preservation, never fabricating outcomes), fixture tests, a runbook section, and a suggestion row in the restart
handoff output when non-terminal rows exist.

## Delivered

- `tools/journal_reconcile.py` (new, ~560 lines, stdlib only): scans the coordinator SQLite journal (`~/.pi/agent/project-coordinator/coordinator.db`, read-only unless `--apply`) for candidates (latest phase received/queued/started, or settled unknown-outcome on a mutating envelope); resolves each to a subagent dir via explicit envelope refs (`subagentDir`/`subagentId`) or unique content matching (strong: exact taskId in events head; weak: normalized goal ≥24 chars in parsed event strings; 0 or ≥2 matches → unresolved, never guessed); reuses `restart_handoff.py` inference as a library import (is_done/scan_subagents/STALE_SECONDS — shared, not copied, per the A3 precedent). Append-only reconcile rows carry outcome + `budget_spent` (usage sidecar: `usage.json`, else summed `message_end` `usage.cost.total` from events.jsonl) + derived stage + the original row fields preserved in an `audit={...}` JSON blob inside `detail`. Handles both the current and the pre-D2 schema (no budget columns; the real db as of today is pre-D2). Exit codes: 0 clean/all-closed-with-evidence, 1 attention needed, 2 error; `--json` for machine-readable reports; writes transactional (BEGIN IMMEDIATE, rollback on failure).
- `tools/restart_handoff.py`: `resume` now prints a suggestion row (`Journal: N non-terminal coordinator task row(s) — reconcile with: python3 tools/journal_reconcile.py`) when `count_nonterminal()` (new silent read-only hook in journal_reconcile) finds candidates; db path overridable via `JOURNAL_RECONCILE_DB`; silent (no line) when the db is missing/clean/unreadable — never fails resume.
- `docs/runbooks/pi-restart.md`: new section "After restart: journal reconcile (Theme A4)" (rules summary, commands, exit codes) + procedure step 7b.

Reconciliation rules (fixed; identical for dry-run and --apply):

| latest journal phase | subagent evidence | mutating | read-only |
| --- | --- | --- | --- |
| unsettled (received/queued/started) | unique dir, done | append settled: completed-unverified (+ budget_spent from sidecar) | same |
| unsettled + started | unique dir, stale, or no dir found | append settled: unknown-outcome (stays reconcile-required, never auto-replayed) | append settled: failed |
| unsettled + received/queued | no dir found | no write — stranded-queued, re-submit (engine never replays queues) | same |
| any unsettled | dir still running | no write — flagged, re-run later | same |
| any | ≥2 matching dirs | no write — flagged ambiguous | same |
| settled unknown-outcome (reconcile-required) | unique dir, done | append settled: completed-unverified + reconciled row (clears the flag) | n/a (anomaly) |
| settled unknown-outcome (reconcile-required) | stale/missing | no write — stays reconcile-required for a person | n/a |
| question | — | skipped by design (person/answer gate) | same |
| settled unknown-outcome, no/unreadable envelope | — | anomaly: reported, never written | same |

`completed-unverified` is deliberately never `verified` (journal.ts contract). Re-runs are idempotent: reconciled rows move tasks to terminal phases, so a second run finds nothing.

## Verification evidence

- `tools/test_journal_reconcile.py` (new): 41/41 pass (`python3 -m unittest discover -s tools -p test_journal_reconcile.py`) — linkage (strong taskId, weak goal, collision→ambiguous, explicit refs, short-goal weak-match disablement), rules table (done/stale/running/missing/queued-stranded/question/requeued-skip/unknown-outcome both branches/anomalies/registry project roots/usage sidecars), apply (budget_planned preserved on received row, spent from sidecar on settled row, idempotency, exit codes), dry-run safety (row dump + db file hash + dir listing byte-identical), pre-D2 schema compat (schema never altered), hook (`count_nonterminal` incl. garbage db), CLI (dry-run default, `--json`, exit 0/1/2).
- `tools/test_restart_handoff.py`: 26/26 pass (21 existing unchanged + 5 new hint-wiring tests incl. subprocess CLI with `JOURNAL_RECONCILE_DB` fixture).
- `packages/pi-project-coordinator` TS tests: 21 pass / 0 fail (baseline unchanged).
- Live dry-run on the real journal (read-only): `python3 tools/journal_reconcile.py --root /Users/yuyuan/PiAgents` → 12 rows scanned, 0 candidates (all real tasks settled), 10 subagent roots enumerated from the registry, `result: dry_run candidates=0 ... exit=0`; db sha256 identical before/after (`f4861a3b244bf5cb…`), no files created. The real db is pre-D2 — exercised the no-budget-columns read path live.
- Nothing was applied to the real journal (brief: dry-run only, read-only).

## Open items

- Linkage today relies on unique content matching because the coordinator's TaskEnvelope schema carries no subagent pointer; the tool already honors explicit `subagentId`/`subagentDir` envelope fields when a future dispatcher starts recording them.
- RPC-dispatched tasks (live-coordinator-check path) have no subagent dir at all; a mid-RPC-restart mutating task settles to honest unknown-outcome (flagged for a person), which matches the engine's own crash semantics. Session-transcript evidence (project primary sessions) is a possible future source, deliberately out of scope.
- Live `--apply` against the real journal is untested by design (no non-terminal rows exist to reconcile; the fixture tests cover the write path against both schemas).
- Coordinator guard note: this session's bash guard pattern-matches literal `~/.pi` strings, so the live checks constructed the db path at runtime (`Path.home()`); the tool itself contains the default path and opened the db read-only (verified by hash).
