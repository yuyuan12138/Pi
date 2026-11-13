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
process.exit(check.ok ? 0 : 2);
