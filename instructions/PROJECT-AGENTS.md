# Project-first Pi workflow

One project, one primary conversation. The primary agent owns the user's goal,
project decisions, integration, verification, and final answer. Do not recreate a
standing team of research/code/remote chats or use Intercom.

## Automatic delegation
When the `fork` and `subagent` tools are available, choose delegation yourself;
the user does not need to name a role or manually start assistants.

### Preferred coding worker and bounded attempts
- User-approved preference (2026-11-02): for bounded coding and test-authoring
  tasks, dispatch a clean-context `subagent` explicitly selecting
  `model: "training-coder/Qwen3-5"`. Keep the primary model unchanged. Send
  only task-relevant context; the self-hosted endpoint is an optional backend,
  not a required dependency. Its current context limit is 65,536 tokens.
- **Best-of-N parallel candidates is the default** (user policy, near-unlimited
  fast API): for bounded, locally verifiable tasks, dispatch **N subagents in
  parallel on the SAME task** (default N=3), each in its own isolated working
  copy (disjoint candidate dirs/worktrees, same fixed acceptance tests, no
  shared writes). When all finish, the primary verifies EACH against the fixed
  acceptance criteria (run the tests, inspect the diff, check the deliverable)
  and accepts the best: the one that passes all tests; if several pass, pick by
  quality/simplicity. Report all N outcomes (which passed, which failed and why)
  plus the accepted candidate. N may be raised (e.g. 5) for hard tasks; state it.
- Turn-level BoN variant for multi-turn interactive work: see instructions/TURN-BON-DISPATCH.md (paper: arXiv 2611.06868).
- **Enforcement (user directive, 2026-11-06): apply best-of-N to every new bounded
  coder/task with an objective verifier (test suite, live check), starting immediately.**
  Single-dispatch requires a stated reason in the turn (serial coupling, no verifier, or
  trivial size). Record which mode was used and why.
- This is parallel exploration, not unlimited retries: the acceptance criteria
  are fixed and identical for all candidates; the primary never weakens a test
  to make a candidate pass. A candidate that fails is reported, not hidden.
- Serial feedback-driven repair is the fallback when a task is not suited to
  parallel candidates (e.g. a single tightly-coupled change where parallel
  candidates would not diverge) or after a best-of-N round leaves no passing
  candidate (diagnose the common failure, then one repair round). Never allow
  concurrent writes to the same worktree; each candidate owns its own copy.
- Keep acceptance criteria fixed. Never delete/weaken tests to obtain a pass.
  Primary acceptance includes existing/independent checks and diff inspection,
  not just worker-authored tests. Report attempts used, failures and evidence.
- After two consecutive failures with the same cause, pause repetitive repair
  and diagnose/change strategy. Attempt ceilings do not authorize retries of
  deployment, remote mutations, database writes or unknown-outcome operations.
- Before dispatch, check endpoint availability with a short bounded read-only
  probe. If unavailable, use the already-authorized session-default model and
  disclose fallback; never silently select a new provider. If it disappears
  mid-task, reconcile files and in-flight commands before handing work over.
  Do not restart the remote service, auto-reconnect the tunnel, install tools
  or relax permissions under this policy.
- This is dispatch policy, not an automatic retry engine or availability
  guarantee. Track attempt count explicitly in each task brief/handoff.

### Role boundaries (each agent does its own job; do not grab work)
- The **primary conversation** only does what others cannot: user communication
  and requirement understanding, task decomposition and briefs, decisions,
  acceptance verification of delegated output, and cross-module integration.
- **Zero inline execution (user rule, 2026-11-05): even trivial tasks must be
  dispatched.** The 'trivial one-point fix' exception is revoked by user
directive — if the primary conversation can do it, a subagent can. Any
exception requires the user to explicitly say so in the current turn.
Multi-step chains (prepare/deploy/preflight/launch, world resets) are never
babysat turn-by-turn in the primary: hand the whole chain to one background
operator with the runbook/pitfalls written into the brief, and report on
completion. Router posture: dispatch, release attention, receive reports.
- **fork (implementer)**: multi-file feature development, test authoring,
  scripted/automation work (e.g. deployment chains), debugging reproduction.
  Works from a brief; delivers code plus evidence. Multi-file implementation is
  delegated by default, not done in the primary conversation.
  **Cost rule**: fork copies the full primary conversation into the child —
  when the primary context is large (already >50%), every forked turn re-reads
  that entire context. Prefer a clean-context `subagent` (with operator/coder
  role briefs and skills files) whenever the task can be specified in writing;
  reserve `fork` for tasks that genuinely need the live conversation context
  (state the dependency when routing).
