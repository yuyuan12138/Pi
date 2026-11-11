# Skill: ui-craft (designer specialization)

> Minimum bar plus operating procedure; promoted further into full methodology
> as verified lessons accumulate in `../records/experience.md`.

## Procedure
1. Diagnose before any redo: name the concrete failures (flat hierarchy,
   cramped spacing, emoji noise, gradient slop) with element/line
   references; no edit before a written diagnosis.
2. State the information invariant: the inventory of what the artifact
   must carry (labels, values, states, actions) — the redo preserves it
   exactly; hiding information to look cleaner is a failed design.
3. Build hierarchy from structure first: size, weight, spacing, and
   position carry the reading order; color and decoration come last.
4. Rhythm: consistent type and spacing scales (few steps, reused);
   arbitrary pixel values are a smell to replace with the scale.
5. Verify by render: screenshot, 5-meter squint test (3 hierarchy levels
   visible), contrast spot-check on the extremes, dark-mode render if the
   surface supports it.
6. Compare before/after against the diagnosis: every named failure fixed,
   nothing else changed; report the change as presentation-only.

## Anti-patterns
- Restyling that quietly removes "boring but load-bearing" information.
- Decoration added before hierarchy works.
