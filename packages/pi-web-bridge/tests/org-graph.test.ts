import { test, describe } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

// The org-graph model is a pure-logic block embedded in the single-file UI
// (src/index.html) between ORG-GRAPH-PURE markers: lineage derivation, the
// coordinator -> projects -> (subprojects) -> agents hierarchy, role badges,
// fit scaling and the deterministic tidy layout. It is extracted here and
// evaluated without a DOM — SVG rendering itself is intentionally not tested.
const here = dirname(fileURLToPath(import.meta.url));
const html = readFileSync(join(here, "..", "src", "index.html"), "utf8");
const match = /\/\* ORG-GRAPH-PURE:BEGIN \*\/([\s\S]*?)\/\* ORG-GRAPH-PURE:END \*\//.exec(html);
if (!match) throw new Error("ORG-GRAPH-PURE block not found in src/index.html");
const org = new Function(
  `${match[1]}; return { ORG_ROLES, ORG_ROLE_GROUPS, ORG_UNATTRIBUTED, ORG_WORKING_MS, orgRoleGroupOf, orgDeriveParent, orgClassifyRole, orgNaturalCompare, orgAttribution, orgGroupByProject, orgProjectHue, orgRegistryWorking, orgSubprojectTarget, orgBuildModel, orgLayoutModel, ORG_LAYOUT, ORG_FIT_FLOOR, ORG_ZOOM_MAX, orgFitScale, orgFocusClosure };`,
)() as {
  ORG_ROLES: string[];
  ORG_ROLE_GROUPS: Array<{ id: string; name: string; roles: string[] }>;
  ORG_UNATTRIBUTED: string;
  ORG_WORKING_MS: number;
  orgRoleGroupOf: (role: string) => { id: string; name: string; roles: string[] } | null;
  orgDeriveParent: (id: string, ids: Set<string>) => { parent: string | null; known: boolean };
  orgClassifyRole: (id: string, label: string | null, session: string | null) => string | null;
  orgAttribution: (sub: { project?: unknown } | null, bridgeProject: string | null) => string | null;
  orgGroupByProject: (subs: Array<Record<string, unknown>>, bridgeProject: string | null) => { keys: string[]; groups: Map<string, Array<Record<string, unknown>>> };
  orgProjectHue: (name: string | null) => number;
  orgNaturalCompare: (a: string, b: string) => number;
  orgRegistryWorking: (entry: Record<string, unknown> | null, nowMs: number) => boolean;
  orgSubprojectTarget: (sub: Record<string, unknown> | null, registry: Array<Record<string, unknown>>) => { project: string; subproject: string } | null;
  orgBuildModel: (subs: Array<Record<string, unknown>>, bridgeProject: string | null, registry: Array<Record<string, unknown>> | null, view: string | null, nowMs: number) => {
    nodes: Map<string, HNode>;
    projKeys: string[];
    maxRow: number;
    maxSpawnDepth: number;
  };
  orgLayoutModel: (model: ReturnType<typeof org.orgBuildModel>) => {
    coordinator: { id: string; x: number; y: number };
    nodes: Array<{
      id: string; kind: "project" | "subproject" | "agent"; x: number; y: number; w: number; h: number; row: number;
      depth: number | null; parent: string | null; parentHint: string | null; hostId: string | null; project: string;
      display: string | null; status: string | null; childIds: string[];
    }>;
    edges: Array<{ from: string; to: string; kind: "entry" | "crew_of" | "spawn" | "sub"; dashed: boolean; key: string }>;
    width: number;
    height: number;
    maxDepth: number;
  };
  ORG_LAYOUT: { nodeW: number; projW: number; gapX: number; rowH: number; padTop: number };
  ORG_FIT_FLOOR: number;
  ORG_ZOOM_MAX: number;
  orgFitScale: (width: number, height: number, panelW: number, panelH: number, zoom?: number) => { fit: number; applied: number };
  orgFocusClosure: (model: ReturnType<typeof org.orgLayoutModel>, id: string) => { nodes: Set<string>; edges: Set<string> };
};

