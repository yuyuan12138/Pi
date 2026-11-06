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

/** Spawn-tree env vars that would otherwise leak from the host session into test managers. */
const HEREDITY = ["PI_SUBAGENT_ID", "PI_SPAWN_DEPTH", "PI_SPAWN_CHAIN", "PI_SPAWN_BUDGET"] as const;

async function setup(script: (fp: FakePi, c: any) => void, extra: Partial<ConstructorParameters<typeof SubagentManager>[0]> = {}, env: Partial<Record<(typeof HEREDITY)[number], string>> = {}) {
  const dir = await mkdtemp(join(tmpdir(), "sub-"));
  const kids: FakePi[] = []; const spawned: string[][] = []; const envs: NodeJS.ProcessEnv[] = [];
  const spawn: SpawnFn = (cmd, args, o) => { spawned.push([cmd, ...args]); envs.push(o.env); const k = new FakePi(script); kids.push(k); return k; };
  const msgs: { t: string; wake: boolean }[] = [];
  // Hermetic: the manager reads its position in the spawn tree from env at construction time,
  // so neutralize the host's vars and apply only what the test asked for.
  const saved = HEREDITY.map((k) => [k, process.env[k]] as const);
  for (const k of HEREDITY) delete process.env[k];
  try {
    for (const [k, v] of Object.entries(env)) if (v !== undefined) process.env[k] = v;
    const m = new SubagentManager({ spawn, extensionPath: "/ext/index.ts", baseDir: dir, progressThrottleMs: 60_000, ...extra }, { deliver: (t, o) => msgs.push({ t, wake: o.wake }) });
    return { m, kids, spawned, envs, msgs, dir };
  } finally {
    for (const [k, v] of saved) { if (v === undefined) delete process.env[k]; else process.env[k] = v; }
  }
}

