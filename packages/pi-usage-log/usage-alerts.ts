/**
 * Usage anomaly alerts (Theme D5, work/2026-11-13/architecture-expansion/PLAN.md):
 * offline threshold evaluation over the local usage rollup. NO network calls, NO
 * notification infrastructure — an alert is a machine-readable surface (JSON line)
 * a caller (script, bridge, agent) can act on.
 *
 * Activation posture (mirrors pi-superagent's model-routing.json, Theme D4):
 * DISABLED by default — with no env flag and no config file nothing is evaluated
 * and every output surface stays byte-for-byte unchanged. Armed by either:
 *   - env `PI_USAGE_ALERTS=1` (or `true`), or
 *   - the presence of `~/.pi/agent/usage-alerts.json` (same routing-config style:
 *     flat JSON; `"enabled": false` opts back out, even against the env flag).
 * When armed, thresholds resolve env > config file > sane defaults, and BOTH
 * checks evaluate: daily tokens > N and rolling-7-day spend > $X (strictly
 * greater fires; exactly-at-threshold does not).
 */
import { readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import type { UsageRecordLike } from "./project-usage.ts";

/** Default config file (same style as the D4 model-routing.json). */
export const USAGE_ALERTS_PATH = join(homedir(), ".pi", "agent", "usage-alerts.json");

/** Sane defaults used when armed but no threshold is configured. */
export const DEFAULT_DAILY_TOKENS = 1_000_000;
export const DEFAULT_WEEK_SPEND_USD = 50;

export const ENV_MASTER = "PI_USAGE_ALERTS";
export const ENV_DAILY_TOKENS = "PI_USAGE_ALERT_DAILY_TOKENS";
export const ENV_WEEK_SPEND_USD = "PI_USAGE_ALERT_WEEK_SPEND_USD";

export interface UsageAlertConfig {
  enabled: boolean;
  /** Daily token threshold (UTC day). */
  dailyTokens: number;
  /** Rolling 7-day spend threshold, USD. */
  weekSpendUsd: number;
}

export interface UsageAlert {
  type: "usage_anomaly";
  severity: "warn";
  check: "daily_tokens" | "week_spend_usd";
  value: number;
  threshold: number;
  unit: "tokens" | "usd";
  message: string;
  at: string;
}

/** Tolerant config-file parse: absent/garbage -> undefined; valid doc -> sanitized fields (bad values dropped). */
export function parseUsageAlertConfig(raw: string | undefined): { enabled?: boolean; dailyTokens?: number; weekSpendUsd?: number } | undefined {
  if (raw === undefined || raw.trim() === "") return undefined;
  let doc: unknown;
  try { doc = JSON.parse(raw); } catch { return undefined; }
  if (typeof doc !== "object" || doc === null || Array.isArray(doc)) return undefined;
  const d = doc as Record<string, unknown>;
  const out: { enabled?: boolean; dailyTokens?: number; weekSpendUsd?: number } = {};
  if (typeof d["enabled"] === "boolean") out.enabled = d["enabled"];
  const tokens = positiveNumber(d["dailyTokens"]);
  if (tokens !== undefined) out.dailyTokens = tokens;
  const spend = positiveNumber(d["weekSpendUsd"]);
  if (spend !== undefined) out.weekSpendUsd = spend;
  return out;
}

/** Read the config file; absent/unreadable/malformed -> undefined (with a one-line stderr warning only when the file exists but is malformed). */
export function readUsageAlertConfig(
  path: string = USAGE_ALERTS_PATH,
  warn: (msg: string) => void = (m) => process.stderr.write(m + "\n"),
): { enabled?: boolean; dailyTokens?: number; weekSpendUsd?: number } | undefined {
  let raw: string | undefined;
  try { raw = readFileSync(path, "utf8"); } catch { return undefined; }
  const parsed = parseUsageAlertConfig(raw);
  if (!parsed) {
    warn(`pi-usage-log: ${path} exists but is not a valid usage-alerts config — ignoring it (alerts stay armed only via ${ENV_MASTER}; see the package README).`);
  }
  return parsed;
}

function positiveNumber(v: unknown): number | undefined {
  const n = typeof v === "number" ? v : typeof v === "string" && v.trim() !== "" ? Number(v) : NaN;
  return Number.isFinite(n) && n > 0 ? n : undefined;
}

function envNumber(raw: string | undefined): number | undefined {
  return raw === undefined ? undefined : positiveNumber(raw);
}

function envTruthy(raw: string | undefined): boolean {
  if (raw === undefined) return false;
  const v = raw.trim().toLowerCase();
  return v === "1" || v === "true";
}

/**
 * Resolve the alert configuration: armed = env master flag truthy OR config file
 * present (unless the file says `"enabled": false` — an explicit opt-out wins).
 * Thresholds: env > config file > defaults. Pure in `env`; reads `alertFile` from
 * disk (pass a tmp path in tests; production callers pass USAGE_ALERTS_PATH).
 */
export function resolveAlertConfig(opts: { env?: NodeJS.ProcessEnv; alertFile?: string } = {}): UsageAlertConfig {
  const env = opts.env ?? process.env;
  const file = readUsageAlertConfig(opts.alertFile ?? USAGE_ALERTS_PATH, () => { /* resolveAlertConfig is silent: callers own stderr */ });
  const enabled = file?.enabled === false ? false : (envTruthy(env[ENV_MASTER]) || file !== undefined);
  return {
    enabled,
    dailyTokens: envNumber(env[ENV_DAILY_TOKENS]) ?? file?.dailyTokens ?? DEFAULT_DAILY_TOKENS,
    weekSpendUsd: envNumber(env[ENV_WEEK_SPEND_USD]) ?? file?.weekSpendUsd ?? DEFAULT_WEEK_SPEND_USD,
  };
}

export interface AlertInputs {
  /** Tokens logged in the current UTC day. */
  dailyTokens: number;
  /** Cost summed over the rolling 7-day window ending now. */
  weekSpendUsd: number;
}

/**
 * Aggregate the two alert inputs from raw usage records (index.ts JSONL shape,
 * unknown fields tolerated; malformed/missing ts records are skipped). The 7-day
 * window filter lives here so callers can pass any superset of recent records.
 */
export function alertInputs(records: UsageRecordLike[], nowMs: number = Date.now()): AlertInputs {
  const weekAgoMs = nowMs - 7 * 24 * 3600e3;
  const day = new Date(nowMs).toISOString().slice(0, 10);
  let dailyTokens = 0;
  let weekSpendUsd = 0;
  for (const r of records) {
    const tsMs = Date.parse(String(r.ts ?? ""));
    if (!Number.isFinite(tsMs)) continue;
    const iso = new Date(tsMs).toISOString();
    if (iso.slice(0, 10) === day) {
      dailyTokens += typeof r.tokens?.total === "number" && Number.isFinite(r.tokens.total) ? r.tokens.total : 0;
    }
    if (tsMs >= weekAgoMs && tsMs <= nowMs) {
      weekSpendUsd += typeof r.cost === "number" && Number.isFinite(r.cost) ? r.cost : 0;
    }
  }
  return { dailyTokens, weekSpendUsd };
}

/**
 * Pure threshold evaluation. Strictly-greater fires ("daily tokens > N, 7-day
 * spend > $X"); exactly-at-threshold does not. Disabled config -> no alerts, ever.
 */
export function evaluateAlerts(cfg: UsageAlertConfig, inputs: AlertInputs, nowMs: number = Date.now()): UsageAlert[] {
  if (!cfg.enabled) return [];
  const at = new Date(nowMs).toISOString();
  const alerts: UsageAlert[] = [];
  if (inputs.dailyTokens > cfg.dailyTokens) {
    alerts.push({
      type: "usage_anomaly",
      severity: "warn",
      check: "daily_tokens",
      value: inputs.dailyTokens,
      threshold: cfg.dailyTokens,
      unit: "tokens",
      message: `daily token usage ${inputs.dailyTokens.toLocaleString("en-US")} exceeded threshold ${cfg.dailyTokens.toLocaleString("en-US")} (current UTC day)`,
      at,
    });
  }
  if (inputs.weekSpendUsd > cfg.weekSpendUsd) {
    alerts.push({
      type: "usage_anomaly",
      severity: "warn",
      check: "week_spend_usd",
      value: inputs.weekSpendUsd,
      threshold: cfg.weekSpendUsd,
      unit: "usd",
      message: `7-day spend $${inputs.weekSpendUsd.toFixed(2)} exceeded threshold $${cfg.weekSpendUsd.toFixed(2)} (rolling window)`,
      at,
    });
  }
  return alerts;
}
