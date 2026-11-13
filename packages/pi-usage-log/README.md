# pi-usage-log

Local, offline usage monitoring for the Pi coding agent.

- On every `turn_end`, appends one JSON line to `~/.pi/agent/usage/YYYY-MM-DD.jsonl`:
  timestamp, cwd, session id, turn index, model, stop reason, token usage
  (input/output/cache read+write/total), cost, tool names invoked that turn,
  and context usage percent. Additive fields (2026-11, Theme D1): `sessionName`
  (human session name, when the session has one) and `task` (first line of the
  most recent user message, <=200 chars) — the evidence the per-project
  attribution needs. Older records without them read fine (attribution just has
  fewer stages available).
- `/usage` command prints today's aggregate grouped by session+model, with a grand total.
- `/usage project [days]` prints the per-project rollup (default 7 days).
- Never sends data anywhere; failures to write are silently ignored so monitoring
  cannot break a session.

## Per-project rollup (Theme D1)

`project-usage.ts` aggregates token/cost by PROJECT, reusing the web bridge's
attribution evidence chain (bridge `orgProjectOf`, reduced to the evidence a
usage record can carry), in priority order:

1. **cwd under a registered project root** (most specific root wins when roots
   are nested, e.g. minecraft's ops dir inside the piagents workspace);
2. **session id equals the project's registry `sessionId`** (e.g.
   `medical-primary` — the coordinator's project-primary convention);
3. **`role-...@<project>` session segment**;
4. **session topic conventions** `<topic>-x<N>` / `<topic>-<N>` /
   `<topic>-primary` — topic prefix must match a registry alias (longest wins,
   aliases < 3 chars never match; superagent collision suffixes like `-2x41`
   are stripped first);
5. **`[project:<name>]` tag in the task text** — resolved against registry
   ids/aliases or the explicit `personal-ops` bucket; an unknown tag is ignored;
6. **alias evidence in the task text** — exactly ONE distinct project may be
   named (the bridge's 2-mention rule), otherwise unattributed.

No evidence -> the explicit **`unattributed`** bucket; **`personal-ops`** is
assigned only by an explicit `[project:personal-ops]` tag. Buckets are disjoint
and exhaustive, so totals always reconcile with the raw JSONL sums — pinned by
`tests/project-usage.test.ts` (reconcile()) and reported by the CLI on every run.

CLI (zero deps, node built-ins only):

```
node --experimental-strip-types packages/pi-usage-log/cli.ts [--days 7] [--dir <usage-dir>] [--db <coordinator.db>]
```

Exit 2 on reconciliation failure. The registry is read read-only from the
coordinator db; any read problem degrades to an empty registry (everything
unattributed), never a crash.

## Usage anomaly alerts (Theme D5)

Offline threshold evaluation over the local rollup — **no network calls, no
notification infrastructure**. An alert is a machine-readable surface (a JSON
line) that a caller (script, bridge, agent) can act on.

**Disabled by default.** With no env flag and no config file, nothing is
evaluated and every output surface is byte-for-byte unchanged. The monitor is
armed by either:

- env `PI_USAGE_ALERTS=1` (or `true`), or
- the presence of `~/.pi/agent/usage-alerts.json` — same flat routing-config
  style as pi-superagent's `model-routing.json`:
  `{"enabled": true, "dailyTokens": 1000000, "weekSpendUsd": 50}`
  (`"enabled": false` opts back out, even against the env flag).

When armed, thresholds resolve **env > config file > sane defaults** for both
checks (strictly-greater fires; exactly-at-threshold does not):

| Check | Env | Config key | Default |
|---|---|---|---|
| daily tokens (UTC day) | `PI_USAGE_ALERT_DAILY_TOKENS` | `dailyTokens` | 1,000,000 |
| 7-day spend (rolling window) | `PI_USAGE_ALERT_WEEK_SPEND_USD` | `weekSpendUsd` | $50 |

Surfaces, all additive:

- **CLI**: after the rollup and reconciliation, each exceeded threshold prints
  one JSON line to **stdout** —
  `{"type":"usage_anomaly","severity":"warn","check":"daily_tokens","value":…,"threshold":…,"unit":"tokens","message":…,"at":…}`
  — plus a human `WARN:` line to **stderr**. The spend check always evaluates a
  true rolling 7-day window regardless of `--days`. Exit codes are unchanged.
- **`/usage`** (both views): an `alerts:` section — `alerts: N fired` with one
  `WARN <check>: …` line each, or `alerts: 0 (monitoring armed, no anomalies)`.
  Disarmed → the section is absent entirely.

Implementation: `usage-alerts.ts` (pure `resolveAlertConfig` / `alertInputs` /
`evaluateAlerts` + tolerant file parse), pinned by `tests/usage-alerts.test.ts`
including a real CLI-path integration test.

The web bridge's `/projects` endpoint exposes the same rollup additively as
`usage7d` (see packages/pi-web-bridge).

Adapted locally for Pi 1.3.0 (first-party package, not from npm).
