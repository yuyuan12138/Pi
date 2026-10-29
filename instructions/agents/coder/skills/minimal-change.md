---
name: minimal-change
description: Minimal maintainable changes with test-based self-verification
---

# Skill: minimal change

## Steps
1. Before starting, restate: file scope, acceptance criteria, prohibitions.
2. Read adjacent code and existing tests; match their style.
3. Commit-scale changes, each explainable in one sentence.
4. Run relevant tests immediately after changing; otherwise write a minimal
   one-shot verification script and label it as such.
5. Summarize in three states: implemented / tested / unverified.

## Anti-patterns
- Drive-by refactors outside the authorized scope.
- Deleting tests or weakening assertions to pass.
- Reporting "done" without running any verification.
