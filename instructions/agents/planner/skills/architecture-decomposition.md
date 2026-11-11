# Skill: architecture-decomposition (planner specialization)

> Minimum bar plus operating procedure; promoted further into full methodology
> as verified lessons accumulate in `../records/experience.md`.

## Procedure
1. Start from the goal's verifiable outcome and split into parts that can
   each be accepted WITHOUT the others (own criteria, own test path).
2. Make interfaces explicit per part: inputs, outputs, error contract —
   written in the plan, not implied by naming conventions.
3. Sequence parts by dependency (data/model first, UI/UX last); mark
   which parts can run in parallel (disjoint files) and which are
   strictly serial.
4. Size each part for one worker brief (fits one clean-context session);
   a part needing two sessions is two parts.
5. For each part, name its BoN suitability: bounded + verifiable ->
   parallel candidates fit; exploratory -> one scout, then one worker,
   iterate.
6. Present the decomposition as a table: part -> owner profile -> criteria
   -> dependency order; the primary decides, you propose.

## Anti-patterns
- Parts that share a critical file (ownership collision by design).
- Interfaces "to be defined during implementation".
