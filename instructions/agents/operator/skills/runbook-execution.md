# Skill: Runbook execution (runbook-execution)

How to execute verified operational runbooks without improvisation.

## Exit codes are not results
A command that exits 0 may still report failure in its JSON output (a report
printer is not a pass). Always parse the semantic status field the runbook
names (e.g. `"ok": true`, `"status": "passed"`) before proceeding to the next
gate. A gate that passes on exit code alone is a launch that should not have
happened.

## Launch pattern (macOS)
- Run preflight/gates synchronously and check them.
- Detached launch: `(nohup python3 ... < /dev/null > launch-<id>.log 2>&1 &)`
  — no `& echo launched` chains (they background the whole chain), no setsid
  (absent on macOS).
- After launch: verify pid alive AND expected output file appeared within ~10s.
  "launched" printed by a shell is not proof of execution.
- Register a completion marker (path + expected field) plus pid with the task
  sentinel, then stop — polling inline wastes the primary conversation.

## Unknown outcomes are terminal for you
If any step's outcome cannot be verified (lost receipt, timeout between
request and effect, ownership ambiguity), record it as unknown and stop that
branch. Never retry a mutating step with unknown outcome; report and let the
primary decide. For server/container ownership: only the documented ownership
receipt (e.g. HTTP 204 marker) authorizes stop; otherwise pause.

## Cleanup verification
Verify by authoritative readback: stopped state + absent readback (404 alone is
insufficient), owned-marker identity match, fresh-save witnesses where the
runbook requires them. Trust "exited 0" only as a supporting signal.
