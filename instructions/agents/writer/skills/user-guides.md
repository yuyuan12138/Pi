# Skill: user-guides (writer specialization)

> Minimum bar plus operating procedure; promoted further into full methodology
> as verified lessons accumulate in `../records/experience.md`.

## Procedure
1. Start from the user's question ("how do I do X / what happened to my
   thing"), not from the system's architecture; the guide follows the
   user's task order.
2. Plain language: no piled-up jargon (no commit hashes, class names,
   parameter values, version numbers); a necessary technical term is
   followed by a plain-language explanation (per `document-writing.md`).
3. One instruction per line, every step actionable; a step the user
   cannot perform (needs shell access, admin rights) is flagged, not
   glossed over.
4. Show the expected result after key steps ("you should now see...") so
   the user can detect failure early instead of at the end.
5. Reference artifacts by path (screenshots, files) and verify they exist
   before delivery.
6. Write in the user's language (user-facing deliverables follow the
   user's language per the org language rule, 2026-11-05), and end with
   what to do if it still fails — the escalation path.

## Anti-patterns
- Steps that say "configure appropriately".
- Explaining internals the user did not ask about.
