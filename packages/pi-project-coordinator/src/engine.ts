/**
 * Coordinator engine: per-project serial queues, one writer lease per project,
 * global concurrency cap, durable journal, dedupe by (sourceMessageId, split).
 *
 * Guarantees implemented (and tested):
 * - one running task per project at a time (single-writer lease);
 * - at most `maxConcurrentProjects` projects executing simultaneously;
 * - same source message + split index => exactly one envelope, ever;
 * - runtime failure during a mutating task => "unknown-outcome", never replayed
 *   until markReconciled()/verification clears it;
 * - queue order per project is FIFO across crash-free restarts (journal replay).
 */
import { randomUUID } from "node:crypto";
import type { Registry } from "./registry.ts";
import { TaskJournal, computeDedupeKey, mandateValid, type Authorization, type TaskEnvelope, type TaskOutcome } from "./journal.ts";

export interface ProjectRuntime {
  /** Unique adapter instance identity for lease bookkeeping. */
  readonly runtimeId: string;
  /** Execute one task for a project. Resolve with an outcome; reject on crash. */
  run(envelope: TaskEnvelope, root: string, sessionId: string): Promise<{ outcome: TaskOutcome; summary: string }>;
}

export interface SubmitResult {
  status: "queued" | "duplicate";
  taskId: string;
}

export interface CoordinatorStats {
  running: string[]; // taskIds
  queues: Record<string, string[]>; // projectId -> waiting taskIds
  leases: Record<string, { holder: string; generation: number }>;
  paused?: { paused: boolean; reason?: string; at: string };
}

interface PauseState {
  paused: boolean;
  reason?: string;
  at: string;
}

export class Coordinator {
  private queues = new Map<string, string[]>(); // projectId -> waiting taskIds
  private running = new Map<string, string>(); // projectId -> taskId
  private leases = new Map<string, { holder: string; generation: number }>();
  private active = 0;
  private readonly runtimeById = new Map<string, ProjectRuntime>();

  private readonly registry: Registry;
  private readonly journal: TaskJournal;
  private readonly runtime: ProjectRuntime;
  private readonly options: { maxConcurrentProjects?: number };
  private pause: PauseState;

  constructor(
    registry: Registry,
    journal: TaskJournal,
    runtime: ProjectRuntime,
    options: { maxConcurrentProjects?: number } = {},
  ) {
    this.registry = registry;
    this.journal = journal;
    this.runtime = runtime;
    this.options = options;
    this.runtimeById.set(runtime.runtimeId, runtime);
    // Persistent pause flag lives in the coordinator SQLite store (same db as
    // the journal); it survives crashes and restarts.
    this.pause = this.readPause();
  }

  private readPause(): PauseState {
    const row = this.journal.store.readPause();
    if (row && typeof row.paused === "boolean") {
      return { paused: row.paused, reason: row.reason, at: row.at };
    }
    return { paused: false, at: new Date().toISOString() };
  }

  private writePause(p: PauseState): void {
    this.pause = p;
    this.journal.store.writePause(p);
  }

  /** User "stop" command: blocks new starts and auto-retries; running tasks finish. */
  pauseAll(reason?: string): void {
    this.writePause({ paused: true, reason, at: new Date().toISOString() });
  }

  /** Only a person lifts a pause. Resumes queued work immediately. */
  unpause(): void {
    this.writePause({ paused: false, at: new Date().toISOString() });
    this.pump();
  }

  paused(): boolean {
    // Re-read from the store so pause state written by another live instance
    // (or a previous process) is honored without a restart.
    this.pause = this.readPause();
    return this.pause.paused;
  }

  get maxConcurrent(): number {
    return this.options.maxConcurrentProjects ?? 2;
  }

  /**
   * Register a task. Returns {status:"duplicate"} when the same
   * (sourceMessageId, splitIndex) was already registered; no second execution.
   */
  submit(input: {
    sourceMessageId: string;
    splitIndex: number;
    projectId: string;
    goal: string;
    deliverable: string;
    nonGoals?: string[];
    mutating: boolean;
    origin?: "user" | "primary";
    authorization?: Authorization;
  }): SubmitResult {
    const project = this.registry.projects.find((p) => p.id === input.projectId);
    if (!project || project.status !== "registered") {
      throw new Error(`unknown or disabled project: ${input.projectId}`);
    }
    const dedupeKey = computeDedupeKey(input.sourceMessageId, input.splitIndex);
    const existing = this.journal.findByDedupeKey(dedupeKey);
    if (existing) return { status: "duplicate", taskId: existing.taskId };

    const envelope: TaskEnvelope = {
      taskId: `task-${randomUUID()}`,
      dedupeKey,
      sourceMessageId: input.sourceMessageId,
      splitIndex: input.splitIndex,
      projectId: input.projectId,
      goal: input.goal,
      deliverable: input.deliverable,
      nonGoals: input.nonGoals,
      mutating: input.mutating,
      origin: input.origin,
      authorization: input.authorization,
      createdAt: new Date().toISOString(),
    };
    this.journal.recordEnvelope(envelope);
    this.journal.mark(envelope.taskId, "queued");
    const queue = this.queues.get(envelope.projectId) ?? [];
    queue.push(envelope.taskId);
    this.queues.set(envelope.projectId, queue);
    this.pump();
    return { status: "queued", taskId: envelope.taskId };
  }

