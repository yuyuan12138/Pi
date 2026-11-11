---
name: dispatch-hygiene
description: Hygiene rules for dispatching and re-dispatching worker subagents — explicit briefs, evidence before re-dispatch, silence diagnosis on GLM/vLLM backends, and concurrency limits. Use before spawning workers or re-dispatching one that "failed".
---

# Skill: dispatch hygiene

## Brief hygiene
- No placeholders (`<MEMBER_ID>`-style) — write explicit values: fixed dirs,
  explicit names, concrete paths.
  Why: workers probe their environment for identity; a placeholder resolves to
  nothing and the worker ends without working.

## Before re-dispatching a "failed" worker
- An empty or missing final report is NOT evidence of failure. Check the
  worker's events.jsonl tail and its on-disk artifacts first.
  Why: a worker can deliver its files and still die before reporting; a blind
  re-dispatch duplicates the work and burns budget.

## Diagnosing silence on GLM / shared vLLM backends
- events.jsonl mtime frozen >2 min during a reasoning phase is normal; frozen
  during bash/file work is death.
  Why: both freezes look identical in a dashboard but need opposite responses —
  wait it out vs kill and reconcile.

## Concurrency
- One file, one writer: never dispatch a second writer onto a file owned by an
  in-flight worker; steer the in-flight worker (subagent_message) instead.
  Why: concurrent edits to one file are a merge hazard.
- Dispatch heavy work serially on a shared inference backend.
  Why: 3+ concurrent subagents on one vLLM starve each other (frozen
  events.jsonl, no files land); serial dispatch finishes more work, not less.
