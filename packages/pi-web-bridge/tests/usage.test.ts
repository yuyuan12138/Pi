import { test, describe } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, mkdir, writeFile, utimes, readFile } from "node:fs/promises";
import { readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, dirname } from "node:path";
import { UsageAggregator, usageStats } from "../src/usage.ts";
import { readSubLog } from "../src/sublog.ts";
import { MainLogReader } from "../src/mainlog.ts";
import { SubagentScanner } from "../src/state.ts";
import { createBridgeServer } from "../src/server.ts";

const evLine = (ev: object) => JSON.stringify(ev) + "\n";

// ---------- shared event-stream fixture lines (subagent events.jsonl format) ----------
const TASK = evLine({ type: "message_end", message: { role: "user", content: [{ type: "text", text: "Do a thing" }] } });
const MSG_A = evLine({
  type: "message_end",
  message: { role: "assistant", content: [{ type: "text", text: "hello" }], model: "m9", timestamp: 1000, usage: { input: 100, output: 20, cacheRead: 5, cacheWrite: 3, reasoning: 2, totalTokens: 130, cost: { total: 0.5 } } },
});
const MSG_TOOLONLY = evLine({
  type: "message_end",
  message: { role: "assistant", content: [{ type: "toolCall", id: "x", name: "bash", arguments: {} }], model: "m9", timestamp: 1100, usage: { input: 10, output: 5, cacheRead: 0, cacheWrite: 0, reasoning: 0, totalTokens: 15, cost: { total: 0.1 } } },
});
const MSG_NOUSAGE = evLine({ type: "message_end", message: { role: "assistant", content: [{ type: "text", text: "no usage here" }], timestamp: 1200 } });
const TURN = evLine({ type: "turn_end" });
const BASH1 = evLine({ type: "tool_execution_start", toolCallId: "b1", toolName: "bash", args: { command: "ls" } });
const BASH2 = evLine({ type: "tool_execution_start", toolCallId: "b2", toolName: "bash", args: { command: "pwd" } });
const READ_SKILL = evLine({ type: "tool_execution_start", toolCallId: "r1", toolName: "read", args: { path: "/Users/x/.pi/agent/skills/alpha/SKILL.md" } });
const GREP_SKILL = evLine({ type: "tool_execution_start", toolCallId: "g1", toolName: "grep", args: { pattern: "x", path: "/proj/.pi/skills/beta/" } });
const SPAWN = evLine({ type: "tool_execution_start", toolCallId: "s1", toolName: "subagent_spawn", args: { label: "child-worker", task: "Do child things", model: "m1" } });
const SPAWN_END = evLine({ type: "tool_execution_end", toolCallId: "s1", toolName: "subagent_spawn", result: { content: [{ type: "text", text: "Spawned sa13-c1 (running). Logs: /x/sa13-c1." }] } });

const EVENT_STREAM = TASK + MSG_A + MSG_TOOLONLY + MSG_NOUSAGE + TURN + TURN + BASH1 + BASH2 + READ_SKILL + GREP_SKILL + SPAWN + SPAWN_END;

describe("UsageAggregator over subagent event-stream lines", () => {
  test("counts tools, spawns, skills, tokens and turns", () => {
    const agg = new UsageAggregator();
    for (const line of EVENT_STREAM.split("\n")) if (line) agg.feedLine(line);
    const s = agg.snapshot();
    assert.deepEqual(s.tools, [
      { name: "bash", count: 2 },
      { name: "grep", count: 1 },
      { name: "read", count: 1 },
      { name: "subagent_spawn", count: 1 },
    ]);
    assert.equal(s.toolCalls, 5);
    assert.deepEqual(s.subagents, [{ id: "sa13-c1", label: "child-worker", session: null, model: "m1" }]);
    assert.deepEqual(s.skills, ["alpha", "beta"]);
    assert.equal(s.assistantMessages, 2); // text-bearing only (tool-only frame excluded)
    assert.equal(s.assistantTurns, 2); // turn_end events
    assert.deepEqual(s.tokens, { input: 110, output: 25, cacheRead: 5, cacheWrite: 3, reasoning: 2, total: 145, cost: 0.6, framesWithUsage: 2, framesWithoutUsage: 1 });
    assert.equal(s.model, "m9");
    assert.equal(s.startedAt, 1000);
  });

  test("parses the session-JSONL format: toolCall blocks, toolResult ids, usage", () => {
    const agg = new UsageAggregator();
    const lines = [
      evLine({ type: "message", message: { role: "assistant", content: [{ type: "toolCall", id: "c1", name: "subagent_spawn", arguments: { label: "kid task", session: "sess-7", model: "mm" } }], model: "gpt-x", timestamp: 1790000000000, usage: { input: 50, output: 10, cacheRead: 0, cacheWrite: 0, reasoning: 0, totalTokens: 60, cost: { total: 0.02 } } } }),
      evLine({ type: "message", message: { role: "toolResult", toolCallId: "c1", content: [{ type: "text", text: "Spawned kid-1 (running). Logs: /x/kid-1." }] } }),
      evLine({ type: "message", message: { role: "assistant", content: [{ type: "toolCall", id: "c2", name: "bash", arguments: { command: "ls" } }, { type: "text", text: "ran ls" }], timestamp: 1790000001000, usage: { input: 20, output: 4, cacheRead: 0, cacheWrite: 0, reasoning: 0, totalTokens: 24, cost: { total: 0.01 } } } }),
    ];
    for (const l of lines) agg.feedLine(l);
    const s = agg.snapshot();
    assert.deepEqual(s.tools, [{ name: "bash", count: 1 }, { name: "subagent_spawn", count: 1 }]);
    assert.deepEqual(s.subagents, [{ id: "kid-1", label: "kid task", session: "sess-7", model: "mm" }]);
    assert.equal(s.toolCalls, 2);
    assert.equal(s.assistantTurns, 2); // session logs: every assistant message is a turn
    assert.equal(s.assistantMessages, 1); // only the second message carries visible text
    assert.equal(s.tokens.total, 84);
    assert.equal(s.tokens.cost, 0.03);
  });
});

