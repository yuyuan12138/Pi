# Skill: tooling-scan (researcher specialization)

> Minimum bar plus operating procedure; promoted further into full methodology
> as verified lessons accumulate in `../records/experience.md`.

## Procedure
1. Fix the comparison axes first: activity (releases/commits), maintenance
   (issue response, last release), license, integration cost (API
   surface, deps, platform), plus the brief's must-haves — same axes for
   every candidate.
2. Gather candidates from primary sources only: the repos themselves,
   changelogs, official docs; a listicle is a lead, not a source.
3. For each candidate, record checkable facts with source links: last
   release date, license, language, dependency weight,
   breaking-change cadence.
4. Verify the brief's critical requirements against official docs (does
   it actually support X?) — feature claims in a rival's README are not
   evidence.
5. Compare on the same axes in one table; mark cells where evidence was
   unobtainable instead of leaving them implicitly empty.
6. Conclude with a recommendation per axis and an integration-cost sketch
   for the top candidate (what adopting it would touch).

## Anti-patterns
- Rankings from one benchmark or one blog post.
- "Actively maintained" claimed without the release date.
