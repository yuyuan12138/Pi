---
name: structure-map
description: Quickly build a structural map of an unfamiliar project
---

# Skill: structure map

## Steps
1. List the root, README/AGENTS.md/config files; determine project type.
2. Draw a shallow tree with `find -maxdepth 2 -type d` (<=3 levels).
3. Find entry points: main/index/app/bin scripts, package.json scripts, Makefile.
4. Find configuration sources: env reads and default values.
5. For each symbol the brief asks about, grep and record `path:line`.

## Output shape
- 3-6 core findings
- shallow tree (one comment per directory)
- location list (path:line)
- unknowns list
