# Theme C P0: generic RSI loop engine extracted to packages/pi-rsi-loop

Date 2026-11-13 · Worker: dispatched coder subagent (Theme C, background) · Status: delivered,
all suites green (package 93 tests; MC regression 93+93 read-only).
Brief: PLAN.md Theme C — C1 extract the MC-proven closed-loop RSI engine into a generic platform
package; C2 adapter contract + one toy second consumer completing a single loop iteration in
dry-run. MC tree read-only; no imports from remote-agent (copy-adapt).

## Changes

### 1. `packages/pi-rsi-loop/` — generic loop engine (new package, Python, stdlib-only)
- `src/rsi_loop/engine.py` — `RsiLoopEngine`: the eight-stage orchestration core
  (SENSE → PROPOSE → FILTER → EXPERIMENT → GATE → APPLY → CURRICULUM → LOOP) with framework-owned
  features as first-class: budget caps (cumulative token cap + per-cycle remaining forwarded to
  the runner + daily cycle cap), two-strikes infra breaker, crash-resume (checkpoint after every
  step; experiment NEVER relaunched; terminal results.json only; bounded poll for a detached
  driver's verdict; unknown phase dropped), observe-first/live gating (window = authorization
  budget; exhaustion pauses in both modes), rejection memory (novelty pressure, cap 5, fed to the
  proposer), decision-line logging, stable exit-code vocabulary (0/3/4/5/6/7/8).
- `src/rsi_loop/ports.py` — the six ports (`LedgerSource`, `Proposer`, `ExperimentRunner`,
  `Gate`, `Applier`, `Curriculum`) + proven defaults: `AcceptGate` (pinned MC criteria:
  primary metric ≥ threshold OR frontier advanced, no error worsened, budget ok, both arms
  completed; capped arm = incomplete), `RecordingApplier` (no-op), `SaturationCurriculum`
  (3 accepts + CV<30% → advance; 5 rejects → hold+flag), `observe_estimate` (prediction-based).
- `src/rsi_loop/state.py` — `LoopState` (atomic 0600 writes, stale-streak self-repair),
  `TwoStrikes`, exit codes. `src/rsi_loop/results.py` — terminal-only results loader (c005 bug
  class: intermediate per-arm writes rejected for gating/resume). `src/rsi_loop/filter.py` —
  generic proposal invariants + adapter-validator hook (extend, never weaken). `src/rsi_loop/
  proposer.py` — chat-completions transport (bounded body, retry + non-retryable short-circuit,
  JSON repair rounds, reasoning_content never read, key never logged; strict 0600 key loader as
  optional helper). `src/rsi_loop/jsonparse.py` — balanced-JSON extractor.
- Extracted as GENERIC: control flow, rails, resume, gating, filter/rejection memory, gate truth
  table, saturation policy, HTTP proposer transport, state/checkpoint format. Left MC-specific
  (documented in ADAPTER.md §6): ssh transport/world-advancements fetch, records-*/events.jsonl
  journal + AUTOPSY/OPERATOR ledger parsing, skills-library staged validation + git-commit
  applier, cold keep/revert driver semantics, advancement-ladder difficulty-escalation policy,
  axonhub/credentials endpoint defaults, proposer prompts.

### 2. `packages/pi-rsi-loop/ADAPTER.md` — the C2 adapter contract
Six-port table, canonical shapes (hypothesis entry, terminal results.json, state file, exit
codes), framework-owned rules, what a project must decide (ledger source, scorer, gate criteria,
apply authorization, budget, scope rules, curriculum semantics), MC → ports map, hard rules for
adapter authors (never fabricate / relaunch / widen write scope; human apply authorization).

### 3. `packages/pi-rsi-loop/tests/dry_run/` — toy second consumer (C2 acceptance)
`toy_consumer.py` (~120-line adapter: FixtureLedgerSource, ScriptedProposer recording rejection
memory, toy scope validator, DeterministicScorer writing canonical terminal results.json,
AcceptGate(0.15) unchanged, RecordingApplier, SaturationCurriculum) + `run_dry_run.py` CLI +
`fixture_ledger.json`. Evidence: `python3 tests/dry_run/run_dry_run.py` → one full iteration,
gate accept `primary_metric_met_no_regressions`, 20% improvement on the pinned 15% threshold,
no-op apply, exit 7; `--observe` → estimate-only `would_accept`, no experiment, exit 6; all
artifacts inside the per-run workspace, zero writes outside (asserted in tests).

### 4. Tests
`tests/test_gate.py` (22), `test_filter.py` (16), `test_results.py` (12), `test_state.py` (17),
`test_engine_cycle.py` (19: full cycle, mode/window semantics, rails/two-strikes/budget, resume
from every phase), `tests/dry_run/test_dry_run.py` (7, incl. zero-side-effects assertions).
93 tests total via `python3 -m unittest discover -s tests -p 'test_*.py'` (pytest not installed
on this machine; matches the MC suite's unittest convention). Package is Python because the
proven engine is Python — copy-adapt preserves field-hardened semantics reviewably 1:1.

## Bugs found during extraction (fixed; first is latent in MC too)
1. Resume from a pre-experiment checkpoint (`propose` phase) left `entry=None` → experiment
   called with None (MC's resume_inflight has the same shape; caught by the new resume tests).
2. `emit_decision` keyword collision when the applier result carries `hypothesis`/`cycle` keys.
3. Terminal `verdict_result` read from the inner results instead of the hoisted verdict
   (MC's real-runner path loses it in gate evidence; both shapes now accepted).
4. Semantic correction (documented): MC's observe-window decrement required live mode while the
   pause required non-live, making the promised `observe_window_done` pause nearly unreachable;
   the window is now a coherent authorization budget that pauses in both modes.

## Regression evidence (MC untouched)
- `PYTHONDONTWRITEBYTECODE=1 python3 -m unittest tests.test_closed_loop` → 93 OK (29.6s)
- `python3 -m unittest tests.test_wave_loop_auto` → 93 OK (11.7s)
- `git status -- remote-agent` shows only the pre-existing live-loop artifact
  `wave/20261104T193537Z-efbc3763/hypotheses.json` (dirty before this task; not touched).

## Limitations (honest)
- The package is not wired to any live project yet; MC keeps running its own proven code path
  (per plan: MC becomes the first *reference* adapter; migrating MC onto the package is future
  work and must preserve its live authorization state).
- The cold-lane semantics are simplified vs MC (uniform runner lane through the same gate; MC's
  driver-decides-keep/revert cold flow stays MC-side) — documented in ADAPTER.md.
- No `pyproject.toml` packaging (repo convention: per-package `package.json`; consumed via
  `sys.path` like MC's importlib pattern). No CLI in the package; adapters own CLIs.
- Semantic-correction delta vs MC (observe-window) is deliberate and documented, not a bug-for-bug copy.
