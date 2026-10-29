# Project-first Pi architecture — 2026-10-29

## Desired interaction

```text
Project A / primary Pi conversation (cwd = Project A)
  ├─ fork: active-branch context → bounded work → evidence-linked report
  ├─ subagent: fresh advisor brief → independent advice
  ├─ subagent: fresh reviewer brief → independent review
  └─ observational memory: session-local observations/reflections + recall

Project B / separate primary Pi conversation (cwd = Project B)
  └─ its own children and session memory
```

Automatic dispatch is model behavior guided by `instructions/PROJECT-AGENTS.md`,
not a deterministic guarantee that every task launches a child. Simple work stays
in the primary conversation. No Intercom, standing specialist sessions, daemon,
cron, or forced scout/planner/worker/reviewer pipeline is introduced.

## Sources and integration

The user supplied the text of **My powerful Pi agent Setup** after Reddit returned
403. Author claims about superior performance/endless memory are not independently
verified. This setup adopts its division of responsibilities, not those claims.

Reviewed local source packages are under `packages/`; no install scripts or npm
runtime dependencies are needed. Each keeps its upstream MIT license and README.
They are local adaptations, **not unmodified upstream installations**:

- `pi-fork`: `elpapi42/pi-fork`, revision
  `e69725c396030cb9e3b119286beca53f47a2305f`.
  <https://github.com/elpapi42/pi-fork>
- `pi-minimal-subagent`: npm `0.1.0`. Upstream targets Pi 1.4.0; this copy is adapted
  and checked against the installed Pi 1.3.0 instead of upgrading Pi implicitly.
  <https://www.npmjs.com/package/pi-minimal-subagent>
- `pi-usage-log`: first-party local extension (packages/pi-usage-log). Logs
  per-turn token/cost/tool usage to `~/.pi/agent/usage/YYYY-MM-DD.jsonl` and
  adds a `/usage` summary command. Offline; write failures never break a session.
- `pi-observational-memory`: npm `3.1.4` (V3).
  <https://github.com/elpapi42/pi-observational-memory>

Code mapping and RTK optimization are deliberately not installed in this change.
Intercom remains uninstalled. Original specialist repositories, skills, research,
worlds and operation records remain intact as legacy/supporting material.

### Local adaptations

- Fork configuration obeys project trust. Fork children disable MCP and project
  startup configuration; global `pi-fork.extensions: []` prevents Telegram,
  recursive delegation and extra memory workers from loading in children.
- Forks do not forward a CLI API key, wait for `agent_settled` before semantic
  completion, and do not turn cancellation, errors, empty output or nonzero exit
  into success. Normal Pi provider retry policy is unchanged.
- Independent subagents disable extensions/MCP/project startup configuration and
  package/catalog startup network work. Only explicitly supported built-in tools
  may be selected; the default filters the parent's tool set. No Telegram child.
- Subagent CWD stays within the dispatching project, including realpath checks.
  Optional persistent child sessions are namespaced by canonical project path.
  This is **not** filesystem/network/process isolation.
- Memory uses trusted project overrides only. Session/tree/shutdown generations
  invalidate delayed memory writes. This prevents stale writes across those
  observed lifecycle transitions; it does not cancel an already-started provider
  request or prove every possible lifecycle race absent.
- A partial prepared observation ledger does not replace an unobserved source
  span during compaction; that cut falls back to Pi's native summarizer.
  This is still lossy summarization, not a lossless-memory guarantee.
- Memory model is not overridden: workers use the session's provider/model.
  Debug logging stays off. Memory is session/branch based, not a global vector
  database and not an automatic cross-project knowledge store.

## User configuration and workflow

Global configuration: `~/.pi/agent/settings.json`. Global instructions:
`~/.pi/agent/AGENTS.md` points to `instructions/PROJECT-AGENTS.md` in this repository.
Existing Telegram configuration and credentials are not modified.

Start one process/session from each real project directory:

```sh
cd /absolute/path/to/project-a
pi
# another terminal/project:
cd /absolute/path/to/project-b
pi
```

In a Telegram setup, each project conversation/thread must be bound to the Pi
instance for that directory using the bridge's supported routing. Merely opening
another chat or naming a conversation does not change `cwd`. This change does not
create chats/topics, move current sessions, or alter bot routing automatically.

Prefer a **new clean project session** after activation rather than importing the
large historical coordinator conversation into the new architecture. Existing
sessions keep their history; restart or use the native Pi terminal `/reload` to
load changed extensions. A Telegram message containing `/reload` is not proof
that the native command executed.

Useful native commands after activation:
- `/subagents`: view independent child task status in the terminal UI.
- `/om:status`: memory state and worker failures.
- `/om:view full`: inspect recorded memory (also attempts a clipboard copy).

## Validation and rollback

See `tools/test_project_architecture.mjs` for offline host-loader and fake child
process checks. These verify registration, invocation options, context separation,
result/error handling and selected lifecycle guards without model API calls.
They are not evidence of model quality, real provider compatibility, weeks-long
memory retention, OS isolation, or Telegram routing to multiple projects.

To disable this architecture, remove only these three local package sources from
Pi settings and unlink the global AGENTS.md only if it still points to our file.
Keep Telegram, user sessions, and all legacy data. Source copies are versioned
here; global settings backups stay private under `~/.pi/agent/backups/`.
