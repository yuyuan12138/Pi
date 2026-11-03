export type ReportStatus = "progress" | "blocked" | "ready" | "failed" | "dropped";
export type SubagentState = "queued" | "running" | "done" | "failed" | "stopped";

export interface Report { status: ReportStatus; summary: string; question?: string; at: string }

export interface SpawnOptions {
  task: string;
  cwd?: string;
  /** Run inside a fresh git worktree + branch so parallel subagents never collide. */
  isolate?: boolean;
  model?: string;
  label?: string;
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
  reports: Report[];
  result?: string;
  error?: string;
  logDir: string;
  startedAt?: string;
  endedAt?: string;
  toolCalls: number;
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
