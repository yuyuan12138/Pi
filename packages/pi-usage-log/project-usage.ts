/**
 * Per-project usage rollup (Theme D1): aggregate token/cost by PROJECT over
 * the local usage JSONL (~/.pi/agent/usage/<date>.jsonl, written by index.ts).
 *
 * Attribution reuses the web bridge's evidence chain (packages/pi-web-bridge/
 * src/index.html `orgProjectOf`), reduced to the evidence a usage record can
 * carry — registry identity, session names, and the bracketed project tag in
 * the task text. Priority order (first hit wins; every stage is explicit
 * evidence, never a guess):
 *   (a) cwd is the project's canonical root or under it        (registry root)
 *   (b) session id equals the project's registry sessionId      (e.g. "medical-primary")
 *   (c) session carries "role-...@<project>" — @-segment resolves against
 *       registry ids (full, or before a "." spec segment)
 *   (d) session topic convention: "<topic>-x<N>" / "<topic>-<N>" /
 *       "<topic>-primary" — the topic prefix must match a registry alias
 *       (longest prefix wins, aliases < 3 chars never match); superagent
 *       collision suffixes ("-2x41") are stripped first
 *   (e) "[project:<name>]" tag in the task text — resolved against registry
 *       ids/aliases (case-insensitive) or the explicit "personal-ops" bucket;
 *       an unknown tag is IGNORED (falls through, never guessed)
 *   (f) task-text alias evidence: registry aliases + canonical roots matched
 *       in the text — exactly ONE distinct project may hit, otherwise the
 *       record is unattributed (the bridge's 2-mention rule)
 *   (g) no evidence -> "unattributed" bucket (explicit, never guessed)
 *
 * "personal-ops" is assigned ONLY by an explicit [project:personal-ops] tag
 * (stage e) — the same convention the bridge's manifest rows use for
 * unregistered personal work. Unattributed and personal-ops are always
 * reported as their own buckets so the totals reconcile exactly with the raw
 * JSONL sums (reconcile()).
 *
 * Failure posture (mirrors the bridge's projects.ts): the registry read is
 * read-only and tolerant — ANY problem degrades to an empty registry, which
 * attribution handles honestly (records fall to unattributed instead of
 * crashing the /usage command or the CLI).
 */
