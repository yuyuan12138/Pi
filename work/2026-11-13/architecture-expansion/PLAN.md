# Architecture Expansion Plan — PiAgents

Date 2026-11-13 · Author: dispatched coder (record 2026-11-13) · Status: proposed — user decisions in §7.
Evidence rule: every load-bearing claim cites a repo path, commit, or doc section; brief-only
operational facts are marked *(user-reported)*. Snapshot of surveyed state: 2026-11-13 19:30 UTC.

## 1. Current-state map (verified)

### 1.1 Constitution layer (`instructions/`, all dated 2026-11-11)
- `AGENT-ORG.md` v1.4 — one agent type; decompose-or-execute rule (§2); UP-CHECK rework loop
  with two-strike escalation (§3); default-ON dispatch authority for every spawned agent (§5.2);
  three-tier memory (§6); anti-patterns incl. no resident daemons, no self-acceptance (§7).
- `ARCHITECTURE.md` — overview projection; identity: 18 profiles → individuals → instances
  (`role-<name>[.<spec>]@<project>`); worker = one-shot, harvest mandatory (§6).
- `ROSTER.md` — 3 seeded individuals (coder-1, operator-1, reviewer-1), evidence-linked; hiring
  gate = user approval. `instructions/agents/` holds all 18 profile dirs (cards + skills + records).
- `PROJECT-SPACE-STANDARD.md` v1.0 — README charter / `docs/` (architecture, ADR, runbooks,
  postmortems) / `work/` RECORD per dispatch; length budgets; subprojects = graduated branches (§10).
- `GRAPH-SCHEMA.md` v1.1 — per-project `graph.json` normative structure (v2 consumers deferred).

### 1.2 Engine packages (`packages/`, one line each)
- `pi-superagent` — proactive GitHub-agent port (dsh-superagent); enforces per-agent spawn budget
  `PI_SPAWN_BUDGET` (src/index.ts:27); tool-call denylist guard; credential guard (blocks `~/.pi/agent/`
  config reads — observed live during this survey).
- `pi-project-coordinator` — registry + FIFO queue per project + single-writer lease + global
  concurrency cap 2, durable across restarts (README engine table).
- `pi-web-bridge` — local web mission control: chat, org-graph invocation tree (src/index.html),
  `/projects` journal panel (src/projects.ts), session→project attribution.
- `pi-coordinator-guard` — per-category tool-call guard; enforce mode denies untagged dispatch +
  out-of-allowlist edit/write; mutating bash stays log-only (package.json description).
- `pi-delegation-reminder` — mechanical per-turn ROUTER CHECK injection; clause 4 = project-space
  routing (commit 070c7c8).
- `pi-delegation-gate` — gates `fork` calls on explicit `[fork-context:]` justification.
- `pi-fork` / `pi-minimal-subagent` — fork-with-branch-context and minimal subagent runner.
- `pi-observational-memory` — tiered compaction with observations/reflections (V3 model), feeds
  the index below.
- `pi-usage-log` — per-turn token/cost/tool JSONL + `/usage` aggregate; per-session, not per-project.

### 1.3 Extensions & memory stack
- `extensions-src/memory-index/` — **P0 of the sa52 design, built**: SQLite FTS5 `memory_search`
  over distilled memory only (compaction observations, KB daily, concepts); jieba tokenization;
  credential screening; project-scoped by default; `kind: atom` is *reserved for P1 and matches
  nothing* (README "Tool" section).
- sa52 design (`.pi/subagents/sa52/result.md` §3) — P1 `memory-distiller` fully designed
  (L1 atom extraction w/ watermarks + dedup; L2 concept consolidation with UPDATE-default,
  cap-15 merge pressure, heat counters; L3 generated profile ≤2KB), **not built**.
- `knowledge-base/` — daily log 2026-11-03→11-13; **only 3 concept articles**
  (`knowledge/concepts/`: agent-library, knowledge-base-design, pi-project-first-architecture);
  wiki/ LLM layer; `compile_kb.py` scope gate fail-closed (global needs ≥2 projects + user approval).

### 1.4 Coordination runtime & tools
- 7 registered projects via `tools/register-*.ts` (minecraft, feishu, english, blog, notion-ops,
  nvim-config, …); coordinator journal lives in `~/.pi/agent/project-coordinator/` (private).
- Guards: `tools/delegation_gate.py` (+tests), `tools/wps-reader/dispatch_guard.py` (refuses
  undispatched user-data writes), `tools/git_guard.py` hook, `tools/task-sentinel.py`,
  `tools/memory_doctor.py`, `tools/skills_doctor.py`.
