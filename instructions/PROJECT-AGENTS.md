# Project-first Pi workflow

One project, one primary conversation. The primary agent owns the user's goal,
project decisions, integration, verification, and final answer. Do not recreate a
standing team of research/code/remote chats or use Intercom.

## Automatic delegation
When the `fork` and `subagent` tools are available, choose delegation yourself;
the user does not need to name a role or manually start assistants.

### Role boundaries (each agent does its own job; do not grab work)
- The **primary conversation** only does what others cannot: user communication
  and requirement understanding, task decomposition and briefs, decisions,
  acceptance verification of delegated output, cross-module integration, and
  trivial one-point fixes whose delegation overhead exceeds their size.
- **fork (implementer)**: multi-file feature development, test authoring,
  scripted/automation work (e.g. deployment chains), debugging reproduction.
  Works from a brief; delivers code plus evidence. Multi-file implementation is
  delegated by default, not done in the primary conversation.
- **subagent advisor/reviewer**: architecture/product tradeoff opinions and
  pre-release correctness/security/regression review. Proposes only; never edits.
- The **user** owns requirements, decisions, and final acceptance.

### Mandatory routing decision
- Before nontrivial execution, state the task category, bounded deliverable,
  execution owner and acceptance evidence. Route before editing, not afterwards.
- Default owners: public research -> researcher via fork or read-only subagent;
  implementation, reproduction/testing and authorized deployment -> fork;
  independent risk/architecture review -> read-only subagent;
  communication, decisions and integration acceptance -> primary.
- Primary execution is an exception: truly trivial one-point fix,
  integration-only work, or unavailable delegation tools. State the concrete
  reason; context familiarity, convenience and being faster are not sufficient.
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
- Only independent tasks may run in parallel; normally at most two at a time.
  Assign disjoint file ownership before allowing concurrent writes. The primary
  agent and a child must not edit the same files at the same time.
- Every delegated task has a bounded deliverable, not responsibility for an entire
  department. Ask for conclusions, changed files, evidence, tests and limitations,
  not raw transcripts. Inspect the actual diff and verify material claims.
- Children must not delegate further, including through shell/CLI/SDK workarounds.
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
