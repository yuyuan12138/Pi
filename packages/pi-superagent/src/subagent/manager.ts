import { appendFileSync, mkdirSync } from "node:fs";
import { join } from "node:path";
import type { ChildLike, FanoutMemberResult, Report, ReportStatus, SpawnFn, SpawnOptions, SubagentInfo } from "./types.ts";
import type { Exec } from "../types.ts";

export const REPORT_TOOL = "report_to_parent";
/** The extension's own delegation tool; appended to child --tools allowlists for recursion. */
export const SPAWN_TOOL = "subagent_spawn";
/** Max fanout per spawn call (best-of-N candidates). */
export const MAX_FANOUT = 3;
/** Max spawn depth: depth 1 = spawned by the root session; agents at this depth cannot spawn further. */
export const MAX_SPAWN_DEPTH = 3;
/** Per-agent spawn budget when PI_SPAWN_BUDGET is unset (fanout of N counts as N). */
export const DEFAULT_SPAWN_BUDGET = 3;
const FANOUT_LETTERS = ["a", "b", "c"];

/** Spawn depth of this process from PI_SPAWN_DEPTH; unset/empty = 0 (root). A corrupt value fails closed. */
export function parseSpawnDepth(raw: string | undefined): number {
  if (raw === undefined || raw.trim() === "") return 0;
  const n = Number.parseInt(raw, 10);
  return Number.isNaN(n) || n < 0 ? Number.MAX_SAFE_INTEGER : n;
}

/** Per-agent spawn budget from PI_SPAWN_BUDGET; unset/invalid = DEFAULT_SPAWN_BUDGET. */
export function parseSpawnBudget(raw: string | undefined): number {
  if (raw === undefined || raw.trim() === "") return DEFAULT_SPAWN_BUDGET;
  const n = Number.parseInt(raw, 10);
  return Number.isNaN(n) || n < 0 ? DEFAULT_SPAWN_BUDGET : n;
}

function parseSpawnChain(raw: string | undefined): string[] {
  return raw ? raw.split(",").map((s) => s.trim()).filter(Boolean) : [];
}

interface FanoutGroup {
  id: string;               // base id; member ids are `${id}-a`…
  total: number;
  memberIds: string[];
  combined?: FanoutMemberResult[];   // set once every member is terminal
  waiters: ((combined: FanoutMemberResult[]) => void)[];
  notified: boolean;        // combined background report delivered?
}

/** Built-in tools a spawned child may be given (matches pi-minimal-subagent's child-allowed set). */
export const CHILD_BUILTIN_TOOLS = ["read", "grep", "find", "ls", "bash", "edit", "write"];
/** Named child session ids must match this (same pattern as pi-minimal-subagent). */
const SESSION_ID_RE = /^[A-Za-z0-9](?:[A-Za-z0-9._-]*[A-Za-z0-9])?$/;

export interface Delivery {
  /** Short text for the main session. `wake` = start a main-agent turn if idle. */
  deliver(text: string, opts: { wake: boolean; id: string }): void;
  onChange?(): void;
}

export interface ManagerOptions {
  spawn: SpawnFn;
  exec?: Exec;
  piCommand?: string;
  extensionPath: string;    // this extension, loaded into every child
  baseDir: string;          // where logs + worktrees live
  maxConcurrent?: number;
  progressThrottleMs?: number;
  resultMaxChars?: number;
  now?: () => number;
  /** This agent's spawn depth (default: PI_SPAWN_DEPTH env, unset = 0 = root). Depths >= MAX_SPAWN_DEPTH refuse to spawn. */
  spawnDepth?: number;
  /** This agent's ancestor id chain, root-first (default: PI_SPAWN_CHAIN env). */
  spawnChain?: string[];
  /** This agent's own subagent id (default: PI_SUBAGENT_ID env); prefixed onto spawned child ids so ids stay unique across the tree. */
  selfId?: string;
  /** Total spawns this agent may make; a fanout of N counts as N (default: PI_SPAWN_BUDGET env, else DEFAULT_SPAWN_BUDGET). */
  spawnBudget?: number;
}

