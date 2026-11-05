# Multi-project coordinator: pi-project-coordinator

> **Reproduction notes**: source and tests live in `packages/pi-project-coordinator/`, with zero external dependencies (SQLite via Node's built-in `node:sqlite`). Offline tests: `node --test tools/test_project_coordinator.ts` (9 passed, 0 failed); the real-CLI smoke test is opt-in via `PI_COORDINATOR_SMOKE=1`. This is an **optional component** — single-project reproduction does not need it; install it only if you want one coordinator conversation to route multiple projects. The safety gates listed here (model calls off by default, prompt accepted ≠ done, crashed mutating tasks are not replayed) are behaviors implemented in the package's code, not configuration switches.

## Positioning

Lets one long-lived coordinator conversation route user requests to "one primary conversation per project". Core principle: **nothing activates automatically** — no global config changes, no automatic session creation, no automatic project registration. Registration is only a "proposal"; a project root takes effect only after explicit user confirmation.

## Five modules, one layer each

- **registry**: persistent project identity — id, aliases, canonical root enforced via realpath, stable sessionId, saved atomically.
- **router**: deterministic routing only (exact id / alias / canonical root); results are only `ok` / `ambiguous` / `unknown` — when ambiguous, ask the user rather than vaguely guess, and never scan the disk to "discover" projects.
- **store**: SQLite persistence layer (a single WAL database, Node's built-in `node:sqlite`, zero external dependencies). The `journal` is append-only, deduplicated by `sha256(sourceMessageId:splitIndex)`; old JSON files are imported once, idempotently, then renamed and kept — never deleted.
- **engine**: FIFO queue per project + single-writer lease + global concurrency cap (default 2); state persists across restarts.
- **rpc-runtime**: launches the project's own Pi session in RPC mode — sessions are restored by exact id (never "continue the most recent one"), cwd is pinned to the project root, no `--model` flag is passed (keeps the current model), and no Telegram transport is attached.

## Built-in safety gates

1. **Model calls off by default**: when `allowModelCalls: false`, only `get_state` probes identity (no model round-trips); automated tests cannot burn tokens or modify projects.
2. **Prompt accepted ≠ done**: the runtime distinguishes a prompt response (disposition) from `agent_settled`; results are always tagged `completed-unverified` — acceptance is a separate step for the primary conversation/user.
3. **Crash rule**: crashed mutating tasks are always recorded `unknown-outcome`; neither the engine nor journal replay will ever execute them again — they can only be closed out explicitly as `reconciled` / `verified` / `cancelled`.

## Status

The offline test suite is 9 passed, 0 failed; real Pi CLI smoke tests covered spawn / protocol / session identity (no real prompt was run). Not yet implemented: wiring into a live coordinator conversation, registering real projects, Telegram thread bridging, and takeover rules for already-running sessions.
