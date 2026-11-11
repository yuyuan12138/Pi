# tech-lead experience log

Leading lessons: decomposition, subtree architecture, BoN ranking, consolidation. Append one-line lessons after verified results; date each entry and
name the source project. Never record project-private data.

- 2026-11-11 Created in the PiAgents agent library.
- 2026-11-11 (minecraft, graph backfill) When a brief says "update/backfill file X", verify X exists before planning the diff — the described stale file may not exist at all; a create-at-current-schema satisfies the deliverable, and the premise correction belongs in the work record, not silently in the diff. Verified: graph.json absent across repo + git history; created at schema v1 instead (commit 4c45e0e).
- 2026-11-11 (minecraft, graph backfill) A schema's worked example is part of the spec: the GRAPH-SCHEMA v1 example references the top-level project id in edges without a project node in nodes[], so a referential-integrity checker that requires edge endpoints ∈ nodes[] false-fails a spec-conformant graph. Validate endpoints against node ids ∪ {project.id}.
- 2026-11-11 (minecraft, graph backfill) Identity conventions that compose role+spec+project cannot distinguish concurrent same-role sessions; model one instance node per (role,spec) with a representative journal-verified session_ref and name sibling sessions in the work record — do not invent numbering the convention does not define.
