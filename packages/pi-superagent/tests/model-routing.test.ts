/**
 * Theme D4 tests: declarative model routing.
 *
 * Layers:
 *  1. resolveModel() pure precedence: explicit arg > routing table (project > role >
 *     default) > PI_SUBAGENT_MODEL env > built-in fallback — including the default
 *     posture (no table = exactly the pre-D4 behavior) and the "explicit args always
 *     win / no silent overrides" rule.
 *  2. Table parsing/loading: absent file = silent no-op; malformed = warn + behave as
 *     absent; bad entries dropped individually.
 *  3. Manager integration: the resolved model reaches the worker's --model arg, the
 *     audit fields (info.modelSource) and the per-dispatch routing.log line.
 *
 * Hermetic: routing tables come from the `modelRouting` option key (pinned, even when
 * undefined — no disk read) or tmp files; PI_SUBAGENT_MODEL is scrubbed/set explicitly.
 */
import { describe, expect, it } from "vitest";
import { EventEmitter } from "node:events";
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { FALLBACK_MODEL, loadModelRouting, parseModelRouting, projectTagOf, resolveModel } from "../src/subagent/model-routing.ts";
import type { ModelRoutingConfig } from "../src/subagent/model-routing.ts";
import { SubagentManager } from "../src/subagent/manager.ts";
import type { ChildLike, SpawnFn } from "../src/subagent/types.ts";

// ---------------------------------------------------------------- resolveModel precedence

const TABLE: ModelRoutingConfig = {
  projects: { PiAgents: "route/by-project", medical: "route/medical" },
  roles: { coder: "route/by-role", reviewer: "route/review" },
  default: "route/table-default",
};

describe("resolveModel precedence", () => {
  it("1. explicit per-spawn model arg always wins — even against a matching table and env (no silent overrides)", () => {
    expect(resolveModel({ explicit: "user/chosen", project: "PiAgents", role: "coder", routing: TABLE, env: "env/model" }))
      .toEqual({ model: "user/chosen", source: "explicit" });
  });

  it("2. project tag hit beats role, table default and env", () => {
    expect(resolveModel({ project: "PiAgents", role: "coder", routing: TABLE, env: "env/model" }))
      .toEqual({ model: "route/by-project", source: "route:project" });
  });

  it("3. role hit beats table default and env", () => {
    expect(resolveModel({ project: "unknown-project", role: "coder", routing: TABLE, env: "env/model" }))
      .toEqual({ model: "route/by-role", source: "route:role" });
    expect(resolveModel({ role: "reviewer", routing: TABLE, env: "env/model" }))
      .toEqual({ model: "route/review", source: "route:role" });
  });

  it("4. table default beats env when no selector matches", () => {
    expect(resolveModel({ project: "nope", role: "nope", routing: TABLE, env: "env/model" }))
      .toEqual({ model: "route/table-default", source: "route:default" });
    expect(resolveModel({ routing: TABLE, env: "env/model" }))
      .toEqual({ model: "route/table-default", source: "route:default" });
  });

  it("5. env fills an unmatched table and is the only source when no table exists (pre-D4 behavior)", () => {
    expect(resolveModel({ routing: {}, env: "env/model" })).toEqual({ model: "env/model", source: "env" });
    expect(resolveModel({ env: "env/model" })).toEqual({ model: "env/model", source: "env" });
    expect(resolveModel({ project: "PiAgents", routing: undefined, env: "env/model" }))
      .toEqual({ model: "env/model", source: "env" });
  });

  it("6. built-in fallback when nothing is configured anywhere", () => {
    expect(resolveModel({})).toEqual({ model: FALLBACK_MODEL, source: "fallback" });
    expect(resolveModel({ routing: {}, env: "  " })).toEqual({ model: FALLBACK_MODEL, source: "fallback" });
  });

  it("empty/garbage explicit args are treated as absent (never spawn with a blank --model)", () => {
    expect(resolveModel({ explicit: "", env: "env/model" }).source).toBe("env");
    expect(resolveModel({ explicit: "   " }).source).toBe("fallback");
    expect(resolveModel({ explicit: "  spaced/model  " })).toEqual({ model: "spaced/model", source: "explicit" });
  });

  it("unknown project tags and roles fall through honestly (exact match, never guessed)", () => {
    expect(resolveModel({ project: "piagents", routing: TABLE, env: "env/model" }).source).toBe("route:default"); // case-sensitive
    expect(resolveModel({ role: "Coder", routing: TABLE }).source).toBe("route:default");
    expect(resolveModel({ project: "medical", routing: { projects: { medical: "route/m" } } }).source).toBe("route:project");
  });

  it("projectTagOf extracts the spawn-gate token", () => {
    expect(projectTagOf("[project:PiAgents] do x")).toBe("PiAgents");
    expect(projectTagOf("please do it [project:medical] inline")).toBe("medical");
    expect(projectTagOf("tagless task")).toBeUndefined();
    expect(projectTagOf("[project:] empty tag")).toBeUndefined();
    expect(projectTagOf(undefined)).toBeUndefined();
  });
});

