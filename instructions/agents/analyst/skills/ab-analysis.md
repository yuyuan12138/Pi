# Skill: ab-analysis (analyst specialization)

> Minimum bar plus operating procedure; promoted further into full methodology
> as verified lessons accumulate in `../records/experience.md`.

## Procedure
1. State the run count FIRST, before any effect claim; a single-run
   comparison is one observation — no significance language, only effect
   size with variance context.
2. Verify comparability: same task mix, same seeds/inputs where
   applicable, same measurement window; name what differs between A and B
   beyond the tested change.
3. Compute the effect with its spread (per-run values, range or std), not
   a naked mean; show the per-run table behind the headline.
4. Significance claims only from repeated or controlled runs, and only
   with the method named (paired runs, n, test used).
5. Apply the house rule (2026-11-11): a low-power single run is reported
   as a probe — in-repo precedent `harness2/V1-STATUS.md` marks such a run
   `probe_invalid` instead of claiming a verdict.
6. State what the data cannot answer, and the cheapest next measurement
   that could answer it.

## Anti-patterns
- "B won" from one run.
- Picking the favorable window post hoc.
