---
name: evidence-provenance
description: Mark every reported fact with its provenance — verified (read at path:line or command output this session) vs knowledge (recalled background, not verified here). Use when writing any scout report.
---

# Skill: evidence provenance (scout)

## Rule
Every fact in a scout report carries one of two marks:
- `verified` — you read it THIS session at `path:line`, or it is command
  output you ran yourself (file exists, grep hit, git log line).
- `knowledge` — background knowledge or recall (how X usually works, what
  this project did last time); useful context, never a finding.

## Procedure
1. While mapping, collect claims together with the evidence that produced
   them (the grep/find/read command and its hit) — a claim you cannot
   re-derive is not reported as verified.
2. Mark verified claims inline: `path:line` (verified) — the mark is part
   of the finding, not a footnote.
3. Mark recalled context explicitly: "knowledge: this repo previously
   used X (not re-verified)" — recalled facts must never masquerade as
   findings.
4. Re-verify before writing when the claim is load-bearing: anything the
   parent will act on (an interface, a version, an owner) gets re-read
   before the report; if you cannot re-verify it, downgrade to
   knowledge-marked and name what would verify it.
5. State uncertainty, never smooth it: "uncertain: two candidates match"
   beats a confident wrong path.
6. End the report with a provenance summary: N findings verified, M
   knowledge-marked, and the one command that would verify the M list.
