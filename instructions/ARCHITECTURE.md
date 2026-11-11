# ARCHITECTURE — the current agent architecture

> Snapshot 2026-11-11. Audience: the owner (English per the agent-authored-doc rule;
> structured for later translation). This is an overview projection, not authority —
> the live sources own the truth: `AGENT-ORG.md` v1.4 (constitution), `ROSTER.md`,
> `GRAPH-SCHEMA.md` v1.1, `PROJECT-SPACE-STANDARD.md`, `packages/pi-superagent`,
> `packages/pi-web-bridge`, `knowledge-base/AGENTS.md`, `packages/pi-delegation-reminder`.
> Anything not verifiable on disk is marked **observed-only** or **deferred**.

## 1. Thesis

There is exactly **one agent type**. Every node — the coordinator entry point and every
spawned worker alike — runs the same first-principles rule (AGENT-ORG §2): restate the
goal, then **decompose-or-execute**. Thirteen **expertise profiles** (skills + standards +
tool allowlist — never authority) and numbered **individuals** (memory-carrying persons)
attach at any node; the org chart is not a structure but the shape one requirement's
recursion happens to take. Depth is decided per node by the decomposition test; the only
bound is the per-agent spawn budget. Capability **compounds through memory**: resumable
sessions, append-only experience ledgers, and a scope-gated knowledge base make each
verified dispatch make the next one cheaper.

## 2. Layers

```
┌────────────────────────────────────────────────────────────────────────┐
│ USER — requirements · final acceptance · hiring gate · budget owner     │
└───────────────┬────────────────────────────────────────────────────────┘
                ▼
┌────────────────────────────────────────────────────────────────────────┐
│ COORDINATOR (fixed entry) — restates · decomposes · budgets ·           │
│ verifies against the filesystem · UP-CHECK pushback · escalates         │
└────────┬───────────────────────────────────────┬───────────────────────┘
         ▼ subagent (coordinator's own project)  ▼ project pipeline
┌────────────────────────────┐    ┌──────────────────────────────────────┐
│ ROLE INSTANCE              │    │ pi-project-coordinator → PROJECT     │
│ role-<ind>[.<spec>]@<proj> │◄───┤ PRIMARY — same node rules, project   │
│ resumable session; may     │    │ CWD; deliverables land in the        │
│ spawn children             │    │ project space (registered roots only)│
└────────┬───────────────────┘    └──────────────────────────────────────┘
         ▼ spawns children (same rule; depth per node, budget-bounded)
┌────────────────────────────────────────────────────────────────────────┐
│ WORKER NODES — fresh one-shot or resumable children; ANY node may      │
│ spawn until its PI_SPAWN_BUDGET (default 3; fanout N = N) is spent.    │
│ A worker engagement closes ONLY with a memory harvest (§6).            │
└────────────────────────────────────────────────────────────────────────┘
```

Cross-project invocation pattern: **project → agent → project → agent → …** — an agent
working project A spawns a child whose CWD is project B (repo facts, sibling tools), the
child reports back up, and the chain continues in A. Two things carry the chain across
hops: (1) **lineage records** — the manager passes `PI_SPAWN_DEPTH` + the spawned-by
chain; ids/depths land in `.pi/subagents/<id>/`, work RECORDs, and the bridge's
invocation tree; (2) **harvested memory** — verified lessons enter the profile/individual
ledgers, so the next engagement inherits them.

## 3. Identity

| Layer | Id convention | What it is | Reusability semantics |
|---|---|---|---|
| Profile | 13 names (`coder`, `scout`, `reviewer`, …) | job description: role card + `skills/<spec>.md` stubs + dispatch-authority section | defines skills/standards, never authority; invoked on every dispatch |
| Individual | speciation path `<profile>[.<spec>…]` (seeded: `coder.infra`, `operator.episodes`, `reviewer.correctness`) | a differentiation lineage: spec chain + level + personal memory file (`records/<path>.md`) | persists; deepening = speciating into a niche (parent memory stays intact); created only via the hiring gate |
| Instance | `role-<ind-path>@<project>[.<sub>…]` | one engagement on one project — a resumable session (`subagent_spawn`, `session` arg) | spawned on demand, idle after reporting, never resident; one active task per id; same role + different projects = separate instances; concurrent same-project = `-2`, `-3` suffixes |
| Worker | fresh, no session id | one-shot child spawned by any node; never resumed or reused | its value is harvested into the ledger on verified completion (§6) |

