/**
 * Theme D5 tests: usage anomaly alerts.
 *
 * Layers:
 *  1. Config resolution: DISABLED by default; armed via PI_USAGE_ALERTS=1|true or
 *     the presence of the config file (same routing-config style); `"enabled": false`
 *     opts out; thresholds env > file > sane defaults; invalid values fall through.
 *  2. alertInputs aggregation + evaluateAlerts thresholds (strictly-greater fires).
 *  3. CLI path (integration, spawnSync): armed + exceeded -> one JSON alert line on
 *     stdout + a WARN line on stderr; disarmed -> output unchanged (no JSON, no WARN).
 *
 * Hermetic: fixtures live under os.tmpdir(); env is scrubbed around every case.
 */
import { test, describe } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

import {
  parseUsageAlertConfig,
  readUsageAlertConfig,
  resolveAlertConfig,
  alertInputs,
  evaluateAlerts,
  DEFAULT_DAILY_TOKENS,
  DEFAULT_WEEK_SPEND_USD,
  ENV_MASTER,
  ENV_DAILY_TOKENS,
  ENV_WEEK_SPEND_USD,
  type UsageAlertConfig,
} from "../usage-alerts.ts";
import type { UsageRecordLike } from "../project-usage.ts";

const ENV_VARS = [ENV_MASTER, ENV_DAILY_TOKENS, ENV_WEEK_SPEND_USD] as const;

function withEnv(values: Record<string, string | undefined>, fn: () => void): void {
  const saved = ENV_VARS.map((k) => [k, process.env[k]] as const);
  try {
    for (const k of ENV_VARS) delete process.env[k];
    for (const [k, v] of Object.entries(values)) if (v !== undefined) process.env[k] = v;
    fn();
  } finally {
    for (const [k, v] of saved) { if (v === undefined) delete process.env[k]; else process.env[k] = v; }
  }
}

function tmpDir(): string {
  const d = mkdtempSync(join(tmpdir(), "alerts-"));
  return d;
}

function rec(partial: Partial<UsageRecordLike>, ts: string): UsageRecordLike {
  return { ts, tokens: { total: 100 }, cost: 0.5, ...partial };
}

const NOW = new Date("2026-11-13T12:00:00.000Z").getTime();

// ---------------------------------------------------------------- config resolution