export function truncate(s: string, n: number): string {
  if (s.length <= n) return s;
  return s.slice(0, n) + `\n…[truncated ${s.length - n} chars]`;
}

interface Live { info: SubagentInfo; child?: ChildLike; buf: string; pending: Map<string, (d: any) => void>; seq: number; lastProgressAt: number; heldProgress?: Report; throttleTimer?: ReturnType<typeof setTimeout>; finished: boolean; waiters: ((i: SubagentInfo) => void)[] }

export class SubagentManager {
  private subs = new Map<string, Live>();
  private queue: string[] = [];
  private n = 0;
  readonly max: number;
  private throttle: number;
  private resultMax: number;
  private now: () => number;
  private groups = new Map<string, FanoutGroup>();
  /** This agent's spawn depth: 0 = root session, MAX_SPAWN_DEPTH = leaf (cannot spawn). */
  private depth: number;
  /** Prefix for spawned child ids: the agent's own id + "-" so ids stay unique across the whole spawn tree. */
  private idPrefix: string;
  /** Lineage stamped onto spawned children: this agent's ancestors + its own id. */
  private childSpawnedBy: string[];
  /** PI_SPAWN_DEPTH passed to children: this agent's depth + 1 (root spawn = depth 1). */
  private childDepth: number;
  private budget: number;
  private used = 0;

  constructor(private o: ManagerOptions, private d: Delivery) {
    this.max = Math.max(1, o.maxConcurrent ?? 3);
    this.throttle = o.progressThrottleMs ?? 60_000;
    this.resultMax = o.resultMaxChars ?? 2000;
    this.now = o.now ?? Date.now;
    this.depth = o.spawnDepth ?? parseSpawnDepth(process.env.PI_SPAWN_DEPTH);
    const selfId = o.selfId ?? (process.env.PI_SUBAGENT_ID || undefined);
    this.idPrefix = selfId ? `${selfId}-` : "";
    const selfChain = o.spawnChain ?? parseSpawnChain(process.env.PI_SPAWN_CHAIN);
    this.childSpawnedBy = selfId ? [...selfChain, selfId] : selfChain;
    this.childDepth = this.depth + 1;
    this.budget = Math.max(0, o.spawnBudget ?? parseSpawnBudget(process.env.PI_SPAWN_BUDGET));
  }

  list(): SubagentInfo[] { return [...this.subs.values()].map((l) => l.info); }
  get(id: string): SubagentInfo | undefined { return this.subs.get(id)?.info; }
  running(): number { return this.list().filter((i) => i.state === "running").length; }

  /** Resolves when the subagent reaches a terminal state (done/failed/stopped); queued subagents are waited out too. */
  waitFor(id: string): Promise<SubagentInfo> {
    const l = this.need(id);
    if (l.finished) return Promise.resolve(l.info);
    return new Promise((res) => { l.waiters.push(res); });
  }

  /** Resolves with the combined result once EVERY member of the fanout group is terminal.
   *  Accepts the group base id (e.g. "sa5") or any member id (e.g. "sa5-b"). */
  async waitForAll(key: string): Promise<FanoutMemberResult[]> {
    const g = this.groupOf(key);
    if (g.combined) return g.combined;
    return new Promise((res) => { g.waiters.push(res); });
  }

  private groupOf(key: string): FanoutGroup {
    const direct = this.groups.get(key);
    if (direct) return direct;
    const gid = this.subs.get(key)?.info.fanout?.groupId;
    const viaMember = gid ? this.groups.get(gid) : undefined;
    if (viaMember) return viaMember;
    throw new Error(`no fanout group ${key}`);
  }

