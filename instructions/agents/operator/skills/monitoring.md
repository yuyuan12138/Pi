# Skill: monitoring (operator specialization)

> Minimum bar plus operating procedure; promoted further into full methodology
> as verified lessons accumulate in `../records/experience.md`.

## Procedure
1. Restate the declared markers, log paths, poll interval, and total
   window from the runbook before the first poll; anything unstated is a
   gap to report, not an assumption to fill.
2. Poll on the stated interval with a bounded loop (hard timeout); a poll
   that can run forever is a runbook bug to report, not to work around.
3. Report observed fields with timestamps: the exact lines/fields read
   (marker state, progress counters), not a summary like "looks healthy".
4. A missing marker at window end is an unknown outcome — reported as
   unknown, never extrapolated to "probably fine" and never retried
   without instruction.
5. Distinguish process state from functional state: a live pid is not a
   working episode; check the progress marker the runbook defines.
6. On anomaly: capture evidence first (log tail, marker state, process
   table), then follow `incident-response.md`; never restart on your own
   judgment unless the runbook's failure table says to.

## Anti-patterns
- Inferring health from the absence of errors in a log you did not open.
- Unbounded polling loops with no timeout.
