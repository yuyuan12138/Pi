/**
 * Offline tests for packages/pi-project-coordinator.
 *
 * Layers:
 *  1. Registry + routing (pure, scratch dirs).
 *  2. Journal durability + crash semantics (replayed from disk).
 *  3. Engine: dedupe, per-project serial queue, lease, max-2 concurrency,
 *     unknown-outcome for mutating crash (no replay).
 *  4. RpcProjectRuntime against a FAKE CLI speaking the documented JSONL
 *     protocol (framing, correlation, get_state probe, prompt gating).
 *  5. Real-runtime smoke (only with PI_COORDINATOR_SMOKE=1): spawns the real
 *     installed Pi CLI in RPC mode in a scratch dir and probes get_state.
 *     No model call, no prompt: proves spawn/protocol/identity only.
 *
 * No network, no provider client, no Telegram transport, no real project
 * directory is touched. Scratch projects under os.tmpdir().
 */
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import {
  Coordinator,
  RpcProjectRuntime,
  TaskJournal,
  emptyRegistry,
  loadRegistry,
  proposeRegistration,
  route,
  saveRegistry,
  validateRegistry,
  type ProjectRuntime,
  type TaskOutcome,
} from "../packages/pi-project-coordinator/index.ts";

function scratch(name: string): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), `coord-${name}-`));
  return dir;
}

function scratchRegistry(): { dir: string; registryFile: string } {
  const dir = scratch("reg");
  return { dir, registryFile: path.join(dir, "registry.json") };
}

function twoProjects(dir: string) {
  const rootA = fs.realpathSync(fs.mkdtempSync(path.join(dir, "projA-")));
  const rootB = fs.realpathSync(fs.mkdtempSync(path.join(dir, "projB-")));
  let registry = emptyRegistry();
  registry = proposeRegistration(registry, {
    id: "alpha",
    displayName: "Alpha",
    aliases: ["医疗平台", "alpha"],
    root: rootA,
    sessionId: "alpha-primary",
  });
  registry = proposeRegistration(registry, {
    id: "beta",
    displayName: "Beta",
    aliases: ["beta", "minecraft"],
    root: rootB,
    sessionId: "beta-primary",
  });
  return { registry, rootA, rootB };
}

// ---------------------------------------------------------------- registry

test("registry: canonical roots, alias uniqueness, validation", () => {
  const { registryFile } = scratchRegistry();
  const dir = scratch("val");
  const root = fs.realpathSync(fs.mkdtempSync(path.join(dir, "r-")));
  let registry = emptyRegistry();
  registry = proposeRegistration(registry, {
    id: "p1",
    displayName: "P1",
    aliases: ["P1", "one"],
    root,
    sessionId: "p1-sess",
  });
  saveRegistry(registryFile, registry);
  const loaded = loadRegistry(registryFile);
  assert.equal(loaded.projects.length, 1);
  assert.deepEqual(loaded.projects[0].aliases, ["p1", "one"]); // normalized

  // duplicate alias across projects rejected
  const root2 = fs.realpathSync(fs.mkdtempSync(path.join(dir, "r2-")));
  assert.throws(
    () =>
      validateRegistry(
        proposeRegistration(registry, {
          id: "p2",
          displayName: "P2",
          aliases: ["one"],
          root: root2,
          sessionId: "p2-sess",
        }),
      ),
    /alias "one" owned by/,
  );
  // duplicate root rejected
  assert.throws(
    () =>
      validateRegistry(
        proposeRegistration(registry, {
          id: "p3",
          displayName: "P3",
          aliases: ["three"],
          root, // same canonical root as p1
          sessionId: "p3-sess",
        }),
      ),
    /duplicate root/,
  );
});

// ----------------------------------------------------------------- routing

test("routing: exact id / alias / root; ambiguous; unknown; disabled", () => {
  const dir = scratch("route");
  const { registry } = twoProjects(dir);

  assert.equal(route(registry, "alpha").status, "ok");
  assert.equal(route(registry, "ALPHA").status, "ok"); // case-insensitive alias
  assert.equal(route(registry, "医疗平台").status, "ok"); // non-ASCII alias
  const byRoot = route(registry, registry.projects[0].root);
  assert.equal(byRoot.status, "ok");
  assert.ok((byRoot as any).matched.startsWith("root:"));

  assert.equal(route(registry, "").status, "unknown");
  assert.equal(route(registry, "gamma").status, "unknown");

  // Two projects sharing an alias (pre-validation state) => ambiguous, never a guess.
  const raw = structuredClone(registry) as typeof registry;
  raw.projects[1].aliases.push("医疗平台");
  const amb = route(raw, "医疗平台");
  assert.equal(amb.status, "ambiguous");
  assert.equal(amb.candidates!.length, 2);

  // disabled projects are invisible to routing
  raw.projects[1].status = "disabled";
  assert.equal(route(raw, "beta").status, "unknown");
});