  async spawn(opts: SpawnOptions): Promise<SubagentInfo> {
    if (opts.session !== undefined && !SESSION_ID_RE.test(opts.session)) throw new Error(`invalid subagent session id: ${opts.session}`);
    if (opts.tools) {
      const bad = opts.tools.find((t) => !CHILD_BUILTIN_TOOLS.includes(t));
      if (bad) throw new Error(`Only built-in child tools are enabled (got "${bad}"; allowed: ${CHILD_BUILTIN_TOOLS.join(", ")})`);
    }
    const n = opts.fanout ?? 1;
    if (!Number.isInteger(n) || n < 1 || n > MAX_FANOUT) throw new Error(`fanout must be an integer between 1 and ${MAX_FANOUT}, got ${String(opts.fanout)}`);
    if (n > 1 && opts.session !== undefined) throw new Error("fanout cannot be combined with a named session: each member needs its own session");
    // Recursion guard: an agent at MAX_SPAWN_DEPTH (or with a corrupt PI_SPAWN_DEPTH, which fails
    // closed) cannot spawn further. Clear error, never a silent no-op.
    if (this.depth >= MAX_SPAWN_DEPTH) throw new Error(`subagent_spawn refused: max spawn depth ${MAX_SPAWN_DEPTH} reached (this agent is at depth ${this.depth}); subagents cannot spawn further subagents`);
    // Per-agent spawn budget: a fanout of N counts as N. Exhaustion is a loud error.
    if (this.used + n > this.budget) throw new Error(`subagent_spawn budget exhausted: ${this.used}/${this.budget} spawns used (PI_SPAWN_BUDGET=${this.budget}); ${n} more requested (a fanout of N counts as N)`);
    if (opts.isolate && !this.o.exec) throw new Error("isolate requires git exec");
    const base = `${this.idPrefix}sa${++this.n}`;
    const memberIds = n === 1 ? [base] : Array.from({ length: n }, (_, i) => `${base}-${FANOUT_LETTERS[i]}`);
    const members: SubagentInfo[] = [];
    const createdWorktrees: { wt: string; branch: string }[] = [];
    try {
      for (let i = 0; i < n; i++) {
        const id = memberIds[i];
        const logDir = join(this.o.baseDir, id);
        mkdirSync(logDir, { recursive: true });
        const info: SubagentInfo = { id, label: opts.label ?? opts.task.slice(0, 40), task: opts.task, state: "queued", cwd: opts.cwd ?? this.o.baseDir, model: opts.model, tools: opts.tools, session: opts.session, reports: [], logDir, toolCalls: 0, spawnedBy: [...this.childSpawnedBy], depth: this.childDepth };
        if (n > 1) info.fanout = { groupId: base, total: n, index: i, memberIds };
        if (opts.isolate) {
          if (!this.o.exec) throw new Error("isolate requires git exec");
          const branch = `subagent/${id}-${Date.now().toString(36)}`;
          const wt = join(this.o.baseDir, "worktrees", id);
          const r = await this.o.exec("git", ["worktree", "add", "-b", branch, wt, "HEAD"], { cwd: info.cwd });
          if (r.code !== 0) throw new Error(`git worktree add failed: ${r.stderr.trim()}`);
          createdWorktrees.push({ wt, branch });
          Object.assign(info, { worktree: wt, branch, cwd: wt });
        }
        members.push(info);
      }
    } catch (e) {
      // Roll back partially created worktrees so a failed fanout leaves no debris.
      const rollbackCwd = opts.cwd ?? this.o.baseDir;
      for (const { wt, branch } of createdWorktrees) {
        try { await this.o.exec?.("git", ["worktree", "remove", "--force", wt], { cwd: rollbackCwd }); } catch { /* best effort */ }
        try { await this.o.exec?.("git", ["branch", "-D", branch], { cwd: rollbackCwd }); } catch { /* best effort */ }
      }
      throw e;
    }
    for (const m of members) {
      this.subs.set(m.id, { info: m, buf: "", pending: new Map(), seq: 0, lastProgressAt: 0, finished: false, waiters: [] });
      this.queue.push(m.id);
    }
    if (n > 1) this.groups.set(base, { id: base, total: n, memberIds, waiters: [], notified: false });
    this.used += n;
    this.pump();
    return members[0];
  }

