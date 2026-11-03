import { describe, expect, it } from "vitest";
import { EventEmitter } from "node:events";
import { mkdtemp, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { SubagentManager } from "../src/subagent/manager.ts";
import type { ChildLike, SpawnFn } from "../src/subagent/types.ts";

/** Fake `pi --mode rpc`: scripted events per prompt. */
class FakePi extends EventEmitter implements ChildLike {
  out = new EventEmitter(); sent: any[] = []; killed = false;
  constructor(private script: (fp: FakePi, cmd: any) => void) { super(); }
  stdin = { write: (s: string) => { for (const l of s.split("\n").filter(Boolean)) { const c = JSON.parse(l); this.sent.push(c); this.script(this, c); } return true; }, end: () => true };
  stdout = { on: (_e: "data", cb: (b: string) => void) => this.out.on("data", cb) };
  emitEv(ev: object) { this.out.emit("data", JSON.stringify(ev) + "\n"); }
  kill() { this.killed = true; return true; }
}

const happy = (final: string) => (fp: FakePi, c: any) => {
  if (c.type === "prompt") setImmediate(() => {
    fp.emitEv({ type: "response", id: c.id, command: "prompt", success: true, data: { disposition: "started" } });
    fp.emitEv({ type: "tool_execution_start", toolName: "bash", args: { command: "ls -la with secret transcript stuff" } });
    fp.emitEv({ type: "tool_execution_start", toolName: "report_to_parent", args: { status: "progress", summary: "read the code" } });
    fp.emitEv({ type: "tool_execution_start", toolName: "report_to_parent", args: { status: "progress", summary: "halfway" } });
    fp.emitEv({ type: "message_end", message: { role: "assistant", content: [{ type: "text", text: "INTERMEDIATE THOUGHTS" }] } });
    fp.emitEv({ type: "agent_settled" });
  });
  if (c.type === "get_last_assistant_text") setImmediate(() => fp.emitEv({ type: "response", id: c.id, success: true, data: { text: final } }));
};

const wait = (ms: number) => new Promise((r) => setTimeout(r, ms));

async function setup(script: (fp: FakePi, c: any) => void, extra: Partial<ConstructorParameters<typeof SubagentManager>[0]> = {}) {
  const dir = await mkdtemp(join(tmpdir(), "sub-"));
  const kids: FakePi[] = []; const spawned: string[][] = [];
  const spawn: SpawnFn = (cmd, args) => { spawned.push([cmd, ...args]); const k = new FakePi(script); kids.push(k); return k; };
  const msgs: { t: string; wake: boolean }[] = [];
  const m = new SubagentManager({ spawn, extensionPath: "/ext/index.ts", baseDir: dir, progressThrottleMs: 60_000, ...extra }, { deliver: (t, o) => msgs.push({ t, wake: o.wake }) });
  return { m, kids, spawned, msgs, dir };
}

describe("subagent manager", () => {
  it("spawns headless pi in rpc mode with this extension and the guard env", async () => {
    const { m, spawned } = await setup(happy("done"));
    await m.spawn({ task: "do x", model: "deepseek/deepseek-flash" });
    expect(spawned[0]).toEqual(["pi", "--mode", "rpc", "--no-session", "-ne", "-e", "/ext/index.ts", "--model", "deepseek/deepseek-flash"]);
  });

  it("keeps main context clean: only throttled reports + truncated final result, full log on disk", async () => {
    const big = "R".repeat(5000);
    const { m, msgs } = await setup(happy(big));
    const i = await m.spawn({ task: "investigate", label: "inv" });
    await wait(30);
    expect(i.state).toBe("done");
    const all = msgs.map((x) => x.t).join("\n");
    expect(all).not.toContain("INTERMEDIATE THOUGHTS");
    expect(all).not.toContain("secret transcript");
    // second progress within throttle window is coalesced, not delivered immediately
    expect(msgs.filter((x) => x.t.includes("progress"))).toHaveLength(1);
    const final = msgs.at(-1)!;
    expect(final.wake).toBe(true);
    expect(final.t).toContain("[truncated");
    expect(final.t.length).toBeLessThan(2400);
    const log = await readFile(join(i.logDir, "transcript.log"), "utf8");
    expect(log).toContain("INTERMEDIATE THOUGHTS");
    expect(log).toContain("[tool] bash");
    expect(await readFile(join(i.logDir, "result.md"), "utf8")).toBe(big + "\n");
  });

  it("blocked report is delivered immediately and wakes the main agent", async () => {
    const { m, msgs } = await setup((fp, c) => {
      if (c.type === "prompt") setImmediate(() => fp.emitEv({ type: "tool_execution_start", toolName: "report_to_parent", args: { status: "blocked", summary: "two options", question: "Postgres or SQLite?" } }));
    });
    await m.spawn({ task: "db" });
    await wait(10);
    expect(msgs[0]).toMatchObject({ wake: true });
    expect(msgs[0].t).toContain("Postgres or SQLite?");
  });

  it("respects the concurrency cap and drains the queue", async () => {
    const { m, kids } = await setup(happy("ok"), { maxConcurrent: 2 });
    const a = await m.spawn({ task: "a" }), b = await m.spawn({ task: "b" }), c = await m.spawn({ task: "c" });
    expect([a.state, b.state, c.state]).toEqual(["running", "running", "queued"]);
    expect(kids).toHaveLength(2);
    await wait(50);
    expect(kids).toHaveLength(3);
    expect(m.list().every((i) => i.state === "done")).toBe(true);
  });

  it("steers a running subagent and stops it", async () => {
    const { m, kids } = await setup(() => {});
    const i = await m.spawn({ task: "long" });
    void m.message(i.id, "focus on tests");
    expect(kids[0].sent.at(-1)).toMatchObject({ type: "steer", message: "focus on tests" });
    m.stop(i.id);
    expect(kids[0].sent.at(-1)).toMatchObject({ type: "abort" });
    kids[0].emitEv({ type: "agent_settled", aborted: true });
    expect(i.state).toBe("stopped");
    await expect(m.message(i.id, "x")).rejects.toThrow();
  });

  it("reports a crash as failed", async () => {
    const { m, kids, msgs } = await setup(() => {});
    const i = await m.spawn({ task: "x" });
    kids[0].emit("exit", 1);
    expect(i.state).toBe("failed");
    expect(msgs.at(-1)!.t).toContain("failed");
  });

  it("auto-cancels dialog UI requests from the child", async () => {
    const { m, kids } = await setup(() => {});
    await m.spawn({ task: "x" });
    kids[0].emitEv({ type: "extension_ui_request", id: "u1", method: "confirm" });
    expect(kids[0].sent.at(-1)).toEqual({ type: "extension_ui_response", id: "u1", cancelled: true });
  });
});
