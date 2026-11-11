# ROSTER — individuals as speciation paths (v2)

> 2026-11-11, user ruling (supersedes v1 numbering): no numbered individuals. An
> individual id is a **hierarchical speciation path** `<profile>[.<spec>[.<subspec>…]]`
> (e.g. `coder.infra`, `coder.algorithm.distributed-training`) — the name records the
> differentiation lineage (一层一层的分化); deepening the path = the individual
> speciating into a niche. Three-layer identity: **PROFILE** (the first path segment —
> job description: skills standard, dispatch authority, the role card) → **INDIVIDUAL**
> (a speciation path + personal experience file, this registry) → **INSTANCE** (an
> individual's engagement on a project — `role-<individual-path>@<project>[.<subproject>]`,
> AGENT-ORG.md §5.1). Hiring gate unchanged: entries are added only by user approval —
> the coordinator invokes, it never creates.

## Format

Individuals are declared as compact entries per profile in this file — the registry
is the roster; personal experience lives in the profile's records dir as `<path>.md`:

```
coder.infra {level: senior, notes: persistence/infra debugging;
             memory: agents/coder/records/coder.infra.md}
```

- **Stub chain**: every path segment after the first must have a spec stub in the
  profile's skills dir — `skills/<segment>.md` (so `coder.infra.recovery` requires
  `skills/infra.md` AND `skills/recovery.md`). Deepening the path requires the stub
  chain to exist first; a stub is the minimum bar for the specialization, promoted
  into full methodology as verified lessons accumulate.
- **Personal memory**: `instructions/agents/<profile>/records/<path>.md` — append-only,
  verified-results-only, dated, source-pointed, no project-private data, no secrets —
  the same rules as the profile-level `experience.md`. The coordinator layer appends
  after filesystem verification; instances propose lessons in their consolidated
  report (AGENT-ORG.md §6).
- **Speciation rule (deepening)**: when an individual differentiates deeper (e.g.
  `coder.infra` → `coder.infra.recovery`), the PARENT remains — its append-only memory
  is untouched. The CHILD's memory file starts with a dated charter line
  `differentiated from <parent>, inherited focus: …` plus evidence pointers to the
  relevant parent entries — never a copy of the whole file.
- **What applies automatically**: the profile's AGENTS.md card + the stubs for every
  path segment + the personal memory file are the standing brief (AGENT-ORG.md §5.1).
  The individual changes WHO learns, never WHAT is authorized.

## Seeded individuals (real history — evidence verified in records/ + KB)

Do NOT invent more now; seeding is evidence-driven (see hiring rule). History: the v1
numbered ids (`coder-1`, `operator-1`, `reviewer-1`) were renamed to speciation paths
on 2026-11-11 — same accumulated memory (each memory file's charter line records it).

```
coder.infra          {level: senior,
                      notes: MC RSI physics-stall forensics (watchdog escalation
                      chain, payload-identity infra-flake class) + wave infra
                      fixes (mutation wrapping, multi-layer validation);
                      memory: agents/coder/records/coder.infra.md}
operator.episodes    {level: senior,
                      notes: MC RSI operator chains — reset/launch/supervise
                      (mc-episode-ops origin), two-strikes
                      evidence-bundle-then-stop, zombie-writer containment;
                      memory: agents/operator/records/operator.episodes.md}
reviewer.correctness {level: senior,
                      notes: subagent-fabrication controls (fabricated-field
                      checks via contract source, receipt validation audits),
                      trust-boundary enforcement, regression-assertion
                      restoration;
                      memory: agents/reviewer/records/reviewer.correctness.md}
```

Evidence pointers (verified 2026-11-11):

- **coder.infra**: `instructions/agents/coder/records/experience.md` (2026-11-09
  physics-stall entries; 2026-11-02 infra entries) ←
  `remote-agent/operations/20261029-minimal-sword-episode/H7-physics-stall-evidence.json`;
  `knowledge-base/daily/2026-11-09.md`.
- **operator.episodes**: `instructions/agents/operator/records/experience.md`
  (creation entry naming mc-episode-ops; 2026-11-09 two-strikes + WPS zombie-writer
  entries) ← same H7 evidence file. *(Inference, marked as such: "episodes" spec
  generalizes from the Minecraft record; the WPS sheet work shows range beyond MC.)*
- **reviewer.correctness**: `instructions/agents/reviewer/records/experience.md`
  (2026-11-02 fabricated-field / trust-boundary / regression-assertion entries);
  `knowledge-base/daily/2026-11-03.md`, `2026-11-04.md`, `2026-11-06.md`,
  `2026-11-08.md` (fabrication/receipt incident threads).

## Hiring rule

A new individual path (a first spec segment, or a deeper speciation) is created when
the **niche recurs: ≥3 dispatches wanting it** (counted from work records'
`Dispatched-by`/`Worker` fields); a deeper path additionally follows the speciation
rule above. Individual creation is cheap — one registry line + a memory file seeded
with its charter; **memory is the asset**. Do not pre-create "for balance"; an
individual without verified results has no memory and is just a name.

## Naming and dispatch

- **Generic profile dispatch (no individual): `role-<profile>@<project>` — NO dot** in
  the individual slot (e.g. `role-coder@minecraft`). **Any dot in the individual slot
  means an individual path**: `role-coder.infra@minecraft` is the individual
  `coder.infra`; `role-coder.infra.recovery@minecraft` the deeper path. Instance =
  `role-<individual-path>@<project>[.<subproject>]` (e.g.
  `role-coder.infra@minecraft.furnace`).
- The router derives the full id mechanically (profile → individual roster → project,
  in-flight set) — never a user question.
- **BoN**: candidates may be **different individuals deliberately** (e.g. `coder.infra`
  + `coder.frontend` + a generic coder) — diversity of accumulated memory beats N
  identical clones; the parent still ranks on the fixed acceptance criteria.
- Crew entries (project README / subproject charter, `PROJECT-SPACE-STANDARD.md` §10)
  may name individuals; the graph model carries `individual` nodes (`GRAPH-SCHEMA.md`).
