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
| subproject | id, parent, graduation_reason, status (active \| archived) | charter under `subprojects/<name>/` |
| profile | name, group, specializations[] | `instructions/agents/<name>/` |
| instance | id (`role-<name>[.<spec>]@<project>[.<sub>]`), session_ref, status (idle \| running \| retired) | `.pi/subagents/<id>/` |
| work | id, title, record_path, outcome | `record_path` → `work/.../RECORD.md` |

Edges:

| Edge | From → To | Meaning |
|---|---|---|
| child_of | subproject → project | graduation created a durable branch |
| crew_of | instance → project \| subproject | membership (the durable Crew section) |
| dispatch | instance → work | this instance executed this task |
| graduated_from | work → subproject | the record whose growth triggered graduation |
| reports_to | instance → instance | the live UP-CHECK edge (parent of the moment) |

## Example — `graph.json` (minecraft, one graduated subproject)

```json
{
  "version": 1,
  "project": { "id": "minecraft", "root": "~/projects/minecraft",
               "charter_path": "README.md", "status": "active" },
  "nodes": [
    { "type": "subproject", "id": "minecraft.furnace-campaign", "parent": "minecraft",
      "graduation_reason": "needs own ADRs; spans 3 work sessions",
      "status": "active",
      "charter_path": "subprojects/furnace-campaign/README.md" },
    { "type": "profile", "id": "coder", "group": "build/run",
      "specializations": ["engine", "frontend"] },
    { "type": "instance", "id": "role-coder.engine@minecraft.furnace-campaign",
      "session_ref": "role-coder.engine@minecraft.furnace-campaign",
      "status": "running" },
    { "type": "instance", "id": "role-scout@minecraft.furnace-campaign",
      "session_ref": "role-scout@minecraft.furnace-campaign", "status": "idle" },
    { "type": "work", "id": "furnace-run-17", "title": "collector-green furnace run",
      "record_path": "subprojects/furnace-campaign/work/2026-11-11-run17/RECORD.md",
      "outcome": "delivered" }
  ],
  "edges": [
    { "rel": "child_of", "from": "minecraft.furnace-campaign", "to": "minecraft" },
    { "rel": "crew_of", "from": "role-coder.engine@minecraft.furnace-campaign",
      "to": "minecraft.furnace-campaign" },
    { "rel": "crew_of", "from": "role-scout@minecraft.furnace-campaign",
      "to": "minecraft.furnace-campaign" },
    { "rel": "reports_to", "from": "role-coder.engine@minecraft.furnace-campaign",
      "to": "role-scout@minecraft.furnace-campaign" },
    { "rel": "dispatch", "from": "role-coder.engine@minecraft.furnace-campaign",
      "to": "furnace-run-17" },
    { "rel": "graduated_from", "from": "furnace-run-17",
      "to": "minecraft.furnace-campaign" }
  ]
}
```

## Convention

- **Where**: every project space holds `graph.json` at its root, versioned in git
  next to the README it extends.
- **When updated**: at the same moments as work records — dispatch, completion,
  graduation, archive (the closing dispatch updates it; Principle 3 of
  `PROJECT-SPACE-STANDARD.md`).
- **Consumers (v2, deferred)**: the web `/projects` + org-graph page read
  `graph.json`; the coordinator journal remains the live/ephemeral complement
  (per-instance events, not durable structure).
- **Rollout**: new projects create `graph.json` from day one; retrofitting the
  existing projects is a rollout step, deliberately not done in v1.
