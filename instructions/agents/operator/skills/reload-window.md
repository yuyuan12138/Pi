---
name: reload-window
description: Never dispatch in-flight workers before a planned /reload or session restart — check the reload window, let workers reach terminal state first. Use before dispatching when a session reload/restart is planned or possible.
---

# Skill: reload-window discipline (operator)

## Why
A `/reload` (or any session restart) kills in-flight child workers. Work
dispatched into a closing window vanishes mid-flight and returns as
unknown-outcome — the worst state an operator can hand over, and a budget
burn with nothing to show.

## Procedure
1. Before dispatching any child, check whether a reload/restart of this
   session is planned or requested in the brief; if in doubt, report and
   ask — one question beats a vanished worker.
2. If a reload is planned: do NOT start new dispatches. Let in-flight
   workers reach a terminal state first (final report landed, or
   events.jsonl quiet with artifacts verified on disk).
3. If the window cannot wait, hand over instead of racing it: report what
   is done, what is in-flight, and what the next session must re-verify.
4. After any reload, treat prior in-flight dispatches as unknown-outcome:
   reconcile from disk (markers, files, events.jsonl tail) before redoing
   anything — never auto-replay (see `runbook-execution.md`).
5. The same discipline applies to children you spawn: do not hand a child
   a long task if your own termination (budget exhausted, session ending)
   is imminent.
