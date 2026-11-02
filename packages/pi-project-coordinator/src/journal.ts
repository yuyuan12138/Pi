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
 */
import fs from "node:fs";
import path from "node:path";
import { createHash } from "node:crypto";

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
  /** Journal file path (public so co-located state files can sit beside it). */
  readonly file: string;

  constructor(file: string) {
    this.file = file;
    if (fs.existsSync(file)) this.replay();
  }

  private replay(): void {
    const lines = fs.readFileSync(this.file, "utf8").split("\n").filter(Boolean);
    for (const line of lines) {
      const rec = JSON.parse(line) as JournalRecord;
      if (rec.phase === "received" && rec.detail) {
        const envelope = JSON.parse(rec.detail) as TaskEnvelope;
        this.envelopes.set(envelope.taskId, envelope);
      }
      this.records.push(rec);
      if (rec.phase === "settled") {
        const outcome = rec.detail?.split(":")[0] as TaskOutcome;
        if (outcome === "completed-unverified" || outcome === "failed" || outcome === "unknown-outcome") {
          this.outcomes.set(rec.taskId, outcome);
        }
      }
      if (rec.phase !== "received") this.knownPhases.set(rec.taskId, rec.phase);
      else if (!this.knownPhases.has(rec.taskId)) this.knownPhases.set(rec.taskId, "received");
    }
  }

  private append(record: JournalRecord): void {
    fs.mkdirSync(path.dirname(this.file), { recursive: true });
    this.records.push(record);
    if (record.phase === "settled") {
      const outcome = record.detail?.split(":")[0] as TaskOutcome;
      if (outcome === "completed-unverified" || outcome === "failed" || outcome === "unknown-outcome") {
        this.outcomes.set(record.taskId, outcome);
      }
    }
    if (record.phase !== "received") this.knownPhases.set(record.taskId, record.phase);
    else if (!this.knownPhases.has(record.taskId)) this.knownPhases.set(record.taskId, "received");
    fs.appendFileSync(this.file, JSON.stringify(record) + "\n", "utf8");
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
    this.append({
      at: envelope.createdAt,
      taskId: envelope.taskId,
      phase: "received",
      detail: JSON.stringify(envelope),
    });
    return true;
  }

  getEnvelope(taskId: string): TaskEnvelope | undefined {
    return this.envelopes.get(taskId);
  }

  findByDedupeKey(dedupeKey: string): TaskEnvelope | undefined {
    for (const e of this.envelopes.values()) if (e.dedupeKey === dedupeKey) return e;
    return undefined;
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
