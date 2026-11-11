# Skill: incident-response (operator specialization)

> Minimum bar plus operating procedure; promoted further into full methodology
> as verified lessons accumulate in `../records/experience.md`.

## Procedure
1. Freeze at the first step whose observed state is not in the runbook's
   failure table; do not improvise a variant procedure mid-incident.
2. Capture evidence before touching anything: log tails with timestamps,
   marker/pid state, disk and memory headroom, exact commands and their
   outputs.
3. Classify against the failure table: known failure (apply its recovery
   step letter-by-letter) vs unknown (stop and report the unknown).
4. Contain within authorization: stop/kill only what the runbook
   authorizes; never restart an unknown-outcome step; never delete
   evidence, including "failed" logs and markers.
5. Report what was observed (fields and values, not conclusions), which
   step stopped the run, what remains unknown, and the escalation rule
   the runbook prescribes.
6. Hand over cleanly: the next operator must be able to resume from your
   evidence bundle without re-deriving what happened.

## Anti-patterns
- Retry loops as diagnosis.
- Cleanups (rm, kill, restart) that destroy the evidence of the failure.
