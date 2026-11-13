# Extension activation contract — config sources, /reload vs restart

Date: 2026-11-13 (expansion plan **A2**, Theme A). Maintainer rule: **every row
is grounded in the package's actual code** — the env reads and config loads are
cited file:line, and `tools/check_activation_contract.py` mechanically verifies
that every env var a package reads appears in its row (a wrong or stale row
fails the grep test). Re-run after touching any package's config surface:

    python3 tools/check_activation_contract.py

## The universal rule (2026-11-13 forensics)

**`/reload` does NOT swap extension module code in a long-lived process.** The
19:08–19:10 reload attempt reconnected and woke (HTTP 200) yet the session kept
serving the OLD guard module (a `/tmp` write still flagged `edit_write`,
impossible under the new allowlist) — log forensics in
`docs/runbooks/pi-restart.md` ("The rule this runbook exists for") and
`/tmp/auto-reload-state.json`. Therefore:

- **Extension code change → full restart** (runbook procedure; tmux + handoff
  snapshot, never a bare `/reload`).
- `/reload` (and restart-free operation) is only useful for **live-edit
  surfaces**: config files re-read with an mtime/stat cache, and per-call env
  reads. The table below says which surfaces those are, per package.
- Env vars read at LOAD (module init / extension activation / first use) are
  frozen until a restart — editing them in the environment does nothing to a
  running session.

## Legend

- **LOAD** — read when the module/extension is activated (process start,
  `session_start`, or first lazy use); a change requires a restart (or, for
  per-session reads, a new session).
- **per-call** — re-read on every matching tool call/spawn; a change applies
  immediately with no restart.
- **live-edit** — a file whose changes are picked up without restart (mtime
  cache or plain per-call re-read).

## The contract table

| Package (role) | Env vars read at LOAD | Env vars read per-call | Config files / live-edit surfaces | What `/reload` gives you | Restart required for |
|---|---|---|---|---|---|
| `pi-coordinator-guard` (tool_call guard, main session) | — | `PI_COORDINATOR_GUARD`, `PI_COORDINATOR_GUARD_ALLOW`, `PI_COORDINATOR_GUARD_LOG` — all re-resolved every tool_call (`index.js` resolve* helpers); `PI_COORDINATOR_GUARD_PROJECT_ROOT`, `PI_COORDINATOR_GUARD_PYTHON` — re-read per reload_safety scan (`reload.js`) | `~/.pi/agent/coordinator-guard.json` — stat+mtime cache, re-read live on change (`config.js`); registry db `~/.pi/agent/project-coordinator/coordinator.db` — 60s TTL re-read (`registry.js`) | Nothing — mode/allow are already live; module code stays stale | Any `.js` code change (incl. the reload_safety category, v0.4.0) |
| `pi-delegation-gate` (fork gate) | — | `PI_DELEGATION_GATE_LOG` — re-read per fork tool_call (`index.ts:20` in `delegationLogPath()`) | none | Nothing | Any code change |
| `pi-delegation-reminder` (router-check prompt section) | Reminder text is the `REMINDER` constant compiled into the module (`index.js`) | — | none | Nothing — the header's "or /reload" claim is superseded by the forensics above | Any wording change (module code) |
| `pi-fork` (fork tool) | — | none for itself (child env is constructed per spawn, `src/env.ts`) | `pi-fork` key in `~/.pi/agent/settings.json` + `<cwd>/.pi/settings.json` (trusted project) — re-read from disk on EVERY fork call (`src/index.ts:176`, `:139`; no cache) → both files are live-edit | Nothing | Any code change |
| `pi-minimal-subagent` (subagent tool) | `PI_SUBAGENT_MAX_DEPTH` — module init, latched (`index.ts:446`); `PI_SUBAGENT_DEPTH` / `PI_SUBAGENT_CHILD` — extension activation (`index.ts:470`) | `PI_SUBAGENT_DEPTH` re-read per spawn when building the child env (`index.ts:325`) | none | Nothing | Code changes; a `PI_SUBAGENT_MAX_DEPTH`/depth env change (LOAD-latched) |
| `pi-observational-memory` (memory tiers) | `PI_OBSERVATIONAL_MEMORY_PASSIVE` + the whole config — loaded ONCE via the `ensureConfig` latch (`src/runtime.ts:122-126`, `configLoaded`); settings keys under `observational-memory` in `~/.pi/agent/settings.json` + `<cwd>/.pi/settings.json` (`src/config.ts:220-245`) | — | none — the latch means even the settings files are NOT live-edit | Nothing | Code changes AND any config/env change (latched for the process lifetime) |
| `pi-project-coordinator` (engine library; short-lived process per invocation) | — | — | coordinator db `~/.pi/agent/project-coordinator/coordinator.db` (registry row + journal) — read/written per operation via the Store (`src/store.ts`); no resident process (`tools/live-coordinator-check.ts` spawns per run) | n/a — no long-lived module to reload | n/a (each invocation re-reads everything) |
| `pi-superagent` (spawner + worker runtime) | `SUPERAGENT_WORKER`, `PI_SUBAGENT_ID` — extension init (`src/index.ts:10-11`); `PI_SUBAGENT_MAX` — parent registration (`src/subagent/extension.ts:61`); `PI_SPAWN_DEPTH` / `PI_SPAWN_CHAIN` / `PI_SPAWN_BUDGET` / `PI_SPAWN_REQUIRE_PROJECT_TAG` — all read once at SubagentManager construction (`src/subagent/manager.ts:179-188`), latched | `PI_SUBAGENT_MODEL` — re-read per spawn inside the launch()'s model resolution (`src/subagent/manager.ts:340`) | `.pi/superagent.yml` — re-read per `/superagent start` (`src/config.ts:33`, `index.ts:70`) → live per start; `~/.pi/agent/model-routing.json` (Theme D4) — read ONCE at SubagentManager construction (`src/subagent/manager.ts:193` via `loadModelRouting`, `src/subagent/model-routing.ts`) → latched; absent file = exactly the pre-D4 behavior | Nothing | Code changes; any init-time env change (worker/subagent identity, max concurrent, spawn budget/depth/chain, spawn-tag kill switch); a `model-routing.json` change (latched at construction) |
| `pi-usage-log` (usage accounting) | — | `PI_USAGE_ALERTS`, `PI_USAGE_ALERT_DAILY_TOKENS`, `PI_USAGE_ALERT_WEEK_SPEND_USD` — re-read per evaluation (Theme D5): every CLI run (`cli.ts:59`) and every `/usage` invocation (`index.ts:35`), via `resolveAlertConfig` in `usage-alerts.ts:106-110` | `~/.pi/agent/usage-alerts.json` (Theme D5) — re-read per evaluation (`usage-alerts.ts:69`) → live; usage JSONL dir hardcoded to `~/.pi/agent/usage/<day>.jsonl` (`index.ts:8`) | Nothing — alerts resolve env+config per run | Any code change |
| `pi-web-bridge` (web mission control server) | `PI_WEB_BRIDGE_DISABLED`, `PI_WEB_BRIDGE_PORT` — extension init, server socket bound once (`src/extension.ts:83-84`) | — | coordinator registry db — read-only per request with a lastGood cache (`src/projects.ts:264`); work RECORD.md mtimes read per request (`projects.ts:160-181`) → both live | Nothing | Code changes; a port/disable env change (socket bound at init) |
| `extensions-src/memory-index` (memory_search tool) | `PI_MEMORY_INDEX_DB` — read lazily at FIRST tool use, latched for the runtime (`src/index.ts:41` via `ensureOpen`/`defaultDbPath`) | `PI_MEMORY_KB_ROOT` — re-read per `session_start` backfill (`src/index.ts:97`, `:112`); KB files under the root re-parsed at each `session_start` (`parse-kb.js`) | SQLite index `~/.pi/agent/memory/index.db` (WAL) — content is per-call; KB file edits apply at the NEXT `session_start` | Nothing | Code changes; a db-path env change (latched after first open); KB content changes need a new session_start, not a restart |
| `extensions-src/memory-distiller` (sa52 P1a / Theme B1 — atom distiller) | — (no env is latched at load; the factory registers handlers only, zero writes at activation) | `PI_DISTILLER_IDLE_MS` — re-read per `agent_settled` when arming the debounce timer (`src/index.ts:27`); `PI_DISTILLER_STATE` — read per `DistillerState` construction, i.e. every distillation run (`src/state.ts:25`); `PI_MEMORY_KB_ROOT` — re-read per run in `kbRootForCwd` (`src/distill.ts:59`) | watermark state `~/.pi/agent/memory/distiller/state.json` — atomic temp+rename saves, re-read per run (`src/state.ts`); atoms land in `<kbRoot>/atoms/<project>/<date>.jsonl` (append-only) | Nothing — all env/config reads are per-run | Any code change (universal rule; distillation triggers re-arm per session) |