The router derives every id mechanically (profile × individual roster × project ×
in-flight set) — never a user question.

## 4. Dispatch protocol

- **Decomposition test (§2)** at every node: sub-goals independently verifiable AND
  disjointly owned AND budget favors delegation → decompose; otherwise execute. A node
  that cannot restate the goal escalates (`blocked` + one concrete question).
- **Acceptance-first briefs**: first line is the identity header
  `[project:<name>[.<subproject>]]` echoed verbatim; boundaries and acceptance criteria
  are fixed before dispatch, identical for all best-of-N candidates, never weakened.
- **UP-CHECK loop** at every edge: child self-checks with evidence → reports up → parent
  re-verifies against real evidence (runs tests, inspects diffs) → pass consolidates one
  level up; fail pushes back **with a written diagnosis**; prefer steering the live child
  (`subagent_message`) over re-spawning.
- **Two-strike rule**: after 2 failed rework rounds on the same criterion, stop and
  escalate to the human with the evidence bundle.
- **Async by default**: every dispatch is background; no node blocks its turn on a chain;
  a consolidating node returns exactly one `ready` report — verdict, deliverable paths,
  evidence table (child → result → path, transcripts by path only).

## 5. Governance

- **Hiring gate**: new profiles/individuals require user approval; seeding is
  evidence-driven (ROSTER: ≥3 recurring dispatches wanting the same spec mix; an
  individual without verified results is just a name).
- **Authority always returns up**: nodes are proposal-only on acceptance, scope, budget,
  authorization; the coordinator verifies the filesystem; the user is final.
- **Vetoed / reverted precedents** (kept on disk as history, never deleted):
  - Fixed-layer org design — AGENT-ORG v1.0/v1.1 assigned dispatch rights by tier;
    reverted to per-node decomposition judgment (§7 anti-pattern 5).
  - Subproject node kind — GRAPH-SCHEMA v1.0 had a distinct `subproject` node;
    v1.1 abolished it: nested projects are plain projects, recursion via `child_of`.
  - Point-in-time status files — `CURRENT.md`/`VISION-STATUS.md` rotted against the
    README; status now lives only in the README table (PROJECT-SPACE-STANDARD §7).
- **Invariants nothing may modify**: the docs layer never edits engine/runtime state;
  work RECORDs and ADR logs are append-only; acceptance criteria are never weakened to
  pass; memory scope gates are fail-closed; `graph.json` is updated at record moments.

## 6. Memory architecture

Three tiers, deliberately separate (AGENT-ORG §6):

| Tier | Scope | Where | Writer |
|---|---|---|---|
| 1a — session | one instance | resumable `role-…` session | the agent (ephemeral; dies with retirement) |
| 1b — role/individual ledger | one profile or individual | `instructions/agents/<role>/records/[<id>.]md` — dated, append-only, verified-results-only, in git | coordinator entry appends after filesystem verification; nodes propose |
| 2 — project | one project root | the project space itself (README, ADRs, runbooks, postmortems, `work/`) + private coordinator registry/journal | executing nodes write RECORDs; project primary maintains docs |
| 3 — global | all projects | `knowledge-base/` (`daily/`, `knowledge/concepts/`, `wiki/`) | primary appends `daily/`; concept promotion gated (below) |

- **Contamination control**: a lesson from project A never surfaces in project B except
  through the KB scope gate — `scope: global` requires evidence from **≥ 2 distinct
  projects** AND **`approval: user-approved`**, enforced fail-closed (exit 1) by
  `knowledge-base/scripts/compile_kb.py` (verified in AGENTS.md + script).
