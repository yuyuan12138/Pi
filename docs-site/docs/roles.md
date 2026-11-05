# The nine predefined roles

> **Reproduction notes**: copying the entire `instructions/agents/` directory is all the role assets there are — 9 roles, one directory each (`AGENTS.md` brief template + `skills/` methodology + `records/experience.md`). The `records/` content is the original author's personal experience; **a reproducer can simply empty it** — the roles only depend on the first two. To dispatch, follow the instructions at the top of each `AGENTS.md`: fill in the five Task Brief fields (Project root / Goal and scope / Relevant paths / Authorization and prohibitions / Expected evidence and acceptance criteria), set the tool allowlist per its Tools section, and have the subagent read its own skill file first. For a complete worked example, see step 3 of the [README](../README.md).

The role library lives in `instructions/agents/`, one directory per role: `AGENTS.md` (brief template) + `skills/` (methodology) + `records/experience.md` (cross-project lessons). They are not resident processes but brief templates for clean-context subagents. Dispatch flow: the primary conversation reads the role's `AGENTS.md` → fills in the "task brief supplement" (cwd, goal, authorization, acceptance) → sets the tool allowlist per its Tools section → the subagent reads its own skill file before starting work.

| Role | Tool allowlist | Responsibilities | When to use |
|---|---|---|---|
| scout | read / grep / find / ls | Map the structure, locate code down to `path:line`, without judging design | "What is this, where is it, how is it organized" |
| planner | read / grep / find / ls | A verifiable plan of ≤6 steps + explicit tradeoffs (at least two options for every key decision) | You need an approach and its tradeoffs before acting |
| coder | read / grep / find / ls / bash / edit / write | Minimal changes + self-testing within the specified files, three-state reporting (implemented / tested / unverified) | Implementation, bug fixes, test authoring |
| operator | bash / read / ls | Mechanically execute a verified runbook: start, monitor, clean up, disk hygiene; never retries unknown-outcome operations | Deployment, inspections, checklist-driven operations |
| reviewer | read / grep / find / ls | Graded review: correctness → security → regressions → test gaps → UX, with `path:line` evidence | Independent review (findings only, no fixes) |
| researcher | read / grep / find / ls / bash | Public research + primary-source verification; every conclusion carries a link and an uncertainty tag | External facts and citations are needed |
| visualizer | read / write / bash / ls | Produce real charts / architecture diagrams / HTML files; data must be real, labeled "explanation ≠ proof" | A visible artifact is needed |
| writer | read / write / bash / ls | Documentation in the user's style (plain language, detailed, no tech-dump), self-updating its skill from feedback | Delivering documents and reports |
| designer | read / write / edit / bash / ls / grep | Redesign that touches looks but not data flow; removes AI slop (unslop) without losing information | Beautifying pages / emails / documents |

Improvement loop: verified results are appended by date to the role's `records/experience.md` (transferable methodology only, no project-private data), committed to Git by the primary conversation — lessons accumulate across projects.
