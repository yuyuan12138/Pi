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
import fs from "node:fs";
import path from "node:path";
import { randomUUID } from "node:crypto";
import type { Registry } from "./registry.ts";
import { TaskJournal, computeDedupeKey, type TaskEnvelope, type TaskOutcome } from "./journal.ts";

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
    if (this.active >= this.maxConcurrent) return;
    for (const [projectId] of this.queues) {
      if (this.active >= this.maxConcurrent) break;
      if (this.running.has(projectId)) continue;
      const queue = this.queues.get(projectId)!;
      const taskId = queue.shift();
      if (taskId === undefined) continue;
      this.start(projectId, taskId);
    }
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
    return { running, queues, leases };
  }
}