- MC closed-loop RSI engine: `remote-agent/operations/20261029-minimal-sword-episode/closed_loop.py`
  — SENSE→PROPOSE→FILTER→EXPERIMENT→GATE→APPLY→CURRICULUM→LOOP; proven in the MC project, not packaged.
- `harness2/` — v1 skill-routing harness experiment (journal tracked, reports untracked, 2026-11-04).

### 1.5 Recent enforcement state (commits)
- `699f8ea` guard P0 observe → `bc1c7b4` v0.2.0 per-category enforce → `ee127c9` regression-pin
  mode resolution (127-line guard.test.js). Current enforce surface: untagged dispatch + edit/write
  allowlist; mutating bash observe-only.

## 2. Gap analysis (ranked by leverage)

| # | Gap | Evidence | Leverage |
|---|-----|----------|----------|
| G1 | **Extension lifecycle/restart is unmanaged**: `/reload` does not reliably swap module code in long-lived processes; mode/config env vars read once at load (`coord-guard-x1/result.md:22`); full restart needed; continuity = tmux watcher hacks; no pre-restart handoff of in-flight dispatches. *(reload failure proven 2026-11-13 log-forensics, user-reported)* | coord-guard result; packages/configs | Highest — blocks every extension iteration; one bad restart orphans all in-flight subagents |
| G2 | **Memory distillation is designed, not built**: only compaction observations + 3 concepts are indexed; no atom layer (`kind: atom` matches nothing), no consolidation, no profile layer; harvest obligation (AGENT-ORG §5.1) is convention, never verified | sa52 §3; memory-index README; concepts/ count | Highest long-term — the compounding thesis (§1 of ARCHITECTURE) is unrealized without it |
| G3 | **Self-improvement loop is MC-locked**: closed_loop.py lives inside one ops dir; ledger→proposer→A/B→gate→apply not reusable by other projects | closed_loop.py path; PROJECT-SPACE-STANDARD §1 example | High — converts a proven competitive advantage into platform |
| G4 | **No org-wide cost/budget surface**: usage-log is per-session/per-day; web bridge attributes sessions to projects but shows no token/cost rollup per project; budget owner (user) sees no number | pi-usage-log README; bridge src | High — scaling spawn autonomy without a cost surface is ungovernable |
| G5 | **Enforcement is partial**: mutating bash observe-only; project-space routing = prompt+reminder; work-record compliance never mechanically checked | bc1c7b4/ee127c9; 070c7c8 | Medium — guardrails must grow with autonomy (G4) |
| G6 | **Model routing is manual**: single local GLM vLLM is the shared bottleneck (16 seq slots, LRU eviction — *user-reported*; `models/` holds only schema/example yaml); cloud fallback exists but selection is ad hoc; coordinator has no model-aware scheduling | models/ dir; coordinator README (no routing) | Medium — throughput ceiling for all projects |
| G7 | **Interface set narrow**: Telegram bridge, web bridge, Feishu group only; no email/voice; critical-alert push depends on whoever is watching | global AGENTS.md Feishu section | Lower — add when autonomy (Theme D) warrants a pager |
| G8 | **Dormant/deferred structure**: `graph.json` not retrofitted to projects (v2); harness2 idle since 11-04; most profile skill stubs are stub-level (ARCHITECTURE §6) | .gitignore harness2 rules; ARCHITECTURE | Lower — retrofit when consumers exist |

## 3. Expansion themes

### Theme A — Runtime reliability & extension lifecycle (G1)
Goal: extension iteration and restarts become routine, evidence-first operations with zero lost work.
- **A1 (P0, S) Restart runbook + handoff ledger.** Formalize the tmux-watcher restart procedure as a
  ≤120-line runbook (PROJECT-SPACE-STANDARD §4); add `tools/restart_handoff.py`: before any restart,
  dump `subagent_list` + brief pointers to `.pi/subagents/<id>/HANDOFF.md`. Acceptance: kill -9 in a
  fixture session → post-restart reconciliation finds every in-flight id and its brief; runbook
  executes start-to-finish by an operator subagent with no live context.
- **A2 (P0, S) Extension activation contract.** One table (docs/ or per-package README section):
  per package — config source, env vars read at load, what `/reload` swaps vs requires restart.
  Acceptance: table verified against each package's `index.ts` load path; wrong rows fail a grep test.