  private pump() {
    while (this.running() < this.max && this.queue.length) this.launch(this.queue.shift()!);
    this.d.onChange?.();
  }

  private log(l: Live, file: string, line: string) { try { appendFileSync(join(l.info.logDir, file), line + "\n"); } catch { /* ignore */ } }

  private launch(id: string) {
    const l = this.subs.get(id)!;
    if (l.info.state !== "queued") return;
    // Hardening (localization): the worker loads ONLY this extension (-e) for the
    // report_to_parent tool. --no-extensions disables auto-discovery of every other
    // extension (Telegram/fork/memory), --no-mcp blocks MCP servers, --no-approve
    // refuses silent tool approval, --offline blocks non-model network. The model API
    // still works (--offline does not gate provider calls, matching pi-minimal-subagent).
    const args = ["--mode", "rpc", "--no-extensions", "--no-mcp", "--no-approve", "--offline", "-e", this.o.extensionPath];
    if (l.info.session) {
      // Named persistent session: created on first spawn, resumed by later spawns with the same id.
      // Kept under .pi/subagents/sessions (gitignored) instead of the global agent dir.
      args.push("--session-dir", join(this.o.baseDir, "sessions"), "--session-id", l.info.session);
    } else {
      args.push("--no-session");
    }
    if (l.info.tools !== undefined) {
      // Exact allowlist (workflow limit, not a sandbox): [] maps to --no-tools, names map to --tools.
      // The child's protocol tools are registered by the -e extension, and a --tools allowlist only
      // activates tools it names — so they must be appended explicitly. report_to_parent is the
      // reporting protocol; subagent_spawn enables recursion (the manager refuses with a clear
      // error at max depth, keeping the refusal observable even under a strict allowlist).
      if (l.info.tools.length === 0) args.push("--no-tools");
      else args.push("--tools", [...l.info.tools, REPORT_TOOL, SPAWN_TOOL].join(","));
    }
    // Localization: always pass a model so the worker never falls back to Pi's
    // default (which 401s on this host). Precedence: explicit subagent_spawn model
    // > PI_SUBAGENT_MODEL env > self-hosted training-coder/GLM-5.3-Flash default.
    const defaultModel = process.env.PI_SUBAGENT_MODEL || "training-coder/GLM-5.3-Flash";
    args.push("--model", l.info.model || defaultModel);
    // Recursion: children learn their position in the spawn tree via env. PI_SPAWN_DEPTH 1 =
    // spawned by the root session; the extension refuses further spawns at depth >= MAX_SPAWN_DEPTH
    // and enforces the per-agent budget (PI_SPAWN_BUDGET, fanout counts as N). PI_SPAWN_CHAIN is
    // the child's ancestor id chain for lineage reporting.
    const env = { ...process.env, PI_SUBAGENT_ID: id, SUPERAGENT_WORKER: "1", PI_SPAWN_DEPTH: String(this.childDepth), PI_SPAWN_CHAIN: this.childSpawnedBy.join(",") };
    let child: ChildLike;
    try { child = this.o.spawn(this.o.piCommand ?? "pi", args, { cwd: l.info.cwd, env }); }
    catch (e) { return this.finish(l, "failed", undefined, String((e as Error).message)); }
    l.child = child;
    l.info.state = "running";
    l.info.startedAt = new Date(this.now()).toISOString();
    child.stdout?.on("data", (b) => this.onData(l, b.toString()));
    child.stderr?.on("data", (b) => this.log(l, "stderr.log", b.toString()));
    child.on("exit", (code) => { if (!l.finished) this.finish(l, "failed", undefined, `pi exited (code ${code}) before finishing`); });
    this.send(l, { type: "prompt", message: l.info.task });
  }

