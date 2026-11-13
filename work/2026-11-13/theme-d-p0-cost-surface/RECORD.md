# Theme D P0: per-project cost surface (D1) + journal budget fields (D2)

Date 2026-11-13 · Worker: dispatched coder (clean-context subagent, Theme D brief) · Status: delivered, all suites green.
Brief: PLAN.md Theme D — D1 (per-project cost rollup; the budget owner sees no number) and D2
(journal budget fields per task envelope, additive schema).

## Changes

### 1. `packages/pi-usage-log` — per-project attribution + rollup (D1 core)
- New `project-usage.ts` (421 LOC, zero deps beyond node built-ins):
  - Attribution chain mirroring the bridge's `orgProjectOf` evidence stages,
    reduced to the evidence a usage record can carry, priority order:
    (a) cwd under a registered project root — MOST SPECIFIC root wins when roots
    are nested (minecraft's ops dir inside the piagents workspace was the live case);
    (b) session id == registry `sessionId` (`medical-primary`, the coordinator's
    project-primary convention, tools/live-coordinator-check.ts:36);
    (c) `role-...@<project>` @-segment; (d) session topic `<topic>-x<N>`/`-<N>`/`-primary`
    with superagent collision suffixes (`-2x41`) stripped first, longest alias prefix,
    aliases < 3 chars never match; (e) `[project:<name>]` tag in the task text resolved
    against registry ids/aliases or `personal-ops`, unknown tags ignored; (f) alias
    evidence with the bridge's 2-mention rule (two projects named → unattributed).
  - Explicit buckets: `unattributed` (no evidence) and `personal-ops` (explicit tag
    only). Buckets are disjoint and exhaustive → totals always reconcile with the raw
    JSONL sums (`reconcile()`, pinned by tests and printed by the CLI on every run).
  - Registry read: read-only coordinator.db via lazy `createRequire("node:sqlite")`
    (same pattern as bridge projects.ts / guard registry.js); ANY failure → empty
    registry → everything honestly unattributed, never a crash, never a guess.
  - `readUsageRecords()` reads only the day files the window touches; malformed
    lines skipped.
- New `cli.ts` (49 LOC): `node --experimental-strip-types packages/pi-usage-log/cli.ts
  [--days 7] [--dir <usage-dir>] [--db <coordinator.db>]` — per-project table +
  buckets + TOTAL + reconciliation line; exit 2 on reconciliation failure.
- `index.ts` (additive, +59/-8):
  - **Bug fix found by the data**: production records have NO `cwd` (1 of 7609 records
    had one — a test fixture). Root cause: `ctx.workingDir` is not the typed field
    (`ExtensionContext.cwd`). Now `ctx.cwd ?? ctx.workingDir` — cwd is the strongest
    attribution signal, so this fix is what makes D1 work for main sessions.
  - Additive record fields: `sessionName` (`getSessionName()`), `task` (first line,
    ≤200 chars, of the most recent user message via `message_start` — carries the
    `[project:...]` tag + alias evidence). Old records/rows read fine without them.
  - `/usage project [days]` command variant rendering the same rollup.
- `package.json`: `npm test` = `node --experimental-strip-types --test tests/` (repo
  lesson: node --test, NOT vitest).
- Tests: new `tests/project-usage.test.ts`, 40 tests — all attribution stages incl.
  the brief's edge cases (renamed session dirs with collision tokens attribute
  correctly; untagged legacy uuid sessions → unattributed bucket), nested-root
  specificity, 2-mention ambiguity, rollup bucket math, reconciliation (incl. a
  negative test), day-file window filtering, tolerant registry parse.

### 2. `packages/pi-project-coordinator` — journal budget fields (D2)
- `store.ts`: additive migration — `journal.budget_planned` / `budget_spent` REAL
  columns via `ALTER TABLE ADD COLUMN` guarded by `PRAGMA table_info`; pre-migration
  dbs upgrade on open, old rows read NULL.
- `journal.ts`: `TaskEnvelope.budgetPlanned`/`budgetSpent` (optional; old envelopes
  read as null); `received` row writes columns + envelope JSON (no-budget rows keep
  the exact old shape, verified by the pre-existing deep-equal replay test);
  `mark(taskId, phase, detail?, budgetSpent?)` — the settled row may refresh spend
  (append-only: new row, never an UPDATE); replay backfills envelope budget from
  columns when the detail JSON predates the fields and keeps the freshest spent.
- `engine.ts`: `submit()` input passes budgets into the envelope;
  `ProjectRuntime.run` may return optional `budgetSpent` (RpcProjectRuntime
  unaffected — it returns without it).
