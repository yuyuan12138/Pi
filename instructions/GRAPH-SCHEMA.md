# GRAPH-SCHEMA — the normative org + project graph (v1.1)

> 2026-11-11, user directive. The machine-readable graph is the single source of
> truth for org + project structure; `AGENT-ORG.md` prose and web views are
> projections of it. v1.1 (2026-11-11, user ruling): the subproject NODE KIND is
> abolished — everything nested under a project IS a project; recursion is
> expressed by structure (`child_of`), not by a distinct category. v1.1 is
> convention-only (zero engine changes): every project space holds
> `<project-root>/graph.json`, versioned in git.

## Model

Nodes — every node carries `id` plus file pointers, so the graph is navigable to
evidence (charter, records, transcripts):

| Node | Fields | Evidence pointer |
|---|---|---|
| project | id (dotted paths like `minecraft.furnace-campaign.fuel` are plain project ids), root?, charter_path, parent (project \| null), graduation_reason?, status (active \| archived) | `charter_path` → project README (any depth under `subprojects/`) |
| profile | name, group, specializations[] | `instructions/agents/<name>/` |
| individual | id (speciation path `<profile>[.<spec>…]`), profile_ref, specializations[], level, memory_path | `memory_path` → `instructions/agents/<profile>/records/<path>.md` (ROSTER.md) |
| instance | id (`role-<individual>[.<spec>]@<project>[.<sub>…]`), session_ref, status (idle \| running \| retired) | `.pi/subagents/<id>/` |
| work | id, title, record_path, outcome | `record_path` → `work/.../RECORD.md` |

Edges:

| Edge | From → To | Meaning |
|---|---|---|
| child_of | project → project | containment (tree, any depth, single parent, cycle-free); graduation created a durable branch |
| crew_of | instance \| individual → project | membership in the innermost containing project (the durable Crew section) |
| dispatch | instance \| individual → work | this agent executed this task |
| graduated_from | work → project | the record whose growth triggered graduation |
| individual_of | individual → profile | this individual (speciation path) holds this profile (ROSTER.md) |
| reports_to | instance → instance | the live UP-CHECK edge (parent of the moment) |

> Containment rule: `child_of` forms a tree rooted at the top-level project —
> any depth allowed, cycles forbidden (a nested project has at most one parent).
> `crew_of`/`dispatch` attach to their innermost containing project, falling up
> to the root project when no nested project applies.

## Example — `graph.json` (minecraft, 3-level nested projects)

```json
{
  "version": 1,
  "project": { "id": "minecraft", "root": "~/projects/minecraft",
               "charter_path": "README.md", "status": "active" },
  "nodes": [
    { "type": "project", "id": "minecraft.furnace-campaign", "parent": "minecraft",
      "graduation_reason": "needs own ADRs; spans 3 work sessions", "status": "active",
      "charter_path": "subprojects/furnace-campaign/README.md" },
    { "type": "project", "id": "minecraft.furnace-campaign.fuel",
      "parent": "minecraft.furnace-campaign", "graduation_reason": "own ADRs for fuel-mixing rules",
      "status": "active", "charter_path": "subprojects/furnace-campaign/subprojects/fuel/README.md" },
    { "type": "profile", "id": "coder", "group": "build/run", "specializations": ["engine", "frontend"] },
    { "type": "individual", "id": "coder.infra", "profile_ref": "coder",
      "specializations": ["infra"], "level": "senior",
      "memory_path": "instructions/agents/coder/records/coder.infra.md" },
    { "type": "instance", "id": "role-coder.engine@minecraft.furnace-campaign",
      "session_ref": "role-coder.engine@minecraft.furnace-campaign", "status": "running" },
    { "type": "instance", "id": "role-coder@minecraft.furnace-campaign.fuel",
      "session_ref": "role-coder@minecraft.furnace-campaign.fuel", "status": "idle" },
    { "type": "instance", "id": "role-scout@minecraft.furnace-campaign",
      "session_ref": "role-scout@minecraft.furnace-campaign", "status": "idle" },
    { "type": "work", "id": "furnace-run-17", "title": "collector-green furnace run",
      "record_path": "subprojects/furnace-campaign/work/2026-11-11-run17/RECORD.md", "outcome": "delivered" }
  ],
  "edges": [
    { "rel": "child_of", "from": "minecraft.furnace-campaign", "to": "minecraft" },
    { "rel": "child_of", "from": "minecraft.furnace-campaign.fuel", "to": "minecraft.furnace-campaign" },
    { "rel": "crew_of", "from": "role-coder.engine@minecraft.furnace-campaign", "to": "minecraft.furnace-campaign" },
    { "rel": "crew_of", "from": "role-coder@minecraft.furnace-campaign.fuel", "to": "minecraft.furnace-campaign.fuel" },
    { "rel": "individual_of", "from": "coder.infra", "to": "coder" },
    { "rel": "dispatch", "from": "coder.infra", "to": "furnace-run-17" },
    { "rel": "crew_of", "from": "role-scout@minecraft.furnace-campaign", "to": "minecraft.furnace-campaign" },
    { "rel": "reports_to", "from": "role-coder.engine@minecraft.furnace-campaign", "to": "role-scout@minecraft.furnace-campaign" },
    { "rel": "dispatch", "from": "role-coder.engine@minecraft.furnace-campaign", "to": "furnace-run-17" },
    { "rel": "graduated_from", "from": "furnace-run-17", "to": "minecraft.furnace-campaign" }
  ]
}
```

## Convention

- **Where**: `graph.json` at each project root, versioned in git next to its README.
- **When updated**: with work records — dispatch, completion, graduation, archive
  (the closing dispatch updates it; Principle 3 of `PROJECT-SPACE-STANDARD.md`).
- **Consumers (v2, deferred)**: web `/projects` + org-graph pages read `graph.json`;
  the coordinator journal stays the live/ephemeral complement (per-instance events).
- **Rollout**: new projects from day one; retrofitting existing projects is deferred
  to the rollout step, deliberately not done in v1.