## Operational consequences (the short version)

- **Restart needed (most common)**: editing any extension source — guard,
  reminder text, fork, spawner, bridge, memory-index. Use the restart runbook
  (`docs/runbooks/pi-restart.md`) with the A1 handoff snapshot
  (`python3 tools/restart_handoff.py snapshot` first, `resume` after).
- **Live without restart**: guard mode/allowlist (`coordinator-guard.json`),
  fork settings (`settings.json` `pi-fork` key), superagent.yml (next
  `/superagent start`), registry membership (≤60s TTL in guard, per-request in
  bridge), per-call env reads (`PI_COORDINATOR_GUARD*`,
  `PI_DELEGATION_GATE_LOG`, `PI_SUBAGENT_MODEL`, usage-alert env vars +
  `usage-alerts.json`).
- **Latched config (restart or new session needed)**: observational-memory
  settings/passive env, minimal-subagent max depth, web-bridge port,
  memory-index db path, superagent's spawn-tree env reads
  (`PI_SPAWN_DEPTH`/`CHAIN`/`BUDGET`/`REQUIRE_PROJECT_TAG`, manager
  constructor) and the Theme D4 model-routing table
  (`~/.pi/agent/model-routing.json`, read once at manager construction).
- **Reload safety**: any reload/restart attempt while dispatches are in flight
  is logged by the guard's `reload_safety` category (v0.4.0, observe-only —
  see `packages/pi-coordinator-guard/README.md`).

## Verification

`tools/check_activation_contract.py` greps each package in `packages/` and
`extensions-src/` for env-var reads (direct `process.env.X` and
`env[CONST]` with same-file constant resolution), then asserts each var is
named in this file's table row for that package. Failure modes it catches:

- a package gains a new env read that the table does not mention;
- a row renamed/removed a var that the code still reads;
- the universal-rule runbook pointer is dropped.

It is a grep test, not a behavior test: it pins the env-var surface and the
evidence pointer; the load-vs-per-call classification is grounded by the
cited file:line references (wrong rows fail review, per the A2 acceptance
rule). Run it in CI or before any activation-contract-affecting commit.
