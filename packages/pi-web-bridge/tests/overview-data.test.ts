import { test, describe, before, after } from "node:test";
import assert from "node:assert/strict";
import { readFileSync, writeFileSync, mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import {
  scanAtoms,
  readMemoryIndex,
  readMemoryLayer,
  resolveGuardMode,
  readGuardPanel,
  readCampaignState,
  readCampaign,
  readBudgetDeep,
  readSystemHealth,
} from "../src/overview-data.ts";

// ---------- fixtures ----------
const FIX = mkdtempSync(join(tmpdir(), "ovdata-"));
const atomsRoot = join(FIX, "atoms");
mkdirSync(join(atomsRoot, "piagents"), { recursive: true });
mkdirSync(join(atomsRoot, "minecraft"), { recursive: true });
writeFileSync(join(atomsRoot, "piagents", "2026-11-13.jsonl"), '{"a":1}\n{"a":2}\n{"a":3}\n');
writeFileSync(join(atomsRoot, "piagents", "2026-11-14.jsonl"), '{"a":4}\n');
writeFileSync(join(atomsRoot, "minecraft", "2026-11-12.jsonl"), '{"b":1}\n');
writeFileSync(join(atomsRoot, "minecraft", "notes.txt"), "not an atoms day file\n");
mkdirSync(join(atomsRoot, "empty-proj"), { recursive: true });
writeFileSync(join(atomsRoot, "empty-proj", ".keep"), "");

// real sqlite fixture for the memory index reader
const indexDb = join(FIX, "index.db");
{
  const db = new DatabaseSync(indexDb);
  db.exec("CREATE TABLE obs(obs_id TEXT PRIMARY KEY, kind TEXT NOT NULL, project TEXT NOT NULL, ts TEXT NOT NULL, content TEXT NOT NULL)");
  const ins = db.prepare("INSERT INTO obs VALUES (?, ?, ?, ?, ?)");
  for (let i = 0; i < 5; i++) ins.run(`o${i}`, "observation", "piagents", "2026-11-14T00:00:00Z", "x");
  ins.run("d1", "daily", "piagents", "2026-11-14T00:00:00Z", "x");
  ins.run("c1", "concept", "piagents", "2026-11-14T00:00:00Z", "x");
  db.close();
}

// guard log: two today entries + one yesterday + one error
const guardLog = join(FIX, "coordinator-guard.jsonl");
const now = new Date();
const todayIso = new Date(now.getFullYear(), now.getMonth(), now.getDate(), 10, 30).toISOString();
const yestIso = new Date(now.getFullYear(), now.getMonth(), now.getDate() - 1, 10, 30).toISOString();
writeFileSync(guardLog, [
  JSON.stringify({ ts: yestIso, mode: "enforce", decision: "denied", tool: "bash", category: "rm_rf", pattern: "rm -rf /", excerpt: "rm -rf /" }),
  JSON.stringify({ ts: todayIso, mode: "enforce", decision: "would_deny", tool: "bash", category: "net", pattern: "curl http", excerpt: "curl http://x" }),
  JSON.stringify({ ts: todayIso, mode: "enforce", decision: "denied", tool: "edit_write", category: "outside_allow", pattern: "/etc/hosts", excerpt: "/etc/hosts" }),
  JSON.stringify({ ts: todayIso, mode: "enforce", decision: "error", tool: "_config", category: "config_error", pattern: "config_parse_error", excerpt: "{}", error: "bad version" }),
].join("\n") + "\n");

// guard config: enforce
const guardConfig = join(FIX, "coordinator-guard.json");
writeFileSync(guardConfig, JSON.stringify({ version: 1, mode: "enforce", allow: [] }));

// MC campaign fixture
const mcRoot = join(FIX, "mc");
mkdirSync(join(mcRoot, "wave"), { recursive: true });
writeFileSync(join(mcRoot, "wave", "closed_loop_state.json"), JSON.stringify({
  version: 2, mode: "live", status: "running",
  node: { current: "wooden_sword", history: [] },
  curriculum: { enabled: true, node: "minecraft:story/upgrade_tools", parked: null, episode_request_budget: 200 },
  counters: { cycles_started: 10, cycles_completed: 9, accepted: 2, rejected: 7, cycles_today: 3 },
  budget: { token_cap: 1000000, spent: 500000 },
  caps: { max_cycles_per_day: 6 },
  updated_at: new Date().toISOString(),
}));

// distiller state fixture
const memDir = join(FIX, "memory");
mkdirSync(join(memDir, "distiller"), { recursive: true });
writeFileSync(join(memDir, "distiller", "state.json"), JSON.stringify({
  version: 1, watermarks: {},
  lastRun: { at: "2026-11-14T06:00:00.000Z", trigger: "idle", scanned: 12, written: 3, llmUsed: false, degradedReason: null, atomsFile: "/kb/atoms/piagents/2026-11-14.jsonl" },
}));
writeFileSync(join(memDir, "profile.md"), "PREFERENCES\n- concise replies\n");

after(() => rmSync(FIX, { recursive: true, force: true }));

describe("overview-data: scanAtoms", () => {
  test("counts lines per project/day, ignores non-day files, sorts days desc", () => {
    const r = scanAtoms(atomsRoot);
    assert.equal(r.total, 5); // piagents 4 + minecraft 1; empty projects omitted
    // precise: piagents 4, minecraft 1
    const byProj = Object.fromEntries(r.projects.map((p) => [p.project, p.total]));
    assert.equal(byProj["piagents"], 4);
    assert.equal(byProj["minecraft"], 1);
    assert.ok(!("empty-proj" in byProj), "empty projects are omitted");
    const pi = r.projects.find((p) => p.project === "piagents");
    assert.deepEqual(pi.days.map((d) => d.day), ["2026-11-14", "2026-11-13"]);
  });
  test("missing root degrades with a note, never throws", () => {
    const r = scanAtoms(join(FIX, "nope"));
    assert.equal(r.total, 0);
    assert.match(r.note ?? "", /unreadable/);
  });
});

describe("overview-data: readMemoryIndex", () => {
  test("groups obs rows by kind over a real sqlite file", () => {
    const r = readMemoryIndex(indexDb);
    assert.equal(r.total, 7);
    const kinds = Object.fromEntries(r.kinds.map((k) => [k.kind, k.count]));
    assert.equal(kinds.observation, 5);
    assert.equal(kinds.daily, 1);
    assert.equal(kinds.concept, 1);
  });
  test("missing db degrades with a note", () => {
    const r = readMemoryIndex(join(FIX, "absent.db"));
    assert.equal(r.total, 0);
    assert.ok(r.note);
  });
});

describe("overview-data: readMemoryLayer", () => {
  test("composes atoms + index + profile + distiller from explicit overrides", () => {
    const m = readMemoryLayer({
      atomsRoot,
      indexDb,
      profilePath: join(memDir, "profile.md"),
      statePath: join(memDir, "distiller", "state.json"),
    });
    assert.equal(m.ok, true);
    assert.equal(m.atoms.total, 5);
    assert.equal(m.index.total, 7);
    assert.equal(m.profile.exists, true);
    assert.ok(m.profile.bytes > 0);
    assert.equal(m.distiller.lastRun.written, 3);
    assert.equal(m.distiller.lastRun.trigger, "idle");
  });
  test("absent profile + corrupt distiller state degrade per-layer, never throw", () => {
    const badState = join(FIX, "bad-state.json");
    writeFileSync(badState, "{not json");
    const m = readMemoryLayer({
      atomsRoot: join(FIX, "nope"),
      indexDb: join(FIX, "absent.db"),
      profilePath: join(FIX, "absent-profile.md"),
      statePath: badState,
    });
    assert.equal(m.ok, true); // the LAYER composes; members degrade
    assert.equal(m.profile.exists, false);
    assert.match(m.distiller.note ?? "", /unreadable/);
  });
});

describe("overview-data: guard mode resolution", () => {
  test("config file wins over the default", () => {
    assert.deepEqual(resolveGuardMode(guardConfig, {}), { mode: "enforce", source: "config" });
  });
  test("env beats the config file", () => {
    assert.deepEqual(resolveGuardMode(guardConfig, { PI_COORDINATOR_GUARD: "observe" }), { mode: "observe", source: "env" });
    assert.deepEqual(resolveGuardMode(guardConfig, { PI_COORDINATOR_GUARD: "enforce" }), { mode: "enforce", source: "env" });
  });
  test("missing config -> observe default; corrupt config -> default with note", () => {
    const r = resolveGuardMode(join(FIX, "absent-config.json"), {});
    assert.deepEqual({ mode: r.mode, source: r.source }, { mode: "observe", source: "default" });
    const badCfg = join(FIX, "bad-cfg.json");
    writeFileSync(badCfg, "{oops");
    const r2 = resolveGuardMode(badCfg, {});
    assert.equal(r2.mode, "observe");
    assert.ok(r2.note);
  });
});

describe("overview-data: readGuardPanel", () => {
  test("counts only TODAY's decisions by category; recent = last 5 overall", () => {
    const g = readGuardPanel({ logPath: guardLog, configPath: guardConfig, now: new Date() });
    assert.equal(g.ok, true);
    assert.equal(g.mode, "enforce");
    assert.equal(g.today.denied, 1);
    assert.equal(g.today.would_deny, 1);
    assert.equal(g.today.errors, 1); // yesterday's denied is excluded; today's error counts
    const cats = Object.fromEntries(g.today.byCategory.map((c) => [c.category, c.count]));
    assert.equal(cats.net, 1);
    assert.equal(cats.outside_allow, 1);
    assert.equal(cats.config_error, 1);
    assert.equal(g.recent.length, 4);
    assert.equal(g.recent[0].decision, "error"); // newest last -> reversed
  });
  test("absent log degrades honestly", () => {
    const g = readGuardPanel({ logPath: join(FIX, "absent-log.jsonl"), configPath: guardConfig });
    assert.equal(g.ok, true);
    assert.equal(g.today.denied, 0);
    assert.equal(g.recent.length, 0);
  });
});

describe("overview-data: MC campaign", () => {
  test("projects the v2 state shape + honest driver absence", () => {
    const c = readCampaign(mcRoot);
    assert.equal(c.exists, true);
    assert.equal(c.state.mode, "live");
    assert.equal(c.state.counters.cycles_started, 10);
    assert.equal(c.state.budget.token_cap, 1000000);
    assert.equal(c.state.curriculum.node, "minecraft:story/upgrade_tools");
    // driver liveness: fixture env has no closed_loop.py process -> null (honest)
    assert.equal(c.driver, null);
  });
  test("root without a wave dir -> exists:false + note, never throws", () => {
    const emptyRoot = join(FIX, "no-wave");
    mkdirSync(emptyRoot, { recursive: true });
    const c = readCampaign(emptyRoot);
    assert.equal(c.exists, false);
    assert.ok(c.note);
  });
  test("readCampaignState tolerates corrupt JSON", () => {
    const bad = join(FIX, "bad-state.json");
    assert.equal(readCampaignState(bad), null);
  });
});

describe("overview-data: budget + system", () => {
  test("readBudgetDeep passes rollups through and carries the campaign", () => {
    const campaign = { root: mcRoot, path: join(mcRoot, "wave", "closed_loop_state.json"), exists: true, state: readCampaignState(join(mcRoot, "wave", "closed_loop_state.json")), driver: null };
    const b = readBudgetDeep({ d7: { totals: { tokens: 1 } }, d30: { totals: { tokens: 2 } } }, campaign);
    assert.equal(b.ok, true);
    assert.deepEqual(b.d7, { totals: { tokens: 1 } });
    assert.equal(b.campaign?.exists, true);
    assert.equal(b.campaign?.state?.counters.cycles_started, 10);
  });
  test("readSystemHealth: routing present/absent + extensions listing + guard mode", () => {
    const routingPath = join(FIX, "model-routing.json");
    writeFileSync(routingPath, JSON.stringify({ roles: { coder: "m1", scout: "m2" } }));
    const extDir = join(FIX, "extensions");
    mkdirSync(extDir, { recursive: true });
    writeFileSync(join(extDir, "guard.js"), "x");
    const s = readSystemHealth({ routingPath, extensionsDir: extDir, bridgeStartedAt: Date.now() - 60000 });
    assert.equal(s.ok, true);
    assert.equal(s.routing.exists, true);
    assert.equal(s.routing.roles, 2);
    assert.equal(s.extensions.count, 1);
    assert.equal(s.guard.mode, "enforce");
    const s2 = readSystemHealth({ routingPath: join(FIX, "absent-routing.json"), extensionsDir: join(FIX, "absent-ext"), bridgeStartedAt: Date.now() });
    assert.equal(s2.routing.exists, false);
    assert.equal(s2.extensions.count, 0);
    assert.ok(s2.extensions.note);
  });
});
