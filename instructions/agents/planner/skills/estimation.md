# Skill: estimation (planner specialization)

> Minimum bar plus operating procedure; promoted further into full methodology
> as verified lessons accumulate in `../records/experience.md`.

## Procedure
1. Estimate in ranges with an explicit assumption list: each range states
   the assumption it rests on ("2h IF the suite already runs in CI").
2. Size by reference classes from the project's own history (similar past
   tasks and their actuals in records/ or git log) before gut-feeling.
3. Decompose the largest items until each is checkable (fits one worker
   session); the estimate is the sum of checkable parts, not one guess.
4. State the uncertainty drivers explicitly: unknowns that would multiply
   the estimate (integration surprises, missing fixtures, slow feedback
   loops).
5. Separate effort from calendar: effort in focused hours; calendar adds
   review rounds, feedback latency, and BoN-candidate overhead.
6. Give a confidence note per range (what evidence supports the low end,
   what threatens the high end); a point estimate without this is a vibe.

## Anti-patterns
- Ranges with no assumptions (width without a reason).
- Estimates that ignore verification and review time.
