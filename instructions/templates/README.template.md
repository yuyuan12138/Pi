<!--
PROJECT README template (Project-Space Standard §1, §7). Budget: ≤150 lines.
Copy into <project-root>/README.md; delete this comment block when filled.
Rule: every state claim cites a source file; unverifiable → mark "unverified".
-->
# <Project name> — <one-line essence>

## What this is
<!-- 2-4 lines: what the system does, why it exists, where it runs. -->
<!-- Pattern (sample README): "A closed-loop RSI lab on Minecraft Java 1.21.6:
     the system improves its own error interface and planning code through
     automated propose → A/B → gate → apply cycles..." -->

## Current status (as of <YYYY-MM-DD UTC>)
<!-- ≤10 rows; refresh at every accepted milestone (Standard §7). -->
| Item | State | Source |
|---|---|---|
| <component/goal> | <verifiable state> | `<file>` or `<file>` + commit id |

## How it works
<!-- 2-3 lines + pointer; details live in docs/architecture.md. -->

## Map of this directory
<!-- One line per top-level path. Mark engine/live state as
     "do not modify from docs work". -->
| Path | What it is |
|---|---|
| `docs/` | Architecture, ADR log, runbook index, postmortems |
| `work/` | One append-only dispatch record per task |

## Conventions
<!-- 5-8 bullets, e.g. (from the sample README): docs layer describes, live
     files own; work records in work/<date>-<task>/RECORD.md; decisions logged
     ADR-style in docs/decisions.md; every number verifiable against a cited
     source or marked unverified; git rules (explicit paths, never git add -A). -->
