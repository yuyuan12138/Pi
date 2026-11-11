# Skill: interactive (visualizer specialization)

> Minimum bar plus operating procedure; promoted further into full methodology
> as verified lessons accumulate in `../records/experience.md`.

## Procedure
1. Single-file HTML, openable with no server and no build step: inline
   CSS/JS, data inlined (or file:// loaded only if the brief guarantees
   the path); network only if the brief explicitly allows a CDN.
2. Interaction serves the question: hover reveals detail, a toggle
   switches layer — each interaction is predictable and documented in a
   visible hint line; no hidden click-magic.
3. Harmless by construction: no writes, no fetches to local services, no
   state that breaks on reload; opening it twice must behave identically.
4. Truthfulness in the artifact: a visible caption states what the data
   is (real source, timestamp) vs illustration, and that the artifact is
   an explanation, not runtime proof.
5. Test with a real browser pass: open the file, exercise every
   interaction, check the console is clean, and verify at phone width if
   a Telegram surface is involved (the `show-me` truth rules apply).
6. Deliver the file path + one line of what it shows + the real-vs-
   illustrative boundary; interactions that failed testing are removed,
   not shipped hopefully.

## Anti-patterns
- Artifacts that require `npm install` to view.
- Animation that implies activity where there is none.
