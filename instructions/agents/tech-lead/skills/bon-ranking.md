# Skill: bon-ranking (tech-lead specialization)

> Minimum bar plus operating procedure; promoted further into full methodology
> as verified lessons accumulate in `../records/experience.md`.

## Procedure
1. Rank only candidates that were all briefed with the SAME fixed
   acceptance criteria; if criteria diverged, fix the comparison basis
   first and say so in the ranking.
2. Verify EACH candidate yourself against the criteria: run the tests,
   run the acceptance commands, inspect the diff — never rank from the
   candidates' self-reports.
3. Score on the stated axes (correctness first, then simplicity/
   maintainability, then scope fit); a candidate that fails any
   acceptance criterion is out, however elegant.
4. Write the ranking: one line per candidate — what was verified, what
   passed/failed, and why it ranks where it does.
5. Recommend exactly one; acceptance authority stays with the parent.
6. Feed the losers' verified lessons back: what the winner did differently
   is a lesson for the role ledger (`../records/experience.md`), not a
   critique of the losing child.

## Anti-patterns
- Accepting the first candidate that "says done".
- Ranking on style while ignoring an unrun test suite.
