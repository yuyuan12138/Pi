import { homedir } from "node:os";
import { join } from "node:path";
import { readdirSync, readFileSync, statSync } from "node:fs";
import { createRequire } from "node:module";

/**
 * Read-only view over the pi-project-coordinator database
 * (~/.pi/agent/project-coordinator/coordinator.db, Node built-in node:sqlite —
 * zero deps) backing GET /projects: the registered projects and, per project,
 * the latest journal-derived working status.
 *
 * Data model (coordinator schema):
 *   registry  single row id=1, `json` = {"schemaVersion":1,"projects":[{id,
 *             displayName, aliases, root, sessionId, status, registeredAt}]}
 *   journal   append-only rows (at, task_id, phase, detail, stage); the
 *             `received` row of a task carries the task envelope as JSON in
 *             `detail`, whose `projectId` attributes the whole task to a
 *             project. Per-project activity = the newest journal row across
 *             that project's tasks.
 *
 * Failure posture (matches the bridge's "the UI must never crash the session"
 * rule): ANY read problem — missing file, missing tables, corrupt file, a
 * writer holding the DB, node:sqlite unavailable in the runtime — degrades to
 * an empty list + note. A per-path last-good snapshot is kept so a transient
 * lock blips never flicker the panel empty.
 */

export interface CoordinatorProject {
  id: string;
  displayName: string;
  root: string;
  /** Registry alias list (e.g. ["minecraft", "mc", "sword", "我的世界"]). */
  aliases: string[];
  /** Registry nested-project tree — recursive (any depth). Legacy wire key: "subprojects". */
  subprojects: ChildProjectRef[];
  /** Registry status string (e.g. "registered"); null when the field is absent. */
  status: string | null;
  registeredAt: string | null;
}

/** Journal-derived working status for one project. */
export interface ProjectActivity {
  /** ISO timestamp (`journal.at`) of the newest journal row for the project. */
  lastActivity: string;
  /** Finest state of that row: its `stage` (e.g. "working", "person/review"), falling back to `phase`. */
  lastJournalStatus: string;
}

export interface ProjectView extends CoordinatorProject {
  /** Omitted when the project has no attributable journal rows ("no data"). */
  lastActivity?: string;
  lastJournalStatus?: string;
  /** Present only when >= 1 task in the journal window carries budget fields (Theme D2). */
  budgetPlanned?: number;
  budgetSpent?: number;
  /** Newest project-space work record: a <root>/work subdirectory RECORD.md, if any. */
  work?: ProjectWorkHint;
  /** UI-facing alias of the nested-project tree (node-kind "subproject" is abolished). */
  childProjects?: ChildProjectRef[];
}

/** One project-space work record, parsed down to what a one-line activity needs. */
export interface ProjectWorkHint {
  /** Work directory name under the project root's work dir (e.g. "2026-11-11-graph-schema-backfill"). */
  dir: string;
  /** First `# ` heading of RECORD.md, else the directory name. */
  title: string | null;
  /** Worker instance id from the `**Worker**:` line (e.g. "role-tech-lead.minecraft"). */
  worker: string | null;
  /** RECORD.md mtime, ISO. */
  at: string;
}

export interface ProjectsSnapshot {
  projects: ProjectView[];
  /** Present only when degraded (registry unavailable): short human-readable reason. */
  note?: string;
}

/** A normalized journal row (NULL columns collapsed to null). */
export interface JournalRowLike {
  taskId: string;
  phase: string;
  stage: string | null;
  at: string | null;
  detail: string | null;
  /** Theme D2 budget columns; null/absent on old rows and pre-migration dbs. */
  budgetPlanned?: number | null;
  budgetSpent?: number | null;
}

/** Default coordinator DB location (same file the coordinator owns; read-only here). */
export function defaultCoordinatorDb(): string {
  return join(homedir(), ".pi", "agent", "project-coordinator", "coordinator.db");
}

// node:sqlite is loaded lazily via createRequire: a runtime without it (older
// node) must degrade the projects panel, not fail the whole import chain
// (extension.ts -> server.ts -> this file) and take the bridge down with it.
// `typeof import("node:sqlite")` is types-only and erased at compile time.
type SqliteModule = typeof import("node:sqlite");
let sqlite: SqliteModule | null | undefined;
function sqliteModule(): SqliteModule | null {
  if (sqlite === undefined) {
    try { sqlite = createRequire(import.meta.url)("node:sqlite") as SqliteModule; } catch { sqlite = null; }
  }
  return sqlite;
}