- **Episodic vs procedural**: `records/experience.md` = the episodic ledger (what
  happened, evidence-linked, dated); `skills/<spec>.md` = distilled procedures (how-to,
  future-facing) that a spec stub accumulates as verified lessons repeat. Today most
  profiles hold stub-level spec files; full distillation is an ongoing practice.
- **Harvest obligation**: closing a worker engagement without appending its transferable
  lessons to the ledger is an incomplete UP-CHECK closure — memory harvest is mandatory.
- Cross-session FTS retrieval (`memory_search`, "pi-memory-index"): referenced by
  AGENT-ORG §6 but **not present under `packages/`** — observed-only; the verified FTS5
  layer is the optional `knowledge-base/scripts/kb.py` search over distilled memory.

## 7. Project spaces

Standard layout (PROJECT-SPACE-STANDARD): `README.md` (charter + status table + map +
Crew) · `graph.json` (normative structure) · `docs/` (architecture, ADR log, runbooks,
postmortems) · `work/` (one append-only RECORD per dispatch). Principles: docs describe,
live files own; no invented facts (every claim cites a source); docs updated in the same
dispatch that changes the system; hard length budgets; retrofit is add-only. Dispatch
acceptance requires the diff to carry both the working change AND its doc updates.
**Nested projects**: a branch needing its own ADRs or spanning multiple sessions
graduates (one user decision each) — a ≤30-line charter with a Crew section, ids extend
to `role-<ind>@<project>.<sub>`, archive merges lessons UP and marks `done`, nothing
deleted (git history is the audit trail). `child_of` containment forms a tree of any
depth, single parent, cycle-free.

## 8. Observability

- **Org-graph invocation tree** (`pi-web-bridge`): project and agent nodes alternate by
  **real spawn lineage** — every edge is an invocation; a grouped org-chart mode is the
  alternative view. Attribution maps sessions to projects via the registry and token
  rules; anything unattributable lands in an explicit `unattributed` bucket (never
  silently guessed); `personal-ops` is a muted bucket for real deliverables that fit no
  registered project (verified in `src/index.html`).
- **Coordinator journal / `/projects` panel** (`pi-web-bridge/src/projects.ts`): a
  read-only view over `coordinator.db` — registry + append-only journal; each task
  envelope's `projectId` attributes it; per-project activity = newest journal row; any
  read failure degrades to an empty list + note (the UI must never crash the session).
- **Per-project `graph.json`**: the durable, git-versioned structure (§3, §7) whose
  evidence pointers navigate to charters, records, transcripts. Web consumers of the
  graph are **v2-deferred**; today the journal is the live layer, the graph the durable one.
  In one line each: the invocation tree answers "who actually ran what, under which
  project, now"; the journal answers "what is each registered project's latest state";
  `graph.json` answers "what is the durable structure and where is the evidence".

## 9. Deliberate limits

- **The only runaway bound is the budget**: nesting depth is uncapped by design —
  `PI_SPAWN_DEPTH` is lineage/observability only; `PI_SPAWN_BUDGET` (per agent, default
  3, fanout of N = N) is the sole runaway bound, and exhausting it fails with a clear
  error (verified in pi-superagent). Trust rests on briefs + UP-CHECK, not a sandbox;
  the tool_call guard is a denylist safety net, explicitly not a sandbox.
- **Novelty/delegation enforcement is prompt-level**: the rules live in AGENTS.md, role
  cards, and the mechanically re-injected router check (`pi-delegation-reminder`, every
  turn, verified in packages/); `tools/delegation_gate.py` is a workflow validator, not
  a runtime interceptor. Deeper mechanical validation is **deferred**.
- **Attribution residue is honest, not forced**: unattributable or cross-project work
  gathers in the explicit `personal-ops` / `unattributed` buckets rather than being
  misattributed to a plausible project.
- **Deferred work**: `graph.json` retrofit onto existing projects, web consumers of the
  graph, and the coordinator registry tree are rollout/v2 steps — v1/v1.1 is
  convention-only, zero engine changes.
