# ROSTER — numbered individuals (v1)

> 2026-11-11, user directive. Profiles are not limited to fixed cards: there can be
> **numbered individuals** (`coder-1`, `coder-2`, …), each with their own
> specialization mix and their own accumulated experience. Three-layer identity:
> **PROFILE** (job description — skills standard, dispatch authority, the role card)
> → **INDIVIDUAL** (a person — spec mix + personal experience file, this registry)
> → **INSTANCE** (an individual's engagement on a project —
> `role-<individual>@<project>[.<subproject>]`, §5.1 of AGENT-ORG.md).
> Hiring gate: entries are added only by user approval — the coordinator invokes, it never creates.

## Format

Individuals are declared as compact entries per profile in this file — the registry
is the roster; personal experience lives in the profile's records dir as `<id>.md`:

```
coder-1 {spec: infra, level: senior, notes: persistence/infra debugging;
         memory: agents/coder/records/coder-1.md}
```

- **Personal memory**: `instructions/agents/<profile>/records/<id>.md` — append-only,
  verified-results-only, dated, source-pointed, no project-private data, no secrets —
  the same rules as the profile-level `experience.md`. The coordinator layer appends
  after filesystem verification; instances propose lessons in their consolidated
  report (AGENT-ORG.md §6). A new individual starts with an empty memory file plus a
  one-line charter copied from its seeding evidence.
- **What applies automatically**: the profile's AGENTS.md card + the named spec stub
  (`skills/<spec>.md`) + the personal memory file are the standing brief (AGENT-ORG.md
  §5.1). The individual changes WHO learns, never WHAT is authorized.

## Seeded individuals (real history — evidence verified in records/ + KB)

Do NOT invent more now; seeding is evidence-driven (see hiring rule).

```
coder-1    {spec: infra, level: senior,
            notes: MC RSI physics-stall forensics (watchdog escalation chain,
            payload-identity infra-flake class) + wave infra fixes (mutation
            wrapping, multi-layer validation);
            memory: agents/coder/records/coder-1.md}
operator-1 {spec: episodes, level: senior,
            notes: MC RSI operator chains — reset/launch/supervise (mc-episode-ops
            origin), two-strikes evidence-bundle-then-stop, zombie-writer containment;
            memory: agents/operator/records/operator-1.md}
reviewer-1 {spec: correctness, level: senior,
            notes: subagent-fabrication controls (fabricated-field checks via contract
            source, receipt validation audits), trust-boundary enforcement,
            regression-assertion restoration;
            memory: agents/reviewer/records/reviewer-1.md}
writer-1   {spec: docs/charter, level: senior,
            notes: project-space scaffolder — 8 dispatches 2026-11-11 (7
            PROJECT-SPACE-STANDARD builds + minecraft retrofit), one brief shape;
            memory: agents/writer/records/writer-1.md}
designer-1 {spec: org/systems design, level: senior,
            notes: AGENT-ORG/graph design thread — 7 revisions 2026-11-11 (org model,
            memory tiers, subprojects, GRAPH-SCHEMA, this roster); session agent-org-x1;
            memory: agents/designer/records/designer-1.md}
coder-2    {spec: frontend, level: senior,
            notes: mission-control UI — bridge Projects panel + #/org graph page +
            user feedback rounds (whole-tree visibility, vertical layout, project
            views); session bridge-org-x1;
            memory: agents/coder/records/coder-2.md}
```

Evidence pointers (verified 2026-11-11):

- **coder-1**: `instructions/agents/coder/records/experience.md` (2026-11-09
  physics-stall entries; 2026-11-02 infra entries) ←
  `remote-agent/operations/20261029-minimal-sword-episode/H7-physics-stall-evidence.json`;
  `knowledge-base/daily/2026-11-09.md`.
- **operator-1**: `instructions/agents/operator/records/experience.md` (creation
  entry naming mc-episode-ops; 2026-11-09 two-strikes + WPS zombie-writer entries) ←
  same H7 evidence file. *(Inference, marked as such: "episodes" spec generalizes
  from the Minecraft record; the WPS sheet work shows range beyond MC.)*
- **reviewer-1**: `instructions/agents/reviewer/records/experience.md` (2026-11-02
  fabricated-field / trust-boundary / regression-assertion entries);
  `knowledge-base/daily/2026-11-03.md`, `2026-11-04.md`, `2026-11-06.md`,
  `2026-11-08.md` (fabrication/receipt incident threads).
- **writer-1**: `instructions/CREW-MANIFEST-2026-11-11.md` (scaffolding-wave rows,
  sa2 + sa4–sa10) ← `.pi/subagents/sa{2,4..10}/events.jsonl` briefs; deliverables:
  project README/docs/work trees in six project spaces + the minecraft ops dir.
- **designer-1**: same manifest (org-wave rows, sa12/14b/15b/17/18/20/21);
  deliverables: `instructions/AGENT-ORG.md`, `instructions/GRAPH-SCHEMA.md`,
  this roster v1.
- **coder-2**: same manifest (bridge rows, sa16 ×2 + sa1/sa2 UI feedback rounds);
  deliverables: `packages/pi-web-bridge` commits 3386629, 3aa55b2, e482784
  (projects panel, org graph views, project hierarchy).

## Hiring rule

A new individual is created when a **niche recurs: ≥3 dispatches wanting the same
spec mix** (counted from work records' `Dispatched-by`/`Worker` fields). Individual
creation is cheap — one registry line + an empty memory file; **memory is the
asset**. Do not pre-create "for balance"; an individual without verified results has
no memory and is just a name.

## Naming and dispatch

- Instance id extends to `role-<individual>@<project>[.<subproject>]` where
  `<individual> = <profile>-<n>` (e.g. `role-coder-1@minecraft.furnace`); spec
  segment composes as before (`role-coder-1.infra@minecraft`). Generic
  profile-level dispatches (no individual needed) keep `role-<profile>@…`.
- The router derives the full id mechanically (profile → individual roster →
  project, in-flight set) — never a user question.
- **BoN**: candidates may be **different individuals deliberately** (e.g.
  `coder-1` + `coder-2` + a generic coder) — diversity of accumulated memory beats
  N identical clones; the parent still ranks on the fixed acceptance criteria.
- Crew entries (project README / subproject charter, `PROJECT-SPACE-STANDARD.md`
  §10) may name individuals; the graph model carries `individual` nodes
  (`GRAPH-SCHEMA.md`).