import { createRequire } from "node:module";
import { existsSync, readFileSync, readdirSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

/** Default coordinator DB location (read-only here; the coordinator owns writes). */
export const DEFAULT_COORDINATOR_DB = join(homedir(), ".pi", "agent", "project-coordinator", "coordinator.db");

/** Default usage JSONL dir (written by index.ts). */
export const DEFAULT_USAGE_DIR = join(homedir(), ".pi", "agent", "usage");

/** Explicit bucket keys (never silently merged into a project). */
export const UNATTRIBUTED = "unattributed";
export const PERSONAL_OPS = "personal-ops";

/** Registry subset the attribution chain needs (tolerant parse of the coordinator registry document). */
export interface RegistryProjectLite {
  id: string;
  displayName: string;
  aliases: string[];
  /** Canonical absolute project root; "" when absent. */
  root: string;
  /** Stable project-primary session id (e.g. "medical-primary"); "" when absent. */
  sessionId: string;
}

/** One usage JSONL record (index.ts writeLine shape; unknown fields tolerated). */
export interface UsageRecordLike {
  ts?: string;
  cwd?: string;
  session?: string;
  /** Additive (new records): human session name, when the session has one. */
  sessionName?: string;
  /** Additive (new records): first line of the most recent user message (<=200 chars). */
  task?: string;
  tokens?: { total?: number };
  cost?: number;
}

/** node:sqlite via createRequire, lazily: a runtime without it degrades the registry read, not the import chain. */
type SqliteModule = typeof import("node:sqlite");
let sqlite: SqliteModule | null | undefined;
function sqliteModule(): SqliteModule | null {
  if (sqlite === undefined) {
    try { sqlite = createRequire(import.meta.url)("node:sqlite") as SqliteModule; } catch { sqlite = null; }
  }
  return sqlite;
}

/**
 * Tolerant registry parse (same document the bridge and the guard read):
 * returns the valid projects, skipping malformed entries, [] for garbage.
 * Registered-status projects only — disabled ones must not attract usage.
 */
export function parseRegistryProjects(raw: unknown): RegistryProjectLite[] {
  if (typeof raw !== "string") return [];
  let parsed: unknown;
  try { parsed = JSON.parse(raw); } catch { return []; }
  const list = (parsed as { projects?: unknown } | null)?.projects;
  if (!Array.isArray(list)) return [];
  const out: RegistryProjectLite[] = [];
  for (const entry of list as Array<Record<string, unknown>>) {
    const e = entry ?? {};
    if (typeof e.id !== "string" || !e.id.trim()) continue;
    if (typeof e.status === "string" && e.status !== "registered") continue;
    out.push({
      id: e.id,
      displayName: typeof e.displayName === "string" && e.displayName ? e.displayName : e.id,
      aliases: Array.isArray(e.aliases) ? e.aliases.filter((a): a is string => typeof a === "string" && !!a.trim()) : [],
      root: typeof e.root === "string" ? e.root : "",
      sessionId: typeof e.sessionId === "string" ? e.sessionId : "",
    });
  }
  return out;
}

/**
 * Read the coordinator registry (read-only) into the attribution subset.
 * Returns [] on ANY problem (missing db, missing table, lock, no node:sqlite):
 * callers attribute honestly to `unattributed` instead of guessing.
 */
export function loadRegistryProjects(dbPath: string = DEFAULT_COORDINATOR_DB): RegistryProjectLite[] {
  try {
    const DatabaseSync = sqliteModule()?.DatabaseSync;
    if (!DatabaseSync) return [];
    const db = new DatabaseSync(dbPath, { readOnly: true });
    try {
      const row = db.prepare("SELECT json FROM registry WHERE id = 1").get() as { json?: unknown } | undefined;
      return parseRegistryProjects(row?.json);
    } finally {
      try { db.close(); } catch { /* ignore */ }
    }
  } catch {
    return [];
  }
}

/**
 * Superagent collision suffix ("bridge-org-x1-2x41" -> "bridge-org-x1") —
 * identical to the bridge's ORG_DIR_SUFFIX_RE, so a session dir renamed with
 * a uniqueness token attributes exactly like the clean name would.
 */
export function dirBase(name: string): string {
  return String(name ?? "").replace(/-([0-9a-z]{4})$/, "");
}

/** ASCII aliases match on word boundaries ("mc" must not hit "mockup"); CJK aliases match as substrings. */
export function textMatches(text: string, alias: string): boolean {
  if (!text || !alias) return false;
  if (!/[a-z0-9]/i.test(alias)) return text.includes(alias.toLowerCase());
  const esc = alias.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  return new RegExp(`(^|[^a-z0-9])${esc}([^a-z0-9]|$)`, "i").test(text);
}

/** True when `dir` is `root` itself or strictly under it (path-boundary aware). */
export function underRoot(dir: string, root: string): boolean {
  if (!dir || !root) return false;
  if (dir === root) return true;
  return dir.startsWith(root.endsWith("/") ? root : root + "/");
}

/**
 * The [project:<name>] tag convention (bracketed project identity token).
 * Returns the tag name, or null. Only the FIRST tag is returned: the routing
 * convention carries exactly one identity tag per brief, and a prose mention
 * of "[project:...]" in quoted text is out of scope for a usage summary.
 */
export function projectTag(taskText: string | undefined | null): string | null {
  const m = /\[project:([^\]]+)\]/i.exec(String(taskText ?? ""));
  return m ? m[1].trim() || null : null;
}

/** Resolve one tag name against registry ids/aliases (case-insensitive) or the personal-ops bucket; null when unknown (never guessed). */
function resolveTag(name: string, registry: RegistryProjectLite[]): string | null {
  const n = name.trim().toLowerCase();
  if (!n) return null;
  if (n === PERSONAL_OPS) return PERSONAL_OPS;
  for (const p of registry) {
    if (String(p.id).toLowerCase() === n) return String(p.id);
    if (p.aliases.some((a) => String(a).toLowerCase() === n)) return String(p.id);
  }
  return null;
}

