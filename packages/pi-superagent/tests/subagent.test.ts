import { describe, expect, it } from "vitest";
import { EventEmitter } from "node:events";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { mkdtemp, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { basename, dirname, join } from "node:path";
import { SubagentManager, allocEventsDirName, dirToken, parseSpawnTagRequired, SPAWN_TAG_ENV } from "../src/subagent/manager.ts";
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
const HEREDITY = ["PI_SUBAGENT_ID", "PI_SPAWN_DEPTH", "PI_SPAWN_CHAIN", "PI_SPAWN_BUDGET", "PI_SPAWN_REQUIRE_PROJECT_TAG", "PI_SUBAGENT_MODEL"] as const;

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
    const m = new SubagentManager({ spawn, extensionPath: "/ext/index.ts", baseDir: dir, progressThrottleMs: 60_000, modelRouting: undefined, ...extra }, { deliver: (t, o) => msgs.push({ t, wake: o.wake }) });
    return { m, kids, spawned, envs, msgs, dir };
  } finally {
    for (const [k, v] of saved) { if (v === undefined) delete process.env[k]; else process.env[k] = v; }
  }
}

describe("subagent manager", () => {
  it("spawns headless pi in rpc mode with this extension and the guard env", async () => {
    const { m, spawned } = await setup(happy("done"));
    await m.spawn({ task: "[project:PiAgents] do x", model: "deepseek/deepseek-flash" });
    expect(spawned[0]).toEqual(["pi", "--mode", "rpc", "--no-extensions", "--no-mcp", "--no-approve", "--offline", "-e", "/ext/index.ts", "--no-session", "--model", "deepseek/deepseek-flash"]);
  });

  it("passes tools and session through to the child CLI args", async () => {
    const { m, spawned, dir } = await setup(happy("done"));
    await m.spawn({ task: "[project:PiAgents] fix auth", tools: ["read", "bash"], session: "fix-auth" });
    const args = spawned[0];
    expect(args).not.toContain("--no-session");
    expect(args).toContain("--tools");
    // The child's protocol tools must be named explicitly or the allowlist would deactivate them:
    // report_to_parent (reporting) and subagent_spawn (recursion; the manager enforces the spawn budget).
    expect(args[args.indexOf("--tools") + 1]).toBe("read,bash,report_to_parent,subagent_spawn");
    expect(args).toContain("--session-dir");
    expect(args[args.indexOf("--session-dir") + 1]).toBe(join(dir, "sessions"));
    expect(args).toContain("--session-id");
    expect(args[args.indexOf("--session-id") + 1]).toBe("fix-auth");
  });

  it("maps an empty tools list to --no-tools (report tool stays active via the extension)", async () => {
    const { m, spawned } = await setup(happy("done"));
    await m.spawn({ task: "[project:PiAgents] think only", tools: [] });
    expect(spawned[0]).toContain("--no-tools");
    expect(spawned[0]).not.toContain("--tools");
  });

  it("rejects tool names outside the built-in child tools and invalid session ids", async () => {
    const { m } = await setup(happy("done"));
    await expect(m.spawn({ task: "[project:PiAgents] x", tools: ["subagent"] })).rejects.toThrow("Only built-in child tools are enabled");
    await expect(m.spawn({ task: "[project:PiAgents] x", tools: ["+bash"] })).rejects.toThrow("Only built-in child tools are enabled");
    await expect(m.spawn({ task: "[project:PiAgents] x", session: "bad id!" })).rejects.toThrow("invalid subagent session id");
    expect(m.list()).toHaveLength(0);
  });

  it("waitFor resolves with the final result once the subagent finishes", async () => {
    const { m } = await setup(happy("FINAL ANSWER"));
    const i = await m.spawn({ task: "[project:PiAgents] compute" });
    const fin = await m.waitFor(i.id);
    expect(fin.state).toBe("done");
    expect(fin.result).toBe("FINAL ANSWER");
  });

  it("waitFor resolves immediately for an already-finished subagent and for queued ones", async () => {
    const { m } = await setup(happy("ok"), { maxConcurrent: 1 });
    const a = await m.spawn({ task: "[project:PiAgents] a" });
    const b = await m.spawn({ task: "[project:PiAgents] b" });
    expect(b.state).toBe("queued");
    const doneA = await m.waitFor(a.id);
    expect(doneA.result).toBe("ok");
    const doneB = await m.waitFor(b.id); // queued: resolves only after it runs and finishes
    expect(doneB.state).toBe("done");
    expect(await m.waitFor(a.id)).toBe(doneA); // terminal state: resolves at once
  });

  it("waitFor surfaces failure", async () => {
    const { m, kids } = await setup(() => {});
    const i = await m.spawn({ task: "[project:PiAgents] x" });
    kids[0].emit("exit", 1);
    const fin = await m.waitFor(i.id);
    expect(fin.state).toBe("failed");
    expect(fin.error).toContain("pi exited");
  });

  it("keeps main context clean: only throttled reports + truncated final result, full log on disk", async () => {
    const big = "R".repeat(5000);
    const { m, msgs } = await setup(happy(big));
    const i = await m.spawn({ task: "[project:PiAgents] investigate", label: "inv" });
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
    await m.spawn({ task: "[project:PiAgents] db" });
    await wait(10);
    expect(msgs[0]).toMatchObject({ wake: true });
    expect(msgs[0].t).toContain("Postgres or SQLite?");
  });

  it("respects the concurrency cap and drains the queue", async () => {
    const { m, kids } = await setup(happy("ok"), { maxConcurrent: 2 });
    const a = await m.spawn({ task: "[project:PiAgents] a" }), b = await m.spawn({ task: "[project:PiAgents] b" }), c = await m.spawn({ task: "[project:PiAgents] c" });
    expect([a.state, b.state, c.state]).toEqual(["running", "running", "queued"]);
    expect(kids).toHaveLength(2);
    await wait(50);
    expect(kids).toHaveLength(3);
    expect(m.list().every((i) => i.state === "done")).toBe(true);
  });

  it("steers a running subagent and stops it", async () => {
    const { m, kids } = await setup(() => {});
    const i = await m.spawn({ task: "[project:PiAgents] long" });
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
    const i = await m.spawn({ task: "[project:PiAgents] x" });
    kids[0].emit("exit", 1);
    expect(i.state).toBe("failed");
    expect(msgs.at(-1)!.t).toContain("failed");
  });

  it("auto-cancels dialog UI requests from the child", async () => {
    const { m, kids } = await setup(() => {});
    await m.spawn({ task: "[project:PiAgents] x" });
    kids[0].emitEv({ type: "extension_ui_request", id: "u1", method: "confirm" });
    expect(kids[0].sent.at(-1)).toEqual({ type: "extension_ui_response", id: "u1", cancelled: true });
  });
});

