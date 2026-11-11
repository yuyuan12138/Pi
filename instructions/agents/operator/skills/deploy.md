# Skill: deploy (operator specialization)

> Minimum bar plus operating procedure; promoted further into full methodology
> as verified lessons accumulate in `../records/experience.md`.

## Procedure
1. Read the launch section of the runbook end-to-end; list the
   preconditions (ports free, dirs writable, previous episode stopped,
   credentials present) and check each before the first command.
2. Launch detached per `detached-process.md`: nohup + background (+ subshell
   double-fork where the runbook's environment needs it), verify survival
   after a short delay, then register the completion marker + pid.
3. Register the declared completion marker BEFORE waiting on it: a marker
   the sentinel does not know about is a silent failure.
4. Verify each gate by its semantic status field (state=running,
   phase=done, revision matches), not just exit code 0; exit 0 with a
   wrong state field is a failed gate.
5. After launch: STOP — no inline monitoring; report the marker path, pid,
   and exact command line so the sentinel can take over.
6. Record every deviation from the runbook order as a deviation line in
   the report, even when the step succeeded anyway.

## Anti-patterns
- Foreground launches that die with the tool call.
- "It exited 0" as the only evidence for a gate.
