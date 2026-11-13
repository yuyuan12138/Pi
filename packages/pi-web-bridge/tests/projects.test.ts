import { test, describe, before, after } from "node:test";
import assert from "node:assert/strict";
import http from "node:http";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { createBridgeServer } from "../src/server.ts";
import {
  parseRegistry,
  envelopeProjectId,
  parseEnvelopeMeta,
  projectActivityFromJournal,
  projectBudgetsFromJournal,
  readCoordinatorProjects,
  type JournalRowLike,
} from "../src/projects.ts";

// ---------- fixture helpers: a coordinator.db with the real schema ----------

const SCHEMA = `
CREATE TABLE registry(id INTEGER PRIMARY KEY CHECK(id = 1), json TEXT NOT NULL);
CREATE TABLE journal(
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  at TEXT NOT NULL,
  task_id TEXT NOT NULL,
  phase TEXT NOT NULL,
  detail TEXT,
  stage TEXT,
  dedupe_sha TEXT
);
`;

const REGISTRY = JSON.stringify({
  schemaVersion: 1,
  projects: [
    { id: "alpha", displayName: "Alpha platform", aliases: ["a", "阿尔法"], root: "/tmp/alpha", sessionId: "alpha-primary", status: "registered", registeredAt: "2026-11-01T00:00:00.000Z" },
    { id: "beta", displayName: "Beta", aliases: [], root: "/tmp/beta", sessionId: "beta-primary", status: "registered", registeredAt: "2026-11-02T00:00:00.000Z" },
    { id: "gamma", displayName: "Gamma", aliases: [], root: "/tmp/gamma", sessionId: "gamma-primary", status: "registered", registeredAt: "2026-11-03T00:00:00.000Z" },
  ],
});

function envelope(taskId: string, projectId: string, extra: Record<string, unknown> = {}): string {
  return JSON.stringify({ taskId, projectId, dedupeKey: "k", sourceMessageId: "m", ...extra });
}

/** Insert one journal row; returns its rowid (newest = highest). */
function addJournal(db: DatabaseSync, at: string, taskId: string, phase: string, detail: string | null, stage: string | null): void {
  db.prepare("INSERT INTO journal(at, task_id, phase, detail, stage) VALUES (?, ?, ?, ?, ?)").run(at, taskId, phase, detail, stage);
}

/** A fixture DB: 3 registered projects; alpha has one settled task, beta a newer in-review task, gamma no journal rows. */
function makeDb(dir: string, name = "coordinator.db"): string {
  const p = join(dir, name);
  const db = new DatabaseSync(p);
  db.exec(SCHEMA);
  db.prepare("INSERT INTO registry(id, json) VALUES (1, ?)").run(REGISTRY);
  // alpha: received -> queued -> started -> settled
  addJournal(db, "2026-11-05T10:00:00.000Z", "task-a1", "received", envelope("task-a1", "alpha"), null);
  addJournal(db, "2026-11-05T10:00:00.000Z", "task-a1", "queued", null, "queued");
  addJournal(db, "2026-11-05T10:00:01.000Z", "task-a1", "started", null, "working");
  addJournal(db, "2026-11-05T10:00:10.000Z", "task-a1", "settled", "completed-unverified: prompt settled", null);
  // beta: a NEWER task still sitting in person/review
  addJournal(db, "2026-11-06T09:00:00.000Z", "task-b1", "received", envelope("task-b1", "beta"), null);
  addJournal(db, "2026-11-06T09:00:00.000Z", "task-b1", "started", null, "working");
  addJournal(db, "2026-11-06T09:00:30.000Z", "task-b1", "settled", "completed-unverified: prompt settled", "person/review");
  db.close();
  return p;
}

function row(overrides: Partial<JournalRowLike> & { taskId: string; phase: string }): JournalRowLike {
  return { stage: null, at: "2026-11-06T00:00:00.000Z", detail: null, ...overrides };
}

// ---------- registry parse ----------