describe("readSubLog exposes stats additively", () => {
  test("stats ride along; legacy fields are unchanged", async () => {
    const dir = await mkdtemp(join(tmpdir(), "wbsub-"));
    await mkdir(join(dir, "saX"));
    await writeFile(join(dir, "saX", "events.jsonl"), EVENT_STREAM);
    const snap = readSubLog(join(dir, "saX"), "saX", null);
    assert.ok(snap.stats, "stats present");
    assert.equal(snap.stats!.tokens.total, 145);
    assert.equal(snap.stats!.toolCalls, 5);
    // legacy shape byte-identical: everything except stats (line order/offsets derived from the raw stream)
    const raw = EVENT_STREAM.split("\n").filter((l) => l);
    const offs: number[] = [];
    let off = 0;
    for (const l of raw) { offs.push(off); off += Buffer.byteLength(l + "\n", "utf8"); }
    const tool = (name: string, i: number) => ({ kind: "tool", name, text: JSON.stringify((JSON.parse(raw[i]) as { args: unknown }).args).slice(0, 200), offset: offs[i] });
    const { stats, ...legacy } = snap;
    assert.ok(stats);
    assert.deepEqual(legacy, {
      id: "saX",
      cursor: off,
      reset: true,
      lines: [
        { kind: "event", name: "task", text: "Do a thing", offset: offs[0] },
        { kind: "assistant", text: "hello", offset: offs[1] },
        { kind: "assistant", text: "no usage here", offset: offs[3] },
        tool("bash", 6),
        tool("bash", 7),
        tool("read", 8),
        tool("grep", 9),
        tool("subagent_spawn", 10),
      ],
      result: null,
      done: false,
    });
  });

  test("incremental polls extend stats without resetting", async () => {
    const dir = await mkdtemp(join(tmpdir(), "wbsub-inc-"));
    await mkdir(join(dir, "saY"));
    const file = join(dir, "saY", "events.jsonl");
    await writeFile(file, TASK + BASH1);
    const first = readSubLog(join(dir, "saY"), "saY", null);
    assert.equal(first.stats!.toolCalls, 1);
    await writeFile(file, TASK + BASH1 + BASH2); // append one more tool call
    const second = readSubLog(join(dir, "saY"), "saY", first.cursor);
    assert.equal(second.reset, false);
    assert.equal(second.stats!.toolCalls, 2);
  });
});

