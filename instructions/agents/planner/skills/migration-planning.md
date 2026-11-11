# Skill: migration-planning (planner specialization)

> Minimum bar plus operating procedure; promoted further into full methodology
> as verified lessons accumulate in `../records/experience.md`.

## Procedure
1. Order steps so every PREFIX leaves the system in a working state: after
   each step the system runs (old path, new path, or dual) — never a step
   whose completion requires three later steps to work again.
2. Write the rollback for each step BEFORE the step: the command/migration
   that restores the prior working state, and which data changes are NOT
   reversible (flag those for explicit user sign-off).
3. Gate irreversible transitions behind a switch: the new path runs
   dual/flagged; the switch flips only after the new path is verified in
   place.
4. Migrations move data forward-compatible: old code must tolerate new
   data for at least one step (add-then-fill-then-constrain, never
   rename-in-place).
5. Define per-step verification (command + expected state) so any
   operator can check the prefix invariant without re-deriving it.
6. State the total window and the stop condition: when to abort and roll
   back vs push through — decided by the parent, written into the plan.

## Anti-patterns
- "Deploy everything, then fix forward" as a rollback plan.
- Data-destroying steps with no tested restore.
