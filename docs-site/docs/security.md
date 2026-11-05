# Security boundaries

> **Reproduction notes**: this page's defenses come in two kinds — do not conflate them. Technical defenses are copyable: `tools/git_guard.py` + `.githooks/pre-commit` (enabled with `git config core.hooksPath .githooks`). Rule defenses are **text** executed by the primary conversation: authorization clauses live in the global rules (`instructions/PROJECT-AGENTS.md`, the "Delegation does not expand authorization" section), and subagent hardening plus "never weaken security checks" are written in each role's Boundaries section (e.g. `instructions/agents/coder/AGENTS.md`). The latter has no automatic enforcement — reproducing it means copying the rules and keeping the primary conversation honest about following them.

## Delegation does not expand authorization

Delegation grants no new authority: no new installs, no touching remote machines, no publishing, no destructive operations, no credential access beyond the task. Parallel candidates must own disjoint files, and the primary conversation and a subagent must not edit the same files at the same time. Be clear about what tool allowlists and cwd limits really are: they are workflow constraints, not OS sandboxes — subagents run under the host user's permissions, so authorization must be written into the brief and kept minimal.

## Subagent hardening

Worker subagents are started with `--no-extensions --no-mcp --no-approve --offline`; a credential denylist blocks `auth.json` / `models.json`; cwd is pinned inside the dispatching project (with realpath validation); Telegram sub-channels are disabled. Fork children disable MCP and project-level startup configuration; cancellations, errors, empty output, and non-zero exits are never dressed up as success.

## Git and secrets

Local commits only: no remotes added, no push, no PRs, unless the user explicitly approves. Staging uses explicit paths; blind `git add .` / `git add -A` is forbidden. Every repo runs the shared `.githooks/` staged-content guard, which scans for common credential patterns and dangerous paths — it is best-effort, not DLP: if the guard blocks you, you must not disable it just to make the commit pass; the right move is to move the sensitive content out of staging. Also remember two easily-forgotten facts: ignoring a file does not untrack it (Git history keeps it), and revert/delete commits do not purge secrets from history — once something is exposed, contain it and notify the user.

## Other defense lines

- **Knowledge base**: the index configuration allows only two workspace roots + a text-extension whitelist, excluding credential / private / session directories and suspicious filenames; SQLite is mode 0600 but not encrypted; retrieved content entering a cloud model's context requires authorization awareness.
- **Multi-project coordinator**: model calls off by default; crashed mutating tasks are recorded `unknown-outcome` and never auto-replayed.
- **The red line shared by all roles**: report failures honestly and never manufacture the appearance of completion — if tests fail or verification is blocked, say so instead of faking a clean checkpoint just before the report.
