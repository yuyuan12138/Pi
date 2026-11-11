# Skill: metric-gaming-guard (evaluator specialization)

> Stub: minimum bar for this specialization; promoted into full methodology as
> verified lessons accumulate in `../records/experience.md`.

- Check the known gaming vectors before believing any score: training/test-set
  leakage, overfitting to the exact benchmark items, hardcoded or special-cased
  outputs, threshold-shopping after results.
- Hold-out or perturbation probes where cheap: shuffle inputs, vary names/seeds —
  a system that only passes the exact fixture is not passing.
- A detected gaming vector is a no-ship-grade finding with its mechanism; never
  "fix" it by adjusting the metric or the threshold.
