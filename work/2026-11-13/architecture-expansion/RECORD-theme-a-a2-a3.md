# Theme A remaining P0/P1: A2 activation contract + A3 reload-safety guard + placeholder false-positive fix

Date 2026-11-13 · Worker: dispatched coder (background subagent, clean context) ·
Status: delivered — 171/171 guard tests + 21/21 restart_handoff tests green, checker + live smoke verified.
Brief: [project:PiAgents] Theme A (work/2026-11-13/architecture-expansion/PLAN.md) items A2 (P0),
A3 (P1), plus the live false positive found in the coordinator guard today.

## Changes

### 1. A2 — `docs/activation-contract.md` (new) + `tools/check_activation_contract.py` (new)
- One table row per package + extension: all 10 `packages/*` plus
  `extensions-src/memory-index` and `extensions-src/memory-distiller` (12 rows).
  Columns: env vars read at LOAD vs per-call · config files / live-edit
  surfaces · what `/reload` gives you · what needs a full restart. Every env
  read is cited to file:line (e.g. guard per-call env re-resolution in
  `index.js`; obsmem `ensureConfig` latch `runtime.ts:122-126`; superagent
  manager per-spawn env `manager.ts:173-176`; web-bridge port bound at init
  `extension.ts:83-84`).
- Universal rule grounded in the 2026-11-13 forensics: `/reload` does NOT swap
  extension module code in a long-lived process — evidence pointer to
  `docs/runbooks/pi-restart.md` ("The rule this runbook exists for",
  `/tmp/auto-reload-state.json`).
- `tools/check_activation_contract.py`: mechanical grep test — collects each
  package's env reads (direct `process.env.X` + same-file const resolution for
  `env[CONST]`), asserts every var is named in its table row, asserts the
  runbook pointer exists. Validated both directions: green on the real tree;
  removing `PI_SPAWN_BUDGET` from the row → exit 1 with a precise message.
- Survey findings the table corrected/exposed:
  - `PI_SPAWN_REQUIRE_PROJECT_TAG` (superagent spawn-tag kill switch,
    manager.ts:182) was missing from my initial survey — caught by the checker.
  - `extensions-src/memory-distiller` exists (B1 in progress: state/scan/
    credentials modules, no extension entry yet) — added its row.
  - Config liveness classes: live = guard config file (mtime cache), fork
    settings (re-read per call), superagent.yml (per start), registry db
    (TTL/per-request); latched = observational-memory settings (ensureConfig
    once), minimal-subagent max depth (module init), web-bridge port (bound at
    init), memory-index db path (first open).

### 2. A3 — guard category `reload_safety` (v0.4.0), observe-only this wave
- `packages/pi-coordinator-guard/classify.js`: `classifyReloadBash()` —
  precision-first `/reload` detection: `reload_send_keys` (tmux send-keys
  segment mentioning /reload) > `reload_quoted` (exact quoted "/reload"
  token) > `reload_bare` (whole command). Paths like `src/reload/index.ts` do
  NOT match; a TUI-typed /reload is out of scope by construction (no tool
  call). `reload_safety` wins over `mutating_bash` when both match.
- `packages/pi-coordinator-guard/reload.js` (new): `scanNonSettledDispatches()`
  reuses `tools/restart_handoff.py`'s inference as a **library import** (a
  `python3 -c` snippet imports the module and JSON-dumps
  `scan_subagents(Path(...))` — no logic copied, so guard and restart runbook
  cannot drift). Non-settled = status `running`/`stale`. Fail-open: any
  failure resolves `{ok:false, error}` (5s timeout), never rejects.
- `packages/pi-coordinator-guard/index.js`: when the category is
  `reload_safety`, the handler scans `<projectRoot>/.pi/subagents`
  (options > `PI_COORDINATOR_GUARD_PROJECT_ROOT` > `/Users/yuyuan/PiAgents`):
  ≥1 non-settled dispatch → one `would_deny` line (excerpt lists ids+statuses);
  0 → silent passthrough; scan failure → `error` line
  (`pattern:"reload_scan_failed"`). **Never blocks in any mode** — the enforce
  flip is a user decision per plan §7 (same gate pattern as mutating-bash D3a).
- Tests (+44): classifier table (flagged/clean/precedence), scan fixtures
  mirroring the production layout (`<root>/tools/restart_handoff.py` copied
  from the real module + `.pi/subagents/<id>/events.jsonl` with
  running/done/stale kinds), wiring tests (enforce mode logs `would_deny`,
  never blocks; safe reload silent; scan failure → error line).

### 3. Placeholder false-positive fix (live FP from today's guard log)
- Incident: a dispatch brief quoting the documentation convention string
  `[project:<name>]` in prose had `<name>` extracted as a tag name; the
  registry check would deny unknown project `<name>` (and a placeholder alone
  would wrongly satisfy the tag rule).
- Fix (`classify.js`): `isPlaceholderTagName()` — a tag name containing angle
  brackets is the convention string, never a real id. `classifySpawn()` now
  requires a real non-placeholder tag; `extractProjectTags()` filters
  placeholders out before the registry validation.
- Regression tests: real leading tag + prose convention → passes tag AND
  registry validation untouched (enforce wiring, hermetic registry fixture);
  placeholder-only task → still `dispatch_missing_project_tag`.
- Live evidence (this session, real registry, temp log sink):
  `[project:PiAgents] … must begin [project:<name>] …` → tags `["PiAgents"]`,
  spawn untouched; a `tmux send-keys -t coordinator '/reload' Enter` probe
  logged `would_deny … 4 non-settled dispatch(es): activation-x1 (running),
  cost-surface-x1 (running), distiller-x1 (running), rsi-platform-x1 (running)`
  without blocking — the scan found the other theme workers actually in flight.

## Verification
- `npm test` (pi-coordinator-guard): 171 tests, 171 pass, 0 fail (127 pre-existing + 44 new).
- `python3 -m unittest discover` for `tools/test_restart_handoff.py`: 21/21 OK
  (the imported library is exercised and healthy).
- `python3 tools/check_activation_contract.py`: OK; negative test (var removed
  from a row) fails with a precise message.
- Live smoke against the real coordinator db (read-only) — see §3 above.
- Note: the earlier log line `12:25:39Z dispatch_unknown_project denied` for a
  real `[project:PiAgents]` dispatch predates the registry row for `piagents`
  (commit e19bb22 registered it after); current registry read resolves
  `[project:PiAgents]` correctly (alias/id, case-insensitive).

## Limitations
- `reload_safety` cannot see a `/reload` typed directly into the TUI (no tool
  call is emitted); it covers tool-call-visible vectors (send-keys, quoted
  command text). Documented in README + classify.js.
- The activation-contract checker pins the env-var surface; the
  load-vs-per-call classification is grounded by cited file:line references,
  not mechanically re-verified (stated in the doc's Verification section).
- Enforcement for `reload_safety` stays OFF (observe-only); flipping it is the
  user's §7 decision after reviewing the JSONL log.
