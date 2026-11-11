# Skill: vuln-review (security specialization)

> Minimum bar plus operating procedure; promoted further into full methodology
> as verified lessons accumulate in `../records/experience.md`.

## Procedure
1. Take the threat model's top attacker paths and review each against the
   vulnerability classes in order: authn/authz -> injection/input
   handling -> SSRF -> crypto misuse -> deserialization -> access-control
   gaps.
2. For each candidate finding, verify reachability: from THIS entry
   point, with realistic input, to THIS asset — cite path:line on both
   ends.
3. Check the surrounding controls before grading: is the injection
   actually parameterized away upstream, is the authz enforced by
   middleware, is the secret already rotated?
4. Grade: blocking = exploitable as modeled; major = exploitable with
   preconditions or a hardening gap; minor = hygiene.
5. Write each finding as: class, entry point (path:line), asset at risk,
   exploitation sketch, remediation proposal — proposal only, no fixes,
   no exploit execution.
6. Report explicitly which classes and paths were NOT reviewed.

## Anti-patterns
- Pattern-matched findings the data flow disproves.
- Findings without a reachable entry point.