describe("parseRegistry", () => {
  test("maps valid registry JSON, keeping aliases but dropping sessionId", () => {
    const projects = parseRegistry(REGISTRY);
    assert.equal(projects.length, 3);
    assert.deepEqual(projects[0], { id: "alpha", displayName: "Alpha platform", root: "/tmp/alpha", aliases: ["a", "阿尔法"], subprojects: [], status: "registered", registeredAt: "2026-11-01T00:00:00.000Z" });
  });

  test("defaults displayName to id and coerces missing fields to null", () => {
    const projects = parseRegistry(JSON.stringify({ projects: [{ id: "solo" }] }));
    assert.deepEqual(projects, [{ id: "solo", displayName: "solo", root: "", aliases: [], subprojects: [], status: null, registeredAt: null }]);
  });

  test("skips malformed entries but keeps valid ones", () => {
    const projects = parseRegistry(JSON.stringify({ projects: [null, 7, {}, { id: "" }, { id: "ok", root: "/ok" }] }));
    assert.deepEqual(projects.map((p) => p.id), ["ok"]);
    assert.equal(projects[0].root, "/ok");
  });

  test("garbage input degrades to an empty list", () => {
    assert.deepEqual(parseRegistry("not json {"), []);
    assert.deepEqual(parseRegistry(JSON.stringify({ nope: 1 })), []);
    assert.deepEqual(parseRegistry(JSON.stringify({ projects: "many" })), []);
    assert.deepEqual(parseRegistry(null), []);
    assert.deepEqual(parseRegistry(undefined), []);
    assert.deepEqual(parseRegistry(42), []);
  });
});

// ---------- journal envelope -> project mapping ----------

describe("envelopeProjectId", () => {
  test("extracts projectId from a received-phase envelope", () => {
    assert.equal(envelopeProjectId(envelope("task-1", "alpha")), "alpha");
  });
  test("non-envelope detail degrades to null", () => {
    assert.equal(envelopeProjectId("completed-unverified: prompt settled for task-1"), null);
    assert.equal(envelopeProjectId("{}"), null);
    assert.equal(envelopeProjectId(JSON.stringify({ projectId: 7 })), null);
    assert.equal(envelopeProjectId(JSON.stringify({ projectId: "" })), null);
    assert.equal(envelopeProjectId("{broken"), null);
    assert.equal(envelopeProjectId(null), null);
    assert.equal(envelopeProjectId(undefined), null);
  });
});

