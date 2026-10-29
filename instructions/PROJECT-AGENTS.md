# Project-first Pi workflow

One project, one primary conversation. The primary agent owns the user's goal,
project decisions, integration, verification, and final answer. Do not recreate a
standing team of research/code/remote chats or use Intercom.

## Automatic delegation
When the `fork` and `subagent` tools are available, choose delegation yourself;
the user does not need to name a role or manually start assistants.
- Do simple short tasks directly. Do not add a planning/review pipeline to every edit.
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
