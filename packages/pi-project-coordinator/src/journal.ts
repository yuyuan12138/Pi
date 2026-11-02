/**
 * Durable task journal (JSONL, append-only).
 *
 * Lifecycle: received -> queued -> started -> settled
 * settled outcomes: completed-unverified | failed | unknown-outcome
 * post-settlement: verified | cancelled (terminal), reconcile-required for
 * unknown-outcome mutating tasks.
 *
 * "completed-unverified" is deliberately not "completed": acceptance
 * verification is a separate human/primary step. `agent_settled` in the RPC
 * runtime maps to completed-unverified, never to verified.
 *
 * Crash rule: a mutating task whose outcome is unknown is never replayed
 * automatically. markReconciled() must be called explicitly after the primary
 * inspects repository/session evidence.
 *
 * Persistence: SQLite (single WAL db, see store.ts). Journal rows are
 * append-only and immutable - no UPDATE/DELETE is ever issued against the
 * journal table. Legacy journal.jsonl in the same directory is imported once
 * by CoordinatorStore and renamed *.legacy.
 */
import { createHash } from "node:crypto";
import { CoordinatorStore } from "./store.ts";

export type TaskOutcome = "completed-unverified" | "failed" | "unknown-outcome";
export type TaskPhase =
  | "received"
  | "queued"
  | "started"
  | "settled"
  | "verified"
  | "cancelled"
  | "reconciled"
  | "question"; // waiting for a person to answer an outstanding question

/** Super-agent style stage label: names WHOM the work currently waits for. */
export type TaskStage =
  | "person/blocked-failed" // failed, no retry pending: a person must decide
  | "person/review" // completed-unverified: a person (primary) must verify
  | "person/answer" // an explicit question to the user is outstanding
  | "working" // a worker session is executing
  | "queued" // waiting for a worker slot
  | "idle"; // terminal (verified/cancelled/reconciled) or unknown

/** Recorded authorization basis for a task (Mandate-lite, dsh-superagent 002). */
export interface Authorization {
  /** Human-readable basis, e.g. a direct user quote. */
  basis: string;
  /** ISO timestamp when the basis was recorded. */
  at: string;
  /** Scope this authorization covers, e.g. "alpha: deploy only". */
  scope: string;
}

export const MANDATE_MAX_AGE_MS = 7 * 24 * 60 * 60 * 1000;

/** A mandate is valid only with a non-empty basis and age < 7 days. */
export function mandateValid(a: Authorization | undefined | null, nowMs: number = Date.now()): boolean {
  if (!a || !a.basis || a.basis.trim().length === 0) return false;
  const at = Date.parse(a.at);
  if (!Number.isFinite(at)) return false;
  const age = nowMs - at;
  return age >= 0 && age < MANDATE_MAX_AGE_MS;
}

/** First-match stage derivation; every branch names the waiting party. */
export function deriveStage(t: { phase?: TaskPhase; outcome?: TaskOutcome }): TaskStage {
  if (t.outcome === "failed") return "person/blocked-failed";
  if (t.outcome === "completed-unverified" && t.phase !== "verified") return "person/review";
  if (t.phase === "question") return "person/answer";
  if (t.phase === "started") return "working";
  if (t.phase === "queued" || t.phase === "received") return "queued";
  return "idle";
}

export interface TaskEnvelope {
  taskId: string;
  /** Stable dedupe key: sha256(sourceMessageId + ":" + splitIndex). */
  dedupeKey: string;
  sourceMessageId: string;
  splitIndex: number;
  projectId: string;
  goal: string;
  /** Deliverable and acceptance evidence expected from the project primary. */
  deliverable: string;
  nonGoals?: string[];
  /** True when execution may mutate state (deploy/push/migrate/write). */
  mutating: boolean;
  /** Who asked for this task; "user" messages take queue precedence. */
  origin?: "user" | "primary";
  /** Recorded authorization basis; gates automatic resume/retry only. */
  authorization?: Authorization;
  createdAt: string;
}

export interface JournalRecord {
  at: string;
  taskId: string;
  phase: TaskPhase;
  detail?: string;
  /** Derived stage label (whom the work waits for), recorded at transitions. */
  stage?: TaskStage;
}

export function computeDedupeKey(sourceMessageId: string, splitIndex: number): string {
  return createHash("sha256").update(`${sourceMessageId}:${splitIndex}`).digest("hex");
}

export class TaskJournal {
  private records: JournalRecord[] = [];
  private envelopes = new Map<string, TaskEnvelope>();
  private knownPhases = new Map<string, TaskPhase>();
  private outcomes = new Map<string, TaskOutcome>();
  /** Backing SQLite store (single writer connection, WAL). */
  readonly store: CoordinatorStore;
  /** Database file path (kept as `file`; co-located state stays together). */
  readonly file: string;

  constructor(file: string) {
    this.store = new CoordinatorStore(file);
    this.file = this.store.dbPath;
    this.replay();
  }