interface HNode {
  id: string;
  kind: "project" | "subproject" | "agent";
  status?: string | null;
  parent: string | null;
  parentHint: string | null;
  hostId?: string | null;
  role?: string | null;
  project: string;
  subproject?: string | null;
  depth: number | null;
  row: number;
  children: HNode[];
  display?: string | null;
  registry?: Record<string, unknown> | null;
}

const NOW = 1_700_000_000_000;
const sub = (id: string, extra: Record<string, unknown> = {}) => ({ id, status: "running", ...extra });
const iso = (msAgo: number) => new Date(NOW - msAgo).toISOString();

describe("org lineage derivation (mirrors server resolveAncestry)", () => {
  const ids = new Set(["sa13", "sa13-a", "sa2", "sa2-sa1", "sa1"]);
  test("fanout child maps to its in-scan parent", () => {
    assert.deepEqual(org.orgDeriveParent("sa13-a", ids), { parent: "sa13", known: true });
  });
  test("nested child maps to its in-scan parent", () => {
    assert.deepEqual(org.orgDeriveParent("sa2-sa1", ids), { parent: "sa2", known: true });
  });
  test("plain id has no parent", () => {
    assert.deepEqual(org.orgDeriveParent("sa1", ids), { parent: null, known: false });
  });
  test("role- namespace ids are role instances, not children of a 'role' agent", () => {
    assert.deepEqual(org.orgDeriveParent("role-coder", ids), { parent: null, known: false });
    // their own fanout children still map to them
    assert.deepEqual(org.orgDeriveParent("role-coder-a", new Set(["role-coder", "role-coder-a"])), { parent: "role-coder", known: true });
  });
  test("prefix-parent absent from the scan stays unknown, never invented", () => {
    assert.deepEqual(org.orgDeriveParent("sa9-x", ids), { parent: "sa9", known: false });
  });
});

describe("role badge classification", () => {
  test("role-<name> id wins", () => {
    assert.equal(org.orgClassifyRole("role-coder", "unrelated label", null), "coder");
    assert.equal(org.orgClassifyRole("role-sec-audit", null, null), "sec-audit");
  });
  test("session naming wins over everything", () => {
    assert.equal(org.orgClassifyRole("sa5", "act as reviewer", "role-planner"), "planner");
  });
  test("first word-boundary keyword in the task label", () => {
    assert.equal(org.orgClassifyRole("sa5", "You are the coder. Then a reviewer pass.", null), "coder");
    assert.equal(org.orgClassifyRole("sa5", "act as REVIEWER of the diff", null), "reviewer");
  });
  test("no role evidence -> null (substring must not match)", () => {
    assert.equal(org.orgClassifyRole("sa5", null, null), null);
    assert.equal(org.orgClassifyRole("sa5", "uncoded nonsense", null), null);
  });
});

describe("standing roles legend partition", () => {
  test("9 predefined roles in 3 non-overlapping groups", () => {
    assert.equal(org.ORG_ROLES.length, 9);
    const flat = org.ORG_ROLE_GROUPS.flatMap((g) => g.roles);
    assert.equal(flat.length, 9);
    assert.deepEqual([...flat].sort(), [...org.ORG_ROLES].sort());
    for (const role of org.ORG_ROLES) assert.ok(org.orgRoleGroupOf(role));
  });
});

