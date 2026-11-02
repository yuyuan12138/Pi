---
name: structure-map
description: Builds a shallow structural map of an unfamiliar codebase (tree, entry points, config sources, symbol locations). Use when a task brief requires exploring or reporting on a project's layout before deeper work begins.
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