// ----------------------------------------------------------------- journal

test("journal: dedupe key stability, replay across instances, unknown-outcome mutations", async () => {
  const dir = scratch("journal");
  const file = path.join(dir, "journal.jsonl");
  const j1 = new TaskJournal(file);
  const envelope = {
    taskId: "task-1",
    dedupeKey: "k1",
    sourceMessageId: "tg-1",
    splitIndex: 0,
    projectId: "alpha",
    goal: "deploy",
    deliverable: "evidence",
    mutating: true,
    createdAt: new Date().toISOString(),
  };
  assert.equal(j1.recordEnvelope(envelope), true);
  assert.equal(j1.recordEnvelope({ ...envelope, taskId: "task-2" }), false); // dedupe on key
  j1.mark("task-1", "queued");
  j1.mark("task-1", "started");
  j1.mark("task-1", "settled", "unknown-outcome: crash: rpc child exited");

  // Replay from disk in a fresh instance.
  const j2 = new TaskJournal(file);
  assert.equal(j2.phase("task-1"), "settled");
  assert.equal(j2.findByDedupeKey("k1")!.taskId, "task-1");
  const unresolved = j2.unresolvedMutations();
  assert.equal(unresolved.length, 1);
  assert.equal(unresolved[0].mutating, true);
  // Explicit reconciliation is required; the engine never replays it.
  j2.mark("task-1", "reconciled", "primary inspected server state");
  assert.equal(new TaskJournal(file).unresolvedMutations().length, 0);
});

// ------------------------------------------------------------------ engine

class ScriptedRuntime implements ProjectRuntime {
  readonly runtimeId = "scripted";
  calls: string[] = [];
  private readonly behavior: (projectId: string, n: number) => Promise<{ outcome: TaskOutcome; summary: string }>;
  private counter = { n: 0 };
  constructor(behavior: (projectId: string, n: number) => Promise<{ outcome: TaskOutcome; summary: string }>) {
    this.behavior = behavior;
  }
  async run(envelope: any, _root: string, _sessionId: string) {
    this.calls.push(envelope.taskId);
    this.counter.n += 1;
    return this.behavior(envelope.projectId, this.counter.n);
  }
}

function makeEngine(dir: string, runtime: ProjectRuntime, maxConcurrent = 2) {
  const { registry } = twoProjects(dir);
  const journal = new TaskJournal(path.join(dir, "journal.jsonl"));
  const coordinator = new Coordinator(registry, journal, runtime, { maxConcurrentProjects: maxConcurrent });
  return { registry, journal, coordinator };
}

test("engine: same message+split never executes twice", async () => {
  const dir = scratch("dedupe");
  let ran = 0;
  const rt = new ScriptedRuntime(async () => {
    ran += 1;
    return { outcome: "completed-unverified", summary: "ok" };
  });
  const { coordinator } = makeEngine(dir, rt);
  const first = coordinator.submit({ sourceMessageId: "tg-9", splitIndex: 0, projectId: "alpha", goal: "g", deliverable: "d", mutating: false });
  const dup = coordinator.submit({ sourceMessageId: "tg-9", splitIndex: 0, projectId: "alpha", goal: "g", deliverable: "d", mutating: false });
  assert.equal(first.status, "queued");
  assert.equal(dup.status, "duplicate");
  assert.equal(dup.taskId, first.taskId);
  await coordinator.drain();
  assert.equal(ran, 1);
  // Split index differentiates tasks within one message.
  const second = coordinator.submit({ sourceMessageId: "tg-9", splitIndex: 1, projectId: "alpha", goal: "g2", deliverable: "d", mutating: false });
  assert.equal(second.status, "queued");
  await coordinator.drain();
  assert.equal(ran, 2);
});

