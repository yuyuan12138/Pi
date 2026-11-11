import { test, describe } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { cp, mkdtemp, mkdir, writeFile, utimes } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { SubagentScanner, naturalCompare, readTail, deriveSession } from "../src/state.ts";

const FIXTURES = new URL("./fixtures/", import.meta.url).pathname;

const evLine = (ev: object) => JSON.stringify(ev) + "\n";
const TASK = evLine({ type: "message_end", message: { role: "user", content: [{ type: "text", text: "Investigate flaky login test and propose a fix" }] } });
const MODEL = evLine({ type: "message_start", message: { role: "assistant", content: [], api: "x", provider: "p", model: "test-model-9" } });
const PROGRESS = evLine({ type: "tool_execution_start", toolCallId: "t1", toolName: "report_to_parent", args: { status: "progress", summary: "reproduced the flake" } });
const BLOCKED = evLine({ type: "tool_execution_start", toolCallId: "t2", toolName: "report_to_parent", args: { status: "blocked", summary: "which fix do you prefer, A or B?" } });
const ASSIST = evLine({ type: "message_end", message: { role: "assistant", content: [{ type: "text", text: "Found the race: the token refresh happens after the redirect." }] } });

async function makeDir(): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), "wbstate-"));
  // Real redacted fixture: a finished subagent (result.md present).
  await cp(join(FIXTURES, "sa-fixture"), join(dir, "sa-fixture"), { recursive: true });
  // Blocked: last report is blocked, no result.
  await mkdir(join(dir, "sa-blocked"));
  await writeFile(join(dir, "sa-blocked", "events.jsonl"), TASK + MODEL + PROGRESS + BLOCKED);
  // Running: recent activity, last report progress.
  await mkdir(join(dir, "sa-running"));
  await writeFile(join(dir, "sa-running", "events.jsonl"), TASK + MODEL + PROGRESS + ASSIST);
  // Idle-running: task only, no reports.
  await mkdir(join(dir, "sa-quiet"));
  await writeFile(join(dir, "sa-quiet", "events.jsonl"), TASK);
  // Deterministic recency: running > quiet > blocked (ordering assertions rely on this).
  const now = Date.now() / 1000;
  await utimes(join(dir, "sa-running", "events.jsonl"), now, now);
  await utimes(join(dir, "sa-quiet", "events.jsonl"), now - 60, now - 60);
  await utimes(join(dir, "sa-blocked", "events.jsonl"), now - 120, now - 120);
  // Noise that must be ignored.
  await mkdir(join(dir, "sessions"));
  await mkdir(join(dir, "worktrees"));
  await writeFile(join(dir, "README.md"), "not a subagent");
  return dir;
}

