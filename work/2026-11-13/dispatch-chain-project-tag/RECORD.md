# Dispatch-chain guarantee: registry-validated spawn tags + spawner-side tag gate

Date 2026-11-13 · Worker: dispatched coder (subagent sa8-a, worktree
`.pi/subagents/worktrees/sa8-a`, branch `subagent/sa8-a-mwewzi06`) · Status: delivered, all suites green.
Brief: user directive 2026-11-13 — "图逻辑链一定能成，定了规则的地方要受控": close the two structural
gaps so the `[project:<name>]` routing chain is enforced end-to-end.

## Changes

### 1. `packages/pi-coordinator-guard` — registry validation of spawn tags (v0.3.0)
- New `registry.js`: read-only coordinator-registry reader
  (`~/.pi/agent/project-coordinator/coordinator.db`, single-row JSON, sqlite).
  Load pattern reused verbatim from `pi-web-bridge/src/projects.ts` (lazy
  `createRequire("node:sqlite")`, zero deps). Membership mirrors the coordinator
  router exactly (`router.ts:route()`): exact id, exact alias (case-insensitive),
  exact canonical root — registered-status projects only. 60s TTL cache per db
  path (failures cached too). Fail-open on READ errors only (missing/corrupt/
  table-less db, no node:sqlite → `{projects: null, error}`), never on format.
- `classify.js`: `extractProjectTags()` — extracts every tag name from the same
  JSON haystack the format check uses, so the registry check validates exactly
  what the format check accepted.
- `index.js`: new category `dispatch_unknown_project` (enforce denies, observe
  logs `would_deny`), deny reason names the offending tag AND lists the
  registered project ids; registry read failure logs one `registry_unavailable`
  warning line (`decision:"error"`, `tool:"_registry"`) per read attempt (cached
  failure identity → once per TTL window, not once per call). Untagged spawns
  (format deny) never touch the registry.
- Tests: 26 new (parse/membership router-parity, fail-open reads, TTL cache with
  `now`/`ttlMs` injection, guard wiring, warning dedupe, reason shape). Three
  pre-existing tagged-spawn tests now pin a hermetic fixture registry db
  (assertions unchanged; previously they implicitly depended on the live db).

### 2. `packages/pi-superagent` — spawn-tag gate at the spawner chokepoint
- `subagent/manager.ts`: `SubagentManager.spawn()` refuses ANY task (root and
  nested alike — workers run `--no-extensions`, so the guard never sees
  sub-spawns) without the literal `[project:<name>]` token. FORMAT ONLY by
  design; registry truth stays with the coordinator guard (documented at the
  gate + in both header comments). Deny = thrown error, same actionable shape
  as the guard's reason. Kill switch `PI_SPAWN_REQUIRE_PROJECT_TAG`
  (default ON; `"0"`/`"false"` disables; env-pinned at construction, same
  precedent as depth/budget; `options.requireProjectTag` overrides).
- The gate runs before the budget check (a tagless task is refused with the tag
  reason even on an exhausted budget).
- Tests: 7 new gate tests (tagless throws before side effects, nested depth-2
  gating, token-anywhere, kill switch 0/false/1/garbage, option override,
  parse table, gate-vs-budget ordering). All 51 pre-existing spawn-task literals
  tagged `[project:PiAgents]` (data-only change; assertions unchanged). Live
  depth-2 recursion e2e updated to carry tags and passes with the gate ON.

## Evidence
- guard: `node --test test/` — 134/134 pass (was 108).
- superagent: `tsc -p .` clean; `vitest run` — 67/67 pass (was 60), incl. the
  real-pi depth-2 recursion chain with the gate ON.
- Live smoke against the real registry db (read-only): `[project:minecraft]`,
  `[project:mc]` allowed; `[project:PiAgents]` DENIED with registered ids listed;
  untagged denied (format reason).

## Findings for the user (decisions needed, not code)
- **"PiAgents" is not a registered project id/alias/root.** Registered:
  medical, minecraft, info-router, vpn-ops, blog, notion-ops, nvim-config,
  english, feishu. Under the new rule, `[project:PiAgents]` dispatches from the
  coordinator session will be DENIED in enforce mode (actionable reason lists
  the registered ids). Fix options: register the PiAgents workspace (e.g.
  id `piagents`, root `/Users/yuyuan/PiAgents`) — a user registry decision — or
  tag coordinator-infrastructure dispatches with a registered id, or run
  degraded-mode (`PI_COORDINATOR_GUARD=observe`).
- Membership was implemented at **router parity** (ids + aliases + canonical
  roots), not ids-only: a guard stricter than the coordinator router would deny
  dispatches the router itself accepts, breaking the very chain this change
  hardens. Documented in `registry.js` + README.

## Limitations
- Registry changes take up to 60s to be seen (TTL cache, by design, no knob).
- Tag extraction/registry check operate on the serialized input (same haystack
  as the format check): a tag inside a quoted excerpt counts, exactly as the
  pre-existing format rule treats it.
- Guard package has no dependencies (node:sqlite is a Node ≥22.13 built-in; on
  older runtimes the registry check fails open to format-only with a warning).