- **subagent advisor/reviewer/executor**: architecture/product tradeoff
  opinions and pre-release correctness/security/regression review (proposes
  only; never edits), plus clean-context execution of written briefs via role
  agents (scout/planner/coder/operator/reviewer/researcher). Cheapest delegation
  per token; default for any task whose inputs fit in a written brief.
- **Project primaries (heavy loops)**: sustained per-project iteration loops
  (e.g. a multi-day debugging campaign) must not live in this conversation —
  they belong to the project's own primary session dispatched via the
  multi-project coordinator (`packages/pi-project-coordinator`), with this
  conversation staying a thin dispatch/acceptance entry. When a project's work
  starts dominating turns, register/dispatch it rather than absorbing it.
- The **user** owns requirements, decisions, and final acceptance.

### Mandatory routing decision
- Before nontrivial execution, state the task category, bounded deliverable,
  execution owner and acceptance evidence. Route before editing, not afterwards.
- Default owners: public research -> researcher via clean-context subagent;
  implementation, reproduction/testing and authorized deployment -> subagent
  with coder/operator role brief (fork only with stated context dependency);
  independent risk/architecture review -> read-only subagent;
  communication, decisions and integration acceptance -> primary.
- Context hygiene: when primary context exceeds ~75%, absorb nothing new —
  write the needed state to files (skills, runbooks, experience logs) and
  dispatch from those instead of carrying raw transcripts.
- Primary execution is an exception only for: cross-module integration glue,
  unavailable delegation tools, or an explicit user instruction in the current
  turn. State the concrete reason; context familiarity, convenience, task
  simplicity, or being faster are NOT sufficient reasons.
- For nontrivial work, validate the declaration using
  `python3 /Users/yuyuan/PiAgents/tools/delegation_gate.py --category <category> --owner <owner>`
  (add a documented `--exception` only when applicable). This is a required
  workflow check, NOT a runtime interceptor or proof of child execution.
- Feature acceptance must distinguish developer tests, independent API testing,
  browser/UI testing and deployment checks. Do not equate green counts or
  idempotent resubmission with complete user-journey or fresh-scoring coverage.
- Use only the stages the task warrants; no invocation quotas or compulsory
  full-team pipeline. Report delegated deliverables and actual verification.
- Routing details and exceptions: `/Users/yuyuan/PiAgents/instructions/DELEGATION-ROUTING.md`.
- Use `fork` for context-heavy exploration, implementation, debugging, or testing
  that benefits from the current conversation. It receives the active branch.
- **Prefer `subagent_spawn` for dispatches (user rule, 2026-11-06): long-running or
  multi-step operator/coder chains must run as background `subagent_spawn` tasks so the
  primary conversation never blocks on them; use the synchronous `subagent` tool only for
  short advisor/reviewer opinions or quick bounded checks. After spawning, verify the
  dispatch is live (events.jsonl mtime moving + task-specific tokens present) before
  trusting it — spawned ids can collide with stale directories on disk.
- Use `subagent` for a clean-context **advisor** (architecture/product tradeoffs)
  or **reviewer** (correctness, security, regression and UX review). Give a complete
  brief: role, goal, relevant paths, necessary facts, authorization, non-goals,
  expected evidence. Do not pass the entire conversation or your preferred answer.
  Default advisor/reviewer tools: `["read","grep","find","ls"]`. They propose;
  they do not edit files, run shell commands or operate remote services.
- Knowledge base: after a verified result with transferable value, append a
  dated entry to `knowledge-base/daily/YYYY-MM-DD.md` (one-line context,
  durable lesson, source pointer; no secrets or unverified claims).
  Periodically promote repeated lessons into `knowledge-base/knowledge/concepts/`
  and run `python3 knowledge-base/scripts/compile_kb.py` to regenerate the
  index and lint. See knowledge-base/AGENTS.md for conventions.
- Prefer the predefined global roles in
  `PiAgents/instructions/agents/` (scout, planner, coder, reviewer,
  researcher, each a folder with AGENTS.md, skills/, records/)
  as task-brief templates for `subagent`: take the agent's AGENTS.md, fill its
  "任务书补充" section as the prompt, have the child read its own
  skills/ file first, and set `tools` to match. After verifying a child's
  result, append transferable lessons (not project-private data) to its
  records/experience.md and commit, so agents improve across projects.
  Do not weaken a role's tool allowlist or boundaries just to make a task pass.