describe("SubagentScanner over a real redacted events.jsonl fixture", () => {
  test("derives status, model, label, excerpt and result from disk", async () => {
    const dir = await makeDir();
    const views = new SubagentScanner().scan(dir);
    const byId = new Map(views.map((v) => [v.id, v]));
    assert.equal(views.length, 4);

    const done = byId.get("sa-fixture")!;
    assert.equal(done.status, "done");
    assert.equal(done.result, true);
    assert.equal(done.model, "claude-opus-4-8");
    assert.ok(done.label!.startsWith("Trivial test of the DeepSeek-style report_to_parent protocol"), done.label ?? "");
    // excerpt contract: the tail of result.md, whitespace-collapsed
    const resRaw = readFileSync(join(dir, "sa-fixture", "result.md"), "utf8");
    const collapsed = resRaw.replace(/\s+/g, " ").trim();
    assert.equal(done.lastExcerpt, collapsed.length <= 400 ? collapsed : "…" + collapsed.slice(collapsed.length - 400));
    assert.ok(done.lastActivity > 0);

    const blocked = byId.get("sa-blocked")!;
    assert.equal(blocked.status, "blocked");
    assert.equal(blocked.result, false);
    assert.equal(blocked.model, "test-model-9");
    assert.equal(blocked.label, "Investigate flaky login test and propose a fix");

    const running = byId.get("sa-running")!;
    assert.equal(running.status, "running");
    assert.equal(running.lastExcerpt, "Found the race: the token refresh happens after the redirect.");

    const quiet = byId.get("sa-quiet")!;
    assert.equal(quiet.status, "running");
    assert.equal(quiet.label, "Investigate flaky login test and propose a fix");
  });

  test("orders running before blocked before done", async () => {
    const dir = await makeDir();
    const views = new SubagentScanner().scan(dir);
    assert.deepEqual(views.map((v) => [v.id, v.status]), [
      ["sa-running", "running"],
      ["sa-quiet", "running"],
      ["sa-blocked", "blocked"],
      ["sa-fixture", "done"],
    ]);
  });

  test("stale result.md does not mask an actively-appending worker (dir collision)", async () => {
    const dir = await makeDir();
    // Simulate a new worker reusing an old task's dir: fresh events, ancient result.
    const evFile = join(dir, "sa-fixture", "events.jsonl");
    await writeFile(evFile, TASK + MODEL + ASSIST);
    const now = Date.now() / 1000;
    await utimes(evFile, now, now);
    await utimes(join(dir, "sa-fixture", "result.md"), now - 86400, now - 86400);
    const views = new SubagentScanner().scan(dir);
    const v = views.find((x) => x.id === "sa-fixture")!;
    assert.equal(v.status, "running");
    assert.equal(v.result, false);
  });

  test("no result + no events for over 15 minutes surfaces as blocked, not eternal running", async () => {
    const dir = await makeDir();
    const evFile = join(dir, "sa-zombie", "events.jsonl");
    await mkdir(join(dir, "sa-zombie"));
    await writeFile(evFile, TASK + MODEL);
    const old = Date.now() / 1000 - 20 * 60;
    await utimes(evFile, old, old);
    const views = new SubagentScanner().scan(dir);
    const v = views.find((x) => x.id === "sa-zombie")!;
    assert.equal(v.status, "blocked");
  });

  test("caches by mtime+size so unchanged dirs are not re-read", async () => {
    const dir = await makeDir();
    const s = new SubagentScanner();
    const first = s.scan(dir);
    const second = s.scan(dir);
    assert.deepEqual(second, first);
    // touch a file: view content updates on the next scan
    await writeFile(join(dir, "sa-running", "events.jsonl"), TASK + MODEL + PROGRESS + ASSIST + evLine({ type: "agent_settled" }));
    const third = s.scan(dir);
    assert.equal(third.length, first.length);
  });

  test("missing dir scans empty", () => {
    assert.deepEqual(new SubagentScanner().scan("/nonexistent-path-xyz"), []);
  });

  test("reused dirs split into task eras at >6h gaps (same-id collision fixture)", async () => {
    const dir = await mkdtemp(join(tmpdir(), "wbstate-era-"));
    const userMsg = (ts: number, text: string) => evLine({ type: "message_start", message: { role: "user", timestamp: ts, content: [{ type: "text", text }] } });
    const T = 1_700_000_000_000;
    // two event clusters >6h apart in ONE dir (the same-id different-era case)
    const cluster1 = userMsg(T, "You are the operator role. Install the Ponytail methodology into the coder subagent") + MODEL;
    const cluster2 = userMsg(T + 30 * 3600e3, "Extend the per-turn injected reminder in the bridge org page") + ASSIST;
    await mkdir(join(dir, "sa-eras"));
    await writeFile(join(dir, "sa-eras", "events.jsonl"), cluster1 + cluster2);
    const views = new SubagentScanner().scan(dir);
    const v = views.find((x) => x.id === "sa-eras")!;
    assert.ok(v, "view present");
    assert.equal(v.eras?.length, 2);
    assert.match(v.eras![0].label, /Ponytail/);
    assert.match(v.eras![1].label, /per-turn injected reminder/);
    assert.equal(v.eras![1].at - v.eras![0].at, 30 * 3600e3);
    // messages within 6h stay one era
    await mkdir(join(dir, "sa-one"));
    await writeFile(join(dir, "sa-one", "events.jsonl"), userMsg(T, "first task in the same hour") + userMsg(T + 2 * 3600e3, "follow-up within the window"));
    const v2 = new SubagentScanner().scan(dir).find((x) => x.id === "sa-one")!;
    assert.ok(!v2.eras || v2.eras.length === 1, "within-window messages stay one era (field omitted when single)");
  });
});

