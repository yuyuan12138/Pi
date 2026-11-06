# Delegation system: dispatch, routing, and acceptance

> **Reproduction notes**: the rule text for this page lives in `instructions/PROJECT-AGENTS.md` (zero inline execution, best-of-N, acceptance gates, Mandatory routing decision) and `instructions/DELEGATION-ROUTING.md` (default ownership table + three explicit exceptions: unavailable-tools / integration-only / trivial-fix). The ownership-check tool is `tools/delegation_gate.py` (two arguments, `--category --owner`; exit 0 = allowed / 1 = policy violation / 2 = bad arguments). Note that it is an advisory check, not a runtime interceptor — reproducing it is as simple as copying the file, but keep its nature in mind: "execution is execution, validation is validation". The global rules file (`~/.pi/agent/AGENTS.md`, sourced from `instructions/PROJECT-AGENTS.md`) also codifies "agent-bound communication is English": prompts, task briefs, and role messages sent to subagents are always written in English; human-facing deliverables follow the human's language.

## Routing decision flow

Before starting any nontrivial work, the primary conversation declares four things: task category, bounded deliverable, execution owner, and acceptance evidence. Default owners: public research → researcher subagent (read-only); implementation and testing → coder / operator subagents (written briefs), with `fork` used only when there is an explicit context dependency, stating what it depends on; review → reviewer (read-only, proposes findings but never edits); deployment → operator (only authorized targets and operations); multi-day iteration campaigns → handed via the coordinator to the project's own primary conversation; requirement understanding, decisions, task briefs, and integration acceptance → the primary conversation itself. Ownership can optionally be validated with `tools/delegation_gate.py`.

## Zero inline execution

As of 2026-11-05, the user explicitly revoked the "the primary can do trivial tasks itself while it's at it" exception: anything the primary conversation can do, a subagent can too. The primary's responsibilities narrow to communication, decomposition, decisions, acceptance, and cross-module integration; it no longer absorbs execution work.

## fork or subagent

`fork` copies the primary conversation's entire context — expensive: the larger the context, the more every forked turn has to re-read. Use `fork` only for tasks that genuinely depend on live conversation state (e.g. an in-progress debugging session), and state the dependency.

## Spawn-first dispatch: subagent_spawn

Since 2026-11-06 the default dispatch is **background `subagent_spawn`** (shipped in `packages/pi-superagent/src/subagent/`): long-running or multi-step operator/coder chains run as background tasks so the primary conversation never blocks on them; the synchronous `subagent` tool (or `subagent_spawn` with `wait=true`) is reserved for short advisor/reviewer opinions or quick bounded checks. By default `subagent_spawn` returns `spawned <id>` immediately and the subagent's milestone reports and final result arrive later as messages — dispatch, release attention, do not poll.

Three optional parameters (commit `0d80c87`):

- **`tools`** — exact tool-name allowlist for the child, validated against the built-in child tools (`read`, `grep`, `find`, `ls`, `bash`, `edit`, `write`); `report_to_parent` is force-appended so background reporting survives any allowlist; `[]` disables all built-in tools (the report tool still stays). A workflow limit, not a sandbox.
- **`session`** — named persistent child session, stored gitignored under `.pi/subagents/sessions/`: created on the first spawn, resumed on later spawns with the same id (use distinct ids for parallel tasks).
- **`wait`** — `wait=true` blocks until the subagent reaches a terminal state and returns its final result text (sync semantics, for short bounded tasks only).

```
subagent_spawn(task="fix the flaky auth test; verify with pytest -q", tools=["read","bash","edit"], session="fix-auth")
# → "Spawned sa7 …" — keep dispatching; reports and the final result arrive as messages.
subagent_spawn(task="one-line check: does settings.json still pin the model?", wait=true)
# → blocks and returns the final text now.
```

**Liveness caveat**: after a background spawn, verify the dispatch is actually live before trusting it — check that the subagent's `events.jsonl` mtime keeps moving and task-specific tokens appear in its log dir (`.pi/subagents/<id>/`) — because spawned ids can collide with stale directories left on disk. Tests: `packages/pi-superagent/tests/subagent.test.ts`.

## best-of-N parallel candidates

For bounded, locally verifiable tasks, the default is to dispatch N subagents in parallel (N=3; may be raised to 5 for hard tasks): each works on an isolated working copy against the same fixed acceptance tests, with no shared writes. When all finish, the primary accepts each one — runs the tests, inspects the diff, checks the deliverable — and adopts the best, reporting all N outcomes honestly (which passed, which failed, and why). Acceptance criteria are identical for every candidate; never delete or weaken tests to make one pass.

## Acceptance gate

A subagent reporting PASS does not equal acceptance done: the primary must personally inspect the actual diff and key evidence. A passing API does not equal a usable browser flow, and a success response from an idempotent retry does not equal the flow having actually rerun. `delegation_gate.py` is only an advisory check (exit 0 = allowed / 1 = policy violation / 2 = bad arguments), not a runtime interceptor and no proof that a subagent actually ran — it validates the *declared* ownership, not the fact itself.
