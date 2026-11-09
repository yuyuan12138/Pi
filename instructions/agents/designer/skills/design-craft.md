---
name: design-craft
description: Visual design craft rules — typographic hierarchy, spacing rhythm, color system, email/HTML-safe implementation, anti-AI-template-slop. Required reading before beautifying any page/document/email.
---

# Design Craft (beautification rules)

The goal is not "add decoration" but to make the information hierarchy legible
at a glance and the artifact worth reading.
Acceptance test: **delete any element — is the information still complete?
If yes, delete it.**

## 1. Hierarchy before decoration
- One visual focal point per screen. Separate four levels (title / group /
  item / meta) by at least a 1.25x font-size step, or by weight/color
  contrast — never by "slightly smaller".
- Group with spacing (inter-group gap ≈ 2x intra-group gap), not divider
  lines. If a line can be omitted, omit it.

## 2. Typography
- Line length 45–75 characters (20–38 CJK characters); line height 1.5–1.7
  for body text.
- Font stack with real fallbacks: for CJK, `PingFang SC, Noto Sans CJK SC,
  Microsoft YaHei, sans-serif`; numerals/code in monospace. At most two font
  families.
- Alignment: always left-aligned (except numeric tables); never justified.

## 3. Color
- One primary color + 2–3 neutral grays + one semantic color per class
  (success / warning / source marker).
- Background color carries grouping; border color is de-emphasized (3 steps
  lighter than the text color).
- Contrast: body text ≥ 4.5:1, secondary text ≥ 3:1 (check dark mode the
  same way).

## 4. Anti-AI-template-slop (slop design)
Fix these on sight — they are the markers of "instantly recognizable as
AI-generated":
- Gradient banner + rounded cards + a grid of three equal-width icon cards
- An emoji on every heading, an icon on every card
- Purple-blue gradients, glassmorphism abuse, triple-stacked shadows
- Empty phrase copy ("empower", "one-stop", triple parallelism)
Decoration must serve information: a source marker, a status, clickability —
that is what earns a color/icon.

## 5. Email HTML safe implementation
- Outer `<table role="presentation">` at 640px; clients strip `<style>`, so
  all critical spacing/font-size/colors go inline; dark mode lives only in
  the head `<style>` `prefers-color-scheme` override, and the light-mode
  rendering must still be complete when no head styles apply.
- Zero external resources (no img/script/link). Replace image slots with a
  color block + text.
- Three-question test: mentally render once each in Gmail web, phone
  portrait, and dark mode.

## 6. Document beautification (Markdown/Feishu/web)
- Paragraphs ≤ 4 lines; lists ≤ 2 levels; use a table instead of
  comma-linked parallelism.
- Emphasis via bold, never underline/italic (italic CJK is a typography
  failure).
- Numbers are visual anchors: bold or enlarge key numbers, do not bury them
  in prose.

## 7. Acceptance
Before delivery, self-check: screenshot/render once → 5-meter squint test
(are three hierarchy levels distinguishable) → delete-an-element test →
contrast spot-check. Compared against the pre-beautification version, you
must be able to state in one sentence: "the information is unchanged; the
difference is in the look".