describe("projectActivityFromJournal (journal-derived lastActivity mapping)", () => {
  test("newest row per project wins; stage is preferred over phase", () => {
    // NEWEST-FIRST order, exactly as the DESC SQL query returns rows.
    const rows = [
      row({ taskId: "task-b1", phase: "settled", at: "2026-11-06T09:00:30.000Z", stage: "person/review", detail: "completed-unverified" }),
      row({ taskId: "task-b1", phase: "started", at: "2026-11-06T09:00:00.000Z", stage: "working" }),
      row({ taskId: "task-b1", phase: "received", at: "2026-11-06T09:00:00.000Z", detail: envelope("task-b1", "beta") }),
      row({ taskId: "task-a1", phase: "settled", at: "2026-11-05T10:00:10.000Z" }),
      row({ taskId: "task-a1", phase: "started", at: "2026-11-05T10:00:01.000Z", stage: "working" }),
      row({ taskId: "task-a1", phase: "received", at: "2026-11-05T10:00:00.000Z", detail: envelope("task-a1", "alpha") }),
    ];
    const map = projectActivityFromJournal(rows);
    assert.equal(map.size, 2);
    assert.deepEqual(map.get("beta"), { lastActivity: "2026-11-06T09:00:30.000Z", lastJournalStatus: "person/review" });
    assert.deepEqual(map.get("alpha"), { lastActivity: "2026-11-05T10:00:10.000Z", lastJournalStatus: "settled" });
  });

  test("rows fall back to phase when stage is absent", () => {
    const rows = [
      row({ taskId: "t1", phase: "queued", at: "2026-11-06T09:00:05.000Z" }),
      row({ taskId: "t1", phase: "received", at: "2026-11-06T09:00:00.000Z", detail: envelope("t1", "p") }),
    ];
    assert.deepEqual(projectActivityFromJournal(rows).get("p"), { lastActivity: "2026-11-06T09:00:05.000Z", lastJournalStatus: "queued" });
  });

  test("multiple tasks for one project: the newest task's rows win", () => {
    const rows = [
      row({ taskId: "t2", phase: "started", at: "2026-11-07T08:00:00.000Z", stage: "working" }),
      row({ taskId: "t2", phase: "received", at: "2026-11-07T08:00:00.000Z", detail: envelope("t2", "p") }),
      row({ taskId: "t1", phase: "settled", at: "2026-11-06T08:00:00.000Z", stage: "person/review" }),
      row({ taskId: "t1", phase: "received", at: "2026-11-06T08:00:00.000Z", detail: envelope("t1", "p") }),
    ];
    assert.equal(projectActivityFromJournal(rows).get("p")?.lastActivity, "2026-11-07T08:00:00.000Z");
  });

  test("rows without an attributable envelope are ignored; bad timestamps skip to the older row", () => {
    const rows = [
      row({ taskId: "t1", phase: "settled", at: "not-a-date" }),
      row({ taskId: "t1", phase: "started", at: "2026-11-06T09:00:00.000Z", stage: "working" }),
      row({ taskId: "t1", phase: "received", at: "2026-11-06T08:00:00.000Z", detail: envelope("t1", "p") }),
      row({ taskId: "ghost", phase: "settled", at: "2026-11-09T00:00:00.000Z" }), // no envelope at all
    ];
    assert.deepEqual(projectActivityFromJournal(rows).get("p"), { lastActivity: "2026-11-06T09:00:00.000Z", lastJournalStatus: "working" });
    assert.equal(projectActivityFromJournal(rows).size, 1);
  });
});

// ---------- SQLite integration + degradation ----------

describe("readCoordinatorProjects over a fixture coordinator.db", () => {
  test("joins registry projects with their journal-derived activity", () => {
    const dir = mkdtempSync(join(tmpdir(), "wbproj-"));
    try {
      const snap = readCoordinatorProjects(makeDb(dir));
      assert.equal(snap.note, undefined);
      assert.equal(snap.projects.length, 3);
      const byId = new Map(snap.projects.map((p) => [p.id, p]));
      assert.deepEqual(byId.get("alpha")?.lastActivity, "2026-11-05T10:00:10.000Z");
      assert.equal(byId.get("alpha")?.lastJournalStatus, "settled");
      assert.equal(byId.get("beta")?.lastActivity, "2026-11-06T09:00:30.000Z");
      assert.equal(byId.get("beta")?.lastJournalStatus, "person/review");
      // no journal rows -> no activity keys at all
      const gamma = byId.get("gamma")!;
      assert.equal(gamma.lastActivity, undefined);
      assert.equal(gamma.lastJournalStatus, undefined);
      assert.equal(gamma.displayName, "Gamma");
      assert.equal(gamma.root, "/tmp/gamma");
      assert.equal(gamma.registeredAt, "2026-11-03T00:00:00.000Z");
    } finally { rmSync(dir, { recursive: true, force: true }); }
  });

  test("missing DB degrades to an empty list + note, never throws", () => {
    const snap = readCoordinatorProjects("/nonexistent-dir-xyz/coordinator.db");
    assert.deepEqual(snap.projects, []);
    assert.match(snap.note ?? "", /coordinator database unavailable/);
  });

  test("corrupt DB file degrades gracefully", () => {
    const dir = mkdtempSync(join(tmpdir(), "wbproj-"));
    try {
      const p = join(dir, "corrupt.db");
      writeFileSync(p, "this is definitely not a sqlite database \x00\x01\x02");
      const snap = readCoordinatorProjects(p);
      assert.deepEqual(snap.projects, []);
      assert.match(snap.note ?? "", /coordinator database unavailable/);
    } finally { rmSync(dir, { recursive: true, force: true }); }
  });

  test("DB without the registry/journal tables degrades gracefully", () => {
    const dir = mkdtempSync(join(tmpdir(), "wbproj-"));
    try {
      const p = join(dir, "other.db");
      const db = new DatabaseSync(p);
      db.exec("CREATE TABLE unrelated(x TEXT)");
      db.close();
      const snap = readCoordinatorProjects(p);
      assert.deepEqual(snap.projects, []);
      assert.match(snap.note ?? "", /coordinator database unavailable/);
    } finally { rmSync(dir, { recursive: true, force: true }); }
  });

  test("registry row present but journal table missing degrades (all-or-nothing read)", () => {
    const dir = mkdtempSync(join(tmpdir(), "wbproj-"));
    try {
      const p = join(dir, "half.db");
      const db = new DatabaseSync(p);
      db.exec("CREATE TABLE registry(id INTEGER PRIMARY KEY CHECK(id = 1), json TEXT NOT NULL)");
      db.prepare("INSERT INTO registry(id, json) VALUES (1, ?)").run(REGISTRY);
      db.close();
      const snap = readCoordinatorProjects(p);
      assert.deepEqual(snap.projects, []);
      assert.match(snap.note ?? "", /coordinator database unavailable/);
    } finally { rmSync(dir, { recursive: true, force: true }); }
  });

  test("a transient read failure falls back to the last good snapshot for that path", () => {
    const dir = mkdtempSync(join(tmpdir(), "wbproj-"));
    try {
      const p = makeDb(dir);
      const good = readCoordinatorProjects(p);
      assert.equal(good.projects.length, 3);
      rmSync(p); // "writer held the lock / file vanished" between polls
      const again = readCoordinatorProjects(p);
      assert.equal(again, good); // same snapshot object: no flicker, no note
      // a never-successful path still degrades with a note
      const fresh = readCoordinatorProjects(join(dir, "never-existed.db"));
      assert.match(fresh.note ?? "", /coordinator database unavailable/);
    } finally { rmSync(dir, { recursive: true, force: true }); }
  });
});