- **A3 (P1, M) Reload safety guard.** New pi-coordinator-guard category: `/reload` while
  `subagent_list` non-empty → observe mode first, enforce after log review. Acceptance: fixture test
  in observe mode logs `would_deny`; enforce flip is a user decision (§7).
- **A4 (P2, M) Coordinator-session continuity.** Extend pi-project-coordinator crash-recovery
  semantics to coordinator restarts: journal rows reconcile mutating tasks after A1 handoff.
  Acceptance: simulated restart mid-task → task marked `completed-unverified`, never auto-replayed.
Dependencies: none. A3/A4 depend on A1's handoff ledger existing.

### Theme B — Memory distillation productionization (G2; execute sa52 P1 as designed)
Goal: the verified-lesson pipeline runs automatically; every dispatch makes the next cheaper.
- **B1 (P0, M) `memory-distiller` extension (sa52 P1a).** Atom extraction on `session_shutdown` +
  idle-debounce; watermarked JSONL deltas; provider-neutral LLM via modelRegistry; atoms →
  `knowledge-base/atoms/<project>/<date>.jsonl` (append-only) with `source_entry_ids` provenance.
  Acceptance (from sa52): atoms dedup, `source_entry_ids` resolvable via `recall()`; `/distill
  --dry-run` writes nothing; kill mid-run leaves no partial concept writes.
- **B2 (P0, S) Index atoms (un-stub `kind: atom`).** memory-index reads `atoms/*.jsonl`; credential
  screen applies. Acceptance: `memory_search` returns a fixture atom with `kind: atom`.
- **B3 (P1, M) L2 consolidation with pressure rules.** UPDATE-default, per-project concept cap ~15
  with forced merge of lowest-heat, heat counters; candidates land `scope: pending`,
  `approval: unreviewed` — the human gate is preserved exactly; `compile_kb.py` lints new fields.
  Acceptance: no concept ever auto-promotes to global (fail-closed test exists).
- **B4 (P1, S) L3 generated profile.** `knowledge/profile.md` ≤2KB, threshold-triggered refresh,
  injected as `before_agent_start` section (never forceSystemPrompt). Acceptance: regenerates only
  at threshold; size budget enforced by lint.
- **B5 (P1, S) Harvest verification.** `tools/harvest_check.py`: cross-reference week's `work/`
  RECORDs against `records/experience.md` appends; report unharvested engagements. Acceptance:
  catches a seeded missing-harvest fixture; advisory only (no blocking).
- **B6 (P2, S) Semantic retrieval** — only if FTS recall quality measurably demands it (sa52
  explicit NOT-build). Gate: recall@5 comparison on a 50-query fixture shows a measurable deficit.
Dependencies: B1→B2→B3→B4 in order; B5 independent; none depend on Theme A but extension reloads
during B1 dev will hurt without A1 (do A1 first in practice).

### Theme C — Self-improving feedback engine as a platform (G3)
Goal: any project with a scorer can run the MC-proven loop; MC becomes the first consumer, not the owner.
- **C1 (P0, M) Extract generic RSI loop.** New package `packages/pi-rsi-loop` (or `tools/rsi/`):
  ledger → LLM proposer → A/B experiment runner → gate → apply, with the scorer/gate as a config
  interface. MC keeps its instance; MC's closed_loop.py becomes the reference adapter.
  Acceptance: package tests cover one full dry-run iteration on a toy ledger+scorer; MC behavior
  unchanged (its smoke dispatch still passes).
- **C2 (P0, S) Adapter contract + second consumer.** `ADAPTER.md`: what a project must provide
  (error-ledger source, scorer, gate criteria, apply authorization). Acceptance: one non-MC project
  (e.g. english or notion-ops) completes a single loop iteration in dry-run against a toy scorer.
- **C3 (P1, M) Evidence auto-plumbing.** Applied loop changes append `daily/` KB entries + work
  RECORDs with run-id evidence pointers automatically. Acceptance: a loop run produces a RECORD
  whose every number resolves to a cited source (PROJECT-SPACE-STANDARD §6 bar).
- **C4 (P2, L) Curriculum layer.** Auto-generate next experiments from the failure taxonomy.
  Acceptance: proposals-only output; never self-applies (AGENT-ORG §7 self-acceptance ban).
Dependencies: C1→C2→C3; independent of A/B.

