# ADAPTER.md — the RSI-loop adapter contract

How a project plugs into `packages/pi-rsi-loop`. The engine owns the
**control flow**; the adapter owns **project facts**. If a rule below is
violated, the engine fails loudly (pauses / rejects the cycle) — it never
fabricates.

**Reference adapter:** the Minecraft closed-loop engine at
`remote-agent/operations/20261029-minimal-sword-episode/closed_loop.py`
(copy-adapted into this package; that file stays the working MC instance and
does NOT import this package). Its map onto the ports is in §6.

**Toy worked example:** `tests/dry_run/toy_consumer.py` — a complete adapter
in ~120 lines that passes the C2 acceptance (one full dry-run iteration,
zero side effects).

---

## 1. The six ports

| Port | You provide | Engine guarantee |
|---|---|---|
| `LedgerSource` | `sense(cycle_id)` → `{'ledger', 'frontier', 'next_before'}`; optional `post_experiment(cycle_id)` → `{'next_after'}` | Checkpointed as the SENSE step; `next_before`/`next_after` feed the frontier-advanced gate criterion; absent values must be `None`, never invented |
| `Proposer` | `propose(ledger, frontier, node, *, rejections, raw_sink, extra_context)` → `(raw_text, doc)` with `doc['hypotheses']` | Feeds the **rejection memory** (novelty pressure); accounts `last_usage.total_tokens` into the budget; `ProposerUnavailable` → loop PAUSES (`paused_no_llm`), never fabricates; raw output archived via `raw_sink` |
| `ExperimentRunner` | `__call__(entry, proposals_path, remaining_budget, cycle_id)` → canonical exp_out; `load_results(auto_dir)` (default: terminal-only loader) | `remaining_budget` honored per experiment; failures → gate reject + **two-strikes infra breaker**; crash-resume reads TERMINAL results only — **the runner is never relaunched** |
| `Gate` | `decide(control, treatment, next_before, next_after, *, budget_ok)` → `{'decision', 'reason', 'evidence'}` | Default `AcceptGate` pins the MC-proven criteria (§3); the engine never weakens your criteria |
| `Applier` | `__call__(entry, cycle_id, description, node, *, dry)` → `{'applied', 'commit'?, 'revert_procedure'?, 'error'?}` | Called ONLY in live mode on a gate-accepted, non-observe cycle; an apply error counts the cycle as NOT accepted; success records the revert procedure in state |
| `Curriculum` | `update(cycle_id, accepted_now, treatment, state)` → `{'transition': ...}`; owns `state.data['node']` | Default `SaturationCurriculum`: 3 consecutive accepts + request CV < 30% → advance; 5 consecutive rejects → hold + flag; a missing next-node holds, never fabricates |

## 2. Canonical shapes (part of the contract)

**Hypothesis entry** (filter output; what runners and appliers receive):

```json
{"id": "Cc001H1", "raw_id": "H1", "description": "...", "novelty": "...",
 "target_file": "skills/library.json", "action": "add|modify|remove|patch",
 "name": "...", "skill": {"name", "when", "source"}, "deactivate": [],
 "prediction": {"error_code", "error_count_target", "max_requests"},
 "falsifiable": true, "evidence": ["..."],
 "scope": "hot",            // adapter-owned routing key; default 'hot'
 "cold_diff": "..."}        // only when action == 'patch'
```

Raw proposer output maps through `entry_from_raw`:
`change = {'file', 'action', 'name'?, 'skill'?, 'deactivate'?, 'diff'?}`.

**Experiment results** — the driver's `results.json` inside `auto_dir`
(runsners write it; the terminal-only loader reads it):

```json
{"verdict": {"result": "treatment_favors | control_favors | ..."},
 "finished_at": "<iso8601>",
 "results": {
   "control":   {"arm": "control",   "outcome": "completed", "model_requests": 193,
                 "error_code_counts": {"code": n}, "token_totals": {"total_tokens": n}},
   "treatment": {...}}}
```

The top-level `verdict` is the **terminal marker**. A `results.json` without
it is an intermediate per-arm write and is REJECTED for gating/resume (the
MC c005 bug class). Outcome vocabulary: `completed`, `model_failed` count as
comparable; `infra_failure`, `timeout`, `died`, `aborted_budget`,
`cap_reached` are incomplete (extend via `AcceptGate(extra_not_completed=)`).

