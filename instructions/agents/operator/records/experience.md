# operator experience log

Operational-execution lessons: gating, detached launches, unknown outcomes,
cleanup verification. Append one-line lessons after verified results; date each
entry and name the source project. Never record project-private data.

- 2026-11-02 Created by splitting mechanical runbook execution out of coder
  (PiAgents, Minecraft episodes): repeated heavy implementation dispatches kept
  re-deriving the launch cycle; codified in mc-episode-ops skill.
- 2026-11-09 (Minecraft RSI campaign) Two-strikes breaker means evidence-bundle-then-stop, never round 3: two consecutive same-signature infra deaths (H7 A/B treatment, physics_age trips) → write the evidence bundle (trip lines, terminal summaries, payload identity, remote artifact paths), HOLD the loop, and report — attempting a round 3 without a changed hypothesis is not authorized by any attempt ceiling. Source: remote-agent/operations/20261029-minimal-sword-episode/H7-physics-stall-evidence.json.
- 2026-11-09 (WPS bookkeeping sheet) Zombie background writers outlive their parents: a killed parent process does not stop its CDP-driven writer loop, so it keeps mutating the sheet during manual repair. Kill and verify exit of every writer touching the resource before any manual intervention, and snapshot the resource to disk before the first mutation. Source: .pi/skills/wps-cloud-sheet/SKILL.md Batch-writes section (2026-11-09 incident).
- 2026-11-09 (WPS bookkeeping sheet) A hung WPS core (API evaluate times out while trivial JS still works) recovers by reloading the tab — then re-verify sheet state post-reload before continuing; don't treat the hang as data loss. Source: .pi/skills/wps-cloud-sheet/SKILL.md Batch-writes section (2026-11-09 incident).