### Theme D — Org autonomy with guardrails + cost surface (G4, G5, G6, G7)
Goal: autonomy scales because the user sees cost and guardrails tighten mechanically, not rhetorically.
- **D1 (P0, S) Per-project cost rollup.** Extend pi-usage-log + pi-web-bridge: aggregate
  token/cost by project (reuse bridge attribution rules: registry + session-name/task-marker
  attribution; `personal-ops`/`unattributed` buckets stay explicit). Acceptance: `/projects` panel
  shows last-7-day per-project tokens+cost; numbers reconcile with usage JSONL totals.
- **D2 (P0, S) Budget visibility in journal.** pi-project-coordinator journal rows carry
  budget-planned/spent per task envelope. Acceptance: fixture dispatch produces rows with both fields.
- **D3 (P1, M) Enforce-mode expansion (two user gates).** (a) mutating bash: observe → enforce after
  reviewing the coordinator-guard log for false positives; (b) work-record compliance linter over
  `work/` RECORDs (required fields + status vocabulary). Acceptance: (a) is a user decision recorded
  as an ADR; (b) linter flags a nonconforming fixture RECORD.
- **D4 (P1, M) Declarative model routing.** Routing table in coordinator config (task class →
  model/fallback), logged per dispatch; no silent provider switch (global AGENTS.md discipline).
  Acceptance: routing decision appears in journal; fallback fires only when primary is unavailable.
- **D5 (P2, S) Unified critical-alert notify.** Severity-graded notify over existing Telegram +
  Feishu channels for gate failures, two-strike escalations, restart events. Acceptance: test alert
  arrives on both channels; no new channels.
- **D6 (P2, L) graph.json retrofit + web graph consumers.** v2-deferred items, sequenced after
  several projects have work/ records worth graphing. Acceptance: two projects retrofitted add-only.
Dependencies: D1/D2 independent; D3 gates on D1 (cost view must exist before stricter enforcement);
D4 independent; D5 after D3 enforcement events exist to notify about.

## 4. Recommended first 2 weeks

**Week 1 — stop losing work, make cost visible:**
1. A1 restart runbook + handoff ledger (S) — unblocks all extension dev.
2. A2 extension activation contract (S).
3. D1 per-project cost rollup (S) — user sees the first real number.
4. B2 atom indexing in memory-index (S) — small, independent.
5. C1 generic RSI loop extraction, MC as first adapter (M, background).

**Week 2 — turn on the distiller, prototype the loop:**
6. B1 memory-distiller L1 atom extraction (M).
7. C2 adapter contract + one toy second-consumer iteration in dry-run (S).
8. A3 reload safety guard in observe mode (M).
9. B5 harvest checker (S).
10. D3(a) review coordinator-guard observe log with the user → enforce decision (user gate, no code).

**Deliberately NOT building yet:** embeddings/semantic retrieval (B6 gate not met), sa52 P2 canvas
(skip verdict stands), graph.json retrofit (D6), email/voice interfaces, resident daemons or
scheduled wake-ups (AGENT-ORG §7 anti-pattern 2), auto-approval of any KB concept, new
individuals/profiles, harness2 revival, subproject graduations.

## 5. Non-goals (standing)
- No weakening of KB scope gates, UP-CHECK, or acceptance criteria to ship faster.
- No silent provider/model switches; model discipline stays inherit-unless-authorized.
- No autonomous spending, installs, remote operations, or publication (delegation does not
  expand authorization).
- No memory of secrets in any tier; credential screens stay fail-closed.

## 6. Effort summary

| Theme | P0 | P1 | P2 |
|---|---|---|---|
| A runtime reliability | A1 S, A2 S | A3 M | A4 M |
| B memory distillation | B1 M, B2 S | B3 M, B4 S, B5 S | B6 S (gated) |
| C RSI platform | C1 M, C2 S | C3 M | C4 L |
| D org autonomy | D1 S, D2 S | D3 M, D4 M | D5 S, D6 L |

## 7. User decisions required (blocking items)

1. **Mutating-bash enforcement flip** (D3a): review `~/.pi/agent/logs/coordinator-guard.jsonl`
   observe log; approve enforce or keep observe.
2. **Compute spend & routing posture** (G6/D4): keep single local GLM vLLM as default with manual
   escalation, or authorize a declarative routing table with cloud fallback rules (and any budget cap).
3. **KB auto-distillation authorization** (Theme B): approve atoms/ as a new KB write path written
   by an extension (LLM-generated content) — it bypasses the "primary appends daily/" convention
   while preserving the human concept gate; also approves `!/work/` whitelist addition in .gitignore
   (done in this record's commit for PLAN.md itself).