describe("fanout / recursion / budget / lineage", () => {
  it("fanout=3 tracks three members and resolves a combined result with unique ids and lineage", async () => {
    const { m, spawned } = await setup(happy("CANDIDATE OK"));
    const first = await m.spawn({ task: "[project:PiAgents] try the fix", fanout: 3 });
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
    const i = await m.spawn({ task: "[project:PiAgents] plain" });
    expect(i.id).toBe("sa1");
    expect(i.fanout).toBeUndefined();
    expect(i.spawnedBy).toEqual([]);
    expect(i.depth).toBe(1);
  });

  it("background fanout: each member reports independently plus one combined report", async () => {
    const { m, msgs } = await setup(happy("member result"));
    await m.spawn({ task: "[project:PiAgents] try", fanout: 2 });
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
    const first = await m.spawn({ task: "[project:PiAgents] t", fanout: 2, isolate: true });
    expect(worktreeAdds).toBe(2);
    expect(first.worktree).toBeTruthy();
    const list = m.list();
    expect(new Set(list.map((i) => i.worktree)).size).toBe(2);
    expect(list.every((i) => i.cwd === i.worktree)).toBe(true);
  });

  it("combined result surfaces a failed member instead of hiding it", async () => {
    const { m, kids } = await setup(happy("ok"));
    await m.spawn({ task: "[project:PiAgents] t", fanout: 2 });
    kids[0].emit("exit", 1); // first member crashes before settling
    const combined = await m.waitForAll("sa1");
    expect(combined[0].status).toBe("failed");
    expect(combined[0].error).toContain("pi exited");
    expect(combined[1].status).toBe("done");
  });

  it("validates fanout and rejects session+fanout", async () => {
    const { m } = await setup(happy("ok"));
    await expect(m.spawn({ task: "[project:PiAgents] t", fanout: 4 })).rejects.toThrow("fanout must be an integer between 1 and 3");
    await expect(m.spawn({ task: "[project:PiAgents] t", fanout: 0 })).rejects.toThrow("fanout must be an integer between 1 and 3");
    await expect(m.spawn({ task: "[project:PiAgents] t", fanout: 1.5 })).rejects.toThrow("fanout must be an integer between 1 and 3");
    await expect(m.spawn({ task: "[project:PiAgents] t", fanout: 2, session: "s" })).rejects.toThrow("fanout cannot be combined with a named session");
    expect(m.list()).toHaveLength(0);
  });

  it("waitForAll rejects unknown keys but resolves via a member id", async () => {
    const { m } = await setup(happy("ok"));
    const i = await m.spawn({ task: "[project:PiAgents] t", fanout: 2 });
    await expect(m.waitForAll("nope")).rejects.toThrow("no fanout group");
    const combined = await m.waitForAll(i.id); // member id resolves its group
    expect(combined).toHaveLength(2);
  });

  it("spawns beyond the old depth cap: a depth-3 agent proceeds while budget remains", async () => {
    const { m, envs } = await setup(happy("ok"), { spawnDepth: 3 });
    const i = await m.spawn({ task: "[project:PiAgents] t" });
    expect(i.depth).toBe(4); // nesting is uncapped; depth is observability only
    expect(envs[0].PI_SPAWN_DEPTH).toBe("4");
    const fan = await m.spawn({ task: "[project:PiAgents] t2", fanout: 2 }); // also proceeds; budget (3) now used up
    expect(fan.depth).toBe(4);
    expect(m.list()).toHaveLength(3);
  });

  it("PI_SPAWN_DEPTH env: unset = root, deep or corrupt values still spawn (depth is never a refusal)", async () => {
    const { m } = await setup(happy("ok"));
    await expect(m.spawn({ task: "[project:PiAgents] t" })).resolves.toMatchObject({ depth: 1 });
    const { m: m3 } = await setup(happy("ok"), {}, { PI_SPAWN_DEPTH: "3" });
    await expect(m3.spawn({ task: "[project:PiAgents] t" })).resolves.toMatchObject({ depth: 4 });
    const { m: mg } = await setup(happy("ok"), {}, { PI_SPAWN_DEPTH: "garbage" });
    const g = await mg.spawn({ task: "[project:PiAgents] t" });
    expect(g.depth).toBeGreaterThan(1e15); // corrupt value stays visible in lineage, never gates spawning
  });

  it("a chain deeper than the old cap keeps spawning while budget lasts", async () => {
    const { m, envs } = await setup(happy("ok"), {}, { PI_SUBAGENT_ID: "sa5-c", PI_SPAWN_DEPTH: "5", PI_SPAWN_CHAIN: "sa5,sa5-b" });
    for (let i = 1; i <= 3; i++) {
      const g = await m.spawn({ task: `[project:PiAgents] level ${i}` }); // default budget 3: all three succeed
      expect(g.depth).toBe(6);
      expect(g.spawnedBy).toEqual(["sa5", "sa5-b", "sa5-c"]);
      expect(envs[i - 1].PI_SPAWN_DEPTH).toBe("6");
    }
  });

  it("budget exhaustion still refuses at deep depth (budget is the only bound, never depth)", async () => {
    const { m } = await setup(happy("ok"), { spawnBudget: 1 }, { PI_SPAWN_DEPTH: "7" });
    await m.spawn({ task: "[project:PiAgents] first" });
    let err: Error | undefined;
    try { await m.spawn({ task: "[project:PiAgents] second" }); } catch (e) { err = e as Error; }
    expect(err?.message).toContain("budget exhausted");
    expect(err?.message).not.toContain("depth"); // refusal names the budget, not a depth cap
    expect(m.list()).toHaveLength(1);
  });

  it("a nested manager stamps lineage and passes depth+1 env to grandchildren", async () => {
    const { m, envs } = await setup(happy("ok"), {}, { PI_SUBAGENT_ID: "sa9-b", PI_SPAWN_DEPTH: "2", PI_SPAWN_CHAIN: "sa9" });
    const g = await m.spawn({ task: "[project:PiAgents] grandchild task" });
    expect(g.id).toBe("sa9-b-sa1"); // ids stay unique across the spawn tree
    expect(g.spawnedBy).toEqual(["sa9", "sa9-b"]);
    expect(g.depth).toBe(3);
    expect(envs[0].PI_SPAWN_DEPTH).toBe("3");
    expect(envs[0].PI_SPAWN_CHAIN).toBe("sa9,sa9-b");
    expect(envs[0].PI_SUBAGENT_ID).toBe("sa9-b-sa1");
    const fan = await m.spawn({ task: "[project:PiAgents] fan", fanout: 2 });
    expect(fan.id).toBe("sa9-b-sa2-a");
    expect(fan.fanout!.groupId).toBe("sa9-b-sa2");
    expect(fan.spawnedBy).toEqual(["sa9", "sa9-b"]);
  });

  it("enforces the spawn budget: fanout counts as N, exhaustion errors loudly", async () => {
    const { m } = await setup(happy("ok"));
    await m.spawn({ task: "[project:PiAgents] 1" });
    await m.spawn({ task: "[project:PiAgents] 2" });
    await m.spawn({ task: "[project:PiAgents] 3" });
    await expect(m.spawn({ task: "[project:PiAgents] 4" })).rejects.toThrow("budget exhausted");
    expect(m.list()).toHaveLength(3); // the refused spawn created nothing
    const { m: m2 } = await setup(happy("ok"), { spawnBudget: 3 });
    await m2.spawn({ task: "[project:PiAgents] fan", fanout: 3 }); // one fanout consumes the whole budget
    await expect(m2.spawn({ task: "[project:PiAgents] more" })).rejects.toThrow("budget exhausted");
    const { m: m3 } = await setup(happy("ok"), { spawnBudget: 2 });
    await expect(m3.spawn({ task: "[project:PiAgents] too big", fanout: 3 })).rejects.toThrow("budget exhausted");
    expect(m3.list()).toHaveLength(0);
  });

  it("PI_SPAWN_BUDGET env overrides the default budget of 3", async () => {
    const { m } = await setup(happy("ok"), {}, { PI_SPAWN_BUDGET: "1" });
    await m.spawn({ task: "[project:PiAgents] a" });
    await expect(m.spawn({ task: "[project:PiAgents] b" })).rejects.toThrow("budget exhausted");
  });
});