describe("project attribution and grouping", () => {
  test("explicit per-sub project wins, then bridge inheritance, else unattributed", () => {
    assert.equal(org.orgAttribution({ project: "alpha" }, "bridge"), "alpha");
    assert.equal(org.orgAttribution({ project: "  beta  " }, null), "beta");
    assert.equal(org.orgAttribution({}, "bridge"), "bridge");
    assert.equal(org.orgAttribution({}, null), null);
    assert.equal(org.orgAttribution({ project: "   " }, "bridge"), "bridge"); // blank is not attribution
  });
  test("grouping: attributed keys sorted, unattributed last, never guessed", () => {
    const { keys, groups } = org.orgGroupByProject(
      [sub("sa3", { project: "beta" }), sub("sa1", { project: "alpha" }), sub("sa2")],
      "bridge",
    );
    assert.deepEqual(keys, ["alpha", "beta", "bridge"]);
    assert.equal(groups.get("alpha")![0].id, "sa1");
    const un = org.orgGroupByProject([sub("sa9")], null);
    assert.deepEqual(un.keys, [org.ORG_UNATTRIBUTED]);
  });
  test("project hue: deterministic and never in the signal-green band", () => {
    assert.equal(org.orgProjectHue("alpha"), org.orgProjectHue("alpha"));
    for (let i = 0; i < 300; i++) {
      const h = org.orgProjectHue(`project-${i}`);
      assert.ok(h >= 0 && h < 360 && !(h >= 130 && h <= 185), `hue ${h} for project-${i}`);
    }
    assert.equal(org.orgProjectHue(null), org.orgProjectHue("")); // degenerate inputs still stable
  });
});

describe("working-registry rule (project layer population)", () => {
  const reg = [
    { id: "alpha", lastActivity: iso(5 * 60_000) }, // working
    { id: "beta" }, // no journal activity
    { id: "gamma", lastActivity: iso(2 * 60_000) }, // working, no agents
    { id: "delta", lastActivity: iso(90 * 60_000) }, // stale
  ];
  test("fresh journal activity marks a project working", () => {
    assert.equal(org.orgRegistryWorking(reg[0], NOW), true);
    assert.equal(org.orgRegistryWorking(reg[1], NOW), false);
    assert.equal(org.orgRegistryWorking(reg[3], NOW), false);
    assert.equal(org.orgRegistryWorking(null, NOW), false);
  });
  test("v2 subproject routing matches explicit agent project against registry subprojects", () => {
    const registry = [{ id: "alpha", subprojects: [{ id: "alpha-web" }] }];
    assert.deepEqual(org.orgSubprojectTarget({ project: "alpha-web" }, registry), { project: "alpha", subproject: "alpha-web" });
    assert.equal(org.orgSubprojectTarget({ project: "alpha" }, registry), null); // the project itself is not a subproject
    assert.equal(org.orgSubprojectTarget({ project: "nope" }, registry), null);
    assert.equal(org.orgSubprojectTarget({}, registry), null);
  });
});

