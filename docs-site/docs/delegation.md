# Delegation system: dispatch, routing, and acceptance

> **Reproduction notes**: the rule text for this page lives in `instructions/PROJECT-AGENTS.md` (zero inline execution, best-of-N, acceptance gates, Mandatory routing decision) and `instructions/DELEGATION-ROUTING.md` (default ownership table + three explicit exceptions: unavailable-tools / integration-only / trivial-fix). The ownership-check tool is `tools/delegation_gate.py` (two arguments, `--category --owner`; exit 0 = allowed / 1 = policy violation / 2 = bad arguments). Note that it is an advisory check, not a runtime interceptor — reproducing it is as simple as copying the file, but keep its nature in mind: "execution is execution, validation is validation". The global rules file (`~/.pi/agent/AGENTS.md`, sourced from `instructions/PROJECT-AGENTS.md`) also codifies "agent-bound communication is English": prompts, task briefs, and role messages sent to subagents are always written in English; human-facing deliverables follow the human's language.

## Routing decision flow

Before starting any nontrivial work, the primary conversation declares four things: task category, bounded deliverable, execution owner, and acceptance evidence. Default owners: public research → researcher subagent (read-only); implementation and testing → coder / operator subagents (written briefs), with `fork` used only when there is an explicit context dependency, stating what it depends on; review → reviewer (read-only, proposes findings but never edits); deployment → operator (only authorized targets and operations); multi-day iteration campaigns → handed via the coordinator to the project's own primary conversation; requirement understanding, decisions, task briefs, and integration acceptance → the primary conversation itself. Ownership can optionally be validated with `tools/delegation_gate.py`.

## Zero inline execution

As of 2026-11-05, the user explicitly revoked the "the primary can do trivial tasks itself while it's at it" exception: anything the primary conversation can do, a subagent can too. The primary's responsibilities narrow to communication, decomposition, decisions, acceptance, and cross-module integration; it no longer absorbs execution work.

## fork or subagent

`fork` copies the primary conversation's entire context — expensive: the larger the context, the more every forked turn has to re-read. Default to a clean-context `subagent` (sufficient whenever the task can be written as a brief); use `fork` only for tasks that genuinely depend on live conversation state (e.g. an in-progress debugging session), and state the dependency.

## best-of-N parallel candidates

For bounded, locally verifiable tasks, the default is to dispatch N subagents in parallel (N=3; may be raised to 5 for hard tasks): each works on an isolated working copy against the same fixed acceptance tests, with no shared writes. When all finish, the primary accepts each one — runs the tests, inspects the diff, checks the deliverable — and adopts the best, reporting all N outcomes honestly (which passed, which failed, and why). Acceptance criteria are identical for every candidate; never delete or weaken tests to make one pass.

## Acceptance gate

A subagent reporting PASS does not equal acceptance done: the primary must personally inspect the actual diff and key evidence. A passing API does not equal a usable browser flow, and a success response from an idempotent retry does not equal the flow having actually rerun. `delegation_gate.py` is only an advisory check (exit 0 = allowed / 1 = policy violation / 2 = bad arguments), not a runtime interceptor and no proof that a subagent actually ran — it validates the *declared* ownership, not the fact itself.
