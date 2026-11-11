<!--
POSTMORTEM template (Project-Space Standard §5). Model: blameless postmortem.
Budget: ≤150 lines. Trigger: any incident that cost a run, corrupted evidence,
or tripped a safety/breaker mechanism.
Save as docs/postmortems/<incident-id>.md; link from the related work record.
Blameless: name mechanisms, never workers.
-->
# Postmortem — <incident id> (<date>)

**Analyst**: <who wrote it> · **Evidence**: `<log paths>`, `records-<run_id>/`,
`<world/state files>`
<!-- Pattern (AUTOPSY-wave30): analyst, date, and every evidence source listed
     up front, including the isolated repro environment. -->

## Impact
<!-- Numbers: cost (requests/tokens/time), lost work, what was NOT affected. -->

## Timeline (UTC, from logs — not memory)
| Time | Event |
|---|---|

## Root cause
<!-- The mechanism, proven with evidence; reproduce in isolation if possible.
     Bar to meet (AUTOPSY-wave30): "the wooden pickaxe broke between req ~105
     and req 130; from req 130 all stone digging was bare-hand; vanilla 1.21.6
     removes the block but awards no stat and no drop" — proven via region-file
     diff + isolated throwaway-server repro. -->

## What went well / What went poorly
<!-- 2-4 bullets each; mechanisms only. -->

## Action items
| Item | Lands in | Status |
|---|---|---|
| <fix/lesson> | ADR / runbook / code commit / KB daily | done/open |
<!-- Pattern (AUTOPSY-h7): two-strikes infra breaker — two identical death
     signatures → STOP, no auto round 3, handoff to human. -->

## Cross-project lessons
<!-- Anything transferable → knowledge-base/daily/YYYY-MM-DD.md. -->