  private send(l: Live, cmd: Record<string, unknown>): Promise<any> {
    const id = `c${++l.seq}`;
    const p = new Promise((res) => l.pending.set(id, res));
    l.child?.stdin?.write(JSON.stringify({ id, ...cmd }) + "\n");
    return p;
  }

  private onData(l: Live, chunk: string) {
    l.buf += chunk;
    let i: number;
    while ((i = l.buf.indexOf("\n")) >= 0) {
      const line = l.buf.slice(0, i).trim(); l.buf = l.buf.slice(i + 1);
      if (!line) continue;
      let ev: any; try { ev = JSON.parse(line); } catch { this.log(l, "stderr.log", line); continue; }
      this.handle(l, ev);
    }
  }

  private handle(l: Live, ev: any) {
    if (ev.type !== "message_update") this.log(l, "events.jsonl", JSON.stringify(ev));
    if (ev.type === "response" && ev.id && l.pending.has(ev.id)) { l.pending.get(ev.id)!(ev.data); l.pending.delete(ev.id); return; }
    if (ev.type === "extension_ui_request" && ["select", "confirm", "input", "editor"].includes(ev.method)) {
      l.child?.stdin?.write(JSON.stringify({ type: "extension_ui_response", id: ev.id, cancelled: true }) + "\n"); return;
    }
    if (ev.type === "tool_execution_start") {
      l.info.toolCalls++;
      this.log(l, "transcript.log", `[tool] ${ev.toolName} ${truncate(JSON.stringify(ev.args ?? {}), 300)}`);
      if (ev.toolName === REPORT_TOOL) this.onReport(l, ev.args ?? {});
      return;
    }
    if (ev.type === "message_end" && ev.message?.role === "assistant") {
      const text = (ev.message.content ?? []).filter((c: any) => c.type === "text").map((c: any) => c.text).join("");
      if (text) this.log(l, "transcript.log", `[assistant] ${text}`);
      return;
    }
    if (ev.type === "agent_settled") void this.onSettled(l, ev.aborted);
  }

  private onReport(l: Live, a: { status?: ReportStatus; summary?: string; question?: string }) {
    const r: Report = { status: a.status ?? "progress", summary: truncate(String(a.summary ?? ""), 500), question: a.question ? truncate(String(a.question), 500) : undefined, at: new Date(this.now()).toISOString() };
    l.info.reports.push(r);
    this.d.onChange?.();
    if (r.status === "progress") {
      const wait = l.lastProgressAt + this.throttle - this.now();
      if (wait > 0) {
        l.heldProgress = r; // coalesce: keep only the newest
        l.throttleTimer ??= setTimeout(() => { l.throttleTimer = undefined; if (l.heldProgress && !l.finished) this.emitProgress(l, l.heldProgress); }, wait);
        return;
      }
      return this.emitProgress(l, r);
    }
    // blocked/ready/failed/dropped: immediate, wakes the main agent
    const q = r.question ? `\nQuestion for you: ${r.question}` : "";
    const lineage = ` (depth ${l.info.depth}, spawned_by ${l.info.spawnedBy.join(" > ") || "root"})`;
    this.d.deliver(`[subagent ${l.info.id} · ${l.info.label}] ${r.status}: ${r.summary}${q}${lineage}`, { wake: r.status === "blocked", id: l.info.id });
  }

  private emitProgress(l: Live, r: Report) {
    l.heldProgress = undefined; l.lastProgressAt = this.now();
    this.d.deliver(`[subagent ${l.info.id} · ${l.info.label}] progress: ${r.summary}`, { wake: false, id: l.info.id });
  }