// ---------- GET /projects route ----------

describe("GET /projects route", () => {
  let server: ReturnType<typeof createBridgeServer>;
  let port: number;
  const base = () => `http://127.0.0.1:${port}`;

  before(async () => {
    server = createBridgeServer({
      project: "ProjRoute",
      inject: () => true,
      sessionFile: () => undefined,
      subagentsDir: () => "/nonexistent-subagents",
      indexHtml: () => "<!doctype html><html><body>ui</body></html>",
      projects: () => ({
        projects: [
          { id: "alpha", displayName: "Alpha", root: "/tmp/alpha", status: "registered", registeredAt: "2026-11-01T00:00:00.000Z", lastActivity: "2026-11-06T09:00:30.000Z", lastJournalStatus: "person/review" },
          { id: "gamma", displayName: "Gamma", root: "/tmp/gamma", status: "registered", registeredAt: "2026-11-03T00:00:00.000Z" },
        ],
      }),
      log: () => {},
    });
    await new Promise<void>((res) => server.listen(0, "127.0.0.1", res));
    port = (server.address() as { port: number }).port;
  });
  after(() => server.closeBridge());

  test("returns ok + projects + generatedAt", async () => {
    const r = await fetch(`${base()}/projects`);
    assert.equal(r.status, 200);
    assert.equal(r.headers.get("cache-control"), "no-store");
    const body = await r.json() as Record<string, unknown>;
    assert.equal(body.ok, true);
    assert.equal(Number.isFinite(Date.parse(body.generatedAt as string)), true);
    const projects = body.projects as Array<Record<string, unknown>>;
    assert.equal(projects.length, 2);
    assert.equal(projects[0].lastJournalStatus, "person/review");
    assert.equal(projects[1].lastActivity, undefined); // no-data project omits the keys
  });

  test("degraded snapshot surfaces the note with an empty list", async () => {
    const s2 = createBridgeServer({
      project: "ProjRoute",
      inject: () => true,
      sessionFile: () => undefined,
      subagentsDir: () => "/nonexistent-subagents",
      indexHtml: () => "<!doctype html><html><body>ui</body></html>",
      projects: () => ({ projects: [], note: "coordinator database unavailable" }),
      log: () => {},
    });
    await new Promise<void>((res) => s2.listen(0, "127.0.0.1", res));
    try {
      const port2 = (s2.address() as { port: number }).port;
      const body = await (await fetch(`http://127.0.0.1:${port2}/projects`)).json() as Record<string, unknown>;
      assert.equal(body.ok, true);
      assert.deepEqual(body.projects, []);
      assert.equal(body.note, "coordinator database unavailable");
    } finally { s2.closeBridge(); }
  });

  test("a throwing reader degrades to a 200 with an empty list + note (never 500s)", async () => {
    const s3 = createBridgeServer({
      project: "ProjRoute",
      inject: () => true,
      sessionFile: () => undefined,
      subagentsDir: () => "/nonexistent-subagents",
      indexHtml: () => "<!doctype html><html><body>ui</body></html>",
      projects: () => { throw new Error("boom"); },
      log: () => {},
    });
    await new Promise<void>((res) => s3.listen(0, "127.0.0.1", res));
    try {
      const port3 = (s3.address() as { port: number }).port;
      const r = await fetch(`http://127.0.0.1:${port3}/projects`);
      assert.equal(r.status, 200);
      const body = await r.json() as Record<string, unknown>;
      assert.equal(body.ok, true);
      assert.deepEqual(body.projects, []);
      assert.equal(body.note, "coordinator database unavailable");
    } finally { s3.closeBridge(); }
  });

  test("same auth as every other route: foreign origin and spoofed host are 403, POST is 405", async () => {
    const badOrigin = await fetch(`${base()}/projects`, { headers: { Origin: "http://evil.example.com" } });
    assert.equal(badOrigin.status, 403);
    const spoofed = await new Promise<number>((resolve, reject) => {
      const req = http.request({ host: "127.0.0.1", port, method: "GET", path: "/projects", headers: { Host: "attacker.example.com" } }, (res) => {
        res.resume();
        res.on("end", () => resolve(res.statusCode ?? 0));
      });
      req.on("error", reject);
      req.end();
    });
    assert.equal(spoofed, 403);
    const post = await fetch(`${base()}/projects`, { method: "POST", body: "{}" });
    assert.notEqual(post.status, 200); // GET-only route: POST falls through (same as POST /state)
  });

  test("default deps (no injected reader) answer 200 with the real-reader shape", async () => {
    const s4 = createBridgeServer({
      project: "ProjRoute",
      inject: () => true,
      sessionFile: () => undefined,
      subagentsDir: () => "/nonexistent-subagents",
      indexHtml: () => "<!doctype html><html><body>ui</body></html>",
      log: () => {},
    });
    await new Promise<void>((res) => s4.listen(0, "127.0.0.1", res));
    try {
      const port4 = (s4.address() as { port: number }).port;
      const r = await fetch(`http://127.0.0.1:${port4}/projects`);
      assert.equal(r.status, 200);
      const body = await r.json() as Record<string, unknown>;
      assert.equal(body.ok, true);
      assert.equal(Array.isArray(body.projects), true); // real DB or degraded — both are a valid shape
      assert.equal(Number.isFinite(Date.parse(body.generatedAt as string)), true);
    } finally { s4.closeBridge(); }
  });
});

