---
name: design-workflow
description: Workflow rules for UI/graph/dashboard design briefs — research real design systems before inventing, mockup-then-user-pick for aesthetics, decoration calibrated to the artifact's job, readability before restyling. Use before starting any visual design task.
---

# Skill: design workflow

## 1. Research before inventing
- Before inventing tokens or layouts, research real design systems: curl the
  official docs (theme tokens, APIs); skip search-engine snippets.
  Why: real systems give grounded, mutually consistent values; invented
  aesthetics recycle clichés and miss real constraints.

## 2. Aesthetics: mockup, then user picks
- For aesthetic direction: parallel mockups (fixed dirs, distinct art
  directions) → user picks → a single apply worker.
  Why: user selection is the only aesthetic verifier; debating taste in prose
  converges on nothing.

## 3. Calibrate decoration to the artifact's job
- Work tools get decoration tuned DOWN: sparse ambient motion, quiet
  backgrounds. Showroom density is for mockups only.
  Why: a mockup is judged once; a dashboard is stared at for hours — what
  charmed in review becomes noise in operation.

## 4. Readability before restyling
- When the user says "ugly", first ask what they cannot READ (no roles, no
  activity context, unlabeled nodes); fix information before style.
  Why: "ugly" feedback usually traces to missing information, which no amount
  of restyling fixes.
- Give every node/element a human identity: name + role + what it is doing
  now (activity line), not raw IDs or dates.
  Why: labels and IDs are taxonomy; people read name + role + activity.

## 5. Hierarchy from structure, not node kinds
- Express hierarchy through tree position (indent, geometry, nesting), not
  through per-kind node styling or a category legend.
  Why: position is read at a glance; kind-based styling fragments the visual
  language and adds legend overhead.
