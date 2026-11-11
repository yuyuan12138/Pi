# Skill: fixture-design (tester specialization)

> Minimum bar plus operating procedure; promoted further into full methodology
> as verified lessons accumulate in `../records/experience.md`.

## Procedure
1. Prefer plain construction over frameworks: build the smallest object
   graph the test needs; reach for a fixture framework only when the
   suite already uses one.
2. Determinism: no real clocks (inject or patch time), no network, no
   filesystem outside a tmp dir, no randomness without a fixed seed.
3. State what each mock/factory fakes and where it deviates from the real
   thing — a mock that lies silently is a future flaky report.
4. Fixtures never mutate module-level or class-level state; where
   unavoidable, restore it in guaranteed teardown.
5. Teardown runs even on assertion failure (try/finally, fixture
   finalizers, tmp cleanup); a test that leaks state fails LATER tests.
6. Verify the fixture against reality once: the factory's output must
   satisfy the real validator/schema, not just the test's assumptions.

## Anti-patterns
- Order dependence (passes alone, fails in suite) — fix the fixture, not
  the run order.
- Factories with hidden defaults that mask required fields.
