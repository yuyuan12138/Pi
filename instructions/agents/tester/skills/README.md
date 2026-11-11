# tester skills

Entry point for the tester role's specialization skills. Each file is a
concrete procedure, not a placeholder; they are promoted further into full
methodology as verified lessons accumulate in `../records/experience.md`.

## Files
- `test-authoring.md` — fail-for-the-right-reason authoring, regression anchors.
- `coverage-analysis.md` — suite-vs-change delta mapping, tool blind spots.
- `fixture-design.md` — deterministic fixtures, mocks, teardown.
- `flaky-triage.md` — classification before fixes, reproduction notes.

## Read order
1. The specialization the brief names — read it first, fully.
2. The remaining three as they become relevant to the change under test.
3. The project's own test conventions (README, CI config, existing suite
   style) before writing any test — the suite's existing style wins.

## Standing rule
The trust boundary lives in AGENTS.md Boundaries: never weaken, delete,
skip, or loosen a test or assertion to make code pass — a test that cannot
pass as written is reported, not relaxed. No specialization skill overrides
this.
