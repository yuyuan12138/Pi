# Skill: backend (coder specialization)

> Minimum bar plus operating procedure; promoted further into full methodology
> as verified lessons accumulate in `../records/experience.md`.

## Procedure
1. Read the existing contract first: route/handler signatures, error shapes,
   status codes, and how tests assert them. Match them before inventing.
2. Design contracts and error paths before happy paths: enumerate the failure
   modes (invalid input, missing entity, conflict, downstream timeout) and
   give each an intended status/error shape in the change note.
3. Migrations are reversible: write the down-path (or state why none exists),
   never shrink or drop a column destructively, and test migration + rollback
   against a copy of realistic data before shipping.
4. Write endpoints are idempotent or state their retry semantics: what a
   repeated request does (no-op, conflict, duplicate) is stated in the code
   path or a doc comment, not implied.
5. Validate at the boundary; trust internally. Reject input the contract
   forbids, and never let a payload bypass validation through a second
   entry point (queue, cron, admin route).
6. Run the service's own test command plus at least one negative case per
   new endpoint; a backend change proven only by the happy path is
   reported as unverified.

## Anti-patterns
- Silent catch-all handlers that turn bugs into generic 500s.
- Schema changes with no rollback story.
- Retries that can double-apply a non-idempotent write.
