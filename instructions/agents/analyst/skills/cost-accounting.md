# Skill: cost-accounting (analyst specialization)

> Minimum bar plus operating procedure; promoted further into full methodology
> as verified lessons accumulate in `../records/experience.md`.

## Procedure
1. Fix the basis before tabulating: unit (tokens/requests/currency),
   period, and attribution rule (which session/agent/project each row
   belongs to).
2. Separate measured from estimated: measured rows cite the source
   log/file; estimated rows carry the estimation rule (e.g. price list x
   tokens) in the row.
3. Never mix token families (input/output/cached) or price tiers in one
   total without labeling the blend; reconcile totals to the source logs
   (sum of rows = reported total).
4. Show the table behind every headline number; a headline without its
   table is an assertion.
5. Report the accounting's coverage: which logs were included or excluded
   and why (sampling, missing files) — an accounting that silently drops
   sessions is wrong, not approximate.
6. Flag anomalies (rows 10x the median, negative or null costs) instead
   of smoothing them; each flag is a question for the parent, not a
   judgment call.

## Anti-patterns
- Totals that no source log reproduces.
- Blended averages hiding a tier change mid-period.
