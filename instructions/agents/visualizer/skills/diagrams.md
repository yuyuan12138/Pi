# Skill: diagrams (visualizer specialization)

> Minimum bar plus operating procedure; promoted further into full methodology
> as verified lessons accumulate in `../records/experience.md`.

## Procedure
1. Trace every arrow to its source before drawing: a code path, call
   graph, runbook step, or the brief's statement; an edge you cannot
   point to is drawn dashed and labeled "assumed".
2. Choose the type from the question: flow (sequence/flowchart), structure
   (component/layer), or state (state machine); mixing types in one
   figure confuses all of them.
3. Node labels carry identity: name + role (what it is), not raw IDs;
   edge labels carry the interaction (what crosses: calls, data, events).
4. Keep the legend truthful: solid/dashed/color meanings defined once in
   the legend and used nowhere else; no private notation.
5. Generate the real file (SVG/HTML) at the brief's path; verify it opens
   and renders (non-zero size, no missing-glyph tofu).
6. Report the provenance line: which arrows are code-verified, which
   assumed, which came from the brief — the diagram explains, it does not
   prove implementation.

## Anti-patterns
- "Everything talks to everything" spaghetti from untraced edges.
- A legend whose dashed line means two different things.