test("engine: per-project serial queue and single-writer lease", async () => {
  const dir = scratch("serial");
  const inFlight: Record<string, number> = {};
  let maxSimultaneousPerProject = 0;
  const rt = new ScriptedRuntime(async (projectId) => {
    inFlight[projectId] = (inFlight[projectId] ?? 0) + 1;
    maxSimultaneousPerProject = Math.max(maxSimultaneousPerProject, inFlight[projectId]);
    await new Promise((r) => setTimeout(r, 25));
    inFlight[projectId] -= 1;
    return { outcome: "completed-unverified", summary: "ok" };
  });
  const { coordinator } = makeEngine(dir, rt);
  for (let i = 0; i < 4; i++) {
    coordinator.submit({ sourceMessageId: `m-${i}`, splitIndex: 0, projectId: "alpha", goal: "g", deliverable: "d", mutating: false });
  }
  await coordinator.drain();
  assert.equal(maxSimultaneousPerProject, 1); // serial per project
  assert.ok(rt.calls.length === 4);
});

test("engine: global concurrency capped at 2 projects", async () => {
  const dir = scratch("cap");
  let active = 0;
  let peak = 0;
  const rt = new ScriptedRuntime(async () => {
    active += 1;
    peak = Math.max(peak, active);
    await new Promise((r) => setTimeout(r, 25));
    active -= 1;
    return { outcome: "completed-unverified", summary: "ok" };
  });
  const { coordinator } = makeEngine(dir, rt, 2);
  for (const pid of ["alpha", "beta"]) {
    for (let i = 0; i < 2; i++) {
      coordinator.submit({ sourceMessageId: `${pid}-${i}`, splitIndex: 0, projectId: pid, goal: "g", deliverable: "d", mutating: false });
    }
  }
  await coordinator.drain();
  assert.equal(peak, 2); // two projects in parallel, never three
  assert.equal(rt.calls.length, 4);
  // lease bookkeeping: alpha and beta each hold a lease with generation >= 1
  const stats = coordinator.stats();
  assert.ok(stats.leases.alpha.generation >= 1);
  assert.ok(stats.leases.beta.generation >= 1);
});

test("engine: mutating crash => unknown-outcome, read-only crash => failed, no auto-replay", async () => {
  const dir = scratch("crash");
  const rt = new ScriptedRuntime(() => {
    throw new Error("simulated controller crash after dispatch");
  });
  const { coordinator, journal } = makeEngine(dir, rt);
  coordinator.submit({ sourceMessageId: "m1", splitIndex: 0, projectId: "alpha", goal: "deploy", deliverable: "d", mutating: true });
  coordinator.submit({ sourceMessageId: "m2", splitIndex: 0, projectId: "alpha", goal: "read report", deliverable: "d", mutating: false });
  await coordinator.drain();
  const unresolved = journal.unresolvedMutations();
  assert.equal(unresolved.length, 1);
  assert.equal(unresolved[0].sourceMessageId, "m1");
  // New controller instance over same journal: replay does not resurrect tasks.
  const j2 = new TaskJournal(path.join(dir, "journal.jsonl"));
  assert.equal(j2.unresolvedMutations().length, 1);
  // The crashed mutating task was executed exactly once (attempted once).
  assert.equal(rt.calls.length, 2);
});

// ------------------------------------------------- fake-CLI RPC runtime

/** Minimal fake Pi RPC CLI implementing the documented protocol subset. */
const FAKE_CLI = `
const records = [];
let buffer = "";
const argv = process.argv;
const sidIdx = argv.indexOf("--session-id");
const sessionId = process.env.FAKE_SESSION_OVERRIDE ?? (sidIdx >= 0 ? argv[sidIdx + 1] : null);
process.stdin.on("data", (chunk) => {
  buffer += chunk.toString("utf8");
  const lines = buffer.split("\\n");
  buffer = lines.pop() ?? "";
  for (const line of lines) {
    if (!line.trim()) continue;
    onCommand(JSON.parse(line));
  }
});
function send(record) { process.stdout.write(JSON.stringify(record) + "\\n"); }
function onCommand(cmd) {
  if (cmd.type === "get_state") {
    send({ id: cmd.id, type: "response", command: "get_state", success: true, data: {
      sessionId,
      sessionFile: "/fake/sessions/" + sessionId + ".jsonl",
      model: { provider: "fake-provider", id: "fake-model" },
    }});
  } else if (cmd.type === "prompt") {
    if (process.env.FAKE_PROMPT_FAIL === "1") {
      send({ id: cmd.id, type: "response", command: "prompt", success: false, error: "no provider" });
      return;
    }
    send({ id: cmd.id, type: "response", command: "prompt", success: true, data: { disposition: "started" } });
    setTimeout(() => send({ type: "agent_settled" }), 20);
  }
}
process.stdin.on("end", () => process.exit(0));
`;

