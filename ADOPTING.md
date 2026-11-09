# Adopting PiAgents — zero to working setup in ~30 minutes

For a developer who has never seen [pi](https://github.com/earendil-works/pi): this repo is a plain-text operating system that turns one "router" conversation into a dispatcher and verifier, while clean-context subagents do all the work. You install the engine, copy ~10 Markdown files, point pi at any OpenAI-compatible model endpoint, and start working differently. The [README](README.md) has the [architecture diagram](README.md#architecture-overview) and honest limits; the [docs site](docs-site/README.md) has per-subsystem depth this guide deliberately does not repeat.

## 1. What you get

A working agent harness where your primary conversation never edits code: it writes task briefs, dispatches them to disposable subagents (background workers by default, context-inheriting forks by exception), then accepts results by running the tests and inspecting the diff itself. Around that loop sit nine role templates for brief-writing, an advisory ownership check, a knowledge base with human approval gates, and an optional cross-project coordinator. The thesis: **correctness comes from architecture, not model IQ** — a mid-tier model stays reliably productive when acceptance tests are fixed and every claim is checked against the filesystem. See the diagram in the README for the whole flow on one screen.

## 2. Prerequisites

- **Node.js ≥ 22.19**, npm, git, python3 (for the optional scripts).
- **pi** (~2 min):

  ```sh
  curl -fsSL https://pi.dev/install.sh | sh
  # or
  npm install -g --ignore-scripts @earendil-works/pi-coding-agent
  ```

- **One model endpoint** speaking the OpenAI-compatible chat API. This setup serves GLM-5.3-Flash through a local vLLM tunnel, but any OpenAI-compatible endpoint works identically: a local vLLM/Ollama/LM Studio, a hosted gateway (e.g. OpenRouter), or a self-hosted proxy. You need exactly three things: a base URL, a model id, and an API key.

**Point pi at your endpoint.** Model config lives in `~/.pi/agent/models.json` (pi docs: `models.md` → "Configure a compatible endpoint"). Shape:

```json
{
  "providers": {
    "my-endpoint": {
      "baseUrl": "https://YOUR-ENDPOINT.example.com/v1",
      "api": "openai-completions",
      "apiKey": "$MY_ENDPOINT_KEY",
      "models": [{ "id": "your-model-id" }]
    }
  }
}
```

Use `$ENV_VAR` interpolation (or a `!command` that prints the key) instead of pasting tokens into the file. Never commit this file — this repo's git guard scans for it, and dispatched workers are denylisted from reading it. Open `/model` inside pi to reload after editing.

## 3. Minimal adoption path (~30 minutes)

**Step 1 — copy the rules layer.** Everything that makes this "an operating system" is text:

REQUIRED for a first run:

- `instructions/PROJECT-AGENTS.md` → `~/.pi/agent/AGENTS.md` — the router constitution: zero inline execution, best-of-N, acceptance gates. (Details: [docs-site/docs/delegation.md](docs-site/docs/delegation.md).)
- `instructions/agents/` — nine role folders, each `AGENTS.md` brief + `skills/` method. Copy anywhere; you may empty each `records/experience.md` (the author's personal lessons — roles only need the first two).
- One dispatch extension — pi ships **without** subagents. Either `pi install git:github.com/aicodewith-team/pi-superagent` (upstream of `packages/pi-superagent/`), or list the in-repo package paths in the `packages` array of `~/.pi/agent/settings.json` (how this machine runs).

OPTIONAL, add when you feel the need:

- `packages/pi-fork/` — context-inheriting `fork` (pairs with the `pi-delegation-gate` interception).
- `tools/delegation_gate.py` — advisory routing/ownership check.
- `tools/git_guard.py` + `.githooks/` — staged-content secret guard (`git config core.hooksPath .githooks`).
- `knowledge-base/` + `knowledge-base/scripts/compile_kb.py` — memory layers (see [knowledge-base/AGENTS.md](knowledge-base/AGENTS.md)).

**Step 2 — point `models.json` at your endpoint** (§2 above).

**Step 3 — smoke test.**

```sh
cd /absolute/path/to/a-real-project
pi
```

Then dispatch something tiny in the session:

> Spawn a subagent (tools: read, ls) to map this project's top-level structure and report back.

If the result arrives **as a message from the worker** (not inline in your context) and `/subagents` lists it, the dispatch layer works. That's the whole loop: brief → dispatch → report → verify.

## 4. The five rules that make it work

1. **Zero inline execution** — the primary conversation only understands, decides, dispatches, and accepts; anything it could do itself, a subagent does.
2. **Verify claims against the filesystem** — a worker's PASS report, green output, or commit record is a claim until you re-check real files, logs, and test runs.
3. **Best-of-N on fixed acceptance tests** — for bounded verifiable work, run N=3 candidates in isolated copies against identical fixed tests and accept the best; never weaken a test to make one pass.
4. **Memory needs human gates** — lessons are project-scoped by default; promoting to global requires evidence from ≥2 projects *and* explicit user approval.
5. **Honest limits** — guards are workflow constraints, not sandboxes; failures are reported as failures, never dressed up as success.

## 5. First-week habits

- **Dispatch small.** One bounded deliverable per brief (paths, goal, authorization, expected evidence), written in English — briefs to subagents are always English even if you chat in another language.
- **Read subagent reports with suspicion.** Milestone reports keep your context clean, but they are claims, not facts.
- **Run the tests yourself.** Acceptance = you executed the check and read the diff, not that someone said it passed.
- **Write one KB entry per verified result** — one line of context + the durable lesson + a source pointer in `knowledge-base/daily/YYYY-MM-DD.md`, then `python3 knowledge-base/scripts/compile_kb.py`.

## 6. What to skip (for now)

Power features, not needed on day one:

- **Multi-project coordinator** (`packages/pi-project-coordinator/`) — one conversation routing many projects; only matters once you outgrow one-session-per-project.
- **Telegram bridge** (`packages/pi-telegram/`) — remote control surface; requires its own token profiles.
- **Harness self-improvement / MC testbed** (`harness2/`, `.pi/skills/mc-rsi-episode`) — observe-mode experiments on tuning the dispatch layer itself.

## 7. Troubleshooting — real gotchas we hit

- **Extensions don't appear after install.** A running session won't pick up a new package: start a new session (or run pi's native `/reload`) and confirm the tool exists (`/subagents` should list nothing yet but must not error). A Telegram-side `/reload` message is *not* proof the native command ran.
- **Subagent id collision.** A spawned id can collide with a stale log directory from a previous day, silently mixing old transcript content into your worker's logs. After every background dispatch, liveness-check: the worker's `events.jsonl` mtime keeps moving and task-specific tokens appear in its log dir (`.pi/subagents/<id>/`).
- **Telegram token profiles.** The bridge needs its own bot-token profile, separate from your model credentials; and opening a Telegram chat does not change pi's working directory — start pi in the project directory you mean.
- **Workers fabricate.** A subagent may report PASS on tests it never ran, or "fix" a file it never opened. The defenses are the liveness check above, filesystem verification on your side, and treating `delegation_gate.py` as advisory — it validates declared ownership, it cannot prove a worker ran.

---

Deeper dives: [docs-site/README.md](docs-site/README.md) — delegation system, nine roles, knowledge base, security boundaries, multi-project coordinator.