describe("scanner usage aggregates + append-only sidecar", () => {
  async function makeScanRoot(): Promise<string> {
    // Unique parent per run: the sidecar (<parent>/subagents-usage.jsonl) is append-only,
    // mirroring production where each project has its own .pi/ directory.
    const root = await mkdtemp(join(tmpdir(), "wbscan-"));
    const dir = join(root, "subagents");
    await mkdir(dir);
    const done = TASK + BASH1 + READ_SKILL
      + evLine({ type: "tool_execution_start", toolCallId: "p1", toolName: "report_to_parent", args: { status: "ready", summary: "done" } })
      + MSG_A + evLine({ type: "agent_settled" });
    await mkdir(join(dir, "sa7"));
    await writeFile(join(dir, "sa7", "events.jsonl"), done);
    await writeFile(join(dir, "sa7", "result.md"), "Done.");
    await mkdir(join(dir, "sa6"));
    await writeFile(join(dir, "sa6", "events.jsonl"), TASK + BASH2 + evLine({ type: "tool_execution_start", toolCallId: "p2", toolName: "report_to_parent", args: { status: "ready", summary: "ok" } }) + evLine({ type: "agent_settled" }));
    await writeFile(join(dir, "sa6", "result.md"), "ok");
    await mkdir(join(dir, "sa6-1"));
    await writeFile(join(dir, "sa6-1", "events.jsonl"), TASK + evLine({ type: "tool_execution_start", toolCallId: "p3", toolName: "report_to_parent", args: { status: "ready", summary: "ok" } }) + evLine({ type: "agent_settled" }));
    await writeFile(join(dir, "sa6-1", "result.md"), "ok");
    return dir;
  }

  test("views carry usage; sidecar records each settle exactly once", async () => {
    const dir = await makeScanRoot();
    const views = new SubagentScanner().scan(dir);
    const byId = new Map(views.map((v) => [v.id, v]));
    assert.equal(byId.get("sa7")!.usage!.totalTokens, 130);
    assert.equal(byId.get("sa7")!.usage!.toolCalls, 3);
    assert.equal(byId.get("sa7")!.usage!.costTotal, 0.5);

    const sidecar = join(dirname(dir), "subagents-usage.jsonl");
    const bytes1 = readFileSync(sidecar);
    const lines1 = bytes1.toString("utf8").trim().split("\n");
    assert.equal(lines1.length, 3); // sa7, sa6, sa6-1 — all settled
    const recs = lines1.map((l) => JSON.parse(l));
    const saU = recs.find((r) => r.id === "sa7");
    assert.equal(saU.tokens.total, 130);
    assert.equal(saU.tokens.cost, 0.5);
    assert.equal(saU.tokens.framesWithUsage, 1);
    assert.deepEqual(saU.tools, { report_to_parent: 1, bash: 1, read: 1 });
    assert.deepEqual(saU.skills, ["alpha"]);
    assert.deepEqual(saU.subagents, []);
    assert.equal(saU.depth, 0);
    assert.equal(saU.spawned_by, null);
    assert.equal(typeof saU.startedAt, "number");
    const child = recs.find((r) => r.id === "sa6-1");
    assert.equal(child.depth, 1);
    assert.equal(child.spawned_by, "sa6");
    const parent = recs.find((r) => r.id === "sa6");
    assert.equal(parent.depth, 0);
    assert.equal(parent.spawned_by, null);

    // idempotent rescan (fresh scanner, sidecar reloaded): no duplicates, byte-identical
    new SubagentScanner().scan(dir);
    assert.equal(readFileSync(sidecar).length, bytes1.length);

    // newer settle (result.md touched) appends; existing prefix never rewritten
    const now = Date.now() / 1000 + 10;
    await utimes(join(dir, "sa7", "result.md"), now, now);
    new SubagentScanner().scan(dir);
    const bytes3 = readFileSync(sidecar);
    assert.ok(bytes3.length > bytes1.length);
    assert.ok(bytes3.subarray(0, bytes1.length).equals(bytes1), "existing lines byte-identical");
    const lines3 = bytes3.toString("utf8").trim().split("\n");
    assert.equal(lines3.length, 4);
    const saURecords = lines3.map((l) => JSON.parse(l)).filter((r) => r.id === "sa7");
    assert.equal(saURecords.length, 2);
    assert.notEqual(saURecords[0].settledAt, saURecords[1].settledAt);
  });
});

describe("main log usage (whole-run, ring-independent)", () => {
  test("backfilled session still yields whole-run stats; appends are incremental", async () => {
    const dir = await mkdtemp(join(tmpdir(), "wbmain-"));
    const file = join(dir, "session.jsonl");
    // early message + >64KB of later traffic so the ring's tail window excludes 'early'
    const lateFiller = Array.from({ length: 800 }, (_, i) => evLine({ type: "custom", n: i, pad: "x".repeat(120) })).join("");
    const early = evLine({ type: "message", message: { role: "assistant", content: [{ type: "toolCall", id: "e1", name: "bash", arguments: { command: "early" } }, { type: "text", text: "early work" }], model: "gpt-x", timestamp: 1790000000000, usage: { input: 1000, output: 100, cacheRead: 0, cacheWrite: 0, reasoning: 0, totalTokens: 1100, cost: { total: 0.2 } } } });
    const late = evLine({ type: "message", message: { role: "assistant", content: [{ type: "text", text: "late reply" }], model: "gpt-x", timestamp: 1790000900000, usage: { input: 2000, output: 50, cacheRead: 0, cacheWrite: 0, reasoning: 0, totalTokens: 2050, cost: { total: 0.3 } } } });
    await writeFile(file, early + lateFiller + late);

    const reader = new MainLogReader(300, 64 * 1024); // small ring window: 'early' is outside it
    reader.attach(file); // the server does this on every poll; the test mirrors it
    const snap = reader.consume(null);
    assert.ok(snap.stats, "stats present on first poll");
    assert.equal(snap.stats!.toolCalls, 1); // early toolCall counted though outside the item ring
    assert.equal(snap.stats!.tokens.total, 3150); // early + late usage summed
    assert.equal(snap.stats!.tokens.cost, 0.5);
    assert.ok(!snap.items.some((i) => i.text.includes("early work")), "ring stays windowed");
    const { stats, ...legacy } = snap;
    assert.ok(stats);
    assert.deepEqual(Object.keys(legacy).sort(), ["cursor", "file", "items", "reset"]);

    const appended = evLine({ type: "message", message: { role: "assistant", content: [{ type: "text", text: "newer" }], timestamp: 1790000999000, usage: { input: 10, output: 2, cacheRead: 0, cacheWrite: 0, reasoning: 0, totalTokens: 12, cost: { total: 0.01 } } } });
    await writeFile(file, early + lateFiller + late + appended);
    const snap2 = reader.consume(snap.cursor);
    assert.equal(snap2.stats!.tokens.total, 3162);
    assert.equal(snap2.stats!.toolCalls, 1);
  });
});

