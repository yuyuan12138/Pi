# PiAgents: A Reproducible Agent Operating System

> 📚 Chinese edition: [zh/README.md](zh/README.md)（中文版）

One-line positioning: **this is not an application — it is an agent operating system written in plain text**. The primary conversation only dispatches work, makes decisions, and accepts deliverables; the actual work is done by clean-context subagents. The entire "kernel" consists of Markdown rules, role templates, and three small scripts — no hidden binaries or cloud dependencies. It is verified running on [pi](https://github.com/earendil-works/pi), but the design is not bound to the engine: any agent framework that supports "a main loop + subtask spawning" can adopt these ideas.

## Architecture overview

```text
              User (requirements · decisions · final acceptance)
                              │
  ┌───────────────────────────▼────────────────────────────┐
  │      Primary conversation (one per project, cwd = project root)
  │  Only does: requirement understanding / written briefs /  │
  │             decisions / acceptance / integration          │
  └────────┬─────────────────────────┬─────────────────────┘
           │ fork                    │ subagent
           │ inherits the current    │ clean context
           │ conversation branch     │ (default)
           ▼                         ▼
    Context-heavy exploration    9 role workers
  (live debugging sessions ·  scout / planner / coder / operator /
   multi-file implementation) reviewer / researcher / visualizer /
                               writer / designer
           │                         │
           └────────────┬────────────┘
                        ▼
      Acceptance: run the tests yourself · inspect the diff ·
                  verify the evidence
                        │ verified → lessons recorded
                        ▼
  ┌─────────────────────────────────────────────┐
  │ knowledge-base/ (two-layer knowledge base)  │
  │  daily/YYYY-MM-DD.md → knowledge/concepts/  │
  │  compile_kb.py index + scope gate           │
  └─────────────────────────────────────────────┘

 ═══════════ Cross-project coordination layer (optional) ═══════════
  Project A primary ──┐
  Project B primary ──┼──▶ pi-project-coordinator
  Project C primary ──┘   registry · deterministic routing ·
                          single-writer queue per project
```

## Reproduction in three steps

### Step 1: Install the engine (~2 minutes)

The engine this repo runs on is [pi](https://github.com/earendil-works/pi) (`@earendil-works/pi-coding-agent`; package name verified against the npm registry, bin name `pi`). Per pi's official README, the preferred install method (handles Node dependencies automatically; upgrade later with `pi update`):

```bash
curl -fsSL https://pi.dev/install.sh | sh
```

Or via npm (note that the official command includes `--ignore-scripts`; requires Node.js ≥ 22.19):

```bash
npm install -g --ignore-scripts @earendil-works/pi-coding-agent
```

**pi itself ships without subagents** — the official README says so verbatim: "Pi ships with powerful defaults but skips features like sub-agents and plan mode". The three derivation tools this architecture depends on are provided as pi packages, with their sources included in this repo:

| Tool | Purpose | In-repo source | Upstream install command |
|---|---|---|---|
| `fork` | Spawns a child process that inherits the current conversation branch (context-heavy exploration) | `packages/pi-fork/` | `pi install git:github.com/elpapi42/pi-fork` |
| `subagent` | Spawns an independent clean-context subagent — **retired 2026-11-09, removed from live config; use `subagent_spawn`** | `packages/pi-minimal-subagent/` | — |
| `subagent_spawn` | Spawns a background clean-context subagent (the default dispatch; `tools` allowlist / persistent `session` / synchronous `wait`) | `packages/pi-superagent/` | `pi install git:github.com/aicodewith-team/pi-superagent` |

Either install path works: install the upstream packages with the `pi install` commands above, or list the in-repo paths in the `packages` array of `~/.pi/agent/settings.json` (which is how this machine runs). Version note: pi's latest release at the time of writing is 1.5.0, and installing the latest is recommended; this repo was verified on 1.3.0, where fork/subagent were tested working.

**Portability statement**: if you use a different framework (Claude Code, a self-built harness, etc.), just skip this step — the two asset categories below are plain text and depend on no pi API. As long as your framework can "spawn a subtask with an independent context and restricted tools", the ideas apply.

### Step 2: Copy three categories of text assets

This is the entire "operating system kernel"; every path below really exists in this repo:

| Asset | Real path in this repo | Installed to | Purpose |
|---|---|---|---|
| ① Global rules (the primary conversation's constitution) | `instructions/PROJECT-AGENTS.md` | `~/.pi/agent/AGENTS.md` (pi's global rules slot, applies to all sessions) | Zero inline execution, best-of-N parallel candidates, acceptance gates, delegation routing |
| ② 9 role templates | `instructions/agents/` — one directory each for scout / planner / coder / operator / reviewer / researcher / visualizer / writer / designer | Any directory; the primary conversation reads them by path | Each role = `AGENTS.md` brief template + `skills/` methodology + `records/experience.md` lessons |
| ③ Three scripts | `tools/delegation_gate.py`, `tools/git_guard.py` (wired via `.githooks/pre-commit`), `knowledge-base/scripts/compile_kb.py` | Anywhere in the repo | Routing validation (advisory) / staged-content guard / knowledge-base compile + lint |

Honest clauses:

- The `records/experience.md` files inside the role templates hold the original author's **personal** cross-project experience; a reproducer can simply **empty them** — the roles only depend on `AGENTS.md` and `skills/`.
- `delegation_gate.py` validates whether the *declared* ownership complies with policy; it is not a runtime interceptor and cannot prove that a subagent actually ran (see [Delegation system](docs/delegation.md)).
- The staged-content guard is enabled with `git config core.hooksPath .githooks`; it is a best-effort scan, not DLP (see [Security boundaries](docs/security.md)).

Optional assets: `packages/pi-project-coordinator/` (multi-project coordinator; not needed for single-project reproduction) and `knowledge-base/` (two-layer knowledge base; the scope-gate rule text is in `knowledge-base/AGENTS.md`).

### Step 3: Walk a real example (dispatching to coder)

Scenario: fix a small bug in your project. The full flow has four steps.

**0. Routing declaration** — before touching anything, the primary conversation states four things (per "Mandatory routing decision" in the global rules):

```text
task category = implementation; deliverable = single-file fix + 1 regression test;
owner = subagent(coder); acceptance = pytest all green + primary inspects the diff itself
```

**1. Advisory ownership check** (optional; usage from `instructions/DELEGATION-ROUTING.md`):

```bash
python3 tools/delegation_gate.py --category implementation --owner subagent
# ALLOW: Declared ownership matches routing policy  (exit 0)
```

**2. Send the brief**. The fields are fixed, from the Task Brief section of `instructions/agents/coder/AGENTS.md`. A filled-in example:

```markdown
## Task Brief (filled by the primary conversation)
- Project root (cwd): /home/you/myapp
- Goal and scope: parse_date() in utils/date.py must reject invalid months
  (e.g. "2026-13-01"); change only this file; add a regression test
  test_rejects_invalid_month in tests/test_date.py
- Relevant paths / background facts: utils/date.py currently uses
  datetime.strptime; tests/test_date.py already has 12 pytest-style
  function-based cases — match that style for the new test
- Authorization and prohibitions: only utils/date.py and tests/test_date.py
  may be modified; no new dependencies, no network access; do not delete
  or weaken existing tests
- Expected evidence and acceptance criteria: pytest -q prints 13 passed;
  report changes file by file in one line each, tagged implemented /
  tested / unverified
```

At the same time, set the tool allowlist from the coder template's Tools section — `read, grep, find, ls, bash, edit, write` — and pin the subagent's cwd to the project root. The coder's first action is to read its own skill file (`instructions/agents/coder/skills/minimal-change.md`: minimal changes + three-state reporting) — methodology is injected this way, not by fine-tuning the model.

**3. Acceptance**. A subagent reporting PASS does not count: the primary runs `pytest -q` itself, inspects the actual diff, and checks the three-state report. Bounded, locally verifiable tasks default to best-of-N (N=3): three candidates each work on an isolated working copy against the **same brief**; the primary accepts each one and adopts the best, reporting all N outcomes honestly (which passed, which failed, and why).

Once verified, one transferable lesson is appended by date to `knowledge-base/daily/YYYY-MM-DD.md`; recurring lessons are later promoted by `compile_kb.py` into `knowledge/concepts/`.

## Design principles (a portable kernel, decoupled from pi)

| # | Principle | What it says | Why |
|---|---|---|---|
| 1 | Zero inline execution | The primary conversation never does the work with its own hands — implementation, testing, research, and review are all dispatched; the primary only communicates, decomposes, decides, accepts, and integrates | The massive file-reading and trial-and-error noise of execution stays inside child processes; the primary's context is reserved for decisions |
| 2 | Clean-context subagents | Every subagent starts from a blank context and receives all input via a written brief; `fork` (context inheritance) is reserved for tasks that genuinely depend on live conversation state | Clean contexts are cheap and parallelizable; the cost of inheriting the full context grows linearly with the primary conversation's size |
| 3 | Fixed acceptance criteria | Acceptance criteria are written into the brief and never changed after dispatch; never delete tests or weaken assertions to make something pass | Makes best-of-N candidates comparable; eliminates "green at any cost" |
| 4 | Written briefs | Every dispatch is a structured brief (cwd / goal / paths / authorization / acceptance) with fixed fields | The only information channel after context isolation; if you cannot write the brief, the requirement is not yet clear |
| 5 | Evidence-driven acceptance | A subagent reporting PASS ≠ acceptance done; the primary runs the tests, inspects the diff, and verifies evidence itself; a passing API ≠ a usable browser flow | Executor and acceptor must be separated, otherwise false positives and embellishment go uncorrected |
| 6 | Falsifiable lessons only | Lessons enter the knowledge base with sources and evidence pointers; "verified" may only be tagged after the primary source was actually opened; unfalsifiable content does not enter | Unfalsifiable knowledge pollutes every subsequent decision; a snippet is not evidence |
| 7 | Scope-gated memory | Lessons in `daily/` are project-scoped by default; promotion to global requires evidence from ≥2 distinct projects + explicit user approval (fail-closed) | Research suggests a naive global memory pool performs worse than no memory at all — scope first, persist second |
| 8 | Agent-bound communication is English | The operator and the primary conversation may use any language, but all text sent to agents — prompts, task briefs, role messages, subagent dispatches — is written in English; human-facing deliverables (chat replies, user reports) follow the human's language | Role templates, skill files, and the toolchain are locked to English; mixed-language briefs degrade instruction-following in small-parameter open-weight models (now codified as a global rule) |

## Document map

| Document | Contents |
|---|---|
| [Delegation system](docs/delegation.md) | Routing decision flow, best-of-N, acceptance gates, the zero inline execution rule |
| [The nine roles](docs/roles.md) | Each role's responsibilities, tool allowlists, and when to use which (table) |
| [Multi-project coordinator](docs/coordinator.md) | Registry / deterministic routing / single-writer queues / RPC runtime |
| [Knowledge base](docs/knowledge-base.md) | Two-layer structure, scope gate, hygiene layer, compile_kb |
| [Security boundaries](docs/security.md) | Delegation does not expand authorization, subagent hardening, Git and secrets rules |

## Key numbers

- **9 predefined roles**: all are brief templates, not resident processes; no extensions loaded; methodology is injected by "read your own skill file first" — the entire asset is the `instructions/agents/` directory.
- **3 derivation tool packages**: `packages/pi-fork`, `packages/pi-minimal-subagent`, and `packages/pi-superagent`; pi ships without subagents — these packages provide the `fork` / `subagent` / `subagent_spawn` tools.
- **3 scripts**: `delegation_gate.py` (ownership check, advisory), `git_guard.py` (staged-content guard), `compile_kb.py` (knowledge-base compile + lint) — purely local, zero dependencies.
- **1 multi-project coordinator** (optional): SQLite persistence, single-writer queue per project, global concurrency cap of 2, crashed mutating tasks are never blindly replayed.
- **2-layer knowledge base**: `wiki/` (curated first-hand external experience, with confidence levels) + `daily/` and `knowledge/concepts/` (internal engineering log), with a fail-closed scope gate.
