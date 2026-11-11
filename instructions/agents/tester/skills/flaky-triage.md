# Skill: flaky-triage (tester specialization)

> Minimum bar plus operating procedure; promoted further into full methodology
> as verified lessons accumulate in `../records/experience.md`.

## Procedure
1. Reproduce before classifying: run the failing test alone, then in the
   suite, then repeated (e.g. 10x) — the pattern (alone-pass,
   suite-fail) is itself evidence.
2. Classify with evidence: product bug (assertion reveals a real defect)
   / test bug (broken fixture, wrong expectation) / environment-timing-
   order (race, tmp-dir collision, resource leak from another test).
3. Write a reproduction note before any fix: exact commands, failure
   rate, and the minimal difference between passing and failing runs.
4. Product-bug findings go back to the primary as findings — never adjust
   the test to make the bug invisible.
5. A test that passes on retry is still reported as flaky; retry-loops
   and sleep-based "fixes" hide the race, they do not remove it.
6. A timing fix must remove the race (proper synchronization, waits, or
   isolation) and is verified by the same repeat run that exposed it.

## Anti-patterns
- Marking a test skip/xfail to green the suite without a filed finding.
- "Works on my machine" as a triage conclusion.
