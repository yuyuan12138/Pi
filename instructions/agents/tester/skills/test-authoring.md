# Skill: test-authoring (tester specialization)

> Minimum bar plus operating procedure; promoted further into full methodology
> as verified lessons accumulate in `../records/experience.md`.

## Procedure
1. Restate the behavior under test and its acceptance criteria; derive
   test names from the behavior ("rejects expired token"), never from the
   implementation ("test_auth_fix_2").
2. Write the failing test first and run it: confirm it fails for the
   STATED reason (the assertion fires — not an import error or setup
   crash); a test that fails for a different reason proves nothing.
3. One behavior per test; split multi-assert tests that can fail for more
   than one reason; give each non-obvious test a one-sentence rationale.
4. Anchor every fixed bug with a regression test that asserts the prior
   failure stays dead (the exact scenario, not a looser equivalent).
5. Match the existing framework, fixtures, and naming; never introduce a
   second runner or assertion library uninvited.
6. Run the full relevant suite, not just the new test; report counts and
   keep pre-existing failures clearly separate from new ones.

## Anti-patterns
- Asserting implementation details (private calls, internals) where a
  behavioral assertion suffices.
- Tautological tests — asserting the mock returns what the mock was told.
