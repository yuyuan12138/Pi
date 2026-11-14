import { existsSync, readFileSync, readdirSync, statSync, mkdtempSync, copyFileSync, rmSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { join, resolve as resolvePath } from "node:path";
import { execFileSync } from "node:child_process";
import { createRequire } from "node:module";
import { readCoordinatorProjects } from "./projects.ts";
import { readTail } from "./state.ts";

/**
 * Server-side readers behind the overview page's deep panels (memory, guard,
 * budget/campaign, system health). All reads are READ-ONLY, bounded, and
 * fail-open in the projects.ts tradition: any problem degrades that one layer
 * to `{ ok: false, note }` (or an empty shape) instead of throwing — a missing
 * file is the quiet normal case (the bridge may run in any project), and the
 * HTTP routes wrap every reader in a catch-all so the endpoints can never 500.
 *
 * Paths honor the same env overrides the owning tools use where they exist
 * (PI_PROFILE_PATH, PI_DISTILLER_STATE, PI_COORDINATOR_GUARD(_LOG)); everything
 * else defaults to the user's real layout under ~/.pi/agent and the bridge
 * project's knowledge-base/.
 */

// node:sqlite loaded lazily via createRequire: a runtime without it degrades
// the memory panel, not the bridge (same pattern as projects.ts).
type SqliteModule = typeof import("node:sqlite");
let sqlite: SqliteModule | null | undefined;
function sqliteModule(): SqliteModule | null {
  if (sqlite === undefined) {
    try { sqlite = createRequire(import.meta.url)("node:sqlite") as SqliteModule; } catch { sqlite = null; }
  }
  return sqlite;
}

/** Degrade shape every reader may return in place of its snapshot. */
export interface Degraded {
  ok: false;
  generatedAt: string;
  note: string;
}

function degraded(note: string): Degraded {
  return { ok: false, generatedAt: new Date().toISOString(), note };
}

// ---------- 1. MEMORY layer ----------

export interface AtomsDay { day: string; count: number }
export interface AtomsProject { project: string; total: number; days: AtomsDay[] }

export interface MemorySnapshot {
  ok: true;
  generatedAt: string;
  atoms: { root: string; projects: AtomsProject[]; total: number; files: number; truncated: boolean; note?: string };
  index: { path: string; kinds: Array<{ kind: string; count: number }>; total: number; note?: string };
  profile: { path: string; exists: boolean; bytes: number | null; mtime: string | null };
  distiller: { path: string; exists: boolean; lastRun: LastRunLike | null; note?: string };
}

/** Mirror of the distiller's LastRunSummary (extensions-src/memory-distiller/src/state.ts). */
export interface LastRunLike {
  at: string;
  trigger: string;
  scanned: number;
  written: number;
  llmUsed: boolean;
  degradedReason: string | null;
  atomsFile: string | null;
}

export interface MemorySourceOverrides {
  atomsRoot?: string;
  indexDb?: string;
  profilePath?: string;
  statePath?: string;
}

const ATOMS_MAX_PROJECTS = 50;
const ATOMS_MAX_FILES_PER_PROJECT = 400;
const ATOMS_MAX_FILE_BYTES = 1 << 20; // 1MB per atoms file: line-count reads stay bounded
const INDEX_DB_COPY_CAP = 64 << 20;   // beyond this, skip the WAL temp-copy fallback
const PROFILE_STALE_DAYS = 30;        // same staleness horizon as distill-profile

export function defaultMemorySourceOverrides(): Required<MemorySourceOverrides> {
  const home = homedir();
  return {
    atomsRoot: process.env.PI_WEB_BRIDGE_KB_ATOMS
      ?? join(process.cwd(), "knowledge-base", "atoms"),
    indexDb: process.env.PI_WEB_BRIDGE_MEMORY_DB
      ?? join(home, ".pi", "agent", "memory", "index.db"),
    profilePath: process.env.PI_PROFILE_PATH
      ?? join(home, ".pi", "agent", "memory", "profile.md"),
    statePath: process.env.PI_DISTILLER_STATE
      ?? join(home, ".pi", "agent", "memory", "distiller", "state.json"),
  };
}

/**
 * knowledge-base/atoms/<project>/<YYYY-MM-DD>.jsonl — append-only distiller
 * atoms. Bounded scan: per-file line counts (≤1MB each), ≤50 projects,
 * ≤400 day-files per project. Days sort newest-first in the response.
 */
export function scanAtoms(root: string): { projects: AtomsProject[]; total: number; files: number; truncated: boolean; note?: string } {
  let names: string[];
  try { names = readdirSync(root, { withFileTypes: true }).map((e) => e.name); } catch {
    return { projects: [], total: 0, files: 0, truncated: false, note: `atoms dir unreadable (${root})` };
  }
  const projects: AtomsProject[] = [];
  let total = 0;
  let files = 0;
  let truncated = false;
  for (const proj of names.sort().slice(0, ATOMS_MAX_PROJECTS)) {
    const dir = join(root, proj);
    let days: string[];
    try {
      if (!statSync(dir).isDirectory()) continue;
      days = readdirSync(dir).filter((f) => /^\d{4}-\d{2}-\d{2}\.jsonl$/.test(f)).sort().reverse();
    } catch { continue; }
    if (days.length > ATOMS_MAX_FILES_PER_PROJECT) { days = days.slice(0, ATOMS_MAX_FILES_PER_PROJECT); truncated = true; }
    const outDays: AtomsDay[] = [];
    let projTotal = 0;
    for (const day of days) {
      const file = join(dir, day);
      let count = 0;
      try {
        const st = statSync(file);
        if (!st.isFile() || st.size > ATOMS_MAX_FILE_BYTES) { truncated = true; continue; }
        const raw = readFileSync(file, "utf8");
        for (let i = 0; i < raw.length; i++) if (raw.charCodeAt(i) === 10) count++;
        if (raw.length > 0 && !raw.endsWith("\n")) count++; // last unterminated line still counts
      } catch { continue; }
      if (count > 0) outDays.push({ day: day.replace(/\.jsonl$/, ""), count });
      projTotal += count;
      files++;
    }
    if (projTotal > 0 || outDays.length) {
      projects.push({ project: proj, total: projTotal, days: outDays.slice(0, 14) });
      total += projTotal;
    }
  }
  return { projects, total, files, truncated };
}

/**
 * index.db `obs` table (extensions-src/memory-index schema): row counts by
 * kind (observation | daily | concept). Read-only; if the on-disk WAL state
 * blocks a read-only open, fall back to a temp COPY (memory_doctor's trick,
 * capped at 64MB) so the panel never blocks a writer and never writes itself.
 */
export function readMemoryIndex(dbPath: string): { kinds: Array<{ kind: string; count: number }>; total: number; note?: string } {
  const DatabaseSync = sqliteModule()?.DatabaseSync;
  if (!DatabaseSync) return { kinds: [], total: 0, note: "node:sqlite unavailable in this runtime" };
  const query = (path: string): Array<{ kind: string; count: number }> => {
    const db = new DatabaseSync(path, { readOnly: true });
    try {
      return (db.prepare("SELECT kind, COUNT(*) AS n FROM obs GROUP BY kind ORDER BY n DESC").all() as Array<Record<string, unknown>>)
        .map((r) => ({ kind: String(r.kind), count: Number(r.n) }));
    } finally {
      try { db.close(); } catch { /* ignore */ }
    }
  };
  try {
    const kinds = query(dbPath);
    return { kinds, total: kinds.reduce((n, k) => n + k.count, 0) };
  } catch (e) {
    // WAL fallback: copy db (+wal/shm) to a temp dir and read the copy.
    let size = 0;
    try { size = statSync(dbPath).size; } catch { /* unreadable below */ }
    if (size > INDEX_DB_COPY_CAP) {
      return { kinds: [], total: 0, note: `memory index unreadable (${(e as Error)?.message ?? "read failed"})` };
    }
    let tmp: string | null = null;
    try {
      tmp = mkdtempSync(join(tmpdir(), "wb-idx-"));
      for (const suffix of ["", "-wal", "-shm"]) {
        try { copyFileSync(dbPath + suffix, join(tmp, "index.db" + suffix)); } catch { /* absent suffix */ }
      }
      const kinds = query(join(tmp, "index.db"));
      return { kinds, total: kinds.reduce((n, k) => n + k.count, 0), note: "read via temp copy (live WAL)" };
    } catch (e2) {
      return { kinds: [], total: 0, note: `memory index unreadable (${(e2 as Error)?.message ?? (e as Error)?.message ?? "read failed"})` };
    } finally {
      if (tmp) { try { rmSync(tmp, { recursive: true, force: true }); } catch { /* temp cleanup */ } }
    }
  }
}

function isLastRunLike(v: unknown): v is LastRunLike {
  if (!v || typeof v !== "object") return false;
  const r = v as Record<string, unknown>;
  return typeof r.at === "string" && typeof r.trigger === "string"
    && typeof r.scanned === "number" && typeof r.written === "number"
    && typeof r.llmUsed === "boolean"
    && (r.degradedReason === null || typeof r.degradedReason === "string")
    && (r.atomsFile === null || typeof r.atomsFile === "string");
}

export function readMemoryLayer(overrides: MemorySourceOverrides = {}): MemorySnapshot | Degraded {
  const o = { ...defaultMemorySourceOverrides(), ...overrides };
  try {
    const atoms = scanAtoms(o.atomsRoot);
    const index = readMemoryIndex(o.indexDb);
    // profile.md: existence + size + mtime (+ staleness horizon note)
    let profile: MemorySnapshot["profile"];
    try {
      const st = statSync(o.profilePath);
      profile = { path: o.profilePath, exists: st.isFile(), bytes: st.isFile() ? st.size : null, mtime: st.isFile() ? new Date(st.mtimeMs).toISOString() : null };
    } catch {
      profile = { path: o.profilePath, exists: false, bytes: null, mtime: null };
    }
    // distiller state.json: bounded lastRun diagnostics (shape-checked, drop not fatal)
    let distiller: MemorySnapshot["distiller"];
    let raw: string | null = null;
    try { raw = readFileSync(o.statePath, "utf8"); } catch { raw = null; }
    if (raw === null) {
      distiller = { path: o.statePath, exists: false, lastRun: null };
    } else {
      let lastRun: LastRunLike | null = null;
      let note: string | undefined;
      try {
        const parsed = JSON.parse(raw) as { lastRun?: unknown };
        if (isLastRunLike(parsed?.lastRun)) lastRun = parsed.lastRun;
        else if (parsed && typeof parsed === "object" && "lastRun" in parsed) note = "distiller state has a malformed lastRun (dropped)";
      } catch {
        note = "distiller state unreadable (corrupt JSON)";
      }
      distiller = { path: o.statePath, exists: true, lastRun, ...(note ? { note } : {}) };
    }
    const staleCut = Date.now() - PROFILE_STALE_DAYS * 86400e3;
    if (profile.mtime && Date.parse(profile.mtime) < staleCut) {
      profile.note = `older than ${PROFILE_STALE_DAYS}d (stale by distill-profile's horizon)`;
    }
    return {
      ok: true,
      generatedAt: new Date().toISOString(),
      atoms: { root: o.atomsRoot, ...atoms },
      index: { path: o.indexDb, ...index },
      profile,
      distiller,
    };
  } catch (e) {
    return degraded(`memory layer unavailable (${(e as Error)?.message ?? "read failed"})`);
  }
}

// ---------- 2. SAFETY / GUARD panel ----------

export interface GuardEntry {
  ts: string | null;
  mode: string | null;
  decision: string;
  tool: string | null;
  category: string | null;
  pattern: string | null;
  excerpt: string | null;
}

export interface GuardSnapshot {
  ok: true;
  generatedAt: string;
  mode: "enforce" | "observe";
  modeSource: "env" | "config" | "default";
  configPath: string;
  logPath: string;
  today: {
    date: string;
    denied: number;
    would_deny: number;
    errors: number;
    byCategory: Array<{ category: string; count: number }>;
  };
  recent: GuardEntry[];
  entriesScanned: number;
  note?: string;
}

export interface GuardSourceOverrides {
  logPath?: string;
  configPath?: string;
  now?: Date;
}

const GUARD_TAIL_BYTES = 256 * 1024; // bounded read; today's tail is always inside
const GUARD_RECENT = 5;

/** Mode resolution in the guard's own precedence: env beats config file beats default. */
export function resolveGuardMode(configPath: string, env = process.env): { mode: "enforce" | "observe"; source: "env" | "config" | "default"; note?: string } {
  const envMode = env.PI_COORDINATOR_GUARD;
  if (envMode === "enforce" || envMode === "observe") return { mode: envMode, source: "env" };
  let raw: string | null = null;
  try { raw = readFileSync(configPath, "utf8"); } catch { raw = null; }
  if (raw !== null) {
    try {
      const cfg = JSON.parse(raw) as { version?: unknown; mode?: unknown };
      if (cfg && typeof cfg === "object" && cfg.version === 1 && (cfg.mode === "enforce" || cfg.mode === "observe")) {
        return { mode: cfg.mode, source: "config" };
      }
      return { mode: "observe", source: "default", note: "coordinator-guard config present but not usable (version/mode) — observe default" };
    } catch {
      return { mode: "observe", source: "default", note: "coordinator-guard config corrupt — observe default" };
    }
  }
  return { mode: "observe", source: "default" };
}

function parseGuardLine(line: string): GuardEntry | null {
  if (!line.trim()) return null;
  try {
    const j = JSON.parse(line) as Record<string, unknown>;
    if (!j || typeof j !== "object" || typeof j.decision !== "string") return null;
    const t = (v: unknown): string | null => (typeof v === "string" ? v : null);
    const ts = t(j.ts);
    return {
      ts,
      mode: t(j.mode),
      decision: j.decision,
      tool: t(j.tool),
      category: t(j.category),
      pattern: t(j.pattern),
      excerpt: t(j.excerpt),
    };
  } catch { return null; }
}

/** Today's guard decisions + the last entries, from the append-only JSONL sink. */
export function readGuardPanel(overrides: GuardSourceOverrides = {}): GuardSnapshot | Degraded {
  const home = homedir();
  const logPath = overrides.logPath
    ?? process.env.PI_COORDINATOR_GUARD_LOG
    ?? join(home, ".pi", "agent", "logs", "coordinator-guard.jsonl");
  const configPath = overrides.configPath ?? join(home, ".pi", "agent", "coordinator-guard.json");
  try {
    const mode = resolveGuardMode(configPath);
    const now = overrides.now ?? new Date();
    const todayDate = `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, "0")}-${String(now.getDate()).padStart(2, "0")}`;
    const dayStart = new Date(now.getFullYear(), now.getMonth(), now.getDate()).getTime();
    const raw = readTail(logPath, GUARD_TAIL_BYTES);
    const lines = raw.split("\n").filter((l) => l.trim());
    const entries = lines.map(parseGuardLine).filter((e): e is GuardEntry => e !== null);
    const recent = entries.slice(-GUARD_RECENT).reverse();
    let denied = 0, would_deny = 0, errors = 0;
    const cats = new Map<string, number>();
    for (const e of entries) {
      const t = e.ts ? Date.parse(e.ts) : NaN;
      if (!Number.isFinite(t) || t < dayStart) continue;
      if (e.decision === "denied") denied++;
      else if (e.decision === "would_deny") would_deny++;
      else if (e.decision === "error") errors++;
      else continue;
      const c = e.category ?? "(none)";
      cats.set(c, (cats.get(c) ?? 0) + 1);
    }
    const byCategory = [...cats.entries()].map(([category, count]) => ({ category, count })).sort((a, b) => b.count - a.count);
    return {
      ok: true,
      generatedAt: new Date().toISOString(),
      mode: mode.mode,
      modeSource: mode.source,
      ...(mode.note ? { note: mode.note } : {}),
      configPath,
      logPath,
      today: { date: todayDate, denied, would_deny, errors, byCategory },
      recent,
      entriesScanned: entries.length,
    };
  } catch (e) {
    return degraded(`guard panel unavailable (${(e as Error)?.message ?? "read failed"})`);
  }
}

// ---------- 3. BUDGET & COST deep: MC closed-loop campaign ----------

export interface CampaignState {
  mode: string | null;
  status: string | null;
  counters: Partial<Record<"cycles_started" | "cycles_completed" | "accepted" | "rejected" | "filtered_out" | "cycles_today", number>> & Record<string, unknown>;
  budget: { token_cap: number | null; spent: number | null };
  caps: Record<string, unknown>;
  node: string | null;
  curriculum: { enabled: boolean | null; node: string | null; parked: string | null; episodeRequestBudget: number | null };
  updatedAt: string | null;
}

export interface CampaignSnapshot {
  root: string | null;
  path: string | null;
  exists: boolean;
  state: CampaignState | null;
  driver: { pid: number; etime: string; command: string } | null;
  note?: string;
}

export interface BudgetSnapshot {
  ok: true;
  generatedAt: string;
  d7: unknown;
  d30: unknown;
  campaign: CampaignSnapshot | null;
  note?: string;
}

/** Liveness of the closed-loop driver: one bounded `ps` scan for closed_loop.py. */
export function findDriver(): { pid: number; etime: string; command: string } | null {
  try {
    const out = execFileSync("ps", ["-axo", "pid=,etime=,command="], { timeout: 3000, maxBuffer: 8 << 20 }).toString("utf8");
    for (const line of out.split("\n")) {
      if (!/closed_loop\.py/.test(line)) continue;
      const m = /^\s*(\d+)\s+(\S+)\s+(.+)$/.exec(line);
      if (m) return { pid: Number(m[1]), etime: m[2], command: m[3].slice(0, 200) };
    }
  } catch { /* ps unavailable or nothing matched */ }
  return null;
}

/** Tolerant projection of wave/closed_loop_state.json (v2; v1 lacks curriculum). */
export function readCampaignState(path: string): CampaignState | null {
  let raw: string;
  try { raw = readFileSync(path, "utf8"); } catch { return null; }
  try {
    const j = JSON.parse(raw) as Record<string, unknown>;
    if (!j || typeof j !== "object") return null;
    const num = (v: unknown): number | null => (typeof v === "number" && Number.isFinite(v) ? v : null);
    const counters = (j.counters ?? {}) as Record<string, unknown>;
    const budget = (j.budget ?? {}) as Record<string, unknown>;
    const node = (j.node ?? {}) as Record<string, unknown>;
    const cur = (j.curriculum ?? {}) as Record<string, unknown>;
    return {
      mode: typeof j.mode === "string" ? j.mode : null,
      status: typeof j.status === "string" ? j.status : null,
      counters,
      budget: { token_cap: num(budget.token_cap), spent: num(budget.spent) },
      caps: (j.caps ?? {}) as Record<string, unknown>,
      node: typeof node.current === "string" ? node.current : null,
      curriculum: {
        enabled: typeof cur.enabled === "boolean" ? cur.enabled : null,
        node: typeof cur.node === "string" ? cur.node : null,
        parked: cur.parked == null ? null : String(cur.parked),
        episodeRequestBudget: num(cur.episode_request_budget),
      },
      updatedAt: typeof j.updated_at === "string" ? j.updated_at : null,
    };
  } catch {
    return null;
  }
}

/**
 * MC closed-loop campaign card: wave/closed_loop_state.json under the
 * minecraft project's registry root (env PI_WEB_BRIDGE_MC_ROOT overrides),
 * plus driver PID liveness via one bounded ps scan. Everything optional.
 */
export function readCampaign(mcRootOverride?: string | null): CampaignSnapshot | null {
  let root: string | null = mcRootOverride ?? process.env.PI_WEB_BRIDGE_MC_ROOT ?? null;
  if (!root) {
    try {
      const snap = readCoordinatorProjects();
      root = (snap.projects ?? []).find((p) => p.id === "minecraft")?.root ?? null;
    } catch { root = null; }
  }
  root = root && typeof root === "string" && root.trim() ? resolvePath(root.trim()) : null;
  if (!root) return { root: null, path: null, exists: false, state: null, driver: null, note: "no minecraft project in the registry" };
  const path = join(root, "wave", "closed_loop_state.json");
  const state = readCampaignState(path);
  const exists = existsSync(path);
  const driver = findDriver();
  return {
    root,
    path,
    exists,
    state,
    driver,
    ...(state === null && exists ? { note: "state file present but unreadable" } : {}),
    ...(!exists ? { note: "no closed_loop_state.json under the minecraft root yet" } : {}),
  };
}

/**
 * Budget & cost deep: the two TTL-cached usage rollups (7d + 30d, wired by
 * extension.ts) + the MC campaign card. `rollups` is already-cached data —
 * this reader never computes it (the TTL source owns that). `campaign`
 * override exists for tests; default resolves the minecraft registry root.
 */
export function readBudgetDeep(rollups: { d7: unknown; d30: unknown } | null, campaignOverride?: CampaignSnapshot | null): BudgetSnapshot | Degraded {
  try {
    const campaign = campaignOverride !== undefined ? campaignOverride : readCampaign();
    return {
      ok: true,
      generatedAt: new Date().toISOString(),
      d7: rollups?.d7 ?? null,
      d30: rollups?.d30 ?? null,
      campaign,
      ...(rollups ? {} : { note: "usage rollups not wired (pi-usage-log unavailable)" }),
    };
  } catch (e) {
    return degraded(`budget panel unavailable (${(e as Error)?.message ?? "read failed"})`);
  }
}

// ---------- 4. SYSTEM health ----------

export interface SystemSnapshot {
  ok: true;
  generatedAt: string;
  bridgeStartedAt: number;
  guard: { mode: "enforce" | "observe"; modeSource: "env" | "config" | "default"; note?: string };
  routing: { path: string; exists: boolean; mtime: string | null; roles: number | null; note?: string };
  extensions: { dir: string; entries: Array<{ name: string; mtime: string }>; count: number; truncated: boolean; note?: string };
}

export interface SystemSourceOverrides {
  routingPath?: string;
  extensionsDir?: string;
  bridgeStartedAt?: number;
}

const EXTENSIONS_MAX = 60;

export function readSystemHealth(overrides: SystemSourceOverrides = {}): SystemSnapshot | Degraded {
  const home = homedir();
  const routingPath = overrides.routingPath ?? join(home, ".pi", "agent", "model-routing.json");
  const extensionsDir = overrides.extensionsDir ?? join(home, ".pi", "agent", "extensions");
  const bridgeStartedAt = overrides.bridgeStartedAt ?? Date.now();
  try {
    // guard mode is cheap — reuse the same resolution for the health strip
    const mode = resolveGuardMode(join(home, ".pi", "agent", "coordinator-guard.json"));
    // D4 declarative model routing: absent = dormant (exactly pre-D4 behavior)
    let routing: SystemSnapshot["routing"];
    try {
      const st = statSync(routingPath);
      let roles: number | null = null;
      let rnote: string | undefined;
      try {
        const parsed = JSON.parse(readFileSync(routingPath, "utf8")) as { roles?: unknown };
        roles = parsed && typeof parsed === "object" && Array.isArray(parsed.roles) ? parsed.roles.length
          : (parsed?.roles && typeof parsed.roles === "object" ? Object.keys(parsed.roles).length : 0);
      } catch {
        rnote = "routing file present but unreadable";
      }
      routing = { path: routingPath, exists: st.isFile(), mtime: st.isFile() ? new Date(st.mtimeMs).toISOString() : null, roles, ...(rnote ? { note: rnote } : {}) };
    } catch {
      routing = { path: routingPath, exists: false, mtime: null, roles: null };
    }
    // installed extensions with mtimes (bounded readdir)
    const entries: Array<{ name: string; mtime: string }> = [];
    let count = 0;
    let truncated = false;
    let enote: string | undefined;
    try {
      const dirents = readdirSync(extensionsDir, { withFileTypes: true });
      count = dirents.length;
      if (count > EXTENSIONS_MAX) truncated = true;
      for (const e of dirents.slice(0, EXTENSIONS_MAX)) {
        try {
          const st = statSync(join(extensionsDir, e.name));
          entries.push({ name: e.name, mtime: new Date(st.mtimeMs).toISOString() });
        } catch { /* raced entry */ }
      }
      entries.sort((a, b) => Date.parse(b.mtime) - Date.parse(a.mtime));
    } catch {
      enote = "extensions dir unreadable";
    }
    return {
      ok: true,
      generatedAt: new Date().toISOString(),
      bridgeStartedAt,
      guard: { mode: mode.mode, modeSource: mode.source, ...(mode.note ? { note: mode.note } : {}) },
      routing,
      extensions: { dir: extensionsDir, entries, count, truncated, ...(enote ? { note: enote } : {}) },
    };
  } catch (e) {
    return degraded(`system health unavailable (${(e as Error)?.message ?? "read failed"})`);
  }
}