**Evidence envelope key (C3, engine-written, optional):** after a cycle
closes, the ENGINE may add a top-level `evidence` key to this envelope
(`rsi-loop-evidence/1` schema, see `rsi_loop.evidence`). Drivers never write
it and must ignore it; the terminal rule is unaffected. Arm dicts MAY carry
a `scorer_output` field (any JSON value) — it flows into the evidence record
bounded (strings >400 chars truncated, dicts/lists capped at 20 entries,
error-code counts capped at 20 with an `*_omitted` sibling count).

**Proposer identity (provenance):** `HttpProposer` exposes `model` and
`last_prompt_hash` (sha256 of the exact accepted round's messages, computed
by the transport — set it yourself in custom proposers so the evidence chain
stays inspectable). A proposer without these attributes still gets its class
name recorded; missing fields stay `null`, never fabricated.

**State file** (`LoopState`, atomic 0600 writes, checkpoint after every
step): `mode` (observe|live), `status`, `node`, counters, budget
(`token_cap`/`spent`), caps (`max_cycles_per_day`), `cycle` (in-flight
checkpoint), `cycles` history (each closed cycle carries an `evidence`
record — see above), `would_accept`, `revert`, `live_transition`
(how/when apply was authorized), `extra` (adapter payload).

**Exit codes** (stable): 0 ok/daily-cap · 3 `paused_no_llm` · 4
`paused_infra` · 5 `budget_exhausted` · 6 `observe_window_done` · 7
`cycles_done` · 8 `paused_no_progress`.

## 3. Framework-owned rules (do NOT re-implement in the adapter)

- **Budget caps** — cumulative token cap (proposer usage + treatment/control
  token_totals), per-cycle remaining budget forwarded to the runner, daily
  cycle cap. Exhaustion pauses, never truncates a running cycle silently.
- **Two-strikes infra breaker** — two consecutive non-model failures
  (experiment_failed / infra_* / infra_exception) → `paused_infra`. A model
  outcome (accept or a criteria reject) resets the strikes.
- **Crash-resume** — checkpoint after EVERY step; `resume_inflight()`
  continues from artifacts: an experiment phase resumes by loading TERMINAL
  results only (bounded poll for a detached driver's verdict, operator-bound
  via `RSI_LOOP_RESUME_WAIT_MINUTES`); a pre-experiment phase recomputes the
  pure filter and starts the experiment fresh (a fresh start, not a replay);
  unknown phases are dropped, never replayed.
- **Observe-first / live gating** — `mode='observe'` estimates only
  (prediction-based `would_accept`, no experiment, no apply). An explicit
  observe window (`observe_window=N`) is an authorization budget in BOTH
  modes; exhaustion pauses (`observe_window_done`) for a human decision.
  Apply happens only in live mode; the transition is recorded in state.
  *(Documented delta from MC: there the window decrement and the pause had
  opposite mode requirements, so the promised pause was nearly unreachable;
  here the window exhausts → pause, coherently.)*
- **Novelty filter / rejection memory** — every gate-rejected cycle's
  accepted hypotheses (summary ≤160 chars, reason, prediction) are fed back
  to the proposer, newest-last, capped at 5 total. An honest proposer must
  not repeat a rejected target+intent.
- **Proposal filter invariants** — k_max cap with overflow logging, list/dict
  shape, falsifiable, measurable prediction, change-keys allowlist. Adapter
  validators EXTEND this list; they cannot weaken it.
- **Accept gate default** (`AcceptGate`) — accept iff primary metric
  (frontier advanced OR same-node requests improved ≥ threshold) AND no
  error code worsened (any treatment−control delta > 0) AND budget ok AND
  treatment completed AND (control present → control completed; a capped
  control is never a valid baseline). Replaceable, but replace it only to
  TIGHTEN (§7).
