/**
 * Dependency-free Pi RPC runtime adapter for project primaries.
 *
 * Speaks the documented JSONL RPC protocol directly (docs/rpc.md) instead of
 * importing @earendil-works/pi-coding-agent, so this package works inside the
 * workspace without an install step. Reads stdout as a byte stream split only
 * on LF (the docs warn that generic line readers also split on U+2028/U+2029,
 * which are valid inside JSON strings).
 *
 * Per project it spawns: node <cliPath> --mode rpc --session-id <sessionId>
 * with cwd pinned to the registered project root:
 * - the exact project session is restored by id (never "continue recent",
 *   which could grab a worker or unrelated session);
 * - no --provider/--model flags: current model/provider is preserved;
 * - no Telegram transport: headless child of the coordinator, not a transport
 *   owner and not a hidden follower.
 *
 * Model calls are disabled by default (`allowModelCalls: false`): run()
 * performs an identity probe (get_state; no model round-trip) and reports the
 * task as not executed. Enabling prompts is an explicit configuration
 * decision by the operator, never an accident of testing.
 */
import { spawn, type ChildProcess } from "node:child_process";

export interface RpcRuntimeOptions {
  /** Absolute path to the installed Pi CLI entry (dist/cli.js). */
  cliPath: string;
  /** Allow sending actual prompts (model calls). Default false. */
  allowModelCalls?: boolean;
  /** Command timeout, ms. Default 60000. */
  timeoutMs?: number;
  /** Extra CLI args (e.g. --session-dir). */
  extraArgs?: string[];
  /** Executable used to run cliPath. Default process.execPath (node). */
  nodePath?: string;
}

export interface ProbeResult {
  sessionId: string;
  sessionFile: string | null;
  provider: string;
  modelId: string;
}

interface Pending {
  resolve: (value: any) => void;
  reject: (err: Error) => void;
  timer: NodeJS.Timeout;
}

export class RpcProjectRuntime {
  readonly runtimeId = `rpc-${process.pid}-${Math.random().toString(36).slice(2, 8)}`;
  private readonly children = new Map<string, ChildProcess>();
  private readonly pending = new Map<string, Pending>();
  private readonly settledWaiters: Array<() => void> = [];
  private buffer = new Map<string, string>(); // per child stdout buffer

  private readonly options: RpcRuntimeOptions;

  constructor(options: RpcRuntimeOptions) {
    this.options = options;
  }

  private childFor(root: string, sessionId: string): ChildProcess {
    const key = `${root}\u0000${sessionId}`;
    const existing = this.children.get(key);
    if (existing && existing.exitCode === null) return existing;

    const child = spawn(
      this.options.nodePath ?? process.execPath,
      [
        this.options.cliPath,
        "--mode",
        "rpc",
        "--session-id",
        sessionId,
        ...(this.options.extraArgs ?? []),
      ],
      { cwd: root, stdio: ["pipe", "pipe", "pipe"] },
    );
    child.stdout!.on("data", (chunk: Buffer) => this.onStdout(key, chunk));
    child.stderr!.on("data", () => {}); // diagnostics; never parse as protocol
    child.on("exit", () => {
      for (const [id, p] of this.pending) {
        clearTimeout(p.timer);
        p.reject(new Error("rpc child exited"));
        this.pending.delete(id);
      }
    });
    this.children.set(key, child);
    return child;
  }

  /** Split stdout strictly on LF, honoring the doc's framing warning. */
  private onStdout(key: string, chunk: Buffer): void {
    const prev = this.buffer.get(key) ?? "";
    const data = prev + chunk.toString("utf8");
    const lines = data.split("\n");
    this.buffer.set(key, lines.pop() ?? "");
    for (const line of lines) {
      const text = line.endsWith("\r") ? line.slice(0, -1) : line;
      if (!text.trim()) continue;
      let record: any;
      try {
        record = JSON.parse(text);
      } catch {
        continue; // never crash the reader on a malformed record
      }
      if (record.type === "response" && record.id && this.pending.has(record.id)) {
        const p = this.pending.get(record.id)!;
        this.pending.delete(record.id);
        clearTimeout(p.timer);
        if (record.success) p.resolve(record.data);
        else p.reject(new Error(record.error ?? `command failed: ${record.command}`));
      } else if (record.type === "agent_settled") {
        const waiters = this.settledWaiters.splice(0);
        for (const w of waiters) w();
      }
    }
  }

  private command<T>(child: ChildProcess, type: string, payload: Record<string, unknown> = {}): Promise<T> {
    const id = `req-${Math.random().toString(36).slice(2, 10)}`;
    return new Promise<T>((resolve, reject) => {
      const timer = setTimeout(
        () => {
          this.pending.delete(id);
          reject(new Error(`timeout waiting for ${type} response`));
        },
        this.options.timeoutMs ?? 60000,
      );
      this.pending.set(id, { resolve, reject, timer });
      child.stdin!.write(JSON.stringify({ id, type, ...payload }) + "\n", (err) => {
        if (err) {
          clearTimeout(timer);
          this.pending.delete(id);
          reject(err);
        }
      });
    });
  }

  private waitForSettled(timeoutMs: number): Promise<void> {
    return new Promise((resolve) => {
      const timer = setTimeout(resolve, timeoutMs);
      this.settledWaiters.push(() => {
        clearTimeout(timer);
        resolve();
      });
    });
  }

  /** Identity probe: session id/file + active model. No model call. */
  async probe(root: string, sessionId: string): Promise<ProbeResult> {
    const child = this.childFor(root, sessionId);
    const state = await this.command<any>(child, "get_state");
    return {
      sessionId: state.sessionId,
      sessionFile: state.sessionFile ?? null,
      provider: state.model?.provider ?? "unknown",
      modelId: state.model?.id ?? "unknown",
    };
  }

  async run(
    envelope: { taskId: string; goal: string },
    root: string,
    sessionId: string,
  ): Promise<{ outcome: "completed-unverified" | "failed"; summary: string }> {
    const probe = await this.probe(root, sessionId);
    if (probe.sessionId !== sessionId) {
      return { outcome: "failed", summary: `session mismatch: expected ${sessionId}, got ${probe.sessionId}` };
    }
    if (!this.options.allowModelCalls) {
      return {
        outcome: "failed",
        summary: `probe ok (session=${probe.sessionId}, model=${probe.provider}/${probe.modelId}) but model calls disabled; task ${envelope.taskId} not executed`,
      };
    }
    const child = this.childFor(root, sessionId);
    const started = await this.command<any>(child, "prompt", { message: envelope.goal });
    if (started.disposition === "handled") {
      // No run started for this prompt; do not wait for agent_settled.
      return { outcome: "failed", summary: `prompt disposition "handled": ${started.dispositionDetail ?? ""}` };
    }
    const timeoutMs = this.options.timeoutMs ?? 60000;
    await this.waitForSettled(timeoutMs);
    return { outcome: "completed-unverified", summary: `prompt settled for ${envelope.taskId}` };
  }

  async stopAll(): Promise<void> {
    for (const child of this.children.values()) {
      child.stdin?.end();
    }
    await Promise.all(
      [...this.children.values()].map(
        (c) => new Promise<void>((resolve) => (c.exitCode === null ? c.once("exit", resolve) : resolve())),
      ),
    );
    this.children.clear();
  }
}