describe("hierarchy model: coordinator -> projects -> (subprojects) -> agents", () => {
  const registry = [
    { id: "alpha", displayName: "Alpha Colony", lastActivity: iso(5 * 60_000) },
    { id: "beta", displayName: "Beta Works" },
    { id: "gamma", displayName: "Gamma Hold", lastActivity: iso(2 * 60_000) },
  ];
  const subs = [
    sub("sa1", { project: "alpha" }), sub("sa1-a", { project: "alpha" }), sub("sa1-a-b", { project: "alpha" }),
    sub("sa2", { project: "beta" }), sub("sa2-sa1", { project: "beta" }),
    sub("role-coder"), sub("sa3"), sub("sa9-x"),
  ];
  const model = org.orgBuildModel(subs, "bridge", registry, null, NOW);

  test("project layer: registry projects (bucketed or working) + extra buckets, in payload order", () => {
    assert.deepEqual(model.projKeys, ["alpha", "beta", "gamma", "bridge"]);
    const proj = [...model.nodes.values()].filter((n) => n.kind === "project");
    assert.equal(proj.length, 4);
    assert.equal(model.nodes.get("__proj:alpha")!.display, "Alpha Colony");
    assert.equal(model.nodes.get("__proj:gamma")!.display, "Gamma Hold"); // working, no agents
    assert.equal(model.nodes.get("__proj:bridge")!.display, "bridge"); // attribution key not in registry
    assert.equal(model.nodes.get("__proj:bridge")!.registry, null);
  });
  test("agents hang under their project; spawn lineage nests below; rows are structural", () => {
    const sa1 = model.nodes.get("sa1")!;
    const sa1a = model.nodes.get("sa1-a")!;
    assert.equal(sa1.row, 2); // project row 1 + 1
    assert.equal(sa1.depth, 0); // SPAWN depth stays honest (dN label)
    assert.equal(sa1a.row, 3);
    assert.equal(sa1a.depth, 1);
    assert.equal(model.nodes.get("sa1-a-b")!.depth, 2);
    assert.equal(model.maxSpawnDepth, 2);
    assert.equal(model.maxRow, 4);
  });
  test("agents with no attribution gather under the explicit unattributed node", () => {
    const un = org.orgBuildModel([sub("sa9")], null, registry, null, NOW);
    // working registry projects (alpha, gamma) still claim their project nodes;
    // beta is neither bucketed nor working -> absent. Unattributed comes last.
    assert.deepEqual(un.projKeys, ["alpha", "gamma", org.ORG_UNATTRIBUTED]);
    const pn = un.nodes.get("__proj:" + org.ORG_UNATTRIBUTED)!;
    assert.equal(pn.display, "unattributed");
    assert.equal(pn.children.length, 1);
  });
  test("pure idle: no subagents at all means no project layer (coordinator + note)", () => {
    const idle = org.orgBuildModel([], "bridge", registry, null, NOW);
    assert.deepEqual(idle.projKeys, []);
    assert.equal(idle.nodes.size, 0);
  });
  test("single-project view: one subtree, project node present even when empty", () => {
    const beta = org.orgBuildModel(subs, "bridge", registry, "beta", NOW);
    assert.deepEqual(beta.projKeys, ["beta"]);
    assert.equal([...beta.nodes.values()].filter((n) => n.kind === "agent").length, 2);
    const empty = org.orgBuildModel([], "bridge", registry, "gamma", NOW);
    assert.equal(empty.nodes.get("__proj:gamma")!.kind, "project");
    assert.equal(empty.nodes.get("__proj:gamma")!.children.length, 0);
  });
  test("cross-project parents become honest dashed roots inside the bucket", () => {
    const lone = org.orgBuildModel([sub("sa2-sa1", { project: "alpha" })], "bridge", [], null, NOW);
    const n = lone.nodes.get("sa2-sa1")!;
    assert.equal(n.parent, null);
    assert.equal(n.parentHint, "sa2");
    assert.equal(n.depth, 0);
  });
  test("v2 subprojects: intermediate nodes render when registry data exists, never fabricated", () => {
    const reg2 = [{ id: "alpha", displayName: "Alpha Colony", subprojects: [{ id: "alpha-web", displayName: "Alpha Web" }] }];
    const m = org.orgBuildModel(
      [sub("sa1", { project: "alpha" }), sub("aw1", { project: "alpha-web" })],
      "bridge", reg2, null, NOW,
    );
    const sp = m.nodes.get("__sub:alpha:alpha-web")!;
    assert.equal(sp.kind, "subproject");
    assert.equal(sp.display, "Alpha Web");
    assert.equal(sp.row, 2);
    assert.deepEqual(sp.children.map((c) => c.id), ["aw1"]); // routed by explicit project match
    assert.equal(m.nodes.get("sa1")!.hostId, "__proj:alpha"); // direct agents skip the layer
    assert.equal(m.nodes.get("aw1")!.row, 3);
    const flat = org.orgBuildModel([sub("sa1", { project: "alpha" })], "bridge", registry, null, NOW);
    assert.ok(![...flat.nodes.keys()].some((k) => k.startsWith("__sub:"))); // absent data -> no layer
  });
});

