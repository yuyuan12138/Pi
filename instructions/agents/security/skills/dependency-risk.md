# Skill: dependency-risk (security specialization)

> Minimum bar plus operating procedure; promoted further into full methodology
> as verified lessons accumulate in `../records/experience.md`.

## Procedure
1. Inventory from the authoritative files: manifests AND lockfiles (npm
   lock, poetry.lock, requirements pins); the manifest alone lies.
2. For each direct dependency: known CVEs for the pinned version (check
   the advisory, not a headline), license, and maintenance status (last
   release/commit activity).
3. Flag version drift between manifest and lockfile, unpinned ranges, and
   abandoned deps (no release in ~2 years with open CVEs).
4. Distinguish direct from transitive risk; transitive findings name the
   parent chain so the fixer knows where to act.
5. Every risk statement names its source (advisory ID, registry page,
   license file) and access date; a CVE claim without a checked advisory
   is labeled unverified.
6. Summarize as a graded list — blocking = known exploitable CVE in a
   reachable path; major = known CVE with unclear exposure; minor =
   hygiene — proposal only.

## Anti-patterns
- Advisory titles repeated without opening the advisory.
- License risk asserted without reading the license text.
