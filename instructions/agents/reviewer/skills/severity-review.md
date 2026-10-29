---
name: severity-review
description: Graded findings with an explicit review-depth statement
---

# Skill: severity review

## Steps
1. Read the change description/diff; write a review-focus checklist.
2. Check in order: correctness -> security -> regressions -> test gaps -> UX.
3. Grade each finding: blocking / major / minor.
4. Attach `path:line` plus the evidence actually read.
5. Close with a coverage statement: reviewed / not reviewed / depth.

## Anti-patterns
- "Looks fine" without citing code.
- Grading style preferences as blocking.
- Pretending to have reviewed unread files.
