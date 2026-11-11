# Skill: coverage-analysis (tester specialization)

> Minimum bar plus operating procedure; promoted further into full methodology
> as verified lessons accumulate in `../records/experience.md`.

## Procedure
1. List the changed behaviors (from the diff/brief) BEFORE looking at any
   coverage number; coverage maps to behaviors, not to line-count vibes.
2. Map each changed behavior to the test(s) that exercise it; a behavior
   with no mapping is a gap, whatever the percentage says.
3. Run the coverage tool only to confirm the mapping (which files/branches
   the mapped tests touch); record the exact command and config used.
4. Name the tool's blind spots explicitly: dynamic dispatch, error and
   timeout paths, async callbacks, platform-specific branches — a
   percentage is not proof for these.
5. Report the delta: behaviors now covered vs newly exposed gaps, each
   with the covering test file — or the reason no test can reach it.
6. Recommend the smallest test set that closes the material gaps (a
   proposal; closing them is in scope only if the brief says so).

## Anti-patterns
- Chasing 100% line coverage with assertion-free tests.
- Reporting a percentage without naming what the suite still cannot see.