// ---------- Theme D2: budget fields on journal rows ----------

describe("parseEnvelopeMeta (budget fields in received envelopes)", () => {
  test("reads camelCase budget fields as the coordinator serializes them", () => {
    const meta = parseEnvelopeMeta(envelope("task-1", "alpha", { budgetPlanned: 5, budgetSpent: 1.25 }));
    assert.equal(meta.projectId, "alpha");
    assert.equal(meta.budgetPlanned, 5);
    assert.equal(meta.budgetSpent, 1.25);
  });
  test("also tolerates snake_case keys", () => {
    const meta = parseEnvelopeMeta(JSON.stringify({ projectId: "beta", budget_planned: 2, budget_spent: 0.5 }));
    assert.equal(meta.budgetPlanned, 2);
    assert.equal(meta.budgetSpent, 0.5);
  });
  test("old envelopes without budget fields read as null", () => {
    const meta = parseEnvelopeMeta(envelope("task-1", "alpha"));
    assert.equal(meta.projectId, "alpha");
    assert.equal(meta.budgetPlanned, null);
    assert.equal(meta.budgetSpent, null);
  });
  test("garbage detail degrades to nulls", () => {
    assert.deepEqual(parseEnvelopeMeta("{broken"), { projectId: null, budgetPlanned: null, budgetSpent: null });
    assert.deepEqual(parseEnvelopeMeta(null), { projectId: null, budgetPlanned: null, budgetSpent: null });
    assert.deepEqual(parseEnvelopeMeta(JSON.stringify({ budgetPlanned: "many" })), { projectId: null, budgetPlanned: null, budgetSpent: null });
  });
});

