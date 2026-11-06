import { appendFileSync, mkdirSync } from "node:fs";
import { join } from "node:path";
import type { ChildLike, Report, ReportStatus, SpawnFn, SpawnOptions, SubagentInfo } from "./types.ts";
import type { Exec } from "../types.ts";

export const REPORT_TOOL = "report_to_parent";

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

  constructor(private o: ManagerOptions, private d: Delivery) {
    this.max = Math.max(1, o.maxConcurrent ?? 3);
    this.throttle = o.progressThrottleMs ?? 60_000;
    this.resultMax = o.resultMaxChars ?? 2000;
    this.now = o.now ?? Date.now;
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

  async spawn(opts: SpawnOptions): Promise<SubagentInfo> {
    if (opts.session !== undefined && !SESSION_ID_RE.test(opts.session)) throw new Error(`invalid subagent session id: ${opts.session}`);
    if (opts.tools) {
      const bad = opts.tools.find((t) => !CHILD_BUILTIN_TOOLS.includes(t));
      if (bad) throw new Error(`Only built-in child tools are enabled (got "${bad}"; allowed: ${CHILD_BUILTIN_TOOLS.join(", ")})`);
    }
    const id = `sa${++this.n}`;
    const logDir = join(this.o.baseDir, id);
    mkdirSync(logDir, { recursive: true });
    const info: SubagentInfo = { id, label: opts.label ?? opts.task.slice(0, 40), task: opts.task, state: "queued", cwd: opts.cwd ?? this.o.baseDir, model: opts.model, tools: opts.tools, session: opts.session, reports: [], logDir, toolCalls: 0 };
    if (opts.isolate) {
      if (!this.o.exec) throw new Error("isolate requires git exec");
      const branch = `subagent/${id}-${Date.now().toString(36)}`;
      const wt = join(this.o.baseDir, "worktrees", id);
      const r = await this.o.exec("git", ["worktree", "add", "-b", branch, wt, "HEAD"], { cwd: info.cwd });
      if (r.code !== 0) throw new Error(`git worktree add failed: ${r.stderr.trim()}`);
      Object.assign(info, { worktree: wt, branch, cwd: wt });
    }
    this.subs.set(id, { info, buf: "", pending: new Map(), seq: 0, lastProgressAt: 0, finished: false, waiters: [] });
    this.queue.push(id);
    this.pump();
    return info;
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
      // The child's report tool is registered by the -e extension, and a --tools allowlist only
      // activates tools it names — so it must be appended explicitly (same as pi-minimal-subagent
      // re-adding its own subagent tool). With --no-tools, extension tools stay active on registration.
      if (l.info.tools.length === 0) args.push("--no-tools");
      else args.push("--tools", [...l.info.tools, REPORT_TOOL].join(","));
    }
    // Localization: always pass a model so the worker never falls back to Pi's
    // default (which 401s on this host). Precedence: explicit subagent_spawn model
    // > PI_SUBAGENT_MODEL env > self-hosted training-coder/Qwen3-5 default.
    const defaultModel = process.env.PI_SUBAGENT_MODEL || "training-coder/Qwen3-5";
    args.push("--model", l.info.model || defaultModel);
    const env = { ...process.env, PI_SUBAGENT_ID: id, SUPERAGENT_WORKER: "1" };
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
    this.d.deliver(`[subagent ${l.info.id} · ${l.info.label}] ${r.status}: ${r.summary}${q}`, { wake: r.status === "blocked", id: l.info.id });
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
    const head = `[subagent ${l.info.id} · ${l.info.label}] ${state}`;
    const body = state === "done" ? truncate(result || "(no final text)", this.resultMax) : state === "failed" ? `error: ${truncate(error ?? "", 800)}` : "stopped by request";
    const wt = l.info.worktree ? `\n(worktree ${l.info.worktree}, branch ${l.info.branch})` : "";
    if (state !== "stopped") this.d.deliver(`${head}:\n${body}${wt}\nFull log: subagent_result id=${l.info.id} log=true`, { wake: true, id: l.info.id });
    this.pump();
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
