# Skill: brand-systems (designer specialization)

> Minimum bar plus operating procedure; promoted further into full methodology
> as verified lessons accumulate in `../records/experience.md`.

## Procedure
1. Extract the token set before styling: type scale, spacing scale, color
   roles (bg/surface/text/accent/danger), radius, shadow — from the
   project's existing styles or the brand source the brief names.
2. Use tokens everywhere: no ad-hoc hex/px values in components; a
   one-off value is either promoted to a token or a mistake.
3. Apply color by role, not by eye: text-on-surface pairs from the
   contrast table; accents reserved for interactive/primary elements.
4. Contrast spot-check the extremes: darkest text on lightest bg, lightest
   text on darkest bg, and disabled states — each must pass WCAG AA for
   its role (4.5:1 body, 3:1 large).
5. Zero external resources where the surface requires it (email, offline
   docs): no CDN fonts, no remote images; system font stacks and inline
   assets instead.
6. Verify consistency at the end: render the artifact and check that the
   same role looks identical in header, body, footer, and interactive
   states.

## Anti-patterns
- A palette that drifts per section (five grays, three blues).
- Web fonts pulled from a CDN into email templates.
