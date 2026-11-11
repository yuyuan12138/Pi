# Skill: subtree-architecture (tech-lead specialization)

> Minimum bar plus operating procedure; promoted further into full methodology
> as verified lessons accumulate in `../records/experience.md`.

## Procedure
1. Map the subtree's current boundaries first (modules, dependency
   direction, public interfaces) — architecture work edits an existing
   system, it does not start from a blank page.
2. Decide interfaces before internals: for each new or changed boundary,
   write the signature, the error contract, and the ownership (who may
   change it later).
3. Keep dependency direction acyclic and downward (stable <- unstable); a
   cross-cutting need becomes an interface owned by the stable side.
4. Contain decisions inside the delegated subtree; anything touching a
   neighboring subtree's contract goes UP as a proposal with options, not
   as a silent local choice.
5. Record each decision in the report as: decision, alternatives
   considered, why, and what would reverse it — one line each.
6. Verify the architecture holds: run the subtree's suite after any
   structural change; a structure without green tests is a sketch, not a
   decision.

## Anti-patterns
- Interfaces changed silently with callers "fixed later".
- "Temporary" layering violations that outlive the milestone.