describe("resolveAlertConfig: disabled by default, armed by env or config file", () => {
  test("no env, no file -> disabled with sane default thresholds (and nothing downstream evaluates)", () => {
    withEnv({}, () => {
      const cfg = resolveAlertConfig({ env: process.env, alertFile: join(tmpDir(), "absent.json") });
      assert.equal(cfg.enabled, false);
      assert.equal(cfg.dailyTokens, DEFAULT_DAILY_TOKENS);
      assert.equal(cfg.weekSpendUsd, DEFAULT_WEEK_SPEND_USD);
      assert.deepEqual(evaluateAlerts(cfg, { dailyTokens: 9e9, weekSpendUsd: 9e9 }, NOW), []);
    });
  });

  test("env master flag arms with defaults: '1' and 'true' yes, '0'/'false'/garbage no", () => {
    withEnv({ [ENV_MASTER]: "1" }, () => {
      assert.equal(resolveAlertConfig({ env: process.env, alertFile: join(tmpDir(), "absent.json") }).enabled, true);
    });
    withEnv({ [ENV_MASTER]: "true" }, () => {
      assert.equal(resolveAlertConfig({ env: process.env, alertFile: join(tmpDir(), "absent.json") }).enabled, true);
    });
    for (const off of ["0", "false", "garbage", ""]) {
      withEnv({ [ENV_MASTER]: off }, () => {
        assert.equal(resolveAlertConfig({ env: process.env, alertFile: join(tmpDir(), "absent.json") }).enabled, false, `master=${off}`);
      });
    }
  });

  test("config file presence arms (same routing-config style), even empty", () => {
    const dir = tmpDir();
    const file = join(dir, "usage-alerts.json");
    writeFileSync(file, "{}");
    withEnv({}, () => {
      const cfg = resolveAlertConfig({ env: process.env, alertFile: file });
      assert.equal(cfg.enabled, true);
      assert.equal(cfg.dailyTokens, DEFAULT_DAILY_TOKENS);
    });
  });

  test('file `"enabled": false` opts back out, even against the env master flag', () => {
    const dir = tmpDir();
    const file = join(dir, "usage-alerts.json");
    writeFileSync(file, JSON.stringify({ enabled: false, dailyTokens: 42 }));
    withEnv({ [ENV_MASTER]: "1" }, () => {
      const cfg = resolveAlertConfig({ env: process.env, alertFile: file });
      assert.equal(cfg.enabled, false);
    });
  });

  test("thresholds resolve env > file > defaults; invalid values fall through", () => {
    const dir = tmpDir();
    const file = join(dir, "usage-alerts.json");
    writeFileSync(file, JSON.stringify({ dailyTokens: 500000, weekSpendUsd: 25 }));
    withEnv({}, () => {
      const cfg = resolveAlertConfig({ env: process.env, alertFile: file });
      assert.deepEqual([cfg.dailyTokens, cfg.weekSpendUsd], [500000, 25]);
    });
    withEnv({ [ENV_MASTER]: "1", [ENV_DAILY_TOKENS]: "750000" }, () => {
      const cfg = resolveAlertConfig({ env: process.env, alertFile: file });
      assert.deepEqual([cfg.dailyTokens, cfg.weekSpendUsd], [750000, 25]);
    });
    withEnv({ [ENV_MASTER]: "1", [ENV_DAILY_TOKENS]: "abc", [ENV_WEEK_SPEND_USD]: "-3" }, () => {
      const cfg = resolveAlertConfig({ env: process.env, alertFile: file });
      assert.deepEqual([cfg.dailyTokens, cfg.weekSpendUsd], [500000, 25]);
    });
    withEnv({ [ENV_MASTER]: "1" }, () => {
      const cfg = resolveAlertConfig({ env: process.env, alertFile: join(tmpDir(), "absent.json") });
      assert.deepEqual([cfg.dailyTokens, cfg.weekSpendUsd], [DEFAULT_DAILY_TOKENS, DEFAULT_WEEK_SPEND_USD]);
    });
  });

  test("parse/read: garbage or wrong-typed file -> undefined (+ one warning when the file exists)", () => {
    assert.equal(parseUsageAlertConfig(undefined), undefined);
    assert.equal(parseUsageAlertConfig("not json"), undefined);
    assert.equal(parseUsageAlertConfig("[1]"), undefined);
    assert.deepEqual(parseUsageAlertConfig('{"enabled": true, "dailyTokens": 10, "weekSpendUsd": 2.5}'), { enabled: true, dailyTokens: 10, weekSpendUsd: 2.5 });
    // negative / non-numeric threshold fields are dropped, the rest kept
    assert.deepEqual(parseUsageAlertConfig('{"dailyTokens": -5, "enabled": true}'), { enabled: true });

    const dir = tmpDir();
    const warnings: string[] = [];
    assert.equal(readUsageAlertConfig(join(dir, "absent.json"), (m) => warnings.push(m)), undefined);
    assert.equal(warnings.length, 0); // absent = silent (default posture)
    const bad = join(dir, "bad.json");
    writeFileSync(bad, "{ nope");
    assert.equal(readUsageAlertConfig(bad, (m) => warnings.push(m)), undefined);
    assert.equal(warnings.length, 1);
  });
});

// ---------------------------------------------------------------- inputs + evaluation

describe("alertInputs + evaluateAlerts", () => {
  const CFG: UsageAlertConfig = { enabled: true, dailyTokens: 1_000_000, weekSpendUsd: 50 };

  test("daily tokens sum only today's records; spend sums only the rolling 7-day window", () => {
    const inputs = alertInputs(
      [
        rec({}, "2026-11-13T01:00:00.000Z"),
        rec({ tokens: { total: 200 } }, "2026-11-13T11:59:00.000Z"),
        rec({ cost: 10 }, "2026-11-07T00:00:00.000Z"), // exactly 6 days+12h before NOW -> inside window
        rec({ cost: 10 }, "2026-11-05T00:00:00.000Z"), // 8 days before NOW -> outside
        rec({}, "2026-11-13T23:59:00.000Z"),           // later today: counts for the daily sum (UTC day), excluded from the spend window (after the NOW anchor)
      ],
      NOW,
    );
    assert.equal(inputs.dailyTokens, 400);
    assert.equal(inputs.weekSpendUsd, 11);
  });

  test("malformed ts records are skipped, unknown token/cost shapes count as zero", () => {
    const inputs = alertInputs([{ ts: "garbage", tokens: { total: 5 }, cost: 5 }, rec({}, NOW === 0 ? "" : "2026-11-13T05:00:00.000Z")], NOW);
    assert.equal(inputs.dailyTokens, 100);
    assert.equal(inputs.weekSpendUsd, 0.5);
  });

  test("disabled config never fires, whatever the values", () => {
    assert.deepEqual(evaluateAlerts({ ...CFG, enabled: false }, { dailyTokens: 9e9, weekSpendUsd: 9e9 }, NOW), []);
  });

  test("strictly-greater fires; exactly-at-threshold does not", () => {
    assert.deepEqual(evaluateAlerts(CFG, { dailyTokens: 1_000_000, weekSpendUsd: 50 }, NOW), []);
    const fired = evaluateAlerts(CFG, { dailyTokens: 1_000_001, weekSpendUsd: 50 }, NOW);
    assert.equal(fired.length, 1);
    assert.equal(fired[0].check, "daily_tokens");
  });

  test("a fired alert is the documented machine-readable shape", () => {
    const fired = evaluateAlerts(CFG, { dailyTokens: 1_200_000, weekSpendUsd: 51.5 }, NOW);
    assert.equal(fired.length, 2);
    const [daily, spend] = fired;
    assert.deepEqual(
      { type: daily.type, severity: daily.severity, check: daily.check, value: daily.value, threshold: daily.threshold, unit: daily.unit },
      { type: "usage_anomaly", severity: "warn", check: "daily_tokens", value: 1_200_000, threshold: 1_000_000, unit: "tokens" },
    );
    assert.match(daily.message, /daily token usage 1,200,000 exceeded threshold 1,000,000/);
    assert.equal(spend.check, "week_spend_usd");
    assert.equal(spend.unit, "usd");
    assert.match(spend.message, /7-day spend \$51\.50 exceeded threshold \$50\.00/);
    assert.equal(daily.at, "2026-11-13T12:00:00.000Z");
  });
});

