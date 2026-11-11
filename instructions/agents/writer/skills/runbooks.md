# Skill: runbooks (writer specialization)

> Minimum bar plus operating procedure; promoted further into full methodology
> as verified lessons accumulate in `../records/experience.md`.

## Procedure
1. Write for letter-by-letter execution: each step is one command or one
   check, in run order, with the expected outcome stated next to it.
2. Preconditions section first: required state, credential paths,
   versions, and the checks that must pass before step 1.
3. Failure table per step: symptom -> cause -> recovery action; anything
   not in the table routes to the escalation rule (who/what is contacted,
   what must NOT be tried).
4. Mark idempotency and safety: which steps are safe to re-run and which
   are not — and what to check before re-running those.
5. Verify the runbook by walking it: run every command in a clean state
   (or a dry-run equivalent); an unexecuted step is marked UNVERIFIED,
   never presented as tested.
6. Register the artifacts: log paths, marker files, and where the
   operator records receipts, so monitoring has defined fields to poll.

## Anti-patterns
- "Then it should work" steps with no expected outcome.
- Recovery instructions that assume knowledge the operator does not have.