describe("projectBudgetsFromJournal (per-project budget sums over the journal window)", () => {
  test("sums planned/spent; latest settled spend wins per task; tasks without budgets contribute nothing", () => {
    // NEWEST-FIRST order, as the DESC query returns rows.
    const rows = [
      row({ taskId: "task-b1", phase: "settled", detail: "completed-unverified: ok", budgetSpent: 2.5 }),
      row({ taskId: "task-b1", phase: "received", detail: envelope("task-b1", "beta", { budgetPlanned: 10 }) }),
      row({ taskId: "task-a1", phase: "settled", detail: "completed-unverified: ok", budgetSpent: 1.5 }),
      row({ taskId: "task-a1", phase: "received", detail: envelope("task-a1", "alpha", { budgetPlanned: 4, budgetSpent: 1 }) }),
      row({ taskId: "task-c1", phase: "received", detail: envelope("task-c1", "alpha") }), // no budget fields
      row({ taskId: "task-d1", phase: "settled", detail: "completed-unverified: orphan" }), // no envelope/project
    ];
    const budgets = projectBudgetsFromJournal(rows);
    assert.equal(budgets.get("alpha")?.planned, 4);
    assert.equal(budgets.get("alpha")?.spent, 1.5); // settled row's fresher spend, not the envelope's initial 1
    assert.equal(budgets.get("alpha")?.tasks, 1); // task-c1 carries no budget fields
    assert.equal(budgets.get("beta")?.planned, 10);
    assert.equal(budgets.get("beta")?.spent, 2.5);
    assert.equal(budgets.size, 2);
  });
  test("empty rows -> empty map", () => {
    assert.equal(projectBudgetsFromJournal([]).size, 0);
  });
});

describe("readCoordinatorProjects: budget columns (Theme D2)", () => {
  test("surfaces per-project budget sums when the migrated db carries them", () => {
    const dir = mkdtempSync(join(tmpdir(), "proj-d2-"));
    const p = makeDb(dir, "budget.db");
    const db = new DatabaseSync(p);
    db.exec("ALTER TABLE journal ADD COLUMN budget_planned REAL");
    db.exec("ALTER TABLE journal ADD COLUMN budget_spent REAL");
    // alpha: planned 4 at receive; settled row refreshes spend to 3
    db.prepare("UPDATE journal SET budget_planned = 4 WHERE task_id = 'task-a1' AND phase = 'received'").run();
    db.prepare("UPDATE journal SET budget_spent = 3 WHERE task_id = 'task-a1' AND phase = 'settled'").run();
    db.close();
    const snap = readCoordinatorProjects(p);
    const alpha = snap.projects.find((x) => x.id === "alpha");
    assert.equal(alpha?.budgetPlanned, 4);
    assert.equal(alpha?.budgetSpent, 3);
    // beta has no budget fields -> keys omitted (shows them WHEN PRESENT)
    const beta = snap.projects.find((x) => x.id === "beta");
    assert.equal(beta?.budgetPlanned, undefined);
    assert.equal(beta?.budgetSpent, undefined);
    rmSync(dir, { recursive: true, force: true });
  });

  test("a PRE-migration db (no budget columns) still loads, without budgets", () => {
    const dir = mkdtempSync(join(tmpdir(), "proj-d2-legacy-"));
    const p = makeDb(dir, "legacy.db"); // plain SCHEMA, no budget columns
    const snap = readCoordinatorProjects(p);
    assert.equal(snap.projects.length, 3);
    assert.equal(snap.note, undefined);
    assert.equal(snap.projects.every((x) => x.budgetPlanned === undefined && x.budgetSpent === undefined), true);
    rmSync(dir, { recursive: true, force: true });
  });
});