  private async onSettled(l: Live, aborted?: boolean) {
    if (l.finished) return;
    if (aborted && l.info.state === "stopped") return this.finish(l, "stopped");
    const data = await Promise.race([this.send(l, { type: "get_last_assistant_text" }), new Promise((r) => setTimeout(() => r(null), 10_000))]);
    const text = (data as any)?.text ?? "";
    this.finish(l, "done", text);
  }

  private finish(l: Live, state: "done" | "failed" | "stopped", result?: string, error?: string) {
    if (l.finished) return;
    l.finished = true;
    if (l.throttleTimer) clearTimeout(l.throttleTimer);
    l.info.state = state; l.info.result = result; l.info.error = error;
    l.info.endedAt = new Date(this.now()).toISOString();
    const waiters = l.waiters; l.waiters = [];
    for (const w of waiters) w(l.info);
    try { l.child?.stdin?.end(); l.child?.kill("SIGTERM"); } catch { /* ignore */ }
    this.log(l, "result.md", result ?? error ?? state);
    const head = `[subagent ${l.info.id} · ${l.info.label}] ${state} (depth ${l.info.depth}, spawned_by ${l.info.spawnedBy.join(" > ") || "root"})`;
    const body = state === "done" ? truncate(result || "(no final text)", this.resultMax) : state === "failed" ? `error: ${truncate(error ?? "", 800)}` : "stopped by request";
    const wt = l.info.worktree ? `\n(worktree ${l.info.worktree}, branch ${l.info.branch})` : "";
    if (state !== "stopped") this.d.deliver(`${head}:\n${body}${wt}\nFull log: subagent_result id=${l.info.id} log=true`, { wake: true, id: l.info.id });
    this.maybeCompleteGroup(l.info);
    this.pump();
  }

  /** Once every member of the sub's fanout group is terminal, resolve the combined result and
   *  deliver the combined background report (selection is the parent agent's job, not automatic). */
  private maybeCompleteGroup(info: SubagentInfo) {
    const gid = info.fanout?.groupId;
    if (!gid) return;
    const g = this.groups.get(gid);
    if (!g || g.combined) return;
    const members = g.memberIds.map((id) => this.subs.get(id)?.info);
    if (!members.every((m) => m && (m.state === "done" || m.state === "failed" || m.state === "stopped"))) return;
    g.combined = members.map((m) => this.toMemberResult(m!));
    const waiters = g.waiters; g.waiters = [];
    for (const w of waiters) w(g.combined);
    // Deliver a combined report unless the operator stopped every member deliberately.
    if (!g.notified && g.combined.some((m) => m.status !== "stopped")) {
      g.notified = true;
      this.d.deliver(`[fanout ${gid} · all ${g.total} members terminal — pick the best yourself]\n${truncate(JSON.stringify(g.combined, null, 2), this.resultMax)}`, { wake: true, id: gid });
    }
  }

  private toMemberResult(info: SubagentInfo): FanoutMemberResult {
    return {
      id: info.id,
      status: info.state,
      resultText: info.result ? truncate(info.result, 600) : undefined,
      error: info.error ? truncate(info.error, 300) : undefined,
      worktree: info.worktree,
      spawnedBy: [...info.spawnedBy],
      depth: info.depth,
    };
  }

  async message(id: string, text: string): Promise<void> {
    const l = this.need(id);
    if (l.info.state !== "running") throw new Error(`subagent ${id} is ${l.info.state}`);
    await this.send(l, { type: "steer", message: text });
  }

  stop(id: string) {
    const l = this.need(id);
    if (l.info.state === "queued") { this.queue = this.queue.filter((q) => q !== id); return this.finish(l, "stopped"); }
    if (l.info.state !== "running") return;
    l.info.state = "stopped";
    this.send(l, { type: "abort" });
    setTimeout(() => this.finish(l, "stopped"), 2000);
  }

  stopAll() { for (const i of this.list()) if (i.state === "running" || i.state === "queued") this.stop(i.id); }

  private need(id: string) { const l = this.subs.get(id); if (!l) throw new Error(`no subagent ${id}`); return l; }
}
