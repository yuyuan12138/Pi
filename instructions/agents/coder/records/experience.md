# coder experience log

Implementation lessons: scoping, test strategy, honest reporting. Append one-line lessons after verified results; date each entry and
name the source project. Never record project-private data.

- 2026-10-29 Created in the PiAgents agent library.
- 2026-11-02 (Minecraft infra): wrap SDK calls with mutationStarted so pre-mutation parameter errors stay recoverable while post-mutation rejections abort terminally — a rejected craft does NOT prove no server effect.
- 2026-11-02 (Minecraft infra): mineflayer pre-packet local-check exceptions ('missing ingredient', 'must be holding an item') must be mapped to known machine codes or they degrade to outcome-unknown terminal kills.
- 2026-11-02 (medical-system): class-level @Transactional tests hide lazy-init failures that occur in real HTTP requests; regression tests need NOT_SUPPORTED propagation or commit/reopen.
- 2026-11-02 (Minecraft infra): every layer that independently validates a value (timeout, heap size) must be updated together; missing one layer surfaces as an unrelated transport failure.
- 2026-11-09 (Minecraft RSI campaign) Client-side watchdogs (physics_age) can escalate a recoverable stall into full teardown: trip → fresh_safety_state_required → dispatch errors → actor_terminal outcome_unknown, all within ~12 s. Before adding retries, check the escalation chain a watchdog triggers — retrying inside that chain just re-dies. Source: remote-agent/operations/20261029-minimal-sword-episode/H7-physics-stall-evidence.json.
- 2026-11-09 (Minecraft RSI campaign) Repeated same-signature deaths on byte-identical payloads (same source_sha256 as a run that completed cleanly) are an infra-flake class, not a code bug — verify payload identity (source_sha256, trip lines, healthy-baseline physics_age ≤40 ms vs 1213/1624 ms trips) before changing any code. Source: remote-agent/operations/20261029-minimal-sword-episode/H7-physics-stall-evidence.json.

## 2026-11-11 · org-graph iteration series (verified via merged commits e78ed24..3ebdfbf)
- Task-brief placeholders like <MEMBER_ID> kill worker dispatches: members probe env for their own identity, find nothing, and end without working. Always write explicit values (fixed dirs, explicit names) into briefs. [bridge-org-x1 sa8 fanout failure, zero artifacts]
- 3+ concurrent subagents on one shared vLLM starve siblings: events.jsonl freezes mid-reasoning and no files land. Remedy: serial dispatch for heavy creative work; an events.jsonl mtime frozen >2min during a GLM reasoning phase is normal, frozen during bash work is death.
- A subagent's empty/missing final report is NOT evidence of failure: check events.jsonl tail + on-disk artifacts before re-dispatching (sa10/sa11 "done (no text)" had delivered files; sa8-b had not).
- Concurrent edits to one file by in-flight workers = merge hazard; steer the in-flight worker (subagent_message) instead of dispatching a second writer.
