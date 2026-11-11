# Skill: regression-review (reviewer specialization)

> Minimum bar plus operating procedure; promoted further into full methodology
> as verified lessons accumulate in `../records/experience.md`.

## Procedure
1. Establish the prior behavior from git (the previous revision of the
   touched code and its tests) before judging the new one; regression
   review compares, it does not assume.
2. Walk the diff hunk by hunk: for each changed call, signature, or
   branch, grep the callers and ask "what did they expect?"
3. Check prior assertions survived: deleted or weakened tests and renamed
   error types are coverage drops, not cleanup, and are reported as such.
4. Hunt contract drift: return-shape changes, silent false-returns, error
   types swallowed, defaults changed without a migration path.
5. Check false-negative traps: branches that now return early and skip
   side effects (notifications, cleanup, persistence) that used to run.
6. Spot-check one or two prior behaviors against the new suite: if
   re-introducing the old behavior would pass unnoticed, say so in the
   coverage statement.

## Anti-patterns
- Treating "tests pass" as regression evidence without checking what the
  tests actually assert.
- Reading only the new code and never the old revision.
