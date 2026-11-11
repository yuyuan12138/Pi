# Skill: charts (visualizer specialization)

> Minimum bar plus operating procedure; promoted further into full methodology
> as verified lessons accumulate in `../records/experience.md`.

## Procedure
1. Confirm the data is measured: read it from the file/command the brief
   names; record the source path and row count; no invented points, and
   approximations are marked ON the chart itself.
2. Pick the form from the question: trend over time -> line; composition
   -> stacked bar (not pie beyond a few slices); distribution ->
   histogram/box; comparison of few items -> bar. "Prettiest" is not a
   selection criterion.
3. Label axes with quantity + unit, title with the takeaway, and state
   the time window/sample size in a subtitle — a chart without units is
   decoration.
4. Honest scales: bar charts start at zero; truncated axes are labeled
   and justified; log axes are stated as log.
5. Render to the file the brief names (PNG/SVG via matplotlib or HTML),
   then verify: file exists with non-zero size, opens, and labels are
   legible at the target display size.
6. In the report, one line per chart: what it shows + the real-vs-approx
   boundary + what it must not be mistaken for.

## Anti-patterns
- Dual axes without labeling (and usually without need).
- Smoothing/interpolation that invents data between points.