- Tests (`tools/test_project_coordinator.ts`, +4): envelope→columns→getEnvelope
  round-trip; pre-migration db opens additively, old rows null, new writes work;
  settled-row spend refresh survives replay; engine submit→settle carries budgets.
  21 pass + 1 opt-in smoke skip (was 17).

### 3. `packages/pi-web-bridge` — the two panels (D1+D2 surface)
- `projects.ts` (+107): tolerant `parseEnvelopeMeta` (camelCase + snake_case budget
  keys); `projectBudgetsFromJournal` — per-project sums over the journal window,
  latest non-null spent per task, tasks without budget fields contribute nothing;
  `ProjectView.budgetPlanned/budgetSpent` present only when ≥1 task carries them;
  the journal SELECT now detects budget columns via `PRAGMA table_info` so a
  PRE-migration db still loads (no regression for dbs the coordinator hasn't
  reopened yet).
- `server.ts` (+13): `/projects` response gains additive `usage7d` (the
  ProjectUsageRollup from pi-usage-log) when wired and non-null; a throwing source
  degrades to omission, never a 500.
- `extension.ts` (+37): wires `usage7d` from pi-usage-log via LAZY dynamic import
  (sibling package missing → logged once, field omitted) + 60s TTL background
  recompute (the route polls every ~3s; sync getter serves the last completed
  rollup, null-while-warm like usage.ts).
- `index.html` (+59, ADDITIVE PANEL MARKUP ONLY — live-served, deploys on hard
  refresh): new CSS rules only (`.pcard.has-usage`, `.card-usage`,
  `.projects-7d`); per-project rows show `7d <tokens> tok · $<cost>` (+ `<budget
  plan X · spent Y>` when present) with a full tooltip; one summary line under the
  rows: `7d total ... · unattributed ... · personal-ops ...`. Absent usage7d renders
  exactly as before.
- Tests (projects.test.ts +8 tests): envelope budget parsing (camel/snake/absent/
  garbage), budget sums with freshest-spent-wins, migrated + pre-migration db
  reads, route passthrough + omission + throw-degradation. 257/257 pass.
  `tsc --noEmit`: src/ clean; tests/ errors are pre-existing (verified via
  git stash: same errors before this change).

## Evidence
- pi-usage-log: `npm test` — 40/40 pass.
- pi-project-coordinator: `npm test` — 21 pass, 1 skip (opt-in real-CLI smoke).
- pi-web-bridge: `npm test` — 257/257 pass.
- Reconciliation on the REAL usage JSONL (read-only): `cli.ts --days 7` → 8 day
  files, 2713 records, 375,295,012 tokens, $0.00 (local/free endpoint),
  `reconciliation: OK`. All 2713 in-window turns currently land in
  `unattributed` — honest: existing records carry no cwd/sessionName/task and the
  only in-window session is the coordinator's bare-uuid main session. After
  reload, new records carry cwd (→ `piagents` via registry root
  /Users/yuyuan/PiAgents) and project-primary sessions attribute via registry
  sessionId / topic conventions.
- Live smoke of the full /projects route against the real coordinator db +
  real usage dir: HTTP 200, 10 registry projects, `usage7d` present with the
  numbers above; budget keys omitted on views without budget data.

## Live-now vs needs-reload
- **Live on hard refresh of the browser tab** (index.html is served per request):
  the /projects panel markup — it renders usage/budget when the API provides them.
- **Needs extension /reload (or restart) to produce data**: bridge
  extension.ts/server.ts/projects.ts (usage7d wiring + budget fields on views)
  and pi-usage-log (cwd/sessionName/task record fields + /usage project).
- **Needs coordinator restart**: pi-project-coordinator (store migration runs on
  next open; budget columns appear for new envelopes).

## Limitations
- Historic usage stays unattributed by design: records before this change carry
  no cwd/sessionName/task. No backfill was attempted (would be guessing).
- `usage7d` is a 60s-cached rollup; a just-finished turn shows within a minute.
- Budget units are envelope-owner-owned (USD or tokens — the coordinator does not
  police units); the panel labels them "journal envelope units".
- The bridge lazy-imports pi-usage-log by relative path (both live in
  PiAgents/packages/); if the package is ever moved alone, usage7d degrades to
  omission with one log line — the panel keeps working.
- Reconciliation covers buckets-vs-raw sums; per-project splits are pinned by
  fixture tests, not by the JSONL itself (no ground-truth project labels exist
  in historic records).
