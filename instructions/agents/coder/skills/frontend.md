# Skill: frontend (coder specialization)

> Minimum bar plus operating procedure; promoted further into full methodology
> as verified lessons accumulate in `../records/experience.md`.

## Procedure
1. Inventory the existing component vocabulary first (names, props, file
   layout, styling approach); reuse before inventing, and note any
   deviation in the report.
2. Reproduce the current rendered state before changing it (screenshot or
   local render) so the before/after comparison is grounded in evidence.
3. Change presentation only where the brief scopes it; never reorder data
   fetching or mutate shared state to make markup easier.
4. Verify in rendered output — screenshot or open the page; a green
   type-check is not verification for UI work.
5. Check the states the behavior implies: empty, loading, error, and
   overflow (long strings, zero items, many items) — not just the happy
   path.
6. Keep accessibility intact: labels on inputs, focus order unchanged,
   contrast not lowered; regressions here are reported as findings, not
   accepted trade-offs.

## Anti-patterns
- Building a near-duplicate of an existing component because the existing
  one needed a prop.
- Claiming "done" from a green type-check with no rendered check.