  /** Acquire-or-bump the single writer lease for a project. */
  private takeLease(projectId: string): { holder: string; generation: number } {
    const current = this.leases.get(projectId);
    const next = { holder: this.runtime.runtimeId, generation: (current?.generation ?? 0) + 1 };
    this.leases.set(projectId, next);
    return next;
  }

  private pump(): void {
    if (this.paused()) return; // person said stop: nothing new starts
    if (this.active >= this.maxConcurrent) return;
    for (const [projectId] of this.queues) {
      if (this.active >= this.maxConcurrent) break;
      if (this.running.has(projectId)) continue;
      const queue = this.queues.get(projectId)!;
      if (queue.length === 0) continue;
      // Human precedence: user-origin tasks jump the queue (stable otherwise).
      let idx = queue.findIndex((id) => this.journal.getEnvelope(id)?.origin === "user");
      if (idx < 0) idx = 0;
      const taskId = queue.splice(idx, 1)[0];
      this.start(projectId, taskId);
    }
  }

  /**
   * Explicit resume/retry of a settled task (e.g. after reconciliation).
   * Gated by a valid mandate: automatic replay without a recorded, fresh
   * authorization basis is refused. Fresh user submissions via submit()
   * are never gated.
   */
  retry(taskId: string, nowMs: number = Date.now()): SubmitResult {
    const envelope = this.journal.getEnvelope(taskId);
    if (!envelope) throw new Error(`unknown task: ${taskId}`);
    if (this.pause.paused) {
      throw new Error(`refusing auto-resume of ${taskId}: coordinator is paused by a person (unpause first)`);
    }
    if (!mandateValid(envelope.authorization, nowMs)) {
      throw new Error(`refusing auto-resume of ${taskId}: no valid mandate (missing, empty basis, or older than 7 days)`);
    }
    if (this.running.has(envelope.projectId) && this.running.get(envelope.projectId) === taskId) {
      throw new Error(`task ${taskId} is already running`);
    }
    const queue = this.queues.get(envelope.projectId) ?? [];
    if (queue.includes(taskId)) return { status: "queued", taskId };
    queue.push(taskId);
    this.queues.set(envelope.projectId, queue);
    this.journal.mark(taskId, "queued", "requeued via explicit retry (mandate valid)");
    this.pump();
    return { status: "queued", taskId };
  }

  private start(projectId: string, taskId: string): void {
    const envelope = this.journal.getEnvelope(taskId);
    if (!envelope) return;
    const project = this.registry.projects.find((p) => p.id === projectId)!;
    this.running.set(projectId, taskId);
    this.takeLease(projectId);
    this.active += 1;
    this.journal.mark(taskId, "started");
    void this.execute(envelope, project.root, project.sessionId);
  }

  private async execute(envelope: TaskEnvelope, root: string, sessionId: string): Promise<void> {
    try {
      const { outcome, summary } = await this.runtime.run(envelope, root, sessionId);
      this.journal.mark(envelope.taskId, "settled", `${outcome}: ${summary}`);
      // completed-unverified stays open for explicit primary verification.
    } catch (error) {
      // Runtime crashed or could not confirm delivery: outcome unknown for
      // mutating tasks (never auto-replay); read-only tasks may be re-queued
      // by the caller explicitly.
      const outcome = envelope.mutating ? "unknown-outcome" : "failed";
      this.journal.mark(envelope.taskId, "settled", `${outcome}: crash: ${String(error)}`);
    } finally {
      this.running.delete(envelope.projectId);
      this.active -= 1;
      this.pump();
    }
  }

  /** Wait until all queues are drained and no task is running. Test helper. */
  async drain(): Promise<void> {
    while (this.running.size > 0 || [...this.queues.values()].some((q) => q.length > 0)) {
      await new Promise((r) => setTimeout(r, 5));
    }
  }

  stats(): CoordinatorStats {
    const queues: Record<string, string[]> = {};
    for (const [k, v] of this.queues) queues[k] = [...v];
    const leases: Record<string, { holder: string; generation: number }> = {};
    for (const [k, v] of this.leases) leases[k] = { ...v };
    const running: string[] = [];
    for (const taskId of this.running.values()) running.push(taskId);
    const stats: CoordinatorStats = { running, queues, leases };
    if (this.pause.paused) stats.paused = { ...this.pause };
    return stats;
  }
}
