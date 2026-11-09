import { test, describe, before, after } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, mkdir, writeFile, cp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createBridgeServer } from "../src/server.ts";

const FIXTURES = new URL("./fixtures/", import.meta.url).pathname;

/** Minimal synthetic events.jsonl, in the exact shape pi-superagent writes. */
function evLine(ev: object): string { return JSON.stringify(ev) + "\n"; }
const TASK = evLine({ type: "message_end", message: { role: "user", content: [{ type: "text", text: "Synthetic task for the UI test window" }] } });
const PROGRESS = evLine({ type: "tool_execution_start", toolCallId: "t1", toolName: "report_to_parent", args: { status: "progress", summary: "started working" } });
const BLOCKED = evLine({ type: "tool_execution_start", toolCallId: "t2", toolName: "report_to_parent", args: { status: "blocked", summary: "need an answer to continue" } });
const ASSIST = evLine({ type: "message_end", message: { role: "assistant", content: [{ type: "text", text: "intermediate assistant text" }] } });
const MODEL = evLine({ type: "message_start", message: { role: "assistant", content: [], api: "x", provider: "p", model: "test-model-1" } });

async function makeSubagentsDir(): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), "wbridge-"));
  // done subagent: copy of the real redacted sa1 fixture
  await cp(join(FIXTURES, "sa-fixture"), join(dir, "sa-fixture"), { recursive: true });
  // blocked subagent: reports blocked, no result.md
  await mkdir(join(dir, "sa-blocked"));
  await writeFile(join(dir, "sa-blocked", "events.jsonl"), TASK + MODEL + PROGRESS + ASSIST + BLOCKED);
  // running subagent: mid-work, no result.md, last report is progress
  await mkdir(join(dir, "sa-running"));
  await writeFile(join(dir, "sa-running", "events.jsonl"), TASK + MODEL + PROGRESS + ASSIST);
  return dir;
}

describe("POST /message routing against a live bridge server", () => {
  let subDir: string;
  let server: ReturnType<typeof createBridgeServer>;
  let url: string;
  const injected: string[] = [];
  let failInject = false;

  before(async () => {
    subDir = await makeSubagentsDir();
    server = createBridgeServer({
      project: "TestProj",
      inject: (t) => { if (failInject) return false; injected.push(t); return true; },
      sessionFile: () => undefined,
      subagentsDir: () => subDir,
      indexHtml: () => "<html><body>test</body></html>",
      log: () => {},
    });
    await new Promise<void>((res) => server.listen(0, "127.0.0.1", res));
    const { port } = server.address() as { port: number };
    url = `http://127.0.0.1:${port}`;
  });
  after(() => server.closeBridge());

  const post = (body: unknown) => fetch(`${url}/message`, {
    method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body),
  });

  test("main target reaches the mocked pi injection emitter with the exact header", async () => {
    const r = await post({ target: "main", text: "hello coordinator" });
    assert.equal(r.status, 200);
    const body = (await r.json()) as any;
    assert.deepEqual(body, { ok: true, routed: "main" });
    assert.equal(injected.at(-1), "[web-chat · project:TestProj] hello coordinator");
  });

  test("subagent target routes through main with the for-subagent fallback header", async () => {
    const r = await post({ target: "subagent:sa-blocked", text: "the answer is 42" });
    assert.equal(r.status, 200);
    const body = (await r.json()) as any;
    assert.deepEqual(body, { ok: true, routed: "main-for-subagent", id: "sa-blocked" });
    assert.equal(injected.at(-1), "[web-chat · for-subagent:sa-blocked] the answer is 42");
  });

  test("unknown subagent id is a 404 and injects nothing", async () => {
    const n = injected.length;
    const r = await post({ target: "subagent:sa-nope", text: "x" });
    assert.equal(r.status, 404);
    assert.equal(injected.length, n);
  });

  test("validation errors are 400 and inject nothing", async () => {
    const n = injected.length;
    for (const bad of [{ target: "main" }, { text: "x" }, { target: "evil", text: "x" }, { target: "subagent:", text: "x" }]) {
      const r = await post(bad);
      assert.equal(r.status, 400, JSON.stringify(bad));
    }
    const raw = await fetch(`${url}/message`, { method: "POST", headers: { "Content-Type": "application/json" }, body: "{not json" });
    assert.equal(raw.status, 400);
    assert.equal(injected.length, n);
  });

  test("a refused injection surfaces as 503", async () => {
    failInject = true;
    const r = await post({ target: "main", text: "will fail" });
    assert.equal(r.status, 503);
    failInject = false;
  });

  test("GET /state reports project, main and subagents with statuses from disk", async () => {
    const r = await fetch(`${url}/state`);
    assert.equal(r.status, 200);
    const body = (await r.json()) as any;
    assert.equal(body.project, "TestProj");
    assert.equal(body.main.alive, true);
    assert.equal(body.main.sessionFile, null);
    const byId = new Map<string, any>(body.subagents.map((s: any) => [s.id, s]));
    assert.equal(byId.get("sa-fixture").status, "done");
    assert.equal(byId.get("sa-fixture").result, true);
    assert.equal(byId.get("sa-fixture").model, "claude-opus-4-8");
    assert.ok(byId.get("sa-fixture").label.includes("DeepSeek-style report_to_parent"));
    assert.ok(byId.get("sa-fixture").lastExcerpt.length > 0);
    assert.equal(byId.get("sa-blocked").status, "blocked");
    assert.equal(byId.get("sa-blocked").model, "test-model-1");
    assert.equal(byId.get("sa-blocked").lastExcerpt, "intermediate assistant text");
    assert.equal(byId.get("sa-running").status, "running");
    // running first, blocked next, done last
    const order = body.subagents.map((s: any) => s.id);
    assert.deepEqual(order, ["sa-running", "sa-blocked", "sa-fixture"]);
  });

  test("GET /sub-log serves parsed events and result.md for the fixture", async () => {
    const r = await fetch(`${url}/sub-log?id=sa-fixture`);
    const body = (await r.json()) as any;
    assert.equal(body.done, true);
    assert.ok(body.result.includes("Protocol test complete"));
    assert.ok(body.lines.some((l: any) => l.kind === "report" && l.name === "progress"));
    assert.ok(body.lines.some((l: any) => l.kind === "report" && l.name === "ready"));
    assert.ok(body.lines.some((l: any) => l.kind === "event" && l.name === "task"));
    assert.ok(body.lines.some((l: any) => l.kind === "tool"));
    const cursor = body.cursor;
    const r2 = await fetch(`${url}/sub-log?id=sa-fixture&after=${cursor}`);
    const b2 = (await r2.json()) as any;
    assert.equal(b2.reset, false);
    assert.equal(b2.lines.length, 0);
  });

  test("GET /main-log returns a reset snapshot on first poll", async () => {
    const r = await fetch(`${url}/main-log`);
    const body = (await r.json()) as any;
    assert.equal(body.reset, true);
    assert.deepEqual(body.items, []);
  });

  test("POST /message end-to-end: the mocked emitter received exactly one message per POST", async () => {
    assert.equal(injected.length, 2);
  });

});
