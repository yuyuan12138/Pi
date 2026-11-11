# GRAPH-SCHEMA — the normative org + project graph (v1)

> 2026-11-11, user directive. The machine-readable graph is the single source of
> truth for org + project structure; `AGENT-ORG.md` prose and web views are
> projections of it. v1 is convention-only (zero engine changes): every project
> space holds `<project-root>/graph.json`, versioned in git.

## Model

Nodes — every node carries `id` plus file pointers, so the graph is navigable to
evidence (charter, records, transcripts):

| Node | Fields | Evidence pointer |
|---|---|---|
| project | id, root, charter_path, status | `charter_path` → project README |
| subproject | id, parent (project \| subproject), graduation_reason, status (active \| archived) | charter under `subprojects/` (any depth) |
| profile | name, group, specializations[] | `instructions/agents/<name>/` |
| individual | id (`<profile>-<n>`), profile_ref, specializations[], level, memory_path | `memory_path` → `instructions/agents/<profile>/records/<id>.md` (ROSTER.md) |
| instance | id (`role-<individual>[.<spec>]@<project>[.<sub>…]`), session_ref, status (idle \| running \| retired) | `.pi/subagents/<id>/` |
| work | id, title, record_path, outcome | `record_path` → `work/.../RECORD.md` |

Edges:

| Edge | From → To | Meaning |
|---|---|---|
| child_of | subproject → project \| subproject | containment; graduation created a durable branch |
| crew_of | instance \| individual → project \| subproject | membership (the durable Crew section) |
| dispatch | instance \| individual → work | this agent executed this task |
| graduated_from | work → subproject | the record whose growth triggered graduation |
| individual_of | individual → profile | this numbered individual holds this profile (ROSTER.md) |
| reports_to | instance → instance | the live UP-CHECK edge (parent of the moment) |

> Containment rule: the subproject containment edge (`child_of`, i.e. subproject_of) forms a
> tree rooted at the project — any depth allowed, cycles forbidden (a subproject has at
> most one parent). `crew_of`/`dispatch` attach to their innermost containing subproject,
> falling up to the project when no subproject applies.

## Example — `graph.json` (minecraft, 3-level subproject tree)

```json
{
  "version": 1,
  "project": { "id": "minecraft", "root": "~/projects/minecraft",
               "charter_path": "README.md", "status": "active" },
  "nodes": [
    { "type": "subproject", "id": "minecraft.furnace-campaign", "parent": "minecraft",
      "graduation_reason": "needs own ADRs; spans 3 work sessions", "status": "active",
      "charter_path": "subprojects/furnace-campaign/README.md" },
    { "type": "subproject", "id": "minecraft.furnace-campaign.fuel",
      "parent": "minecraft.furnace-campaign", "graduation_reason": "own ADRs for fuel-mixing rules",
      "status": "active", "charter_path": "subprojects/furnace-campaign/subprojects/fuel/README.md" },
    { "type": "profile", "id": "coder", "group": "build/run", "specializations": ["engine", "frontend"] },
    { "type": "individual", "id": "coder-1", "profile_ref": "coder",
      "specializations": ["infra"], "level": "senior",
      "memory_path": "instructions/agents/coder/records/coder-1.md" },
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
    { "rel": "individual_of", "from": "coder-1", "to": "coder" },
    { "rel": "dispatch", "from": "coder-1", "to": "furnace-run-17" },
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