describe("usageStats warming and edge cases", () => {
  test("small files scan inline; missing files yield empty stats", async () => {
    const dir = await mkdtemp(join(tmpdir(), "wbwarm-"));
    const small = join(dir, "small.jsonl");
    await writeFile(small, TASK + BASH1);
    const s = usageStats(small);
    assert.equal(s!.toolCalls, 1);
    const missing = usageStats(join(dir, "nope.jsonl"));
    assert.deepEqual(missing!.toolCalls, 0);
    assert.deepEqual(missing!.tools, []);
  });

  test("large cold files warm in the background then report whole-run stats", async () => {
    const dir = await mkdtemp(join(tmpdir(), "wbwarm2-"));
    const file = join(dir, "big.jsonl");
    const filler = Array.from({ length: 3000 }, (_, i) => evLine({ type: "custom", n: i, pad: "y".repeat(120) })).join("");
    await writeFile(file, filler + BASH1 + TASK);
    assert.equal(usageStats(file), null, "cold large file returns null (warming)");
    let stats = null;
    for (let i = 0; i < 5000 && !stats; i++) {
      await new Promise((r) => setImmediate(r));
      stats = usageStats(file);
    }
    assert.ok(stats, "warmed eventually");
    assert.equal(stats!.toolCalls, 1);
    assert.equal(stats!.assistantMessages, 0);
  });
});

describe("bridge API surfaces usage additively", () => {
  test("GET /state, /sub-log and /main-log carry usage fields; legacy fields intact", async () => {
    const dir = await mkdtemp(join(tmpdir(), "wbapi-"));
    await mkdir(join(dir, "sa7"));
    await writeFile(join(dir, "sa7", "events.jsonl"), TASK + BASH1 + MSG_A);
    await writeFile(join(dir, "sa7", "result.md"), "Done.");
    const session = join(dir, "session.jsonl");
    await writeFile(session, evLine({ type: "message", message: { role: "assistant", content: [{ type: "text", text: "hi" }], timestamp: 1790000000000, usage: { input: 5, output: 1, cacheRead: 0, cacheWrite: 0, reasoning: 0, totalTokens: 6, cost: { total: 0 } } } }));

    const server = createBridgeServer({
      project: "UsageProj",
      inject: () => true,
      sessionFile: () => session,
      subagentsDir: () => dir,
      indexHtml: () => "<html><body>x</body></html>",
      log: () => {},
    });
    await new Promise<void>((res) => server.listen(0, "127.0.0.1", res));
    const base = `http://127.0.0.1:${(server.address() as { port: number }).port}`;
    try {
      const state = await (await fetch(`${base}/state`)).json();
      const view = state.subagents.find((s: { id: string }) => s.id === "sa7");
      assert.equal(view.usage.totalTokens, 130);
      assert.equal(view.usage.toolCalls, 1);
      assert.ok("label" in view && "status" in view && "lastActivity" in view, "legacy view fields intact");

      const subSnap = await (await fetch(`${base}/sub-log?id=sa7`)).json();
      assert.equal(subSnap.stats.tokens.total, 130);
      assert.deepEqual(Object.keys(subSnap).sort(), ["cursor", "done", "id", "lines", "reset", "result", "stats"]);

      const mainSnap = await (await fetch(`${base}/main-log`)).json();
      assert.equal(mainSnap.stats.tokens.total, 6);
      assert.ok(Array.isArray(mainSnap.items) && Array.isArray(mainSnap.stats.tools));
    } finally {
      server.closeBridge();
    }
  });
});