/**
 * Attribution chain (stages a-f above). Pure: registry is passed in.
 * Returns a registry project id, PERSONAL_OPS, or null (unattributed).
 */
export function attributeUsageProject(rec: UsageRecordLike, registry: RegistryProjectLite[]): string | null {
  // (a) cwd: the session's working directory under a canonical project root.
  // When roots are nested (e.g. minecraft's ops dir inside the piagents
  // workspace), the MOST SPECIFIC (longest) matching root wins — the umbrella
  // project must not swallow work done under a registered subproject root.
  const cwd = typeof rec.cwd === "string" ? rec.cwd : "";
  if (cwd) {
    let best: RegistryProjectLite | null = null;
    for (const p of registry) {
      if (p.root && underRoot(cwd, p.root) && (!best || p.root.length > best.root.length)) best = p;
    }
    if (best) return String(best.id);
  }
  const session = typeof rec.session === "string" ? rec.session.trim() : "";
  const sessionName = typeof rec.sessionName === "string" ? rec.sessionName.trim() : "";
  // (b) exact project-primary session id from the registry.
  for (const name of [session, sessionName]) {
    if (!name) continue;
    for (const p of registry) {
      if (p.sessionId && p.sessionId === name) return String(p.id);
    }
  }
  // (c) role-<name>[.<spec>]@<project> — the @-segment names the project.
  for (const name of [session, sessionName]) {
    if (!name || !name.includes("@")) continue;
    const right = (name.split("@")[1] ?? "").trim();
    const ids = new Set(registry.map((p) => String(p.id)));
    for (const cand of [right, right.split(".")[0]]) {
      if (cand && ids.has(cand)) return cand;
    }
  }
  // (d) "<topic>-x<N>" / "<topic>-<N>" / "<topic>-primary" session ids — the
  // topic prefix must match a registry alias (longest wins, >= 3 chars).
  for (const name of [session, sessionName]) {
    if (!name) continue;
    const base = dirBase(name);
    const m = /^(.+?)-(?:x)?\d+$/.exec(base) ?? /^(.+?)-primary$/.exec(base);
    if (!m) continue;
    const topic = m[1].toLowerCase();
    if (topic.length < 3) continue;
    let best: [alias: string, id: string] | null = null;
    for (const p of registry) {
      for (const a of p.aliases) {
        const al = String(a).toLowerCase();
        if (al.length < 3 || !topic.startsWith(al)) continue;
        if (!best || al.length > best[0].length) best = [al, String(p.id)];
      }
    }
    if (best) return best[1];
  }
  // (e) [project:<name>] tag in the task text.
  const task = typeof rec.task === "string" ? rec.task : "";
  const tag = projectTag(task);
  if (tag) {
    const resolved = resolveTag(tag, registry);
    if (resolved) return resolved;
    // An unknown tag is ignored (falls through) — never guessed into a project.
  }
  // (f) alias evidence in the task text: exactly ONE distinct project may hit
  // (the bridge's 2-mention rule: a cross-project brief citing two projects
  // is not attributable to one). Roots are matched as literal substrings.
  if (task) {
    const hits = new Set<string>();
    for (const p of registry) {
      if (p.root && task.toLowerCase().includes(String(p.root).toLowerCase())) hits.add(String(p.id));
      if (p.aliases.some((a) => textMatches(task, a))) hits.add(String(p.id));
    }
    if (hits.size === 1) return [...hits][0];
  }
  return null;
}

/** One bucket of usage totals. */
export interface UsageBucket {
  tokens: number;
  cost: number;
  turns: number;
  /** Distinct session ids seen in the bucket. */
  sessions: number;
}

function emptyBucket(): UsageBucket {
  return { tokens: 0, cost: 0, turns: 0, sessions: 0 };
}