// ---------------------------------------------------------------- table parse + load

describe("parseModelRouting / loadModelRouting", () => {
  it("parses a full table and sanitizes entries", () => {
    expect(parseModelRouting(JSON.stringify(TABLE))).toEqual(TABLE);
  });

  it("drops individually bad entries (non-string/empty values, empty keys) but keeps the rest", () => {
    const parsed = parseModelRouting(JSON.stringify({
      projects: { good: "m/1", bad: 5, "": "m/2", blank: "   " },
      roles: { coder: "m/3" },
      default: "   ",
    }));
    expect(parsed).toEqual({ projects: { good: "m/1" }, roles: { coder: "m/3" } });
  });

  it("garbage, arrays, nulls and wrong-typed sections are malformed (undefined)", () => {
    expect(parseModelRouting(undefined)).toBeUndefined();
    expect(parseModelRouting("")).toBeUndefined();
    expect(parseModelRouting("not json")).toBeUndefined();
    expect(parseModelRouting('["array"]')).toBeUndefined();
    expect(parseModelRouting("null")).toBeUndefined();
    expect(parseModelRouting('"str"')).toBeUndefined();
    expect(parseModelRouting('{"projects": "not-an-object"}')).toBeUndefined();
    expect(parseModelRouting('{"roles": [1,2]}')).toBeUndefined();
  });

  it("an empty object is a valid (matching-nothing) table", () => {
    expect(parseModelRouting("{}")).toEqual({});
  });

  it("loadModelRouting: absent file -> undefined with NO warning (the default posture is silent)", () => {
    const dir = mkdtempSync(join(tmpdir(), "mr-"));
    const warnings: string[] = [];
    expect(loadModelRouting(join(dir, "absent.json"), (m) => warnings.push(m))).toBeUndefined();
    expect(warnings).toHaveLength(0);
    rmSync(dir, { recursive: true, force: true });
  });

  it("loadModelRouting: malformed file -> undefined + one stderr warning; valid file -> parsed", () => {
    const dir = mkdtempSync(join(tmpdir(), "mr-"));
    const bad = join(dir, "bad.json");
    writeFileSync(bad, "{ not json");
    const warnings: string[] = [];
    expect(loadModelRouting(bad, (m) => warnings.push(m))).toBeUndefined();
    expect(warnings).toHaveLength(1);
    expect(warnings[0]).toContain("model-routing");
    const good = join(dir, "good.json");
    writeFileSync(good, JSON.stringify({ default: "route/d" }));
    expect(loadModelRouting(good, (m) => warnings.push(m))).toEqual({ default: "route/d" });
    expect(warnings).toHaveLength(1);
    rmSync(dir, { recursive: true, force: true });
  });
});

// ---------------------------------------------------------------- manager integration

/** Minimal fake `pi --mode rpc` child: records nothing, never exits (we inspect sync launch state). */
class FakePi extends EventEmitter implements ChildLike {
  stdin = { write: () => true, end: () => true };
  stdout = { on: () => { /* no events */ } };
  stderr = { on: () => { /* no events */ } };
  kill() { return true; }
}

