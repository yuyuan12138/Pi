#!/usr/bin/env node
/**
 * CLI summary for pi-usage-log (Theme D1): per-project token/cost rollup over
 * the last N days, with explicit unattributed / personal-ops buckets and a
 * reconciliation line proving the buckets sum to the raw JSONL totals.
 *
 * Usage:
 *   node --experimental-strip-types packages/pi-usage-log/cli.ts [--days 7]
 *        [--dir <usage-dir>] [--db <coordinator.db>]
 *
 * Exit codes: 0 on success (even when the registry is unavailable — that
 * degrades attribution, not the command); 2 on a reconciliation failure
 * (buckets vs raw sums disagree — a rollup bug, never a data problem).
 */
import { rollupLastDays, loadRegistryProjects, readUsageRecords, reconcile, formatBucketLine, DEFAULT_USAGE_DIR, DEFAULT_COORDINATOR_DB } from "./project-usage.ts";
import { resolveAlertConfig, evaluateAlerts, alertInputs, USAGE_ALERTS_PATH } from "./usage-alerts.ts";

function argValue(flag: string, argv: string[]): string | undefined {
  const i = argv.indexOf(flag);
  return i >= 0 ? argv[i + 1] : undefined;
}

const argv = process.argv.slice(2);
if (argv.includes("--help") || argv.includes("-h")) {
  console.log("usage: cli.ts [--days 7] [--dir <usage-dir>] [--db <coordinator.db>]");
  process.exit(0);
}
const days = Math.max(1, Math.min(90, Number(argValue("--days", argv) ?? 7) || 7));
const dir = argValue("--dir", argv) ?? DEFAULT_USAGE_DIR;
const db = argValue("--db", argv) ?? DEFAULT_COORDINATOR_DB;

const registry = loadRegistryProjects(db);
const { records, since, until } = readUsageRecords(dir, days);
const rollup = rollupLastDays(dir, registry, days);
const check = reconcile(rollup, records);

console.log(`Per-project usage, last ${days} day(s) (${since} .. ${until})`);
console.log(`files: ${rollup.filesRead.length} day file(s) read, ${rollup.totals.records} records`);
console.log("");
for (const p of rollup.projects) {
  console.log(`  ${p.projectId} (${p.displayName}): ${p.tokens.toLocaleString()} tokens, $${p.cost.toFixed(4)}, ${p.turns} turns, ${p.sessions} sessions`);
}
console.log("");
console.log(formatBucketLine("  personal-ops (explicit tag)", rollup.personalOps));
console.log(formatBucketLine("  unattributed (no evidence)", rollup.unattributed));
if (rollup.note) console.log(`  note: ${rollup.note}`);
console.log("");
console.log(formatBucketLine("TOTAL", rollup.totals));
console.log(`reconciliation: ${check.ok ? "OK" : "FAILED"} — ${check.detail}`);

// Usage anomaly alerts (Theme D5): armed only via PI_USAGE_ALERTS=1|true or the
// presence of ~/.pi/agent/usage-alerts.json — DISARMED (default) means this block
// is skipped entirely and the output is exactly the pre-D5 rollup. When armed and
// a threshold is exceeded: one JSON alert line per anomaly on STDOUT (the
// machine-readable surface a caller acts on) plus a human `WARN:` line on STDERR.
// The spend check always evaluates a true rolling 7-day window, regardless of --days.
const alertCfg = resolveAlertConfig({ env: process.env, alertFile: USAGE_ALERTS_PATH });
if (alertCfg.enabled) {
  const alertRecords = days >= 7 ? records : readUsageRecords(dir, 7).records;
  const alerts = evaluateAlerts(alertCfg, alertInputs(alertRecords));
  if (alerts.length > 0) {
    console.log("");
    for (const a of alerts) console.log(JSON.stringify(a));
    for (const a of alerts) console.error(`WARN: ${a.message}`);
  }
}
process.exit(check.ok ? 0 : 2);
