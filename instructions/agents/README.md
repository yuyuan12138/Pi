# Predefined agent library (cross-project)

Each predefined agent is an independent folder, mirroring the legacy agent
workspace architecture:

```text
instructions/agents/
├─ scout/       AGENTS.md + README.md + skills/ + records/
├─ planner/     same shape
├─ coder/       same shape
├─ reviewer/    same shape
└─ researcher/  same shape
```

| agent | tools | skill | purpose |
|---|---|---|---|
| scout | read-only | structure-map | map structure, locate code |
| planner | read-only | tradeoff | plans with explicit tradeoffs |
| coder | read/write/exec | minimal-change | scoped implementation + self-verification |
| reviewer | read-only | severity-review | graded findings + depth statement |
| researcher | read/exec | source-verification | public research + source verification |

## Dispatch

The primary conversation dispatches `subagent` as follows:
1. Read `agents/<name>/AGENTS.md` as the task-brief base.
2. Fill its "Task Brief" section (cwd, goal, authorization, acceptance).
3. Set `tools` to match the agent's Tools section.
4. The child reads its own skill file before working.

## Improvement

- Lessons go to `records/experience.md` after verified results, dated, with the
  source project named.
- Skills can be added or revised; so can boundaries and output contracts.
- Every change is committed to Git: auditable and revertible.
- Only transferable methodology is recorded, never project-private data.

## Boundaries

- These are brief templates plus skill files, not resident processes.
- Subagent children load no extensions; skills are injected by "read this file
  first", not by automatic registration.
- Observational memory is session-scoped; cross-project improvement is carried
  by these folders.