describe("per-dispatch events directories (root fix for numeric id collisions)", () => {
  it("no-session dispatch gets a suffixed unique dir (sa1-k3f9 style) with the display id unchanged", async () => {
    const { m, dir } = await setup(happy("ok"));
    const i = await m.spawn({ task: "[project:PiAgents] t" });
    expect(i.id).toBe("sa1"); // numeric id stays the display id reported to the coordinator
    expect(dirname(i.logDir)).toBe(dir);
    expect(basename(i.logDir)).toMatch(/^sa1-[a-z0-9]{4}$/); // 4-char filesystem-safe token
    expect(existsSync(i.logDir)).toBe(true);
  });

  it("a named session id becomes the events directory verbatim, display id unchanged", async () => {
    const { m, dir } = await setup(happy("ok"));
    const i = await m.spawn({ task: "[project:PiAgents] t", session: "arch-zh-x1" });
    expect(i.id).toBe("sa1");
    expect(i.logDir).toBe(join(dir, "arch-zh-x1"));
    expect(existsSync(i.logDir)).toBe(true);
  });

  it("does not reuse an existing dir with the same name: re-derives and leaves the old era untouched", async () => {
    const { m, dir } = await setup(happy("ok"));
    const oldDir = join(dir, "sa1"); // historical era dir from another conversation
    mkdirSync(oldDir, { recursive: true });
    writeFileSync(join(oldDir, "events.jsonl"), "OLD ERA\n");
    const i = await m.spawn({ task: "[project:PiAgents] t" });
    expect(i.id).toBe("sa1");
    expect(i.logDir).not.toBe(oldDir);
    expect(basename(i.logDir)).toMatch(/^sa1-[a-z0-9]{4}$/);
    expect(readFileSync(join(oldDir, "events.jsonl"), "utf8")).toBe("OLD ERA\n");
    await m.waitFor(i.id);
    expect(existsSync(join(i.logDir, "events.jsonl"))).toBe(true); // new worker wrote to its own dir
  });

  it("old bare-numeric era dirs stay readable and intact while new dispatches allocate alongside", async () => {
    const { m, dir } = await setup(happy("ok"));
    for (const name of ["sa1", "sa2", "sa27"]) {
      mkdirSync(join(dir, name), { recursive: true });
      writeFileSync(join(dir, name, "result.md"), `era ${name}\n`);
    }
    const i = await m.spawn({ task: "[project:PiAgents] t" });
    const { m: m2 } = await setup(happy("ok"), { baseDir: dir }); // a second conversation-era manager over the same disk
    const j = await m2.spawn({ task: "[project:PiAgents] t2" });
    for (const name of ["sa1", "sa2", "sa27"]) {
      expect(readFileSync(join(dir, name, "result.md"), "utf8")).toBe(`era ${name}\n`); // still readable, unmodified
    }
    expect(existsSync(i.logDir)).toBe(true);
    expect(existsSync(j.logDir)).toBe(true);
    expect(basename(j.logDir)).toMatch(/^sa1-[a-z0-9]{4}$/); // the second manager's sa1 does not collide either
    expect(j.logDir).not.toBe(i.logDir);
  });

  it("fanout members get unique suffixed dirs while keeping their display ids", async () => {
    const { m } = await setup(happy("ok"));
    const first = await m.spawn({ task: "[project:PiAgents] t", fanout: 3 });
    expect(first.id).toBe("sa1-a");
    const list = m.list();
    expect(list.map((i) => i.id).sort()).toEqual(["sa1-a", "sa1-b", "sa1-c"]); // display ids unchanged
    expect(basename(list[0].logDir)).toMatch(/^sa1-a-[a-z0-9]{4}$/);
    expect(basename(list[1].logDir)).toMatch(/^sa1-b-[a-z0-9]{4}$/);
    expect(basename(list[2].logDir)).toMatch(/^sa1-c-[a-z0-9]{4}$/);
    expect(new Set(list.map((i) => i.logDir)).size).toBe(3);
  });

  it("spawns keep byte-identical worker args, env and lineage despite the dir rename", async () => {
    const { m, spawned, envs } = await setup(happy("ok"), {}, { PI_SUBAGENT_ID: "sa9-b", PI_SPAWN_DEPTH: "2", PI_SPAWN_CHAIN: "sa9" });
    const g = await m.spawn({ task: "[project:PiAgents] t" });
    expect(g.id).toBe("sa9-b-sa1");
    expect(basename(g.logDir)).toMatch(/^sa9-b-sa1-[a-z0-9]{4}$/); // dir unique, id prefix intact
    expect(g.spawnedBy).toEqual(["sa9", "sa9-b"]);
    expect(g.depth).toBe(3);
    expect(envs[0].PI_SPAWN_DEPTH).toBe("3");
    expect(envs[0].PI_SPAWN_CHAIN).toBe("sa9,sa9-b");
    expect(envs[0].PI_SUBAGENT_ID).toBe("sa9-b-sa1");
    expect(spawned[0]).toEqual(["pi", "--mode", "rpc", "--no-extensions", "--no-mcp", "--no-approve", "--offline", "-e", "/ext/index.ts", "--no-session", "--model", expect.any(String)]);
  });

  it("dirToken: 4 fs-safe chars, deterministic, varies with time, pid and salt", () => {
    const t = dirToken(1_700_000_000_000, 4242);
    expect(t).toMatch(/^[a-z0-9]{4}$/);
    expect(dirToken(1_700_000_000_000, 4242)).toBe(t);
    expect(dirToken(1_700_000_000_001, 4242)).not.toBe(t);
    expect(dirToken(1_700_000_000_000, 4243)).not.toBe(t);
    expect(dirToken(1_700_000_000_000, 4242, 1)).not.toBe(t);
    expect(dirToken(5, 1)).toMatch(/^[a-z0-9]{4}$/); // tiny inputs still pad to 4 chars
  });

  it("allocEventsDirName: session verbatim when free, re-derived with a token on collision", () => {
    expect(allocEventsDirName("sa1", "arch-zh-x1", () => false, () => "k3f9")).toBe("arch-zh-x1");
    expect(allocEventsDirName("sa1", "arch-zh-x1", (n) => n === "arch-zh-x1", () => "k3f9")).toBe("arch-zh-x1-k3f9");
    expect(allocEventsDirName("sa1", "arch-zh-x1", (n) => n === "arch-zh-x1" || n === "arch-zh-x1-k3f9", (s) => (s === 0 ? "k3f9" : "q7w2"))).toBe("arch-zh-x1-q7w2");
  });

  it("allocEventsDirName: no-session suffix, re-derive once on collision, never return an existing name", () => {
    expect(allocEventsDirName("sa27", undefined, () => false, () => "k3f9")).toBe("sa27-k3f9");
    expect(allocEventsDirName("sa27", undefined, (n) => n === "sa27-k3f9", (s) => (s === 0 ? "k3f9" : "q7w2"))).toBe("sa27-q7w2");
    const taken = new Set(["sa27-k3f9", "sa27-q7w2", "sa27-aaaa"]);
    expect(allocEventsDirName("sa27", undefined, (n) => taken.has(n), (s) => ["k3f9", "q7w2", "aaaa"][s] ?? "zzzz")).toBe("sa27-zzzz");
  });
});