describe("hierarchy layout: deterministic, banded, overlap-free", () => {
  const registry = [
    { id: "alpha", displayName: "Alpha Colony", lastActivity: iso(5 * 60_000) },
    { id: "beta", displayName: "Beta Works" },
    { id: "gamma", displayName: "Gamma Hold", lastActivity: iso(2 * 60_000) },
  ];
  const subs = [
    sub("sa1", { project: "alpha" }), sub("sa1-a", { project: "alpha" }), sub("sa1-a-b", { project: "alpha" }),
    sub("sa2", { project: "beta" }), sub("sa2-sa1", { project: "beta" }),
    sub("role-coder"), sub("sa9-x", { status: "done" }),
  ];
  const layout = org.orgLayoutModel(org.orgBuildModel(subs, "bridge", registry, null, NOW));

  test("same input -> identical output (no physics, no randomness)", () => {
    const again = org.orgLayoutModel(org.orgBuildModel(subs, "bridge", registry, null, NOW));
    assert.equal(JSON.stringify(layout), JSON.stringify(again));
  });
  test("rows: coordinator 0, projects 1, agents below; spawn depth kept as dN label", () => {
    const { padTop, rowH } = org.ORG_LAYOUT;
    assert.equal(layout.coordinator.y, padTop);
    const byId = new Map(layout.nodes.map((n) => [n.id, n]));
    for (const n of layout.nodes) assert.equal(n.y, padTop + n.row * rowH);
    assert.equal(byId.get("__proj:alpha")!.row, 1);
    assert.equal(byId.get("sa1")!.row, 2);
    assert.equal(byId.get("sa1")!.depth, 0);
    assert.equal(byId.get("sa1-a-b")!.depth, 2);
    assert.equal(layout.maxDepth, 2);
  });
  test("parents center over their children (projects over agents, agents over children)", () => {
    const byId = new Map(layout.nodes.map((n) => [n.id, n]));
    for (const n of layout.nodes) {
      if (!n.childIds.length) continue;
      const xs = n.childIds.map((c) => byId.get(c)!.x);
      assert.ok(n.x >= Math.min(...xs) && n.x <= Math.max(...xs), `${n.id} not over its children`);
    }
  });
  test("same-row nodes never overlap (mixed capsule/box widths)", () => {
    const rows = new Map<number, Array<{ x: number; w: number }>>();
    for (const n of layout.nodes) {
      if (!rows.has(n.y)) rows.set(n.y, []);
      rows.get(n.y)!.push({ x: n.x, w: n.w });
    }
    for (const row of rows.values()) {
      row.sort((a, b) => a.x - b.x);
      for (let i = 1; i < row.length; i++) {
        const gap = row[i].x - row[i - 1].x;
        assert.ok(gap >= org.ORG_LAYOUT.projW, `overlap: centers ${row[i - 1].x} vs ${row[i].x} (gap ${gap})`);
      }
    }
  });
  test("typed edges: entry from coordinator, crew_of to agents (dashed when parent not in scan), spawn between agents", () => {
    const byKey = new Map(layout.edges.map((e) => [e.key, e]));
    assert.equal(byKey.get("__coord__>__proj:alpha")!.kind, "entry");
    assert.equal(byKey.get("__proj:alpha>sa1")!.kind, "crew_of");
    assert.equal(byKey.get("__proj:alpha>sa1")!.dashed, false);
    assert.equal(byKey.get("__proj:bridge>sa9-x")!.kind, "crew_of");
    assert.equal(byKey.get("__proj:bridge>sa9-x")!.dashed, true); // prefix-parent sa9 not in scan
    assert.equal(byKey.get("sa1>sa1-a")!.kind, "spawn");
    assert.equal(layout.edges.filter((e) => e.kind === "entry").length, 4); // alpha, beta, gamma (working) + bridge bucket
  });
  test("natural id order: sa2 sorts before sa10", () => {
    assert.ok(org.orgNaturalCompare("sa2", "sa10") < 0);
    assert.ok(org.orgNaturalCompare("sa10", "sa2") > 0);
  });
});