async function setup(opts: { modelRouting?: ModelRoutingConfig } = {}, env: Record<string, string> = {}) {
  const dir = mkdtempSync(join(tmpdir(), "mrt-"));
  const spawned: string[][] = [];
  const spawn: SpawnFn = (cmd, args) => { spawned.push([cmd, ...args]); return new FakePi() as unknown as ChildLike; };
  const saved = ["PI_SUBAGENT_MODEL", "PI_SPAWN_BUDGET", "PI_SPAWN_REQUIRE_PROJECT_TAG", "PI_SUBAGENT_ID"] as const;
  const old = saved.map((k) => [k, process.env[k]] as const);
  for (const k of saved) delete process.env[k];
  for (const [k, v] of Object.entries(env)) process.env[k] = v;
  const m = new SubagentManager(
    { spawn, extensionPath: "/ext/index.ts", baseDir: dir, modelRouting: opts.modelRouting },
    { deliver: () => { /* tests never assert deliveries here */ } },
  );
  return {
    m, spawned, dir,
    cleanup() {
      for (const [k, v] of old) { if (v === undefined) delete process.env[k]; else process.env[k] = v; }
      rmSync(dir, { recursive: true, force: true });
    },
  };
}

const modelArg = (args: string[]) => args[args.indexOf("--model") + 1];

describe("manager model resolution (Theme D4 wiring)", () => {
  it("no table, no env: worker gets the built-in fallback and the source is recorded", async () => {
    const { m, spawned, cleanup } = await setup();
    try {
      const i = await m.spawn({ task: "[project:PiAgents] t" });
      expect(modelArg(spawned[0])).toBe(FALLBACK_MODEL);
      expect(i.model).toBe(FALLBACK_MODEL);
      expect(i.modelSource).toBe("fallback");
    } finally { cleanup(); }
  });

  it("routing table fills the default slot: project tag routes, source + routing.log recorded", async () => {
    const { m, spawned, dir, cleanup } = await setup({ modelRouting: TABLE });
    try {
      const i = await m.spawn({ task: "[project:PiAgents] t" });
      expect(modelArg(spawned[0])).toBe("route/by-project");
      expect(i.model).toBe("route/by-project");
      expect(i.modelSource).toBe("route:project");
      const log = JSON.parse(readFileSync(join(i.logDir, "routing.log"), "utf8"));
      expect(log).toMatchObject({ subagent: i.id, requested: null, project: "PiAgents", role: null, resolved: "route/by-project", source: "route:project" });
      expect(existsSync(join(dir, "routing.log"))).toBe(false); // log lives in the subagent's own events dir
    } finally { cleanup(); }
  });

  it("explicit model arg still beats the table (no silent overrides) and the audit line shows requested vs resolved", async () => {
    const { m, spawned, cleanup } = await setup({ modelRouting: TABLE }, { PI_SUBAGENT_MODEL: "env/model" });
    try {
      const i = await m.spawn({ task: "[project:PiAgents] t", model: "user/chosen" });
      expect(modelArg(spawned[0])).toBe("user/chosen");
      expect(i.modelSource).toBe("explicit");
      const log = JSON.parse(readFileSync(join(i.logDir, "routing.log"), "utf8"));
      expect(log.requested).toBe("user/chosen");
      expect(log.resolved).toBe("user/chosen");
    } finally { cleanup(); }
  });

  it("role selector routes when the project does not match; table default beats env; project outranks role", async () => {
    const { m, spawned, cleanup } = await setup({ modelRouting: TABLE });
    try {
      const i = await m.spawn({ task: "[project:unlisted] t", role: "coder" });
      expect(modelArg(spawned[0])).toBe("route/by-role");
      expect(i.modelSource).toBe("route:role");
      const j = await m.spawn({ task: "[project:other] t" });
      expect(modelArg(spawned[1])).toBe("route/table-default");
      expect(j.modelSource).toBe("route:default");
    } finally { cleanup(); }
  });

  it("with the table absent (undefined pin) the env slot still applies — exactly the pre-D4 chain", async () => {
    const { m, spawned, cleanup } = await setup({}, { PI_SUBAGENT_MODEL: "env/model" });
    try {
      const i = await m.spawn({ task: "[project:PiAgents] t" });
      expect(modelArg(spawned[0])).toBe("env/model");
      expect(i.modelSource).toBe("env");
    } finally { cleanup(); }
  });
});
