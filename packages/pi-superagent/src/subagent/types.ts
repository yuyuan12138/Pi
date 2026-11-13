import type { ModelSource } from "./model-routing.ts";

export type ReportStatus = "progress" | "blocked" | "ready" | "failed" | "dropped";
export type SubagentState = "queued" | "running" | "done" | "failed" | "stopped";

export interface Report { status: ReportStatus; summary: string; question?: string; at: string }

export interface SpawnOptions {
  task: string;
  cwd?: string;
  /** Run inside a fresh git worktree + branch so parallel subagents never collide. */
  isolate?: boolean;
  /** Run N (1-3) identical copies of this task in parallel (best-of-N). All N are tracked to a
   *  terminal state and resolved together as a combined result; picking the best member is the
   *  parent agent's job. A fanout of N counts as N against the spawn budget. */
  fanout?: number;
  model?: string;
  label?: string;
  /** Optional role selector for the declarative model routing table (Theme D4, `roles` key of ~/.pi/agent/model-routing.json). Ignored when no table is configured or no entry matches; never overrides an explicit model arg. */
  role?: string;
  /** Exact tool-name allowlist for the child (workflow limit, not a sandbox). [] disables all built-in tools; omit for pi defaults. */
  tools?: string[];
  /** Named child session id: created on first spawn, resumed on later spawns with the same id. */
  session?: string;
}

export interface SubagentInfo {
  id: string;
  label: string;
  task: string;
  state: SubagentState;
  cwd: string;
  worktree?: string;
  branch?: string;
  model?: string;
  /** How the launched model was chosen (Theme D4 audit field): explicit arg, a routing-table hit, env, or the built-in fallback. Set at launch; absent for queued subagents. */
  modelSource?: ModelSource;
  tools?: string[];
  /** Role selector passed at spawn (Theme D4 routing input); absent when not provided. */
  role?: string;
  session?: string;
  reports: Report[];
  result?: string;
  error?: string;
  logDir: string;
  startedAt?: string;
  endedAt?: string;
  toolCalls: number;
  /** Chain of ancestor agent ids that produced this agent (root-first). [] = spawned by the root session. */
  spawnedBy: string[];
  /** Spawn depth: 1 = spawned by the root session. Uncapped (observability/lineage only — the spawn budget is the only bound). */
  depth: number;
  /** Present on members of a fanout group (fanout > 1): the group id and this member's position. */
  fanout?: { groupId: string; total: number; index: number; memberIds: string[] };
}

/** One member of a fanout group, resolved once every member reached a terminal state. */
export interface FanoutMemberResult {
  id: string;
  status: SubagentState;
  /** Final assistant text of a done member. */
  resultText?: string;
  error?: string;
  worktree?: string;
  /** Lineage: chain of ancestor agent ids (root-first); [] = spawned by the root session. */
  spawnedBy: string[];
  /** Spawn depth: 1 = spawned by the root session. */
  depth: number;
}

/** Minimal child-process surface so tests can mock pi. */
export interface ChildLike {
  stdin: { write(s: string): unknown; end(): unknown } | null;
  stdout: { on(ev: "data", cb: (b: Buffer | string) => void): unknown } | null;
  stderr?: { on(ev: "data", cb: (b: Buffer | string) => void): unknown } | null;
  on(ev: "exit", cb: (code: number | null) => void): unknown;
  kill(sig?: NodeJS.Signals): unknown;
}
export type SpawnFn = (cmd: string, args: string[], opts: { cwd: string; env: NodeJS.ProcessEnv }) => ChildLike;
