/**
 * SQLite-backed durable store for the coordinator (single file, WAL).
 *
 * Adopted from dsh-superagent 007-architecture.md: one durable store, one
 * writer per state kind, "store first, act after commit". We adopt the
 * storage, not their full domain model.
 *
 * Tables:
 *  - meta(key, value)            schema flags (e.g. legacy migration done)
 *  - journal(...)                append-only task lifecycle records
 *  - registry(id=1, json)        the project registry document (validated)
 *  - pause(id=1, ...)            persistent user pause flag
 *  - mandates(task_id, ...)      authorization basis per task (queryable copy
 *                                of envelope.authorization)
 *
 * Journal rows are append-only and immutable: no code path ever UPDATEs or
 * DELETEs a journal row (enforced by code discipline; see journal.ts).
 *
 * Legacy file-based state (journal.jsonl / registry.json / pause.json in the
 * same directory) is imported once, idempotently, then renamed to *.legacy.
 * Legacy files are never deleted.
 *
 * Concurrency: a single DatabaseSync connection per store instance; SQLite
 * file locking plus WAL serializes accidental cross-instance writers, but
 * running two live coordinators over the same DB is out of scope (documented,
 * not enforced).
 */
import fs from "node:fs";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";

export interface PauseRow {
  paused: boolean;
  reason?: string;
  at: string;
}

export class CoordinatorStore {
  readonly dbPath: string;
  readonly db: DatabaseSync;

  constructor(dbPath: string) {
    this.dbPath = dbPath;
    fs.mkdirSync(path.dirname(dbPath), { recursive: true });
    this.db = new DatabaseSync(dbPath);
    this.db.exec("PRAGMA journal_mode = WAL;");
    this.initSchema();
    this.migrateLegacy();
  }

