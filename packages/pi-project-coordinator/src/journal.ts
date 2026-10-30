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
export type TaskPhase = "received" | "queued" | "started" | "settled" | "verified" | "cancelled" | "reconciled";

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
  createdAt: string;
}

export interface JournalRecord {
  at: string;
  taskId: string;
  phase: TaskPhase;
  detail?: string;
}

export function computeDedupeKey(sourceMessageId: string, splitIndex: number): string {
  return createHash("sha256").update(`${sourceMessageId}:${splitIndex}`).digest("hex");
}

export class TaskJournal {
  private records: JournalRecord[] = [];
  private envelopes = new Map<string, TaskEnvelope>();
  private knownPhases = new Map<string, TaskPhase>();
  private outcomes = new Map<string, TaskOutcome>();
  private readonly file: string;

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
    this.append({ at: new Date().toISOString(), taskId, phase, detail });
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
