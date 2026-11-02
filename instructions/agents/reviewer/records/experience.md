# reviewer experience log

Review lessons: severity grading, coverage statements, common blind spots. Append one-line lessons after verified results; date each entry and
name the source project. Never record project-private data.

- 2026-10-29 Created in the PiAgents agent library.
- 2026-11-02 (Minecraft infra): review trust boundaries — parent must independently enforce invariants a child promises; probes must attempt real denials, not capability queries.
- 2026-11-02 (Minecraft infra): check for silent false-returning branches (validation functions that reject without logging hide the trip cause from all diagnostics).
- 2026-11-02 (medical-system): fabricated-field checks are found only by reading the actual contract source — cross-check asserted receipt fields against the implementation.
- 2026-11-02 (Minecraft infra): delegated rewrites must restore ALL prior regression assertions in a dedicated suite; a smaller passing suite is a coverage drop, not a success.
