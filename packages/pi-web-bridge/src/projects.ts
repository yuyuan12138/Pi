import { homedir } from "node:os";
import { join } from "node:path";
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
      status: typeof e.status === "string" ? e.status : null,
      registeredAt: typeof e.registeredAt === "string" ? e.registeredAt : null,
    });
  }
  return out;
}

/** Extract `projectId` from a `received`-phase task envelope (`journal.detail`); null when absent/unparseable. */
export function envelopeProjectId(detail: unknown): string | null {
  if (typeof detail !== "string") return null;
  try {
    const env = JSON.parse(detail) as { projectId?: unknown } | null;
    return env && typeof env.projectId === "string" && env.projectId ? env.projectId : null;
  } catch { return null; }
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
    const journalRows = (db.prepare(
      "SELECT task_id, phase, stage, at, detail FROM journal ORDER BY id DESC LIMIT ?",
    ).all(JOURNAL_WINDOW) as Array<Record<string, unknown>>).map((r) => ({
      taskId: typeof r.task_id === "string" ? r.task_id : "",
      phase: typeof r.phase === "string" ? r.phase : "",
      stage: typeof r.stage === "string" ? r.stage : null,
      at: typeof r.at === "string" ? r.at : null,
      detail: typeof r.detail === "string" ? r.detail : null,
    }));
    const activity = projectActivityFromJournal(journalRows);
    const views: ProjectView[] = projects.map((p) => {
      const a = activity.get(p.id);
      const view: ProjectView = { ...p };
      if (a) { view.lastActivity = a.lastActivity; view.lastJournalStatus = a.lastJournalStatus; }
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