// ---------- Theme D1: usage7d on the /projects route ----------

describe("GET /projects route: usage7d (additive)", () => {
  test("injected rollup appears in the response; absent wiring omits the field", async () => {
    const s2 = createBridgeServer({
      project: "ProjRoute",
      inject: () => true,
      sessionFile: () => undefined,
      subagentsDir: () => "/nonexistent-subagents",
      indexHtml: () => "<!doctype html><html><body>ui</body></html>",
      projects: () => ({ projects: [] }),
      usage7d: () => ({
        since: "2026-11-06T00:00:00.000Z",
        until: "2026-11-13T00:00:00.000Z",
        projects: [{ projectId: "alpha", displayName: "Alpha", tokens: 1234, cost: 0.5, turns: 3, sessions: 1 }],
        unattributed: { tokens: 10, cost: 0, turns: 1, sessions: 1 },
        personalOps: { tokens: 20, cost: 0, turns: 1, sessions: 1 },
        totals: { tokens: 1264, cost: 0.5, turns: 5, sessions: 3, records: 5 },
        filesRead: [],
      }),
      log: () => {},
    });
    await new Promise<void>((res) => s2.listen(0, "127.0.0.1", res));
    try {
      const r = await fetch(`http://127.0.0.1:${(s2.address() as { port: number }).port}/projects`);
      const body = await r.json() as Record<string, unknown>;
      const usage = body.usage7d as Record<string, unknown> | undefined;
      assert.ok(usage, "usage7d present when wired");
      assert.equal((usage.projects as Array<Record<string, unknown>>)[0].projectId, "alpha");
      assert.equal((usage.totals as Record<string, unknown>).tokens, 1264);
    } finally {
      s2.closeBridge();
    }
    // Without wiring: the field is omitted entirely (old payloads unchanged).
    const s3 = createBridgeServer({
      project: "ProjRoute",
      inject: () => true,
      sessionFile: () => undefined,
      subagentsDir: () => "/nonexistent-subagents",
      indexHtml: () => "<!doctype html><html><body>ui</body></html>",
      projects: () => ({ projects: [] }),
      log: () => {},
    });
    await new Promise<void>((res) => s3.listen(0, "127.0.0.1", res));
    try {
      const r = await fetch(`http://127.0.0.1:${(s3.address() as { port: number }).port}/projects`);
      const body = await r.json() as Record<string, unknown>;
      assert.equal("usage7d" in body, false);
    } finally {
      s3.closeBridge();
    }
  });

  test("a throwing usage7d source degrades to omission (never 500s the panel)", async () => {
    const s4 = createBridgeServer({
      project: "ProjRoute",
      inject: () => true,
      sessionFile: () => undefined,
      subagentsDir: () => "/nonexistent-subagents",
      indexHtml: () => "<!doctype html><html><body>ui</body></html>",
      projects: () => ({ projects: [] }),
      usage7d: () => { throw new Error("boom"); },
      log: () => {},
    });
    await new Promise<void>((res) => s4.listen(0, "127.0.0.1", res));
    try {
      const r = await fetch(`http://127.0.0.1:${(s4.address() as { port: number }).port}/projects`);
      assert.equal(r.status, 200);
      const body = await r.json() as Record<string, unknown>;
      assert.equal("usage7d" in body, false);
      assert.equal(body.ok, true);
    } finally {
      s4.closeBridge();
    }
  });
});