- **Evidence auto-plumbing (C3)** — the engine builds one bounded
  `rsi-loop-evidence/1` record per closed cycle (arm summaries, error-code
  deltas, scorer verdict, gate inputs/decision/reason, apply/revert outcome
  with commit sha, proposer provenance incl. model + prompt-hash) and
  persists it: always into the state cycle record (`record['evidence']`) and,
  when the experiment produced a TERMINAL results envelope, additively into
  that envelope too. Evidence is write-only bookkeeping: it never affects
  gating, budgeting, the two-strikes breaker, crash-resume (terminal-results
  rule unchanged — the `evidence` key is not part of terminality), or the
  observe-mode no-apply guarantee. Read-back for tooling:
  `PYTHONPATH=src python3 -m rsi_loop --evidence <state|auto_dir|results.json>`
  (exit 0 evidence · 2 path missing · 3 artifact unreadable, e.g. non-terminal).

## 4. What a project MUST decide / provide

1. **Ledger source** — where error evidence comes from and what "baseline
   requests" means (MC: newest `records-<run>/events.jsonl` controller_final
   journal + AUTOPSY/OPERATOR markdown mention counts).
2. **Scorer / experiment driver** — what an A/B arm runs, what one "request"
   is, and the terminal results.json write (MC: `wave_loop.py auto`
   subprocess per arm; token totals from the episode).
3. **Gate criteria** — the default AcceptGate, or stricter: primary metric,
   threshold (MC pins 15%), what counts as a regression.
4. **Apply authorization** — who flips observe→live (a human flag recorded
   in `live_transition`), what the applier may write (MC: exactly
   `skills/library.json`, atomic, git commit; rollback = recorded git
   revert), and what is NEVER writable.
5. **Budget** — token cap, cycles/day cap, per-episode request budget.
6. **Proposal scope rules** — the adapter validator (MC: hot = skills
   library shape via wave_loop staged validation; cold = artifact patch
   schema + denylist; unknown = refused) and the proposer prompts (project
   content — the package ships transport + JSON repair, not prompts).
7. **Curriculum target semantics** — default saturation policy, or an
   adapter policy (MC: advancement-ladder difficulty escalation with
   too-easy/retry/park — stays in MC's adapter layer).

## 5. Dry-run / observe posture (zero side effects)

Assemble the engine with stub ports (like `toy_consumer.py`): scripted
proposer (no network), deterministic runner (writes results.json only inside
its workspace), `RecordingApplier` (records would_write, writes nothing),
state/reports/proposals/experiments all under one workspace dir. `dry=True`
+ `RecordingApplier` gives the MC `--dry-run` semantics (simulate the live
path, nothing written live); `mode='observe'` gives estimate-only cycles.

## 6. MC closed_loop.py → ports map (reference adapter)

| MC construct | Port |
|---|---|
| `build_ledger()` + `build_advancements_doc()` + `Ladder` (advancement_ladder.py subprocess, ssh advancements fetch) | `LedgerSource` |
| `GLMProposer` (axonhub chat-completions, 0600 credentials, JSON repair rounds) + `PROPOSE_SYSTEM/_INSTRUCTIONS` | `Proposer` (transport in `rsi_loop.proposer.HttpProposer`; prompts are adapter content) |
| `SubprocessRunner` / `ColdRunner` (wave_loop.py auto / --cold) + `load_auto_results` | `ExperimentRunner` (terminal rule = `rsi_loop.results.load_terminal_results`) |
| `accept_gate` / `requests_improved` / `frontier_advanced` | `Gate` = `AcceptGate(threshold=0.15)` |
| `apply_acceptance` (build_staged → validate_staged → atomic write → git add -f + commit) | `Applier` |
| saturation `curriculum_update` + ladder policy (`full_budget_failure`/`node_reached`/`ladder_policy`) | `Curriculum` (saturation is the package default; the ladder difficulty-escalation policy is MC's adapter extension) |
| `ClosedLoopState`, `TwoStrikes`, budget/daily caps, observe/live, rejection memory | framework (this package) |

## 7. Rules for adapter authors (hard)

- Never fabricate: missing evidence → `None` → honest degradation; unreachable
  proposer → `ProposerUnavailable` → pause.
- Never relaunch an experiment on resume; never gate on intermediate results.
- Never widen the applier's write scope beyond what the brief authorizes;
  hot-only means hot-only.
- Adapter validators extend, never weaken, the generic filter invariants;
  replacing the default gate is allowed only to TIGHTEN criteria.
- The apply authorization is human: mode flips are recorded in state with
  `authorized_by`; dry-run never counts as authorization.
- Keep every artifact under paths the operator chose (state, reports,
  proposals, experiments); the toy consumer's zero-outside-writes test is
  the posture to copy.