describe("spawn-tag gate (project-space routing, PI_SPAWN_REQUIRE_PROJECT_TAG)", () => {
  it("default ON: a task without the [project:<name>] token throws the actionable reason before any spawn side effect", async () => {
    const { m, spawned } = await setup(happy("ok"));
    let err: Error | undefined;
    try { await m.spawn({ task: "no tag here" }); } catch (e) { err = e as Error; }
    expect(err?.message).toContain("missing the required [project:<name>] token");
    expect(err?.message).toContain('[project:PiAgents]'); // the example fix
    expect(err?.message).toContain("PI_SPAWN_REQUIRE_PROJECT_TAG=0"); // the kill switch
    expect(err?.message).toContain("coordinator-side guard"); // division of labor is documented in the denial
    expect(spawned).toHaveLength(0); // nothing was spawned
    expect(m.list()).toHaveLength(0); // no subagent state was created
  });

  it("nested (depth-2) managers are gated identically: tagless grandchild task throws, tagged passes", async () => {
    const { m, spawned, envs } = await setup(happy("ok"), {}, { PI_SUBAGENT_ID: "sa9-b", PI_SPAWN_DEPTH: "2", PI_SPAWN_CHAIN: "sa9" });
    await expect(m.spawn({ task: "tagless grandchild task" })).rejects.toThrow("missing the required [project:<name>] token");
    expect(spawned).toHaveLength(0);
    const g = await m.spawn({ task: "[project:PiAgents] grandchild task" });
    expect(g.id).toBe("sa9-b-sa1"); // the nested path itself is unchanged for tagged dispatches
    expect(envs[0].PI_SPAWN_DEPTH).toBe("3");
    expect(spawned).toHaveLength(1);
  });

  it("the token counts anywhere in the task text (prefix or inline)", async () => {
    const { m, spawned } = await setup(happy("ok"));
    await m.spawn({ task: "[project:PiAgents] prefix form" });
    await m.spawn({ task: "please do it [project:PiAgents] inline form" });
    expect(spawned).toHaveLength(2);
  });

  it("kill switch PI_SPAWN_REQUIRE_PROJECT_TAG=0|false restores untagged spawning; any other value stays ON", async () => {
    const { m } = await setup(happy("ok"), {}, { [SPAWN_TAG_ENV]: "0" });
    await expect(m.spawn({ task: "tagless legacy task" })).resolves.toMatchObject({ id: "sa1" });
    const { m: mf } = await setup(happy("ok"), {}, { [SPAWN_TAG_ENV]: "false" });
    await expect(mf.spawn({ task: "tagless legacy task" })).resolves.toMatchObject({ id: "sa1" });
    const { m: m1 } = await setup(happy("ok"), {}, { [SPAWN_TAG_ENV]: "1" });
    await expect(m1.spawn({ task: "tagless legacy task" })).rejects.toThrow("missing the required [project:<name>] token");
    const { m: mg } = await setup(happy("ok"), {}, { [SPAWN_TAG_ENV]: "garbage" });
    await expect(mg.spawn({ task: "tagless legacy task" })).rejects.toThrow("missing the required [project:<name>] token");
  });

  it("options.requireProjectTag overrides env (manager-level pin)", async () => {
    const { m } = await setup(happy("ok"), { requireProjectTag: false }, { [SPAWN_TAG_ENV]: "1" });
    await expect(m.spawn({ task: "tagless via option" })).resolves.toMatchObject({ id: "sa1" });
    const { m: m2 } = await setup(happy("ok"), { requireProjectTag: true }, { [SPAWN_TAG_ENV]: "0" });
    await expect(m2.spawn({ task: "tagless via option" })).rejects.toThrow("missing the required [project:<name>] token");
  });

  it("parseSpawnTagRequired: only '0'/'false' disable (case/space tolerant); unset/empty/garbage = ON", () => {
    expect(parseSpawnTagRequired(undefined)).toBe(true);
    expect(parseSpawnTagRequired("")).toBe(true);
    expect(parseSpawnTagRequired("  ")).toBe(true);
    expect(parseSpawnTagRequired("0")).toBe(false);
    expect(parseSpawnTagRequired(" false ")).toBe(false);
    expect(parseSpawnTagRequired("FALSE")).toBe(false);
    expect(parseSpawnTagRequired("1")).toBe(true);
    expect(parseSpawnTagRequired("true")).toBe(true);
    expect(parseSpawnTagRequired("off")).toBe(true); // anything but 0/false is ON
  });

  it("the gate runs before the budget check: a tagless task names the tag, a tagged one names the budget", async () => {
    const { m } = await setup(happy("ok"), { spawnBudget: 1 });
    await m.spawn({ task: "[project:PiAgents] one" });
    await expect(m.spawn({ task: "tagless second" })).rejects.toThrow("missing the required [project:<name>] token");
    await expect(m.spawn({ task: "[project:PiAgents] second" })).rejects.toThrow("budget exhausted");
  });
});