  private initSchema(): void {
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS meta(
        key TEXT PRIMARY KEY,
        value TEXT NOT NULL
      );
      CREATE TABLE IF NOT EXISTS journal(
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        at TEXT NOT NULL,
        task_id TEXT NOT NULL,
        phase TEXT NOT NULL,
        detail TEXT,
        stage TEXT,
        dedupe_sha TEXT
      );
      CREATE INDEX IF NOT EXISTS journal_task ON journal(task_id);
      CREATE TABLE IF NOT EXISTS registry(
        id INTEGER PRIMARY KEY CHECK(id = 1),
        json TEXT NOT NULL
      );
      CREATE TABLE IF NOT EXISTS pause(
        id INTEGER PRIMARY KEY CHECK(id = 1),
        paused INTEGER NOT NULL,
        reason TEXT,
        at TEXT NOT NULL
      );
      CREATE TABLE IF NOT EXISTS mandates(
        task_id TEXT PRIMARY KEY,
        basis TEXT NOT NULL,
        at TEXT NOT NULL,
        scope TEXT NOT NULL
      );
    `);
    this.migrateAdditiveColumns();
  }

  /**
   * Additive column migrations (Theme D2): budget_planned / budget_spent on
   * journal rows. ALTER TABLE ADD COLUMN never touches existing rows (they
   * read back as NULL), so old journals keep replaying byte-identically.
   * Checked via table_info so reopening an already-migrated db is a no-op.
   */
  private migrateAdditiveColumns(): void {
    const cols = new Set(
      (this.db.prepare("PRAGMA table_info(journal)").all() as Array<{ name: string }>).map((c) => c.name),
    );
    if (!cols.has("budget_planned")) this.db.exec("ALTER TABLE journal ADD COLUMN budget_planned REAL");
    if (!cols.has("budget_spent")) this.db.exec("ALTER TABLE journal ADD COLUMN budget_spent REAL");
  }

  // ------------------------------------------------------------- meta

  getMeta(key: string): string | undefined {
    const row = this.db.prepare("SELECT value FROM meta WHERE key = ?").get(key) as
      | { value: string }
      | undefined;
    return row?.value;
  }

  setMeta(key: string, value: string): void {
    this.db.prepare("INSERT INTO meta(key, value) VALUES(?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value").run(key, value);
  }

  // ------------------------------------------------------ legacy import

  /**
   * One-time, idempotent import of file-based legacy state sitting in the same
   * directory: journal.jsonl -> journal, registry.json -> registry,
   * pause.json -> pause. Guarded by meta flag "legacy_imported" so a second
   * constructor run never duplicates rows. Legacy files are renamed *.legacy,
   * never deleted.
   */
  private migrateLegacy(): void {
    if (this.getMeta("legacy_imported")) return;
    const dir = path.dirname(this.dbPath);

    const journalLegacy = path.join(dir, "journal.jsonl");
    const isSqlite = (f: string): boolean => {
      try {
        return fs.readFileSync(f).subarray(0, 15).toString("utf8") === "SQLite format 3";
      } catch {
        return false;
      }
    };
    if (fs.existsSync(journalLegacy) && !isSqlite(journalLegacy)) {
      const insert = this.db.prepare(
        "INSERT INTO journal(at, task_id, phase, detail, stage, dedupe_sha) VALUES(?, ?, ?, ?, ?, ?)",
      );
      const lines = fs.readFileSync(journalLegacy, "utf8").split("\n").filter(Boolean);
      this.db.exec("BEGIN");
      try {
        for (const line of lines) {
          const rec = JSON.parse(line);
          let dedupe: string | undefined;
          if (rec.phase === "received" && rec.detail) {
            try {
              dedupe = JSON.parse(rec.detail).dedupeKey;
            } catch {
              /* leave null */
            }
          }
          insert.run(rec.at, rec.taskId, rec.phase, rec.detail ?? null, rec.stage ?? null, dedupe ?? null);
        }
        this.db.exec("COMMIT");
      } catch (error) {
        this.db.exec("ROLLBACK");
        throw error;
      }
      fs.renameSync(journalLegacy, journalLegacy + ".legacy");
    }

    const registryLegacy = path.join(dir, "registry.json");
    if (fs.existsSync(registryLegacy) && !isSqlite(registryLegacy)) {
      const json = fs.readFileSync(registryLegacy, "utf8");
      this.db.prepare("INSERT INTO registry(id, json) VALUES(1, ?) ON CONFLICT(id) DO NOTHING").run(json);
      fs.renameSync(registryLegacy, registryLegacy + ".legacy");
    }

    const pauseLegacy = path.join(dir, "pause.json");
    if (fs.existsSync(pauseLegacy) && !isSqlite(pauseLegacy)) {
      try {
        const raw = JSON.parse(fs.readFileSync(pauseLegacy, "utf8")) as PauseRow;
        if (raw && typeof raw.paused === "boolean") {
          this.writePause({ paused: raw.paused, reason: raw.reason, at: raw.at });
        }
      } catch {
        /* unreadable legacy pause: treat as not paused */
      }
      fs.renameSync(pauseLegacy, pauseLegacy + ".legacy");
    }

    this.setMeta("legacy_imported", new Date().toISOString());
  }

  // ------------------------------------------------------------ pause

  readPause(): PauseRow | undefined {
    const row = this.db.prepare("SELECT paused, reason, at FROM pause WHERE id = 1").get() as
      | { paused: number; reason: string | null; at: string }
      | undefined;
    if (!row) return undefined;
    return { paused: row.paused === 1, reason: row.reason ?? undefined, at: row.at };
  }

  writePause(p: PauseRow): void {
    this.db
      .prepare(
        "INSERT INTO pause(id, paused, reason, at) VALUES(1, ?, ?, ?) ON CONFLICT(id) DO UPDATE SET paused = excluded.paused, reason = excluded.reason, at = excluded.at",
      )
      .run(p.paused ? 1 : 0, p.reason ?? null, p.at);
  }

  // --------------------------------------------------------- registry

  readRegistryJson(): string | undefined {
    const row = this.db.prepare("SELECT json FROM registry WHERE id = 1").get() as { json: string } | undefined;
    return row?.json;
  }

  writeRegistryJson(json: string): void {
    this.db
      .prepare("INSERT INTO registry(id, json) VALUES(1, ?) ON CONFLICT(id) DO UPDATE SET json = excluded.json")
      .run(json);
  }
}