function writeFakeCli(dir: string): string {
  const file = path.join(dir, "fake-pi-cli.cjs");
  fs.writeFileSync(file, FAKE_CLI, "utf8");
  return file;
}

test("rpc runtime: probe identity, model-call gating, settled wait, framing", async () => {
  const dir = scratch("rpc");
  const cli = writeFakeCli(dir);
  const root = fs.realpathSync(fs.mkdtempSync(path.join(dir, "root-")));
  const rt = new RpcProjectRuntime({
    cliPath: cli,
    extraArgs: [],
    timeoutMs: 10000,
  });
  const rt2 = new RpcProjectRuntime({ cliPath: cli, allowModelCalls: true, timeoutMs: 10000 });
  const rt3 = new RpcProjectRuntime({ cliPath: cli, allowModelCalls: true, timeoutMs: 10000 });
  try {
    // Gated: probe succeeds, prompt refused by policy.
    const run1 = await rt.run({ taskId: "t1", goal: "do work" }, root, "proj-sess-1");
    assert.equal(run1.outcome, "failed");
    assert.match(run1.summary, /model calls disabled/);

    // Enabled: prompt accepted then agent_settled observed.
    const probe = await rt2.probe(root, "proj-sess-1");
    assert.equal(probe.sessionId, "proj-sess-1");
    assert.equal(probe.provider, "fake-provider");
    const run2 = await rt2.run({ taskId: "t2", goal: "do work" }, root, "proj-sess-1");
    assert.equal(run2.outcome, "completed-unverified");

    // Session-id mismatch fails the task before any prompt. The fake CLI is
    // overridden to report a session id different from the requested one.
    process.env.FAKE_SESSION_OVERRIDE = "wrong-session";
    const bad = await rt3.run({ taskId: "t3", goal: "x" }, root, "other-session");
    delete process.env.FAKE_SESSION_OVERRIDE;
    assert.equal(bad.outcome, "failed");
    assert.match(bad.summary, /session mismatch/);
  } finally {
    await Promise.all([rt.stopAll(), rt2.stopAll(), rt3.stopAll()]);
  }
});

test("rpc runtime: failed prompt command surfaces as error (no fake success)", async () => {
  const dir = scratch("rpcfail");
  const cli = writeFakeCli(dir);
  const root = fs.realpathSync(fs.mkdtempSync(path.join(dir, "root-")));
  const rt = new RpcProjectRuntime({
    cliPath: cli,
    allowModelCalls: true,
    timeoutMs: 10000,
    nodePath: process.execPath,
    extraArgs: [],
  });
  // Force the fake CLI to reject prompts.
  const origEnv = process.env.FAKE_PROMPT_FAIL;
  process.env.FAKE_PROMPT_FAIL = "1";
  await assert.rejects(() => rt.run({ taskId: "t", goal: "x" }, root, "s1"), /no provider/);
  process.env.FAKE_PROMPT_FAIL = origEnv;
  await rt.stopAll();
});

// ------------------------------------------- real-runtime smoke (opt-in)

test("real pi rpc smoke: spawn + get_state identity, no model call", { skip: !process.env.PI_COORDINATOR_SMOKE }, async () => {
  const release = "/Users/yuyuan/.pi/agent/install/releases/1.3.0/node_modules/@earendil-works/pi-coding-agent/dist/cli.js";
  assert.ok(fs.existsSync(release), "installed Pi CLI not found");
  const dir = scratch("smoke");
  const root = fs.realpathSync(fs.mkdtempSync(path.join(dir, "root-")));
  const sessionDir = path.join(dir, "sessions");
  const rt = new RpcProjectRuntime({ cliPath: release, allowModelCalls: false, timeoutMs: 90000, extraArgs: ["--session-dir", sessionDir] });
  try {
    const probe = await rt.probe(root, "smoke-primary");
    assert.equal(probe.sessionId, "smoke-primary");
    assert.ok(probe.sessionFile!.startsWith(sessionDir), `session file under project session dir: ${probe.sessionFile}`);
    assert.ok(probe.provider && probe.modelId, "current model reported");
    const run = await rt.run({ taskId: "smoke-1", goal: "should not execute" }, root, "smoke-primary");
    assert.equal(run.outcome, "failed");
    assert.match(run.summary, /model calls disabled/);
  } finally {
    await rt.stopAll();
  }
});

