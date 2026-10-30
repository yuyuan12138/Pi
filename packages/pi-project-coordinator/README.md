# pi-project-coordinator

Multi-project coordination layer for the Project-first Pi workflow: one
long-lived coordinator conversation routes user requests to per-project
primary agents, each owning its project directory, session and task queue.

This package is the deterministic, testable core. **Nothing here
auto-activates**: no global config is touched, no sessions are created, no
project is registered automatically. The primary conversation (or an operator)
wires it up explicitly.

## Layers

| Module | Responsibility |
|---|---|
| `src/registry.ts` | Durable project identity: id, aliases, canonical root (realpath-enforced), stable `sessionId`, status. Atomic save. Registration is a *proposal* until the user confirms the root. |
| `src/router.ts` | Deterministic routing over explicit identifiers only (id / alias / canonical root). Results: `ok`, `ambiguous` (never a guess), `unknown` (ask the user). No fuzzy matching, no directory scanning. |
| `src/journal.ts` | Append-only JSONL task journal. Envelopes deduped by `sha256(sourceMessageId:splitIndex)`. Outcomes (`completed-unverified` / `failed` / `unknown-outcome`) tracked separately from phases. Mutating tasks with unknown outcome are **never replayed**; only explicit `reconciled`/`verified`/`cancelled` closes them. |
| `src/engine.ts` | `Coordinator`: FIFO queue per project, single-writer lease per project, global concurrency cap (default 2), durable across restarts, crash semantics above. |
| `src/rpc-runtime.ts` | `RpcProjectRuntime`: spawns `node <cli> --mode rpc --session-id <id> --session-dir <dir>` with `cwd` pinned to the project root. Speaks the documented JSONL protocol directly (dependency-free). Restores the *exact* project session by id — never "continue recent". No `--provider/--model` flags (current model/provider preserved). No Telegram transport: headless child, not a transport owner, not a hidden follower. |

## Safety gates baked in

- **Model calls disabled by default.** `RpcProjectRuntime` with
  `allowModelCalls: false` (the default) probes identity via `get_state`
  (no model round-trip) and refuses to send prompts. Automated tests can
  never spend tokens or mutate a project through this layer.
- **Prompt acceptance ≠ completion.** The runtime distinguishes the prompt
  response (`disposition`, including `"handled"` with no run), then waits for
  `agent_settled`. Results are `completed-unverified` — acceptance
  verification is a separate primary/user step.
- **Crash rule.** A runtime crash on a mutating task settles as
  `unknown-outcome`; the engine and journal replay never re-execute it.

## Status: implemented / tested / proposed

**Implemented and offline-tested** (`node --test tools/test_project_coordinator.ts`,
9 pass / 0 fail / 1 opt-in skip): registry validation (canonical roots, alias
uniqueness, duplicate roots), routing (exact id/alias/root, case-insensitive,
non-ASCII aliases, ambiguity, disabled projects), journal replay and dedupe
across instances, engine dedupe by message+split, per-project serial
execution, global cap of 2, lease bookkeeping, mutating-crash →
unknown-outcome with no auto-replay, fake-CLI RPC protocol tests (framing,
correlation, identity probe, model-call gate, prompt failure surfacing).

**Implemented and live-verified once** (opt-in `PI_COORDINATOR_SMOKE=1`):
spawning the real installed Pi CLI in RPC mode in a scratch project:
`get_state` returned the exact requested `sessionId` with the session file
under the project session dir, reported the current model, and the gated
`run()` correctly refused to execute the prompt. This proves spawn/protocol/
session identity only — **no prompt or model call was exercised**.

**Proposed, not implemented:**
- Wiring `Coordinator` + `RpcProjectRuntime` into the live coordinator
  conversation (an extension or operator script choosing when to enable
  `allowModelCalls`).
- Stage D: registering real projects (requires explicit user confirmation of
  each root; nothing registers itself).
- Telegram bridge integration for per-project threads (must go through the
  bridge's supported registration workflow; this package never creates a
  transport owner).
- Already-running-session adoption rules (a project TUI editing the same
  session needs ownership coordination before the RPC child attaches).

## Running

```sh
node --test tools/test_project_coordinator.ts            # offline suite
PI_COORDINATOR_SMOKE=1 node --test --test-timeout=120000 \
  --test-name-pattern 'real pi rpc smoke' \
  tools/test_project_coordinator.ts                      # live probe smoke
```

## Limitations

- The RPC adapter is protocol-tested against a fake CLI plus one real
  `get_state` smoke; full prompt runs (`promptAndWait`-equivalent waiting on
  `agent_settled`, error/abort paths against the real CLI) are unverified.
- `RpcSessionState` has no `cwd` field, so the runtime pins cwd via process
  spawn options and verifies session identity instead.
- This is process isolation, not a sandbox: children run with the host user's
  permissions.
- One prompt in flight per child; no steering/follow-up handling yet.
