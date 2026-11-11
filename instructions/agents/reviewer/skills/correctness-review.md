# Skill: correctness-review (reviewer specialization)

> Minimum bar plus operating procedure; promoted further into full methodology
> as verified lessons accumulate in `../records/experience.md`.

## Procedure
1. Read the brief/diff's stated intent FIRST; correctness is measured
   against the stated intent, not against your preferred design.
2. Trace the primary path end-to-end, then the error paths: invalid input,
   empty/null, boundary values, concurrent or duplicate invocation, and
   the failure handling the code promises.
3. For each suspicion, open the actual code at path:line and quote the
   lines you relied on; findings without read evidence are speculation
   and are dropped.
4. Check the change against its own tests: do the new/changed tests
   actually exercise the changed behavior, or only the happy path?
5. Grade each finding — blocking (wrong behavior reachable in normal use)
   / major (edge cases, missing handling) / minor (suggestion) — and name
   the input that triggers it.
6. Close with the coverage statement: what you reviewed, at what depth,
   and what you did not read.

## Anti-patterns
- "Looks fine" without citing the code you read.
- Re-litigating style preferences as correctness findings.
