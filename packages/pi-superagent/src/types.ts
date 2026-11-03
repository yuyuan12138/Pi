export interface ExecResult { stdout: string; stderr: string; code: number }
export type Exec = (cmd: string, args: string[], opts?: { cwd?: string; timeout?: number }) => Promise<ExecResult>;

export interface Rule {
  /** Issue/PR label that lets the agent act without an explicit @mention (proactive mode). */
  label: string;
  /** "work" = open a work item automatically; "ignore" = never act. */
  action: "work" | "ignore";
}

export interface SuperagentConfig {
  repo: string;            // owner/name
  mention: string;         // e.g. "@my-agent-bot"
  allow: string[];         // GitHub logins allowed to dispatch work
  baseBranch: string;
  pollIntervalSec: number;
  maxConcurrent: number;
  rules: Rule[];
  piCommand: string;       // command used to run a fresh pi session
  piArgs: string[];
  dryRun: boolean;         // record work items but do not execute
}

export type WorkStatus = "queued" | "running" | "done" | "failed" | "needs-human";

export interface WorkItem {
  id: string;              // e.g. "42-123456" (issue-commentId)
  issue: number;
  commentId: number;
  author: string;
  request: string;
  title: string;
  status: WorkStatus;
  branch?: string;
  worktree?: string;
  prUrl?: string;
  error?: string;
  createdAt: string;
  updatedAt: string;
}

export interface Trigger {
  issue: number;
  commentId: number;
  author: string;
  body: string;
  title: string;
  labels: string[];
  createdAt: string;
}