/** Hard bound on journal rows read per snapshot (registry DB is small; the journal is append-only). */
export const JOURNAL_WINDOW = 400;

/**
 * Tolerant registry parse: returns the valid projects, skipping malformed
 * entries, and [] for any garbage input (missing row, corrupt JSON, wrong
 * shape). `id` is the only required field; everything else coerces to null.
 */
/** A nested project in the registry tree — recursive to arbitrary depth. */
export interface ChildProjectRef {
  id: string;
  displayName: string;
  aliases: string[];
  subprojects: ChildProjectRef[];
}

function normSubprojects(raw: unknown): ChildProjectRef[] {
  if (!Array.isArray(raw)) return [];
  const out: ChildProjectRef[] = [];
  for (const entry of raw as Array<Record<string, unknown>>) {
    if (!entry || typeof entry.id !== "string" || !entry.id.trim()) continue;
    out.push({
      id: entry.id,
      displayName: typeof entry.displayName === "string" && entry.displayName ? entry.displayName : entry.id,
      aliases: Array.isArray(entry.aliases) ? entry.aliases.filter((a): a is string => typeof a === "string" && !!a.trim()) : [],
      subprojects: normSubprojects(entry.subprojects),
    });
  }
  return out;
}

export function parseRegistry(raw: unknown): CoordinatorProject[] {
  if (typeof raw !== "string") return [];
  let parsed: unknown;
  try { parsed = JSON.parse(raw); } catch { return []; }
  const list = (parsed as { projects?: unknown } | null)?.projects;
  if (!Array.isArray(list)) return [];
  const out: CoordinatorProject[] = [];
  for (const entry of list) {
    const e = entry as Record<string, unknown> | null;
    if (!e || typeof e.id !== "string" || !e.id.trim()) continue;
    out.push({
      id: e.id,
      displayName: typeof e.displayName === "string" && e.displayName ? e.displayName : e.id,
      root: typeof e.root === "string" ? e.root : "",
      aliases: Array.isArray(e.aliases) ? e.aliases.filter((a): a is string => typeof a === "string" && !!a.trim()) : [],
      subprojects: normSubprojects(e.subprojects),
      status: typeof e.status === "string" ? e.status : null,
      registeredAt: typeof e.registeredAt === "string" ? e.registeredAt : null,
    });
  }
  return out;
}

/**
 * Newest project-space work record for a registered project root:
 * the RECORD.md (in the root's work dir) with the newest mtime, parsed down
 * to the title heading + worker instance id. Read-only, bounded (only `stat`s
 * one entry per work dir + reads the first 4KB of one file); any problem -> null.
 */