export interface ProjectUsageRollup {
  /** ISO bounds of the aggregation window (records with ts < since are excluded). */
  since: string;
  until: string;
  /** Attributed projects, sorted by tokens desc. Projects with zero in-window usage are omitted. */
  projects: Array<UsageBucket & { projectId: string; displayName: string }>;
  /** Explicit bucket: records with no attribution evidence. */
  unattributed: UsageBucket;
  /** Explicit bucket: records tagged [project:personal-ops]. */
  personalOps: UsageBucket;
  /** Grand totals — equals unattributed + personalOps + sum(projects); reconcile() pins this against the raw records. */
  totals: UsageBucket & { records: number };
  /** Usage files that were read (absolute paths). */
  filesRead: string[];
  /** Present when the registry was unavailable: everything falls to unattributed, by design. */
  note?: string;
}

function addBucket(b: UsageBucket, rec: UsageRecordLike, sessionId: string | null): void {
  b.tokens += typeof rec.tokens?.total === "number" && Number.isFinite(rec.tokens.total) ? rec.tokens.total : 0;
  b.cost += typeof rec.cost === "number" && Number.isFinite(rec.cost) ? rec.cost : 0;
  b.turns += 1;
  if (sessionId) b.sessions += 1;
}

/**
 * Pure rollup over in-window records. Buckets are disjoint and exhaustive, so
 * `totals` always equals the raw record sums — reconcile() pins it.
 */
export function projectUsageRollup(records: UsageRecordLike[], registry: RegistryProjectLite[], opts: { since: string; until: string; filesRead?: string[]; note?: string }): ProjectUsageRollup {
  const perProject = new Map<string, UsageBucket & { displayName: string; sessionIds: Set<string> }>();
  const unattributed = emptyBucket();
  const personalOps = emptyBucket();
  const totals = { tokens: 0, cost: 0, turns: 0, sessions: 0, records: 0 };
  const unSessions = new Set<string>();
  const poSessions = new Set<string>();
  for (const rec of records) {
    totals.records += 1;
    totals.tokens += typeof rec.tokens?.total === "number" && Number.isFinite(rec.tokens.total) ? rec.tokens.total : 0;
    totals.cost += typeof rec.cost === "number" && Number.isFinite(rec.cost) ? rec.cost : 0;
    totals.turns += 1;
    const sessionId = typeof rec.session === "string" && rec.session.trim() ? rec.session.trim() : null;
    if (sessionId) totals.sessions += 1;
    const key = attributeUsageProject(rec, registry);
    if (key === null) {
      addBucket(unattributed, rec, sessionId);
      if (sessionId) unSessions.add(sessionId);
    } else if (key === PERSONAL_OPS) {
      addBucket(personalOps, rec, sessionId);
      if (sessionId) poSessions.add(sessionId);
    } else {
      let entry = perProject.get(key);
      if (!entry) {
        const p = registry.find((r) => r.id === key);
        entry = { tokens: 0, cost: 0, turns: 0, sessions: 0, displayName: p?.displayName ?? key, sessionIds: new Set() };
        perProject.set(key, entry);
      }
      addBucket(entry, rec, sessionId);
      if (sessionId) entry.sessionIds.add(sessionId);
    }
  }
  unattributed.sessions = unSessions.size;
  personalOps.sessions = poSessions.size;
  const projects = [...perProject.entries()]
    .map(([projectId, e]) => ({ projectId, displayName: e.displayName, tokens: e.tokens, cost: e.cost, turns: e.turns, sessions: e.sessionIds.size }))
    .sort((a, b) => b.tokens - a.tokens || (a.projectId < b.projectId ? -1 : 1));
  const rollup: ProjectUsageRollup = {
    since: opts.since,
    until: opts.until,
    projects,
    unattributed,
    personalOps,
    totals: { tokens: totals.tokens, cost: totals.cost, turns: totals.turns, sessions: totals.sessions, records: totals.records },
    filesRead: opts.filesRead ?? [],
  };
  if (opts.note) rollup.note = opts.note;
  return rollup;
}

