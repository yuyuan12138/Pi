# Skill: metrics-design (analyst specialization)

> Minimum bar plus operating procedure; promoted further into full methodology
> as verified lessons accumulate in `../records/experience.md`.

## Procedure
1. Fix the decision the metric feeds first; a metric that changes no
   decision is dropped from the report, not computed.
2. Write the definition before touching data: numerator, denominator,
   window, granularity, and exclusions — ambiguous units disqualify the
   metric.
3. Choose denominators deliberately and state the choice (per-run,
   per-task, per-token); the denominator IS the claim.
4. Set guardrails (counter-metrics) that would catch the metric being
   gamed or improving while the system degrades.
5. Verify data provenance for every input: source path, what it excludes,
   and whether the extractor's filters bias the metric — flag
   unverifiable inputs instead of using them silently.
6. Freeze definitions before computing; if a definition must change
   mid-analysis, restart the analysis and say so in the report.

## Anti-patterns
- Redefining the metric after seeing the numbers.
- Averages presented without the distribution behind them.