  private replay(): void {
    const rows = this.store.db
      .prepare("SELECT at, task_id, phase, detail, stage FROM journal ORDER BY id")
      .all() as Array<{ at: string; task_id: string; phase: TaskPhase; detail: string | null; stage: string | null }>;
    for (const row of rows) {
      const rec: JournalRecord = {
        at: row.at,
        taskId: row.task_id,
        phase: row.phase,
        detail: row.detail ?? undefined,
      };
      if (row.stage !== null) rec.stage = row.stage as TaskStage;
      this.absorb(rec);
    }
  }

  /** Apply a record to the in-memory indexes; replay and append share this. */
  private absorb(record: JournalRecord): void {
    if (record.phase === "received" && record.detail) {
      const envelope = JSON.parse(record.detail) as TaskEnvelope;
      this.envelopes.set(envelope.taskId, envelope);
    }
    this.records.push(record);
    if (record.phase === "settled") {
      const outcome = record.detail?.split(":")[0] as TaskOutcome;
      if (outcome === "completed-unverified" || outcome === "failed" || outcome === "unknown-outcome") {
        this.outcomes.set(record.taskId, outcome);
      }
    }
    if (record.phase !== "received") this.knownPhases.set(record.taskId, record.phase);
    else if (!this.knownPhases.has(record.taskId)) this.knownPhases.set(record.taskId, "received");
  }

  /** Append-only INSERT into SQLite; journal rows are never UPDATEd/DELETEd. */
  private append(record: JournalRecord, dedupeSha?: string): void {
    this.absorb(record);
    this.store.db
      .prepare("INSERT INTO journal(at, task_id, phase, detail, stage, dedupe_sha) VALUES(?, ?, ?, ?, ?, ?)")
      .run(record.at, record.taskId, record.phase, record.detail ?? null, record.stage ?? null, dedupeSha ?? null);
    return;
  }

  /** Last settled outcome, if any. Kept separate from phase. */
  outcome(taskId: string): TaskOutcome | undefined {
    return this.outcomes.get(taskId);
  }

  /** Persist an envelope. Returns false when the dedupe key already exists. */
  recordEnvelope(envelope: TaskEnvelope): boolean {
    for (const existing of this.envelopes.values()) {
      if (existing.dedupeKey === envelope.dedupeKey) return false;
    }
    this.envelopes.set(envelope.taskId, envelope);
    this.append(
      {
        at: envelope.createdAt,
        taskId: envelope.taskId,
        phase: "received",
        detail: JSON.stringify(envelope),
      },
      envelope.dedupeKey,
    );
    if (envelope.authorization) {
      this.store.db
        .prepare(
          "INSERT INTO mandates(task_id, basis, at, scope) VALUES(?, ?, ?, ?) ON CONFLICT(task_id) DO NOTHING",
        )
        .run(envelope.taskId, envelope.authorization.basis, envelope.authorization.at, envelope.authorization.scope);
    }
    return true;
  }

  getEnvelope(taskId: string): TaskEnvelope | undefined {
    return this.envelopes.get(taskId);
  }

  findByDedupeKey(dedupeKey: string): TaskEnvelope | undefined {
    const row = this.store.db
      .prepare("SELECT task_id FROM journal WHERE dedupe_sha = ? LIMIT 1")
      .get(dedupeKey) as { task_id: string } | undefined;
    return row ? this.envelopes.get(row.task_id) : undefined;
  }

  phase(taskId: string): TaskPhase | undefined {
    return this.knownPhases.get(taskId);
  }

  mark(taskId: string, phase: TaskPhase, detail?: string): void {
    let outcome = this.outcomes.get(taskId);
    if (phase === "settled" && detail) {
      const o = detail.split(":")[0] as TaskOutcome;
      if (o === "completed-unverified" || o === "failed" || o === "unknown-outcome") outcome = o;
    }
    this.append({ at: new Date().toISOString(), taskId, phase, detail, stage: deriveStage({ phase, outcome }) });
  }

  /** Ask the user a question; the task waits for a person (person/answer). */
  askPerson(taskId: string, question: string): void {
    this.append({ at: new Date().toISOString(), taskId, phase: "question", detail: question, stage: "person/answer" });
  }

  /** Current derived stage for a task. */
  stage(taskId: string): TaskStage {
    return deriveStage({ phase: this.knownPhases.get(taskId), outcome: this.outcomes.get(taskId) });
  }

  /** Mutating tasks stuck in unknown-outcome; never replayed automatically. */
  unresolvedMutations(): TaskEnvelope[] {
    const out: TaskEnvelope[] = [];
    for (const e of this.envelopes.values()) {
      const phase = this.knownPhases.get(e.taskId);
      if (
        e.mutating &&
        this.outcomes.get(e.taskId) === "unknown-outcome" &&
        phase !== "reconciled" &&
        phase !== "cancelled" &&
        phase !== "verified"
      ) {
        out.push(e);
      }
    }
    return out;
  }

  allRecords(): JournalRecord[] {
    return [...this.records];
  }
}