/** Reconciliation invariant: bucket sums equal the raw record sums, exactly. */
export function reconcile(rollup: ProjectUsageRollup, records: UsageRecordLike[]): { ok: boolean; detail: string } {
  const raw = records.reduce(
    (acc, r) => {
      acc.tokens += typeof r.tokens?.total === "number" && Number.isFinite(r.tokens.total) ? r.tokens.total : 0;
      acc.cost += typeof r.cost === "number" && Number.isFinite(r.cost) ? r.cost : 0;
      acc.records += 1;
      return acc;
    },
    { tokens: 0, cost: 0, records: 0 },
  );
  const bucketSum = rollup.unattributed.tokens + rollup.personalOps.tokens + rollup.projects.reduce((s, p) => s + p.tokens, 0);
  const bucketCost = rollup.unattributed.cost + rollup.personalOps.cost + rollup.projects.reduce((s, p) => s + p.cost, 0);
  const bucketRecords = rollup.unattributed.turns + rollup.personalOps.turns + rollup.projects.reduce((s, p) => s + p.turns, 0);
  const ok = bucketSum === raw.tokens && bucketCost === raw.cost && bucketRecords === raw.records
    && rollup.totals.tokens === raw.tokens && rollup.totals.cost === raw.cost && rollup.totals.records === raw.records;
  return {
    ok,
    detail: `buckets ${bucketSum} tok / $${bucketCost.toFixed(6)} / ${bucketRecords} rec vs raw ${raw.tokens} tok / $${raw.cost.toFixed(6)} / ${raw.records} rec`,
  };
}

/**
 * Read the usage JSONL day files covering the last `days` UTC days (records
 * with ts < since are filtered out — day files can straddle the cutoff).
 * Tolerant: missing files are skipped, malformed lines are skipped, and the
 * file list is bounded to the date range so the scan stays 7-day sized.
 */
export function readUsageRecords(usageDir: string = DEFAULT_USAGE_DIR, days = 7, nowMs: number = Date.now()): { records: UsageRecordLike[]; filesRead: string[]; since: string; until: string } {
  const untilMs = nowMs;
  const sinceMs = nowMs - days * 24 * 3600e3;
  const since = new Date(sinceMs).toISOString();
  const until = new Date(untilMs).toISOString();
  const records: UsageRecordLike[] = [];
  const filesRead: string[] = [];
  // Day files are named <UTC-date>.jsonl; include every date the window touches.
  const dates = new Set<string>();
  for (let i = 0; i <= days; i++) {
    dates.add(new Date(sinceMs + i * 24 * 3600e3).toISOString().slice(0, 10));
  }
  dates.add(new Date(untilMs).toISOString().slice(0, 10));
  let names: string[] = [];
  try { names = readdirSync(usageDir).filter((n) => /^\d{4}-\d{2}-\d{2}\.jsonl$/.test(n) && dates.has(n.slice(0, 10))); } catch { names = []; }
  names.sort();
  for (const name of names) {
    const file = join(usageDir, name);
    let text: string;
    try { text = readFileSync(file, "utf8"); } catch { continue; }
    filesRead.push(file);
    for (const line of text.split("\n")) {
      if (!line.trim()) continue;
      try {
        const rec = JSON.parse(line) as UsageRecordLike;
        if (typeof rec.ts !== "string" || !Number.isFinite(Date.parse(rec.ts))) continue;
        if (Date.parse(rec.ts) < sinceMs || Date.parse(rec.ts) > untilMs) continue;
        records.push(rec);
      } catch { /* malformed line: skip */ }
    }
  }
  return { records, filesRead, since, until };
}

/** Convenience: read + rollup in one call (the shape both the CLI and the bridge consume). */
export function rollupLastDays(usageDir: string = DEFAULT_USAGE_DIR, registry: RegistryProjectLite[] = [], days = 7, nowMs: number = Date.now()): ProjectUsageRollup {
  const { records, filesRead, since, until } = readUsageRecords(usageDir, days, nowMs);
  const note = registry.length === 0 ? "project registry unavailable or empty — everything is unattributed by design" : undefined;
  return projectUsageRollup(records, registry, { since, until, filesRead, note });
}

/** Compact human line for one bucket, used by the /usage command and the CLI. */
export function formatBucketLine(label: string, b: UsageBucket): string {
  return `${label}: ${b.tokens.toLocaleString()} tokens, $${b.cost.toFixed(4)}, ${b.turns} turns, ${b.sessions} sessions`;
}
