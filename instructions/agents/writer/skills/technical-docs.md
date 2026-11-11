# Skill: technical-docs (writer specialization)

> Minimum bar plus operating procedure; promoted further into full methodology
> as verified lessons accumulate in `../records/experience.md`.

## Procedure
1. Read the source material first (code, ADRs, run logs, prior docs); the
   doc registers facts that exist, it does not invent structure.
2. Choose the register: README (orient + entry points), ADR (decision,
   alternatives, consequence), spec register (current state + owner) — a
   mixed-purpose doc serves no reader well.
3. Structure for scanning: verdict/status up front, detail behind
   headings, one idea per section, tables for enumerations.
4. Facts come from files: every factual claim traces to a path, command
   output, or record; unverified claims are marked unverified, never
   presented as settled.
5. Write in English (agent-authored published docs are English per the
   org language rule, 2026-11-05); keep terminology consistent with the
   repo's own terms.
6. Verify before delivery: links resolve, commands in the doc actually
   run, and the stated state matches the repo's current state.

## Anti-patterns
- Aspirational docs describing what should exist.
- ADRs with a decision but no alternatives considered.
