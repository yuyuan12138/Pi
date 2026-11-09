# PiAgents — a personal operating system for AI worker fleets

One router conversation dispatches every task to clean-context subagents, then verifies their work against real files and tests — all execution happens in disposable workers, and every rule, role brief, and memory layer is plain text in this repo. Core thesis: **correctness comes from architecture, not model IQ**.

> 📚 Architecture documentation portal (English): [docs-site/](docs-site/README.md) (overview + delegation system / nine roles / multi-project coordinator / knowledge base / security, incl. a single-page [index.html](docs-site/index.html) tour; Chinese edition: [zh/README.md](docs-site/zh/README.md))
>
> 👋 New here? [ADOPTING.md](ADOPTING.md) takes you from zero to this setup in about 30 minutes.
>
> 🏠 Product overview: [yuyuan12138.github.io/piagents](https://yuyuan12138.github.io/piagents/) — architecture, verification loop, live subagent panels
>
> ✍️ Blog post: ["The time my AI claimed 26 test failures were the environment"](https://yuyuan12138.github.io/2026/11/09/pi-agent-architecture/)

PiAgents is a personal operating system for coordinating dozens of AI workers from one router conversation. The router (the primary conversation) only understands requirements, writes briefs, dispatches, and verifies; all execution happens in clean-context subagents, context-inheriting forks, and per-project primary sessions. The core thesis: **correctness comes from architecture, not model IQ** — fixed acceptance tests, filesystem-checked evidence, scope-gated memory, and auditable state make an ordinary mid-tier model (currently GLM-5.3-Flash served through a local vLLM tunnel) reliably productive, and keep a stronger model from quietly failing anyway. Everything is plain text: Markdown rules, role templates, vendored Pi extensions, and a few small scripts. No hidden binaries, no cloud dependency.

Verified running on [pi](https://github.com/earendil-works/pi) 1.3.0, but not bound to it: any framework with "a main loop + subtask spawning" can adopt the design. See [PROJECT-ARCHITECTURE.md](PROJECT-ARCHITECTURE.md) for upstream provenance and local adaptations, and [docs-site/](docs-site/README.md) for the full reproduction guide.

## Architecture overview

```text
                User (requirements · decisions · final acceptance)
                                  │
 ┌──────────────────────────────────────────────────────────────────────┐
 │ PRIMARY CONVERSATION = router — one per project, cwd = project root  │
 │ only does: requirements · written briefs · decisions · acceptance ·  │
 │            cross-module integration          (zero inline execution) │
 └──────────────────────────────┬────────────────────────────────────┘
                                │ dispatch via two channels
          ┌─────────────────────┼─────────────────────┐
          ▼                     ▼
   subagent_spawn         fork (by exception)
   background headless    copies the active
   workers — the default; session branch into
   report_to_parent       an isolated worktree;
   milestone reports      context-inherit
   arrive as messages,
   never polling
          └─────────────────────┼─────────────────────┘
                                ▼
 ┌──────────────────────────────────────────────────────────────────────┐
 │ ROLE BRIEFS — instructions/agents/, 9 templates: scout · planner ·   │
 │ coder · operator · reviewer · researcher · visualizer · writer ·     │
 │ designer  (each: AGENTS.md brief + skills/ method + experience log)  │
 └──────────────────────────────┬────────────────────────────────────┘
                                ▼
 ┌──────────────────────────────────────────────────────────────────────┐
 │ VERIFICATION GATES — best-of-N candidates on fixed acceptance        │
 │ tests · primary inspects the actual diff · advisory ownership        │
 │ check (tools/delegation_gate.py; real tool_call interception         │
 │ for fork) · worker hardening (no-extensions/MCP/approve,             │
 │ credential denylist)                                                 │
 └──────────────────────────────┬────────────────────────────────────┘
                                ▼  verified results only
 ┌──────────────────────────────────────────────────────────────────────┐
 │ MEMORY LAYERS                                                        │
 │ 1 session observations/reflections (pi-observational-memory)         │
 │ 2 daily decision log   knowledge-base/daily/YYYY-MM-DD.md            │
 │ 3 distilled concepts   knowledge/concepts/ (scope + approval gated)  │
 │ 4 sourced wiki         knowledge-base/wiki/ (confidence-tagged)      │
 │ + pi-memory-index (installed): cross-session SQLite FTS5             │
 │   memory_search                                                      │
 └──────────────────────────────────────────────────────────────────────┘

 ════════════ cross-project coordination layer (optional) ════════════
  Project A primary ──┐
  Project B primary ──┼──▶ pi-project-coordinator
  …                   │    registry (explicit ids only, never disk
                      │    scanning) · per-project FIFO queues ·
                      ▼    single-writer lease · crash-safe journal
                           (SQLite)
```

## Dispatch discipline

Three channels, chosen per task; the router dispatches and releases attention instead of babysitting:

- **Background `subagent_spawn` (default since 2026-11-06).** Headless `pi` workers with a `report_to_parent` protocol — `progress` / `blocked` / `ready` arrive as messages, the main context never sees a worker transcript, and full logs stay on disk for on-demand `subagent_result log=true`. Supports `fanout`, `isolate` worktrees, tool allowlists, persistent named sessions, depth-3 recursion and a per-agent spawn budget. The router never holds a turn open on long work.
- **`fork` — context inheritance, by exception only.** It copies the whole primary conversation into the child, so every forked turn re-reads the context. Requires a stated `[fork-context: …]` dependency, enforced by a real tool-call gate (`pi-delegation-gate`), not just policy text.
- **Sync `subagent` — retired 2026-11-09.** Its remaining capabilities (allowlists, sessions, wait) were absorbed into `subagent_spawn` (commit `0d80c87`); the package was removed from the live `settings.json`, making `subagent_spawn` the only dispatch tool.

**Best-of-N parallel candidates** is the default for bounded, locally verifiable work: N=3 (up to 5 for hard tasks) subagents run the same task in isolated working copies against identical, fixed acceptance tests, no shared writes; the primary verifies each candidate — runs the tests, inspects the diff, checks the deliverable — and accepts the best, reporting all N outcomes. Acceptance criteria are never weakened to make a candidate pass. For interactive work too long to run N times end-to-end, a turn-level variant (Turn-BoN, [instructions/TURN-BON-DISPATCH.md](instructions/TURN-BON-DISPATCH.md)) samples N candidates for the next step only and executes one.

**Verify everything against the filesystem.** A subagent's PASS report, a commit record's gate numbers, a tool's green output — all are claims until the primary re-checks against real files, logs, and server state. Three incidents that shaped this rule:

- A commit record declared 26 failing containerized tests "pre-existing environmental"; a baseline A/B with the previous payload on the same machine proved the new payload itself caused them (fixed in commit `a367fef`).
- A spawned subagent id collided with a stale log directory from the previous day and its transcript was polluted with old content — since then every background dispatch is liveness-checked (log `events.jsonl` mtime moving + task-specific tokens present).
- A server-side verification tool grepped a stats string that exists in no real file format, so it returned 0 forever — a false negative caught only by reading the actual on-disk format.

## The nine roles

Brief templates in `instructions/agents/` — not resident processes. The router fills the task-brief fields (project root, goal/scope, relevant paths, authorization/prohibitions, expected evidence), sets the tool allowlist, and has the child read its own skill file first.

| Role | One line |
|---|---|
| **scout** | Maps structure and locates code to `path:line`; never judges design. |
| **planner** | A verifiable ≤6-step plan with explicit tradeoffs (two options per key decision). |
| **coder** | Minimal changes + self-testing within specified files; reports implemented / tested / unverified honestly. |
| **operator** | Mechanically executes a verified runbook (start, monitor, clean up); never retries unknown-outcome operations. |
| **reviewer** | Read-only graded review (correctness → security → regressions → test gaps → UX) with `path:line` evidence; proposes, never edits. |
| **researcher** | Public research with primary-source verification; every conclusion carries a link and an uncertainty tag. |
| **visualizer** | Real charts/diagrams/HTML from real data; labels "explanation ≠ proof". |
| **writer** | Documentation in the user's style; self-updates its skill from feedback. |
| **designer** | Redesigns looks without touching data flow; removes AI slop without losing information. |

After a verified result, transferable lessons are appended to the role's `records/experience.md` and committed, so roles improve across projects.

## Memory: four layers plus a full-text index

1. **Session observations** (`pi-observational-memory`): observations/reflections and hierarchical compaction keep long sessions coherent; delayed writes are invalidated across session/tree/shutdown generations.
2. **Daily decision log** (`knowledge-base/daily/YYYY-MM-DD.md`): one dated entry per verified result — context, durable lesson, source pointer. Decisions and outcomes, never transcripts.
3. **Distilled concepts** (`knowledge/concepts/`): promoted lessons with frontmatter metadata. A fail-closed gate (`scripts/compile_kb.py`) requires `scope: global` concepts to cite evidence from ≥2 distinct projects **and** `approval: user-approved`; unapproved or stale (90-day) content is warned and treated as project-local. Motivation: a naive global memory pool scored worse than no memory (arXiv 2609.29144).
4. **Sourced wiki** (`knowledge-base/wiki/`): user-facing topic pages of external experience, each entry confidence-tagged by whether the source page was actually read.

**`pi-memory-index` (new, installed):** a cross-session SQLite FTS5 `memory_search` tool over *distilled* memory only — compaction observations, daily entries, concepts — with project scoping, time windows, and drill-back through `recall(obs_id)`. Rows pass a credential-regex screen before insert; raw tool output is never indexed; CJK-aware tokenization (jieba with a disclosed bigram fallback). No embeddings, no LLM calls.

The knowledge base deliberately stays small (tens to low hundreds of articles, no vector DB); Git history is the tamper-evident audit trail, and writes only happen from the owning conversation. See [knowledge-base/AGENTS.md](knowledge-base/AGENTS.md) for scope/approval gates.

## Harness self-improvement

The dispatch layer tunes itself the same way work is dispatched — with a human gate:

- **`harness2/`**: a v0 observe-mode harness-optimization loop (inventory → propose → probe → journal) for tuning the dispatch layer itself.
- **Closed-loop experiment engine** (in progress, honestly marked): error ledger → LLM hypotheses (hot-path only, each with a falsifiable prediction) → controlled A/B on a real task environment → rule-based accept gate → apply with revert procedure. Observe mode records "would accept" decisions only; live apply requires an explicit human flag. State checkpoints after every step; crashed experiments are never replayed. There is deliberately no auto-accept: acceptance is the human's, at the gate.

## Repository layout

| Path | What it is |
|---|---|
| `packages/` | Vendored Pi extensions, source-tracked and loaded directly from here (see table below). |
| `packages/pi-web-bridge/` | Web mission control (127.0.0.1:7788) for the running session — coordinator conversation, live per-subagent panels, message injection. |
| `extensions-src/memory-index/` | Source of the `pi-memory-index` FTS5 extension (installed at `~/.pi/agent/extensions/memory-index/`). |
| `instructions/` | Operating rules: `PROJECT-AGENTS.md`, `DELEGATION-ROUTING.md`, `TURN-BON-DISPATCH.md`, `GENERAL-ARCHITECTURE.md`. |
| `instructions/agents/` | The nine role folders (brief template + skills + experience log). |
| `knowledge-base/` | Four-layer knowledge base with compile/lint scripts and gates (independent repo). |
| `docs-site/` | Reproducible architecture guide — English with Chinese mirror, plus single-page `index.html`. |
| `tools/` | `delegation_gate.py` (advisory ownership check), harness/coordination tools, test suites. |
| `.pi/skills/` | Coordinator skills: `workspace-checkpoint`, `mc-rsi-episode`, `vultr-vps-ops`, `info-router-sources`, `wps-cloud-sheet`, `notion-migration`, `hbench-ab`. |
| `remote-agent/` | Independent legacy repo (operations records kept for provenance). |
| `research-agent/`, `internet-search-agent/` | Independent legacy repos: paper registry, and bounded public-source search (dependency-free `tools/search.py`). |
| `harness2/` | Observe-mode harness-optimization loop (v0). |
| `agents.json` | Multi-project coordinator registry snapshot (live state lives in `~/.pi/agent/project-coordinator/`, private). |

## Installed Pi extensions

One npm package plus eight locally vendored/local extensions (loaded directly from `packages/` so the running Pi always matches committed source); `pi-memory-index` loads from the user extensions dir.

| Extension | Origin | Role |
|---|---|---|
| `pi-telegram` | npm:`@llblab/pi-telegram` | Telegram bridge with source-gated delivery and a FIFO queue. |
| `pi-superagent` | vendored (DeepSeek `dsh-superagent` port), security-adapted | **Primary dispatch layer**: `subagent_spawn` headless workers + `report_to_parent` milestone protocol; `fanout` (1–3) best-of-N, `isolate` worktrees, tool allowlists, depth-3 recursion, per-agent budget, lineage; worker hardening (`--no-extensions --no-mcp --no-approve --offline`, credential denylist blocking `auth.json`/`models.json`, cwd confinement). Worker model: explicit `model` spawn arg > `PI_SUBAGENT_MODEL` env > fallback alias (currently **training-coder/GLM-5.3-Flash** via a local vLLM tunnel) — the session model is NOT inherited, so export `PI_SUBAGENT_MODEL=training-coder/GLM-5.3-Flash` if you rely on the fallback. |
| `pi-fork` | vendored (`elpapi42/pi-fork`) | `fork` tool: context-heavy delegated work in an isolated worktree; children get no MCP/extra extensions. |
| `pi-minimal-subagent` | vendored (npm 0.1.0, adapted) | Sync `subagent` tool — **removed from live config 2026-11-09** (kept in-repo for reference); capabilities absorbed into `subagent_spawn`. |
| `pi-observational-memory` | vendored (npm 3.1.4, V3) | Session observations/reflections/compaction memory. |
| `pi-usage-log` | local | Per-turn token/cost JSONL + `/usage` command; offline, write failures never break a session. |
| `pi-delegation-gate` | local | Real `tool_call` interception: `fork` without a stated context dependency is blocked; allowed forks are logged. |
| `pi-memory-index` | local (`extensions-src/`) | Cross-session SQLite FTS5 `memory_search` over distilled memory; credential-screened, project-scoped, jieba CJK tokenization. |
| `pi-web-bridge` | local (since `fe02dda`) | Web mission control: a local web UI on 127.0.0.1:7788 (hero coordinator conversation + right LIVE WORK panel with per-subagent status, slide-over transcripts with reply composer) injected into the running session; subagent replies ride the coordinator's `subagent_message` fallback. |

## Reproduce / quickstart

The full step-by-step reproduction guide lives in the [docs-site](docs-site/README.md) (architecture, delegation, coordinator, knowledge base, security — each page opens with "Reproduction notes" naming the exact rule files to copy). In short: clone this repo, install the packages listed above into `~/.pi/agent/settings.json`, drop `extensions-src/memory-index` into `~/.pi/agent/extensions/`, and start one session per project directory:

```sh
cd /absolute/path/to/your-project
pi
```

The router session needs no role chats and no daemons — it dispatches to subagents itself. `/subagents`, `/usage`, `/om:status` are useful native commands; a Telegram `/reload` message is not proof the native command ran, and opening a chat does not change the working directory.

## Honest limits

- **Guards are advisory or workflow-level, not sandboxes.** Tool allowlists and cwd limits constrain workflows; children still run under the host user's permissions. `delegation_gate.py` validates *declared* ownership and is not a runtime interceptor; only the `fork`-context rule has real interception. No Pi hook can prove a child actually ran.
- **Local Git is not backup, and not encryption.** Ignore rules exclude runtime state and credentials, but ignoring a file does not untrack it, and revert/delete commits do not purge secrets from history. The shared `.githooks/pre-commit` staged-content guard is best-effort, not DLP; never disable it to make a commit pass.
- **Verification evidence has ceilings.** Offline extension tests are not evidence of model quality, weeks-long memory retention, OS isolation, or multi-project Telegram routing. API green ≠ browser usable; idempotent success ≠ the flow reran. Single-episode success only fails to falsify a fix, it does not prove one.
- **The harness self-improvement loop is not autonomous yet.** Experiment cycles have run in observe mode only; live apply requires an explicit human flag, and no auto-accept exists by design.
- **Model-calls-off is real but narrow.** The coordinator's RPC runtime refuses prompts by default and never replays crashed mutating tasks, but nothing here prevents a human or a shell-capable child from spending tokens; authorization lives in briefs and rules, enforced by attention, not by the OS.
- **Skills guide behavior; they enforce nothing.** They neither isolate processes nor grant permissions, and skills in one workspace do not automatically load in sibling workspaces.