// ---------------------------------------------------------------- CLI path (integration)

const CLI = join(dirname(fileURLToPath(import.meta.url)), "..", "cli.ts");

/** Fixture usage dir with today's JSONL; tokens/cost are caller-tuned to trip one check. */
function usageFixture(records: UsageRecordLike[]): string {
  const dir = join(tmpDir(), "usage");
  mkdirSync(dir, { recursive: true });
  const day = new Date().toISOString().slice(0, 10);
  writeFileSync(join(dir, `${day}.jsonl`), records.map((r) => JSON.stringify(r)).join("\n") + "\n");
  return dir;
}

function runCli(dir: string, env: Record<string, string>) {
  return spawnSync(process.execPath, ["--experimental-strip-types", CLI, "--days", "7", "--dir", dir, "--db", join(tmpDir(), "no-registry.db")], {
    encoding: "utf8",
    env: { ...process.env, ...env },
  });
}

describe("cli.ts anomaly alert surface (Theme D5)", () => {
  test("armed + exceeded: JSON alert line on stdout, WARN line on stderr, exit code untouched", () => {
    const now = new Date().toISOString();
    const dir = usageFixture([
      rec({ tokens: { total: 600_000 }, cost: 0.01 }, now),
      rec({ tokens: { total: 600_000 }, cost: 0.01 }, now), // 1.2M daily tokens; $0.02 spend
    ]);
    const r = runCli(dir, { [ENV_MASTER]: "1", [ENV_DAILY_TOKENS]: "1000000" });
    assert.equal(r.status, 0, r.stderr);
    const jsonLines = r.stdout.split("\n").filter((l) => l.startsWith("{"));
    assert.equal(jsonLines.length, 1);
    const alert = JSON.parse(jsonLines[0]);
    assert.equal(alert.type, "usage_anomaly");
    assert.equal(alert.check, "daily_tokens");
    assert.equal(alert.value, 1_200_000);
    assert.equal(alert.threshold, 1_000_000);
    assert.equal(alert.severity, "warn");
    assert.match(r.stderr, /WARN: daily token usage/);
    assert.equal(r.stderr.includes("week_spend_usd"), false); // $0.02 is far below the default $50
    rmSync(dirname(dir), { recursive: true, force: true });
  });

  test("disarmed (default): no JSON, no WARN — output is exactly the pre-D5 rollup", () => {
    const now = new Date().toISOString();
    const dir = usageFixture([rec({ tokens: { total: 9_000_000 }, cost: 900 }, now)]);
    const r = runCli(dir, {});
    assert.equal(r.status, 0, r.stderr);
    assert.equal(r.stdout.includes("usage_anomaly"), false);
    assert.equal(r.stderr.includes("WARN:"), false);
    assert.match(r.stdout, /reconciliation: OK/);
    rmSync(dirname(dir), { recursive: true, force: true });
  });

  test("the 7-day spend check stays a true 7-day window even under --days 1", () => {
    const now = new Date().toISOString();
    const threeDaysAgo = new Date(Date.now() - 3 * 24 * 3600e3).toISOString();
    const dir = usageFixture([
      rec({ tokens: { total: 10 }, cost: 40 }, now),           // today: cheap
      rec({ tokens: { total: 10 }, cost: 40 }, threeDaysAgo),  // 3 days ago: pushes the week over $50
    ]);
    const r = runCli(dir, { [ENV_MASTER]: "1", [ENV_DAILY_TOKENS]: "1000000" });
    assert.equal(r.status, 0, r.stderr);
    const jsonLines = r.stdout.split("\n").filter((l) => l.startsWith("{"));
    assert.equal(jsonLines.length, 1);
    assert.equal(JSON.parse(jsonLines[0]).check, "week_spend_usd");
    assert.equal(JSON.parse(jsonLines[0]).value, 80);
    rmSync(dirname(dir), { recursive: true, force: true });
  });
});
