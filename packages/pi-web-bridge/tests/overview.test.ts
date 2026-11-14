import { test, describe } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { mkdtemp, mkdir, writeFile, utimes, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { createBridgeServer, type BridgeServer } from "../src/server.ts";

const here = fileURLToPath(new URL(".", import.meta.url));
const overviewSrc = readFileSync(join(here, "..", "src", "overview.html"), "utf8");

function listen(server: BridgeServer): Promise<number> {
  return new Promise((resolve) => {
    server.listen(0, "127.0.0.1", () => resolve((server.address() as { port: number }).port));
  });
}

describe("overview page source (src/overview.html)", () => {
  test("composes ONLY the whitelisted GET endpoints (relative, sub-path safe)", () => {
    const fetches = [...overviewSrc.matchAll(/api\(\s*["'`]([a-z][a-z/-]*)/g)].map((m) => m[1]);
    assert.ok(fetches.length >= 8, "expected the composed endpoints");
    assert.deepEqual([...new Set(fetches)].sort(),
      ["main-log", "overview/budget", "overview/guard", "overview/memory", "overview/system", "projects", "state", "stream"]);
    // no absolute-path fetches and no other host paths: hard-refresh deploy
    // must hit exactly the endpoints server.ts already serves
    assert.ok(!/api\(["'`]\//.test(overviewSrc), "fetch paths must stay relative");
    assert.ok(!/fetch\(["'`]\//.test(overviewSrc), "no direct absolute fetch calls");
  });

  test("escape-first rendering: no innerHTML/outerHTML/document.write anywhere", () => {
    for (const bad of ["innerHTML", "outerHTML", "document.write", "insertAdjacentHTML"]) {
      assert.ok(!overviewSrc.includes(bad), `untrusted task text must never pass through ${bad}`);
    }
    assert.ok(overviewSrc.includes("textContent"), "DOM text goes through textContent");
  });

  test("all required sections + auto-refresh + visible stamp are present", () => {
    for (const id of ["status-cluster", "now-box", "tl-box", "act-box", "mem-box", "guard-box", "bud-box", "proj-box", "sys-box", "inflight"]) {
      assert.ok(overviewSrc.includes(`id="${id}"`), `missing section #${id}`);
    }
    // auto-refresh cadence: live surfaces 3-10s, deep panels 10-30s
    assert.ok(overviewSrc.includes("setInterval(pollState, 5000)"), "state 5s");
    assert.ok(overviewSrc.includes("setInterval(pollStream, 3000)"), "stream 3s");
    assert.ok(overviewSrc.includes("setInterval(pollProjects, 10000)"), "projects 10s");
    assert.ok(overviewSrc.includes("setInterval(pollMain, 10000)"), "main-log stats 10s");
    assert.ok(overviewSrc.includes("setInterval(pollGuard, 10000)"), "guard 10s");
    assert.ok(overviewSrc.includes("setInterval(pollMemory, 30000)"), "memory 30s");
    assert.ok(overviewSrc.includes("setInterval(pollBudget, 30000)"), "budget 30s");
    assert.ok(overviewSrc.includes("setInterval(pollSystem, 30000)"), "system 30s");
    assert.ok(overviewSrc.includes('id="updated"'), "visible last-updated stamp");
    assert.ok(overviewSrc.includes("visibilitychange"), "mobile resume on tab visible");
  });

  test("status strip covers bridge, model, stream, uptime, session", () => {
    for (const id of ["st-bridge", "st-model", "st-stream", "st-up", "st-sess"]) {
      assert.ok(overviewSrc.includes(`id="${id}"`), `missing status cell #${id}`);
    }
    assert.ok(overviewSrc.includes("parseSessionStart"), "uptime from the session-file path stamp");
    assert.ok(overviewSrc.includes("stats"), "model sourced from /main-log stats");
  });

  test("subagent status contract: only running/blocked are live workers", () => {
    assert.ok(overviewSrc.includes('s.status === "running" || s.status === "blocked"'),
      "NOW cards = non-settled subagents (running/blocked), done stays out");
    assert.ok(overviewSrc.includes("projectOf"), "project attribution function present");
    assert.ok(overviewSrc.includes("unattributed"), "honest unattributed bucket");
  });

  test("org view links to the existing org-graph page (never duplicates it)", () => {
    assert.ok(overviewSrc.includes('href="index.html#/org"'), "org link present");
    assert.ok(!overviewSrc.includes("renderOrg"), "org rendering is NOT duplicated");
  });

  test("panel fail-open: degraded payloads render honest notes, never blank lies", () => {
    assert.ok(overviewSrc.includes("panelNote"), "shared degrade helper");
    assert.ok(overviewSrc.includes("payload.ok === false"), "ok:false detection");
    assert.ok(overviewSrc.includes("renderTimeline"), "timeline renderer present");
  });
});

describe("GET /overview route", () => {
  test("serves the wired page at /overview and /overview.html as html", async () => {
    const server = createBridgeServer({
      project: "demo",
      inject: () => true,
      sessionFile: () => undefined,
      subagentsDir: () => "/nonexistent",
      indexHtml: () => "<html></html>",
      overviewHtml: () => overviewSrc,
    });
    const port = await listen(server);
    server.unref();
    try {
      for (const path of ["/overview", "/overview.html"]) {
        const r = await fetch(`http://127.0.0.1:${port}${path}`);
        assert.equal(r.status, 200, path);
        assert.match(r.headers.get("content-type") ?? "", /^text\/html/);
        assert.match(r.headers.get("cache-control") ?? "", /no-store/);
        const body = await r.text();
        assert.ok(body.startsWith("<!doctype html>"));
        assert.ok(body.includes("Overview"), path);
      }
      // unknown sibling still 404s (one route, not a static file server)
      const miss = await fetch(`http://127.0.0.1:${port}/anything-else.html`);
      assert.equal(miss.status, 404);
    } finally {
      server.close();
    }
  });

  test("absent dep -> 404 (route is additive and opt-in)", async () => {
    const bare = createBridgeServer({
      project: "demo",
      inject: () => true,
      sessionFile: () => undefined,
      subagentsDir: () => "/nonexistent",
      indexHtml: () => "<html></html>",
    });
    const port = await listen(bare);
    bare.unref();
    try {
      const r = await fetch(`http://127.0.0.1:${port}/overview`);
      assert.equal(r.status, 404);
      assert.deepEqual(await r.json(), { ok: false, error: "not found" });
    } finally {
      bare.close();
    }
  });

  test("deep panels: wired -> snapshot; unwired -> ok:false note; throwing reader -> catch-all, never 500", async () => {
    const server = createBridgeServer({
      project: "demo",
      inject: () => true,
      sessionFile: () => undefined,
      subagentsDir: () => "/nonexistent",
      indexHtml: () => "<html></html>",
      overviewMemory: () => ({ ok: true, generatedAt: "t", atoms: { total: 5 } }),
      overviewGuard: () => { throw new Error("boom"); },
      overviewBudget: () => ({ ok: true, generatedAt: "t", d7: null, d30: null, campaign: null }),
    });
    const port = await listen(server);
    server.unref();
    try {
      const mem = await (await fetch(`http://127.0.0.1:${port}/overview/memory`)).json();
      assert.equal(mem.ok, true);
      assert.equal(mem.atoms.total, 5);
      // throwing reader -> the /projects catch-all pattern: 200 + ok:false note
      const guardRes = await fetch(`http://127.0.0.1:${port}/overview/guard`);
      assert.equal(guardRes.status, 200);
      const guard = await guardRes.json();
      assert.equal(guard.ok, false);
      assert.match(guard.note ?? "", /boom/);
      const bud = await (await fetch(`http://127.0.0.1:${port}/overview/budget`)).json();
      assert.equal(bud.ok, true);
      // unwired system -> honest note (200, never a lie)
      const sys = await (await fetch(`http://127.0.0.1:${port}/overview/system`)).json();
      assert.equal(sys.ok, false);
      assert.match(sys.note ?? "", /not wired/);
    } finally {
      server.close();
    }
  });

  test("serves the REAL src/overview.html over a fixture subagent dir end-to-end", async () => {
    // A running + a blocked worker (same shape as tests/state.test.ts fixtures)
    // so a browser probe against this server sees live cards, not empty states.
    const dir = await mkdtemp(join(tmpdir(), "wboverview-"));
    const evLine = (ev: object) => JSON.stringify(ev) + "\n";
    const task = evLine({ type: "message_end", message: { role: "user", content: [{ type: "text", text: "[project:piagents] Overview page acceptance probe" }] } });
    const model = evLine({ type: "message_start", message: { role: "assistant", content: [], model: "test-model-ov" } });
    const blocked = evLine({ type: "tool_execution_start", toolCallId: "t2", toolName: "report_to_parent", args: { status: "blocked", summary: "need a decision" } });
    const running = evLine({ type: "message_end", message: { role: "assistant", content: [{ type: "text", text: "Working on the overview acceptance probe." }] } });
    await mkdir(join(dir, "sa-ov-running"));
    await writeFile(join(dir, "sa-ov-running", "events.jsonl"), task + model + running);
    await mkdir(join(dir, "sa-ov-blocked"));
    await writeFile(join(dir, "sa-ov-blocked", "events.jsonl"), task + model + blocked);
    const now = Date.now() / 1000;
    await utimes(join(dir, "sa-ov-running", "events.jsonl"), now, now);
    await utimes(join(dir, "sa-ov-blocked", "events.jsonl"), now - 30, now - 30);

    const server = createBridgeServer({
      project: "PiAgents",
      inject: () => true,
      sessionFile: () => "/tmp/demo-sessions/2026-11-14T08-30-00-000Z_probe.jsonl",
      subagentsDir: () => dir,
      indexHtml: () => "<html></html>",
      overviewHtml: () => readFileSync(join(here, "..", "src", "overview.html"), "utf8"),
    });
    const port = await listen(server);
    server.unref();
    try {
      const page = await (await fetch(`http://127.0.0.1:${port}/overview`)).text();
      assert.ok(page.startsWith("<!doctype html>"));
      // the page is the real deliverable, not a stub
      assert.ok(page.includes("Recent activity"));
      assert.ok(page.includes("Projects"));
      const state = await (await fetch(`http://127.0.0.1:${port}/state`)).json();
      assert.equal(state.subagents.length, 2);
      const statuses = Object.fromEntries(state.subagents.map((s: { id: string; status: string }) => [s.id, s.status]));
      assert.equal(statuses["sa-ov-running"], "running");
      assert.equal(statuses["sa-ov-blocked"], "blocked");
      // the probe label carries an explicit [project:piagents] tag: the page's
      // attribution chain must resolve it to the registry id "piagents"
      const tagRule = /\[project:([^\]]+)\]/i;
      assert.match(String(state.subagents[0].label), tagRule);
    } finally {
      server.closeBridge();
      await rm(dir, { recursive: true, force: true });
    }
  });
});
