# Theme D remaining P1/P2: D4 declarative model routing + D5 usage anomaly alerts

Date: 2026-11-13
Task: [project:PiAgents] Theme D remaining (work/2026-11-13/architecture-expansion/PLAN.md) — D4 (P1) declarative model routing in pi-superagent + D5 (P2) usage anomaly alerts in pi-usage-log
Dispatched-by: main coordinator conversation (user brief, 2026-11-13, background coder dispatch)
Worker: background coder subagent (clean context, this dispatch)
Status: delivered

## Task brief

D4: optional routing table `~/.pi/agent/model-routing.json` (absent = exactly current behavior) mapping selectors
(project id | role | default) → model id at pi-superagent's manager model-resolution point; precedence explicit arg >
table > `PI_SUBAGENT_MODEL` env > fallback; table fills only the DEFAULT slot (explicit args always win, no silent
overrides); README precedence table + `resolveModel` suite + activation-contract entry (latched-at-init). D5:
pi-usage-log CLI-path anomaly alerts after aggregation — configurable thresholds (daily tokens > N, 7-day spend > $X;
sane defaults, disabled by default; env or the same routing-config style) emitting a structured alert (JSON to stdout + WARN line) plus an additive `/usage` field; no network, no notifications.

## Delivered

- `packages/pi-superagent/src/subagent/model-routing.ts` (new): `parseModelRouting`
  (tolerant; bad entries dropped, wrong-typed sections = malformed), `loadModelRouting`
  (absent = silent undefined = pre-D4 behavior; malformed = one stderr warning + as-absent),
  `projectTagOf`, pure `resolveModel` → `{model, source}`.
- `packages/pi-superagent/src/subagent/manager.ts`: table latched at manager construction
  (`modelRouting` option key pins it, else file read once); `launch()` resolves
  explicit > route:project > route:role > route:default > env > fallback, sets
  `info.modelSource`, and appends a per-dispatch `routing.log` JSON line.
- `packages/pi-superagent/src/subagent/types.ts` + `extension.ts` (additive):
  `SpawnOptions.role` / `SubagentInfo.role` / `SubagentInfo.modelSource`;
  `subagent_spawn` optional `role` selector; `fmt` shows `model (via <source>)`.
- `packages/pi-superagent/tests/model-routing.test.ts` (new, 20 tests): precedence,
  no-silent-override, garbage args, exact-match fall-through, parse/load, manager
  wiring incl. routing.log; `tests/subagent.test.ts` hermeticity hardened
  (`PI_SUBAGENT_MODEL` scrubbed, `modelRouting: undefined` pin).
- `packages/pi-superagent/README.md`: Theme D4 section (EN + 中文) with precedence table.
- `packages/pi-usage-log/usage-alerts.ts` (new): `resolveAlertConfig` (armed =
  `PI_USAGE_ALERTS=1|true` or config file present; file `"enabled": false` opts out;
  thresholds env > file > defaults 1,000,000 tokens / $50), `alertInputs` (UTC-day
  tokens + rolling-7-day spend), pure `evaluateAlerts` (strictly-greater fires).
- `packages/pi-usage-log/cli.ts`: armed + exceeded → one JSON alert line per anomaly
  on stdout + a `WARN:` line on stderr, after rollup/reconciliation; spend check always
  a true 7-day window regardless of `--days`; exit codes unchanged; disarmed =
  byte-for-byte pre-D5 output.
- `packages/pi-usage-log/index.ts`: `/usage` (both views) additive `alerts:` section;
  absent when disarmed.
- `packages/pi-usage-log/tests/usage-alerts.test.ts` (new, 14 tests): config matrix,
  aggregation windows, threshold semantics, alert shape, 3 real CLI-path integration
  tests (spawnSync, tmp usage dirs).
- `packages/pi-usage-log/README.md`: Theme D5 section (activation, thresholds, output contract).
- `docs/activation-contract.md`: pi-superagent row records `model-routing.json` as
  latched-at-construction (manager.ts:193), corrects the per-call cell to the one true
  per-spawn env read (`PI_SUBAGENT_MODEL`, manager.ts:340) and moves spawn-tree env
  reads to LOAD (manager.ts:179-188); pi-usage-log row gains the three env vars +
  `usage-alerts.json` as live per-evaluation surfaces; summary bullets updated.

## Verification evidence

- pi-superagent: `tsc -p .` clean; vitest 87/87 (67 pre-existing + 20 new D4).
- pi-usage-log: `node --experimental-strip-types --test tests/` 54/54 (40 pre-existing D1 + 14 new D5),
  incl. spawnSync CLI integration asserting JSON stdout line, stderr WARN, disarmed no-op.
- `python3 tools/check_activation_contract.py` → OK.
- `python3 tools/work_record_lint.py --record <this file>` → pass (0 FAIL).
- Default posture proven by dedicated tests: absent routing file / unarmed alerts
  leave both packages' outputs unchanged.

## Open items

- Routing project selector matches the `[project:<name>]` tag exactly (no registry/alias
  resolution); coordinator-registry wiring is a follow-up if mismatches appear.
- D4's "routing decision appears in journal" is satisfied at the spawner layer
  (`routing.log` + `modelSource`); pi-project-coordinator journal surfacing was out of scope.
- D5 evaluates on demand (CLI / `/usage`), no daemons (AGENT-ORG §7); a scheduled caller
  can consume the CLI JSON surface when push-style alerts are wanted.