describe("subagent manager", () => {
  it("spawns headless pi in rpc mode with this extension and the guard env", async () => {
    const { m, spawned } = await setup(happy("done"));
    await m.spawn({ task: "do x", model: "deepseek/deepseek-flash" });
    expect(spawned[0]).toEqual(["pi", "--mode", "rpc", "--no-extensions", "--no-mcp", "--no-approve", "--offline", "-e", "/ext/index.ts", "--no-session", "--model", "deepseek/deepseek-flash"]);
  });

  it("passes tools and session through to the child CLI args", async () => {
    const { m, spawned, dir } = await setup(happy("done"));
    await m.spawn({ task: "fix auth", tools: ["read", "bash"], session: "fix-auth" });
    const args = spawned[0];
    expect(args).not.toContain("--no-session");
    expect(args).toContain("--tools");
    // The child's protocol tools must be named explicitly or the allowlist would deactivate them:
    // report_to_parent (reporting) and subagent_spawn (recursion; the manager refuses at max depth).
    expect(args[args.indexOf("--tools") + 1]).toBe("read,bash,report_to_parent,subagent_spawn");
    expect(args).toContain("--session-dir");
    expect(args[args.indexOf("--session-dir") + 1]).toBe(join(dir, "sessions"));
    expect(args).toContain("--session-id");
    expect(args[args.indexOf("--session-id") + 1]).toBe("fix-auth");
  });

  it("maps an empty tools list to --no-tools (report tool stays active via the extension)", async () => {
    const { m, spawned } = await setup(happy("done"));
    await m.spawn({ task: "think only", tools: [] });
    expect(spawned[0]).toContain("--no-tools");
    expect(spawned[0]).not.toContain("--tools");
  });

  it("rejects tool names outside the built-in child tools and invalid session ids", async () => {
    const { m } = await setup(happy("done"));
    await expect(m.spawn({ task: "x", tools: ["subagent"] })).rejects.toThrow("Only built-in child tools are enabled");
    await expect(m.spawn({ task: "x", tools: ["+bash"] })).rejects.toThrow("Only built-in child tools are enabled");
    await expect(m.spawn({ task: "x", session: "bad id!" })).rejects.toThrow("invalid subagent session id");
    expect(m.list()).toHaveLength(0);
  });

  it("waitFor resolves with the final result once the subagent finishes", async () => {
    const { m } = await setup(happy("FINAL ANSWER"));
    const i = await m.spawn({ task: "compute" });
    const fin = await m.waitFor(i.id);
    expect(fin.state).toBe("done");
    expect(fin.result).toBe("FINAL ANSWER");
  });

  it("waitFor resolves immediately for an already-finished subagent and for queued ones", async () => {
    const { m } = await setup(happy("ok"), { maxConcurrent: 1 });
    const a = await m.spawn({ task: "a" });
    const b = await m.spawn({ task: "b" });
    expect(b.state).toBe("queued");
    const doneA = await m.waitFor(a.id);
    expect(doneA.result).toBe("ok");
    const doneB = await m.waitFor(b.id); // queued: resolves only after it runs and finishes
    expect(doneB.state).toBe("done");
    expect(await m.waitFor(a.id)).toBe(doneA); // terminal state: resolves at once
  });

  it("waitFor surfaces failure", async () => {
    const { m, kids } = await setup(() => {});
    const i = await m.spawn({ task: "x" });
    kids[0].emit("exit", 1);
    const fin = await m.waitFor(i.id);
    expect(fin.state).toBe("failed");
    expect(fin.error).toContain("pi exited");
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

describe("fanout / recursion / budget / lineage", () => {
  it("fanout=3 tracks three members and resolves a combined result with unique ids and lineage", async () => {
    const { m, spawned } = await setup(happy("CANDIDATE OK"));
    const first = await m.spawn({ task: "try the fix", fanout: 3 });
    expect(m.list().map((i) => i.id).sort()).toEqual(["sa1-a", "sa1-b", "sa1-c"]);
    expect(first.id).toBe("sa1-a");
    expect(first.fanout).toEqual({ groupId: "sa1", total: 3, index: 0, memberIds: ["sa1-a", "sa1-b", "sa1-c"] });
    expect(first.spawnedBy).toEqual([]);
    expect(first.depth).toBe(1);
    const combined = await m.waitForAll("sa1");
    expect(combined.map((c) => c.id)).toEqual(["sa1-a", "sa1-b", "sa1-c"]);
    expect(combined.every((c) => c.status === "done" && c.resultText === "CANDIDATE OK")).toBe(true);
    expect(combined.every((c) => c.spawnedBy.length === 0 && c.depth === 1)).toBe(true);
    expect(spawned).toHaveLength(3); // one identical worker per member
  });

  it("no fanout keeps the exact single-spawn shape (no suffix, no fanout metadata)", async () => {
    const { m } = await setup(happy("ok"));
    const i = await m.spawn({ task: "plain" });
    expect(i.id).toBe("sa1");
    expect(i.fanout).toBeUndefined();
    expect(i.spawnedBy).toEqual([]);
    expect(i.depth).toBe(1);
  });

  it("background fanout: each member reports independently plus one combined report", async () => {
    const { m, msgs } = await setup(happy("member result"));
    await m.spawn({ task: "try", fanout: 2 });
    await wait(30);
    const combined = msgs.filter((x) => x.t.includes("[fanout sa1"));
    expect(combined).toHaveLength(1);
    expect(combined[0].wake).toBe(true);
    expect(combined[0].t).toContain("sa1-a");
    expect(combined[0].t).toContain("sa1-b");
    expect(combined[0].t).toContain("pick the best");
    // each member still delivered its own final report
    expect(msgs.filter((x) => x.t.includes("[subagent sa1-") && x.t.includes("] done"))).toHaveLength(2);
  });

  it("fanout with isolate gives each member its own worktree", async () => {
    let worktreeAdds = 0;
    const exec = async (cmd: string, args: string[]) => {
      if (cmd === "git" && args[0] === "worktree" && args[1] === "add") worktreeAdds++;
      return { code: 0, stdout: "", stderr: "" };
    };
    const { m } = await setup(happy("ok"), { exec });
    const first = await m.spawn({ task: "t", fanout: 2, isolate: true });
    expect(worktreeAdds).toBe(2);
    expect(first.worktree).toBeTruthy();
    const list = m.list();
    expect(new Set(list.map((i) => i.worktree)).size).toBe(2);
    expect(list.every((i) => i.cwd === i.worktree)).toBe(true);
  });

  it("combined result surfaces a failed member instead of hiding it", async () => {
    const { m, kids } = await setup(happy("ok"));
    await m.spawn({ task: "t", fanout: 2 });
    kids[0].emit("exit", 1); // first member crashes before settling
    const combined = await m.waitForAll("sa1");
    expect(combined[0].status).toBe("failed");
    expect(combined[0].error).toContain("pi exited");
    expect(combined[1].status).toBe("done");
  });

  it("validates fanout and rejects session+fanout", async () => {
    const { m } = await setup(happy("ok"));
    await expect(m.spawn({ task: "t", fanout: 4 })).rejects.toThrow("fanout must be an integer between 1 and 3");
    await expect(m.spawn({ task: "t", fanout: 0 })).rejects.toThrow("fanout must be an integer between 1 and 3");
    await expect(m.spawn({ task: "t", fanout: 1.5 })).rejects.toThrow("fanout must be an integer between 1 and 3");
    await expect(m.spawn({ task: "t", fanout: 2, session: "s" })).rejects.toThrow("fanout cannot be combined with a named session");
    expect(m.list()).toHaveLength(0);
  });

  it("waitForAll rejects unknown keys but resolves via a member id", async () => {
    const { m } = await setup(happy("ok"));
    const i = await m.spawn({ task: "t", fanout: 2 });
    await expect(m.waitForAll("nope")).rejects.toThrow("no fanout group");
    const combined = await m.waitForAll(i.id); // member id resolves its group
    expect(combined).toHaveLength(2);
  });

  it("refuses to spawn at max depth (>= 3) with a clear error", async () => {
    const { m } = await setup(happy("ok"), { spawnDepth: 3 });
    await expect(m.spawn({ task: "t" })).rejects.toThrow("max spawn depth 3 reached");
    await expect(m.spawn({ task: "t", fanout: 2 })).rejects.toThrow("max spawn depth 3 reached");
    expect(m.list()).toHaveLength(0);
  });

  it("PI_SPAWN_DEPTH env: unset = root (can spawn), 3 or corrupt = refused (fails closed)", async () => {
    const { m } = await setup(happy("ok"));
    await expect(m.spawn({ task: "t" })).resolves.toMatchObject({ depth: 1 });
    const { m: m3 } = await setup(happy("ok"), {}, { PI_SPAWN_DEPTH: "3" });
    await expect(m3.spawn({ task: "t" })).rejects.toThrow("max spawn depth");
    const { m: mg } = await setup(happy("ok"), {}, { PI_SPAWN_DEPTH: "garbage" });
    await expect(mg.spawn({ task: "t" })).rejects.toThrow("max spawn depth");
  });

  it("a nested manager stamps lineage and passes depth+1 env to grandchildren", async () => {
    const { m, envs } = await setup(happy("ok"), {}, { PI_SUBAGENT_ID: "sa9-b", PI_SPAWN_DEPTH: "2", PI_SPAWN_CHAIN: "sa9" });
    const g = await m.spawn({ task: "grandchild task" });
    expect(g.id).toBe("sa9-b-sa1"); // ids stay unique across the spawn tree
    expect(g.spawnedBy).toEqual(["sa9", "sa9-b"]);
    expect(g.depth).toBe(3);
    expect(envs[0].PI_SPAWN_DEPTH).toBe("3");
    expect(envs[0].PI_SPAWN_CHAIN).toBe("sa9,sa9-b");
    expect(envs[0].PI_SUBAGENT_ID).toBe("sa9-b-sa1");
    const fan = await m.spawn({ task: "fan", fanout: 2 });
    expect(fan.id).toBe("sa9-b-sa2-a");
    expect(fan.fanout!.groupId).toBe("sa9-b-sa2");
    expect(fan.spawnedBy).toEqual(["sa9", "sa9-b"]);
  });

  it("enforces the spawn budget: fanout counts as N, exhaustion errors loudly", async () => {
    const { m } = await setup(happy("ok"));
    await m.spawn({ task: "1" });
    await m.spawn({ task: "2" });
    await m.spawn({ task: "3" });
    await expect(m.spawn({ task: "4" })).rejects.toThrow("budget exhausted");
    expect(m.list()).toHaveLength(3); // the refused spawn created nothing
    const { m: m2 } = await setup(happy("ok"), { spawnBudget: 3 });
    await m2.spawn({ task: "fan", fanout: 3 }); // one fanout consumes the whole budget
    await expect(m2.spawn({ task: "more" })).rejects.toThrow("budget exhausted");
    const { m: m3 } = await setup(happy("ok"), { spawnBudget: 2 });
    await expect(m3.spawn({ task: "too big", fanout: 3 })).rejects.toThrow("budget exhausted");
    expect(m3.list()).toHaveLength(0);
  });

  it("PI_SPAWN_BUDGET env overrides the default budget of 3", async () => {
    const { m } = await setup(happy("ok"), {}, { PI_SPAWN_BUDGET: "1" });
    await m.spawn({ task: "a" });
    await expect(m.spawn({ task: "b" })).rejects.toThrow("budget exhausted");
  });
});