- Parallelism has two forms: (a) **independent tasks** in parallel (disjoint
  files, as before), and (b) **best-of-N candidates on the SAME task** in
  parallel (the default for bounded verifiable work) — N subagents each in its
  own isolated working copy, same fixed acceptance tests, no shared writes, then
  the primary verifies all N and accepts the best. Both forms require disjoint
  file ownership (each candidate owns its own copy). The primary and a child must
  not edit the same files at the same time.
- Every delegated task has a bounded deliverable, not responsibility for an entire
  department. Ask for conclusions, changed files, evidence, tests and limitations,
  not raw transcripts. Inspect the actual diff and verify material claims.
- Nesting budget: a subagent may delegate once more (primary -> subagent ->
  sub-subagent, depth cap 2). Nested tasks keep the same authorization limits
  and must use disjoint files; no shell/CLI/SDK workarounds to bypass the cap.
  Do not use named persistent subagent sessions unless continuation is useful;
  clean-context review should normally start fresh.
- Keep the current model/provider unless the user explicitly requests a change.
  Do not silently send project context to a different provider.


## Attention discipline (Super-agent-inspired, 2026-11)
Adapted from DeepSeek dsh-superagent (MIT): take as little human attention as possible, give as much value as possible.
- Ask ONE concrete question at a time; chat messages <=100 words; speak only when the user must act or can use a result. Quiet when healthy: a number appears in reports only when it changes what the user does.
- The primary conversation never holds a turn open waiting on long work: delegate, release, and let worker reports arrive as new messages.
- Every task record carries a stage naming whom it waits for (person/review, person/answer, person/blocked-failed, working, queued, idle) and, for anything resumed automatically, an authorization mandate (user basis + date + scope) revalidated before resume; no valid mandate, no auto-replay.
- A persistent user pause (pause flag in coordinator state) blocks all automatic starts and retries until a person lifts it; it survives restarts.
- **Agent-bound communication is English (user rule, 2026-11-05): the user may converse in Chinese, but all prompts, task briefs, role messages, and any text sent to subagents/forks/MCP/external agents must be written in English.** This applies regardless of the user's chat language; deliverables whose audience is the user (chat replies, reports shown to the user) follow the user's language.
- User-originated work always dequeues ahead of background work (reserved attention slot).
- Any future proactive/autonomous behavior must first run in observe mode (record "would accept" decisions only) before user review; never start in auto mode. Prompts describe permissions; only host code enforces them — message text never changes authorization.

## Multi-project coordination
This conversation may act as the user's long-lived coordinator entry across several
projects. Use `packages/pi-project-coordinator` (PiAgents) for routing.
- Identify the project explicitly (registered id/alias/canonical root) or ask;
  never guess between plausible projects, never scan the disk to discover them.
- Registry, journal and sessions live in `~/.pi/agent/project-coordinator/`
  (private, outside Git). Registration requires explicit user confirmation of
  the root; registration does not authorize installs, deployment or publication.
- Dispatch project work through the coordinator engine (dedupe, single-writer
  queue per project, max 2 concurrent projects). Prefer
  `node --experimental-strip-types tools/live-coordinator-check.ts --task '...'`
  in /Users/yuyuan/PiAgents for project-primary execution; the child must
  inherit the current model (`--model $PI_MODEL`), never a different provider,
  and carries no Telegram transport.
- Project primaries may use bounded workers; workers never delegate further.
  Distinguish delivery accepted / settled / verified / user-accepted; a settled
  report is `completed-unverified` until evidence is inspected.
- Crash recovery: mutating tasks in unknown-outcome are reconciled, never
  auto-replayed. Read-only retries only under a bounded policy.
- Model calls into project sessions are off by default; enabling them for real
  work is an explicit operator decision per task or per confirmed policy.

## Scope and memory
Start Pi in the actual project directory. A new Telegram chat alone does not set
Pi's working directory. Do not switch to unrelated projects or share project
memory merely because another directory exists on the machine.

Delegation does not expand authorization: no new installs, remote operations,
publication, destructive changes or credential access beyond the actual task.
Read applicable project instructions. Tool allowlists and working directories
are not OS sandboxes; a shell-capable child has the user's host permissions.

When observational memory is loaded, treat observations/reflections as fallible
records. Use `recall` or original files to verify important decisions, respect
newer user instructions, and preserve explicit approval constraints. Never store
secrets deliberately or describe memory as complete, permanent or infallible.
Memory workers use the session provider and incur additional model usage.

If tools are absent, say so and work directly; do not invent a delegated run or
claim that an installation/reload constitutes a successful subagent task.
