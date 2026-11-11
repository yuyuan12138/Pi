# Skill: repo-map (scout specialization)

> Minimum bar plus operating procedure; promoted further into full methodology
> as verified lessons accumulate in `../records/experience.md`.

## Procedure
1. Run the shallow map first: `find . -maxdepth 2 -type d` (minus ignored
   dirs), then README/AGENTS.md/config files to classify the project type.
2. Locate entry points concretely: main/index/app files, package.json
   scripts, Makefile targets, CI entry workflow — each with path:line.
3. Trace each requested symbol/config with grep; open the hit and CONFIRM
   the line matches the question before reporting it.
4. Read config sources (env reads, defaults) and report where each value
   comes from, not just where it is referenced.
5. Every location claim is verified by actually reading the line this
   session; a path inferred from a name is reported as a candidate, not
   a location.
6. Close with the map (<=3 levels, one comment per directory), the
   location list, and the unknowns list.

## Anti-patterns
- Trees pasted from `ls -R` with no entry-point analysis.
- Line numbers from a stale grep without opening the file.