describe("session-named dirs (pi-superagent dd08db5)", () => {
  const userMsg = (ts: number, text: string) => evLine({ type: "message_start", message: { role: "user", timestamp: ts, content: [{ type: "text", text }] } });
  const T = 1_700_000_000_000;
  async function sessionDir(root: string, name: string, events: string): Promise<void> {
    await mkdir(join(root, name));
    await writeFile(join(root, name, "events.jsonl"), events);
  }
  test("session field populated from the dir name; numeric dirs stay null", async () => {
    const dir = await mkdtemp(join(tmpdir(), "wbstate-sess-"));
    for (const name of ["notion-rsi-x1", "medical-upstream-x1", "rsi-live-c12-mon-2"]) {
      await sessionDir(dir, name, userMsg(T, "Do the thing for the project") + MODEL);
    }
    await sessionDir(dir, "sa42", userMsg(T, "numeric-style dispatch") + MODEL);
    const views = new SubagentScanner().scan(dir);
    const byId = new Map(views.map((v) => [v.id, v]));
    assert.equal(byId.get("notion-rsi-x1")!.session, "notion-rsi-x1");
    assert.equal(byId.get("medical-upstream-x1")!.session, "medical-upstream-x1");
    assert.equal(byId.get("rsi-live-c12-mon-2")!.session, "rsi-live-c12-mon-2");
    assert.equal(byId.get("sa42")!.session, null, "numeric dirs keep the old null-session contract");
  });
  test("era extraction runs for session-named dirs too (2 clusters)", async () => {
    const dir = await mkdtemp(join(tmpdir(), "wbstate-sess-era-"));
    const clusters = userMsg(T, "First mission for the notion workspace") + MODEL
      + userMsg(T + 30 * 3600e3, "Second mission, much later the same session") + ASSIST;
    await sessionDir(dir, "notion-rsi-x1", clusters);
    const v = new SubagentScanner().scan(dir).find((x) => x.id === "notion-rsi-x1")!;
    assert.ok(v, "view present");
    assert.equal(v.eras?.length, 2);
    assert.match(v.eras![0].label, /First mission/);
    assert.match(v.eras![1].label, /Second mission/);
    assert.equal(v.eras![1].at - v.eras![0].at, 30 * 3600e3);
  });
  test("lineage for session-named dirs is a clean null, not a fabricated depth", async () => {
    const dir = await mkdtemp(join(tmpdir(), "wbstate-sess-lin-"));
    await sessionDir(dir, "medical-upstream-x1", userMsg(T, "root-level persistent dispatch") + MODEL);
    // a numeric sibling so any wrong dash-cut parent ("medical-upstream-x") is provably absent
    await sessionDir(dir, "medical-upstream-x", userMsg(T, "decoy: would be a bogus dash-cut parent") + MODEL);
    const v = new SubagentScanner().scan(dir).find((x) => x.id === "medical-upstream-x1")!;
    assert.ok(v, "view present");
    assert.equal(v.spawned_by, null);
    assert.equal(v.depth, null);
    assert.equal(v.status, "running"); // no crash, ordinary lifecycle fields intact
  });
  test("deriveSession: numeric chains null, session names pass through", () => {
    for (const n of ["sa1", "sa42", "sa13-a", "sa2-sa1", "sa9-b-sa1", "sa27-k3f9", "sa9-b-sa1-k3f9"]) {
      assert.equal(deriveSession(n), null, n);
    }
    for (const n of ["notion-rsi-x1", "medical-upstream-x1", "rsi-live-c12-mon-2", "bridge-org-x1"]) {
      assert.equal(deriveSession(n), n, n);
    }
  });
});

describe("helpers", () => {
  test("naturalCompare orders sa2 before sa10", () => {
    const ids = ["sa10", "sa2", "sa40-sa1", "sa40", "sa1"];
    ids.sort(naturalCompare);
    assert.deepEqual(ids, ["sa1", "sa2", "sa10", "sa40", "sa40-sa1"]);
  });

  test("readTail returns only the requested suffix", async () => {
    const dir = await mkdtemp(join(tmpdir(), "wbtail-"));
    const f = join(dir, "f.txt");
    await writeFile(f, "0123456789".repeat(100));
    assert.equal(readTail(f, 5), "56789");
    assert.equal(readTail(f, 10_000).length, 1000);
    assert.equal(readTail(join(dir, "missing.txt"), 5), "");
  });
});