describe("fit-to-panel scaling", () => {
  test("fit never upscales and is the default applied scale", () => {
    const r = org.orgFitScale(1000, 200, 800, 600, 1);
    assert.equal(r.fit, 0.8);
    assert.equal(r.applied, 0.8);
  });
  test("height can be the binding dimension on wide short panels", () => {
    const r = org.orgFitScale(400, 400, 1200, 300, 1);
    assert.equal(r.fit, 0.75);
  });
  test("small trees never upscale past 100%", () => {
    const r = org.orgFitScale(160, 68, 1200, 700, 1);
    assert.equal(r.fit, 1);
    assert.equal(r.applied, 1);
  });
  test("downscale floors; zoom clamps to [floor, max] in applied terms", () => {
    const r = org.orgFitScale(20000, 300, 390, 600, 1);
    assert.equal(r.fit, org.ORG_FIT_FLOOR); // extreme width keeps the floor, panel pans
    const zin = org.orgFitScale(1000, 200, 800, 600, 10);
    assert.equal(zin.applied, org.ORG_ZOOM_MAX);
    const zout = org.orgFitScale(1000, 200, 800, 600, 0.001);
    assert.equal(zout.applied, org.ORG_FIT_FLOOR);
  });
  test("degenerate panels stay safe", () => {
    const r = org.orgFitScale(1000, 200, 0, 0, 1);
    assert.equal(r.fit, 1);
    assert.equal(r.applied, 1);
  });
});

describe("idle layout and subtree focus", () => {
  const registry = [{ id: "alpha", displayName: "Alpha Colony", lastActivity: iso(60_000) }];
  test("idle model: coordinator only, no edges, compact canvas", () => {
    const idle = org.orgLayoutModel(org.orgBuildModel([], "bridge", registry, null, NOW));
    assert.equal(idle.nodes.length, 0);
    assert.equal(idle.edges.length, 0);
    assert.ok(idle.coordinator.x > 0);
    assert.ok(idle.width < 400);
  });
  test("clicking a project node highlights exactly its subtree (agents + edges)", () => {
    const model = org.orgLayoutModel(org.orgBuildModel(
      [sub("sa1", { project: "alpha" }), sub("sa1-a", { project: "alpha" }), sub("sa1-a-b", { project: "alpha" }), sub("sa2", { project: "beta" })],
      "bridge", registry, null, NOW,
    ));
    const proj = org.orgFocusClosure(model, "__proj:alpha");
    assert.deepEqual([...proj.nodes].sort(), ["__coord__", "__proj:alpha", "sa1", "sa1-a", "sa1-a-b"]);
    assert.ok(proj.edges.has("__coord__>__proj:alpha"));
    assert.ok(proj.edges.has("__proj:alpha>sa1"));
    assert.ok(proj.edges.has("sa1>sa1-a"));
    assert.ok(proj.edges.has("sa1-a>sa1-a-b"));
    assert.ok(!proj.nodes.has("sa2"));
    assert.ok(!proj.edges.has("__proj:beta>sa2"));
  });
  test("agent focus still walks up to the coordinator and down its subtree", () => {
    const model = org.orgLayoutModel(org.orgBuildModel(
      [sub("sa1", { project: "alpha" }), sub("sa1-a", { project: "alpha" }), sub("sa1-a-b", { project: "alpha" }), sub("sa2", { project: "beta" })],
      "bridge", registry, null, NOW,
    ));
    const deep = org.orgFocusClosure(model, "sa1-a-b");
    assert.deepEqual([...deep.nodes].sort(), ["__coord__", "__proj:alpha", "sa1", "sa1-a", "sa1-a-b"]);
    assert.ok(deep.edges.has("sa1-a>sa1-a-b"));
    const coord = org.orgFocusClosure(model, "__coord__");
    assert.deepEqual([...coord.nodes], ["__coord__"]);
    assert.equal(coord.edges.size, 0);
  });
});
