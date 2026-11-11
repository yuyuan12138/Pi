# Skill: dependency-census (scout specialization)

> Minimum bar plus operating procedure; promoted further into full methodology
> as verified lessons accumulate in `../records/experience.md`.

## Procedure
1. Read the authoritative dependency files: manifests AND lockfiles;
   report when they disagree (drift is a finding).
2. Census per ecosystem: direct deps with exact versions, then notable
   transitives when the brief asks; licenses from lockfile metadata or
   the registry.
3. Record versions exactly as pinned (or note the range/unpinned state);
   "latest" is not a version.
4. Flag as facts, not judgments: unpinned entries, duplicated deps across
   ecosystems, packages with no release in ~2 years, license conflicts
   with the project's own license file.
5. Verify each flag's basis in a file you read (path:line for the pin,
   the license field, the publish date you looked up); when offline, mark
   registry-dependent facts as not-verified-this-session (see
   `evidence-provenance.md`).
6. Output: census table (name, version, license, flag) + flags list + what
   you could not verify locally.

## Anti-patterns
- Judgments ("this dep is risky") without the fact trail.
- Versions from memory instead of the lockfile.