export function projectWorkHint(root: string): ProjectWorkHint | null {
  if (!root || typeof root !== "string") return null;
  try {
    const workDir = join(root, "work");
    let best: { rec: string; mtimeMs: number; dir: string } | null = null;
    for (const ent of readdirSync(workDir, { withFileTypes: true })) {
      if (!ent.isDirectory()) continue;
      const rec = join(workDir, ent.name, "RECORD.md");
      try {
        const st = statSync(rec);
        if (st.isFile() && (!best || st.mtimeMs > best.mtimeMs)) best = { rec, mtimeMs: st.mtimeMs, dir: ent.name };
      } catch { /* no RECORD.md in this work dir */ }
    }
    if (!best) return null;
    const head = readFileSync(best.rec, "utf8").slice(0, 4096);
    const title = /^#\s+(.+)$/m.exec(head)?.[1]?.trim() || best.dir;
    const worker = /\*\*Worker\*\*:\s*`([^`]+)`/.exec(head)?.[1]?.trim() || null;
    return { dir: best.dir, title, worker, at: new Date(best.mtimeMs).toISOString() };
  } catch {
    return null;
  }
}

/** Extract `projectId` from a `received`-phase task envelope (`journal.detail`); null when absent/unparseable. */
export function envelopeProjectId(detail: unknown): string | null {
  return parseEnvelopeMeta(detail).projectId;
}

/** Theme D2 budget fields per task, as read from a `received` envelope's detail JSON. */
export interface EnvelopeMeta {
  projectId: string | null;
  budgetPlanned: number | null;
  budgetSpent: number | null;
}

/**
 * Parse a `received`-phase task envelope (`journal.detail`) down to what the
 * projects panel shows: projectId + budget fields. Tolerant: anything absent,
 * unparseable, or non-numeric collapses to null (old rows read as null by
 * design). Both camelCase (budgetPlanned, as the coordinator serializes) and
 * snake_case (budget_planned) keys are accepted.
 */
export function parseEnvelopeMeta(detail: unknown): EnvelopeMeta {
  if (typeof detail !== "string") return { projectId: null, budgetPlanned: null, budgetSpent: null };
  try {
    const env = JSON.parse(detail) as Record<string, unknown> | null;
    if (!env || typeof env !== "object") return { projectId: null, budgetPlanned: null, budgetSpent: null };
    const num = (v: unknown): number | null => (typeof v === "number" && Number.isFinite(v) ? v : null);
    return {
      projectId: typeof env.projectId === "string" && env.projectId ? env.projectId : null,
      budgetPlanned: num(env.budgetPlanned) ?? num(env.budget_planned),
      budgetSpent: num(env.budgetSpent) ?? num(env.budget_spent),
    };
  } catch {
    return { projectId: null, budgetPlanned: null, budgetSpent: null };
  }
}

/** Per-project budget rollup over the journal window (Theme D2). */
export interface ProjectBudget {
  /** Sum of budgetPlanned over tasks whose received row is in the window; null when no task plans a budget. */
  planned: number | null;
  /** Sum of the LATEST budgetSpent per task (settled rows may refresh it); null when no task reports spend. */
  spent: number | null;
  /** Tasks in the window that carry any budget field. */
  tasks: number;
}

/**
 * Map journal rows (NEWEST-FIRST) to per-project budget sums. projectId comes
 * from the first `received` envelope per task (same rule as activity);
 * budgetSpent takes the newest non-null value across the task's rows (a
 * settled row may report the measured spend); budgetPlanned comes from the
 * envelope. Tasks with NO budget fields at all contribute nothing ("shows
 * them when present").
 */
export function projectBudgetsFromJournal(rows: JournalRowLike[]): Map<string, ProjectBudget> {
  const taskProject = new Map<string, string | null>();
  const taskPlanned = new Map<string, number | null>();
  const taskSpent = new Map<string, number | null>();
  for (const r of rows) {
    if (r.phase === "received" && !taskProject.has(r.taskId)) {
      taskProject.set(r.taskId, parseEnvelopeMeta(r.detail).projectId);
    }
    const planned = typeof r.budgetPlanned === "number" && Number.isFinite(r.budgetPlanned)
      ? r.budgetPlanned
      : (r.phase === "received" ? parseEnvelopeMeta(r.detail).budgetPlanned : null);
    const spent = typeof r.budgetSpent === "number" && Number.isFinite(r.budgetSpent) ? r.budgetSpent : null;
    if (planned !== null && !taskPlanned.has(r.taskId)) taskPlanned.set(r.taskId, planned);
    if (spent !== null && !taskSpent.has(r.taskId)) taskSpent.set(r.taskId, spent); // newest-first: first non-null wins
  }
  const out = new Map<string, ProjectBudget>();
  for (const [taskId, projectId] of taskProject) {
    if (!projectId) continue;
    const planned = taskPlanned.get(taskId) ?? null;
    const spent = taskSpent.get(taskId) ?? null;
    if (planned === null && spent === null) continue; // task carries no budget fields
    const agg = out.get(projectId) ?? { planned: null, spent: null, tasks: 0 };
    if (planned !== null) agg.planned = (agg.planned ?? 0) + planned;
    if (spent !== null) agg.spent = (agg.spent ?? 0) + spent;
    agg.tasks += 1;
    out.set(projectId, agg);
  }
  return out;
}

/**
 * Map journal rows (NEWEST-FIRST, as the DESC query returns them) to
 * per-project latest activity. Pass 1 builds taskId -> projectId from the
 * `received` envelopes (first envelope wins); pass 2 records the first row
 * seen per project — the newest — as its activity. Rows with an unparseable
 * `at` are skipped so an older good row still provides the timestamp.
 */
export function projectActivityFromJournal(rows: JournalRowLike[]): Map<string, ProjectActivity> {
  const taskProject = new Map<string, string>();
  for (const r of rows) {
    if (r.phase !== "received" || taskProject.has(r.taskId)) continue;
    const pid = envelopeProjectId(r.detail);
    if (pid) taskProject.set(r.taskId, pid);
  }
  const out = new Map<string, ProjectActivity>();
  for (const r of rows) {
    const pid = taskProject.get(r.taskId);
    if (!pid || out.has(pid)) continue;
    if (typeof r.at !== "string" || !Number.isFinite(Date.parse(r.at))) continue;
    out.set(pid, { lastActivity: r.at, lastJournalStatus: r.stage || r.phase });
  }
  return out;
}

// Last good snapshot per DB path: a transient read failure (e.g. a writer
// holding the lock for a moment) returns the previous snapshot instead of
// flickering the panel empty; only a never-successful path degrades with a note.
const lastGood = new Map<string, ProjectsSnapshot>();

function readOnce(dbPath: string): ProjectsSnapshot {
  const DatabaseSync = sqliteModule()?.DatabaseSync;
  if (!DatabaseSync) throw new Error("node:sqlite is unavailable in this runtime");
  const db = new DatabaseSync(dbPath, { readOnly: true });
  try {
    const regRow = db.prepare("SELECT json FROM registry WHERE id = 1").get() as { json?: unknown } | undefined;
    const projects = parseRegistry(regRow?.json);
    // Theme D2: budget columns exist only after the coordinator store's additive
    // migration has run on this db. A bridge read may happen first — detect via
    // table_info and select accordingly, so a pre-migration db still loads.
    const cols = new Set(
      (db.prepare("PRAGMA table_info(journal)").all() as Array<{ name: string }>).map((c) => c.name),
    );
    const budgetCols = cols.has("budget_planned") && cols.has("budget_spent");
    const journalRows = (db.prepare(
      budgetCols
        ? "SELECT task_id, phase, stage, at, detail, budget_planned, budget_spent FROM journal ORDER BY id DESC LIMIT ?"
        : "SELECT task_id, phase, stage, at, detail FROM journal ORDER BY id DESC LIMIT ?",
    ).all(JOURNAL_WINDOW) as Array<Record<string, unknown>>).map((r) => ({
      taskId: typeof r.task_id === "string" ? r.task_id : "",
      phase: typeof r.phase === "string" ? r.phase : "",
      stage: typeof r.stage === "string" ? r.stage : null,
      at: typeof r.at === "string" ? r.at : null,
      detail: typeof r.detail === "string" ? r.detail : null,
      budgetPlanned: typeof r.budget_planned === "number" ? r.budget_planned : null,
      budgetSpent: typeof r.budget_spent === "number" ? r.budget_spent : null,
    }));
    const activity = projectActivityFromJournal(journalRows);
    const budgets = projectBudgetsFromJournal(journalRows);
    const views: ProjectView[] = projects.map((p) => {
      const a = activity.get(p.id);
      const view: ProjectView = { ...p };
      if (a) { view.lastActivity = a.lastActivity; view.lastJournalStatus = a.lastJournalStatus; }
      const b = budgets.get(p.id);
      if (b) {
        if (b.planned !== null) view.budgetPlanned = b.planned;
        if (b.spent !== null) view.budgetSpent = b.spent;
      }
      const w = p.root ? projectWorkHint(p.root) : null;
      if (w) view.work = w;
      view.childProjects = p.subprojects;
      return view;
    });
    return { projects: views };
  } finally {
    try { db.close(); } catch { /* ignore */ }
  }
}

/** Read the coordinator registry + journal into a UI-ready snapshot; never throws. */
export function readCoordinatorProjects(dbPath: string = defaultCoordinatorDb()): ProjectsSnapshot {
  try {
    const snap = readOnce(dbPath);
    lastGood.set(dbPath, snap);
    return snap;
  } catch (e) {
    const cached = lastGood.get(dbPath);
    if (cached) return cached;
    return { projects: [], note: `coordinator database unavailable (${(e as Error)?.message ?? "read failed"})` };
  }
}
