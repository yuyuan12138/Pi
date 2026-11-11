import { test, describe } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

// The org-graph model is a pure-logic block embedded in the single-file UI
// (src/index.html) between ORG-GRAPH-PURE markers: lineage derivation, tree
// building, role badges and the deterministic depth-banded layout. It is
// extracted here and evaluated without a DOM — SVG rendering itself is
// intentionally not tested.
const here = dirname(fileURLToPath(import.meta.url));
const html = readFileSync(join(here, "..", "src", "index.html"), "utf8");
const match = /\/\* ORG-GRAPH-PURE:BEGIN \*\/([\s\S]*?)\/\* ORG-GRAPH-PURE:END \*\//.exec(html);
if (!match) throw new Error("ORG-GRAPH-PURE block not found in src/index.html");
const org = new Function(
  `${match[1]}; return { ORG_ROLES, ORG_ROLE_GROUPS, ORG_UNATTRIBUTED, orgRoleGroupOf, orgDeriveParent, orgClassifyRole, orgNaturalCompare, orgAttribution, orgGroupByProject, orgProjectHue, orgBuildTree, orgLayoutTree, ORG_LAYOUT, ORG_FIT_FLOOR, ORG_ZOOM_MAX, orgFitScale, orgFocusClosure };`,
)() as {
  ORG_ROLES: string[];
  ORG_ROLE_GROUPS: Array<{ id: string; name: string; roles: string[] }>;
  orgRoleGroupOf: (role: string) => { id: string; name: string; roles: string[] } | null;
  orgDeriveParent: (id: string, ids: Set<string>) => { parent: string | null; known: boolean };
  orgClassifyRole: (id: string, label: string | null, session: string | null) => string | null;
  ORG_UNATTRIBUTED: string;
  orgAttribution: (sub: { project?: unknown } | null, bridgeProject: string | null) => string | null;
  orgGroupByProject: (subs: Array<Record<string, unknown>>, bridgeProject: string | null) => { keys: string[]; groups: Map<string, Array<Record<string, unknown>>> };
  orgProjectHue: (name: string | null) => number;
  orgNaturalCompare: (a: string, b: string) => number;
  orgBuildTree: (subs: Array<Record<string, unknown>>, bridgeProject?: string | null) => {
    nodes: Map<string, Node & { children: Node[]; depth: number; parent: string | null; parentHint: string | null; role: string | null; project: string | null }>;
    roots: Node[];
    maxDepth: number;
  };
  orgLayoutTree: (tree: ReturnType<typeof org.orgBuildTree>) => {
    coordinator: { id: string; x: number; y: number };
    nodes: Array<{ id: string; x: number; y: number; depth: number; parent: string | null; parentHint: string | null; role: string | null; status: string; project: string | null; childIds: string[] }>;
    edges: Array<{ from: string; to: string; dashed: boolean; key: string }>;
    width: number;
    height: number;
    maxDepth: number;
  };
  ORG_LAYOUT: { nodeW: number; gapX: number; rowH: number; padTop: number };
  ORG_FIT_FLOOR: number;
  ORG_ZOOM_MAX: number;
  orgFitScale: (width: number, height: number, panelW: number, panelH: number, zoom?: number) => { fit: number; applied: number };
  orgFocusClosure: (model: ReturnType<typeof org.orgLayoutTree>, id: string) => { nodes: Set<string>; edges: Set<string> };
};

interface Node {
  id: string;
  status: string;
  parent: string | null;
  parentHint: string | null;
  knownParent: boolean;
  role: string | null;
  depth: number;
  children: Node[];
}

const sub = (id: string, extra: Record<string, unknown> = {}) => ({ id, status: "running", ...extra });

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
    assert.equal(org.orgClassifyRole("sa5", "run the deployment drill as operator", null), "operator");
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
    assert.equal(groups.get("bridge")![0].id, "sa2");
    const un = org.orgGroupByProject([sub("sa9")], null);
    assert.deepEqual(un.keys, [org.ORG_UNATTRIBUTED]);
    assert.equal(un.groups.get(org.ORG_UNATTRIBUTED)!.length, 1);
  });
  test("project hue: deterministic and never in the signal-green band", () => {
    assert.equal(org.orgProjectHue("alpha"), org.orgProjectHue("alpha"));
    for (let i = 0; i < 300; i++) {
      const h = org.orgProjectHue(`project-${i}`);
      assert.ok(h >= 0 && h < 360 && !(h >= 130 && h <= 185), `hue ${h} for project-${i}`);
    }
    assert.equal(org.orgProjectHue(null), org.orgProjectHue("")); // degenerate inputs still stable
  });
  test("buildTree carries attribution; bridge inheritance applies", () => {
    const tree = org.orgBuildTree([sub("sa1", { project: "alpha" }), sub("sa2")], "bridge");
    assert.equal(tree.nodes.get("sa1")!.project, "alpha");
    assert.equal(tree.nodes.get("sa2")!.project, "bridge");
    const noBridge = org.orgBuildTree([sub("sa2")]);
    assert.equal(noBridge.nodes.get("sa2")!.project, null);
  });
  test("layout passes project through for the tint pass", () => {
    const model = org.orgLayoutTree(org.orgBuildTree([sub("sa1", { project: "alpha" })], "bridge"));
    assert.equal(model.nodes[0].project, "alpha");
  });
});

describe("spawn tree building", () => {
  test("depth emerges from lineage, branch by branch (uneven tree)", () => {
    const tree = org.orgBuildTree([
      sub("sa13"), sub("sa13-a"), sub("sa13-b"),
      sub("sa2"), sub("sa2-sa1"), sub("sa2-sa1-c"),
      sub("sa1"), sub("role-coder"),
    ]);
    assert.equal(tree.nodes.get("sa13")!.depth, 0);
    assert.equal(tree.nodes.get("sa13-a")!.depth, 1);
    assert.equal(tree.nodes.get("sa2-sa1")!.depth, 1);
    assert.equal(tree.nodes.get("sa2-sa1-c")!.depth, 2);
    assert.equal(tree.nodes.get("sa1")!.depth, 0);
    assert.equal(tree.maxDepth, 2); // variance: one branch d2, another d0
    assert.equal(tree.roots.length, 4);
    assert.deepEqual(tree.nodes.get("sa13")!.children.map((c) => c.id).sort(), ["sa13-a", "sa13-b"]);
  });
  test("unknown-parent id stays an honest depth-0 root with parentHint", () => {
    const tree = org.orgBuildTree([sub("sa9-x")]);
    const n = tree.nodes.get("sa9-x")!;
    assert.equal(n.parent, null);
    assert.equal(n.parentHint, "sa9");
    assert.equal(n.depth, 0);
    assert.equal(tree.maxDepth, 0);
  });
  test("project view: parents from other projects become honest dashed roots", () => {
    // in alpha's view, sa2 (beta) is absent, so sa2-sa1's parent is not in the subset
    const tree = org.orgBuildTree([sub("sa2-sa1", { project: "alpha" })], "bridge");
    const n = tree.nodes.get("sa2-sa1")!;
    assert.equal(n.parent, null);
    assert.equal(n.parentHint, "sa2");
    assert.equal(n.depth, 0);
  });
  test("empty scan -> no nodes, idle model", () => {
    const tree = org.orgBuildTree([]);
    assert.equal(tree.roots.length, 0);
    assert.equal(tree.nodes.size, 0);
  });
});

describe("deterministic depth-banded layout", () => {
  const subs = [
    sub("sa13", { status: "done" }), sub("sa13-a", { status: "running" }), sub("sa13-b", { status: "blocked" }),
    sub("sa2", { status: "blocked" }), sub("sa2-sa1", { status: "done" }),
    sub("sa1", { status: "running" }), sub("role-coder", { status: "running" }),
    sub("sa9-x", { status: "done" }),
  ];
  const model = org.orgLayoutTree(org.orgBuildTree(subs));

  test("same input -> identical output (no physics, no randomness)", () => {
    const again = org.orgLayoutTree(org.orgBuildTree(subs));
    assert.equal(JSON.stringify(model), JSON.stringify(again));
  });
  test("rows are depth bands; coordinator is the entry row", () => {
    const { padTop, rowH } = org.ORG_LAYOUT;
    assert.equal(model.coordinator.y, padTop);
    for (const n of model.nodes) assert.equal(n.y, padTop + (n.depth + 1) * rowH);
    assert.equal(model.maxDepth, 1);
  });
  test("parents center over their children", () => {
    const byId = new Map(model.nodes.map((n) => [n.id, n]));
    for (const n of model.nodes) {
      if (!n.childIds.length) continue;
      const xs = n.childIds.map((c) => byId.get(c)!.x);
      assert.ok(n.x >= Math.min(...xs) && n.x <= Math.max(...xs), `${n.id} not over its children`);
    }
  });
  test("same-row nodes never overlap", () => {
    const rows = new Map<number, number[]>();
    for (const n of model.nodes) {
      if (!rows.has(n.y)) rows.set(n.y, []);
      rows.get(n.y)!.push(n.x);
    }
    for (const xs of rows.values()) {
      xs.sort((a, b) => a - b);
      for (let i = 1; i < xs.length; i++) {
        assert.ok(xs[i] - xs[i - 1] >= org.ORG_LAYOUT.nodeW, `overlap at y=${rows}: ${xs[i - 1]} vs ${xs[i]}`);
      }
    }
  });
  test("edges: dispatch from coordinator (dashed when parent not in scan), spawn edges from parents", () => {
    const byKey = new Map(model.edges.map((e) => [e.key, e]));
    assert.equal(byKey.get("__coord__>sa9-x")!.dashed, true);
    assert.equal(byKey.get("__coord__>sa13")!.dashed, false);
    assert.equal(byKey.get("sa13>sa13-a")!.dashed, false);
    assert.ok(byKey.has("sa2>sa2-sa1"));
    assert.equal(model.edges.length, 8); // 4 dispatch + 4 spawn edges
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

describe("idle and focus behavior", () => {
  test("idle model: coordinator only, no edges, compact canvas", () => {
    const idle = org.orgLayoutTree(org.orgBuildTree([]));
    assert.equal(idle.nodes.length, 0);
    assert.equal(idle.edges.length, 0);
    assert.ok(idle.coordinator.x > 0);
    assert.ok(idle.width < 400);
  });
  test("focus closure walks up to the coordinator and down the subtree", () => {
    const model = org.orgLayoutTree(org.orgBuildTree([
      sub("sa13"), sub("sa13-a"), sub("sa13-a-b"), sub("sa1"),
    ]));
    const deep = org.orgFocusClosure(model, "sa13-a-b");
    assert.deepEqual([...deep.nodes].sort(), ["__coord__", "sa13", "sa13-a", "sa13-a-b"]);
    assert.ok(deep.edges.has("sa13>sa13-a"));
    assert.ok(deep.edges.has("sa13-a>sa13-a-b"));
    assert.ok(deep.edges.has("__coord__>sa13"));
    const root = org.orgFocusClosure(model, "sa13");
    assert.ok(root.edges.has("sa13>sa13-a"));
    assert.ok(root.edges.has("sa13-a>sa13-a-b"));
    assert.ok(root.nodes.has("sa13-a-b"));
    assert.ok(!root.edges.has("__coord__>sa1"));
    assert.ok(!root.nodes.has("sa1"));
    const coord = org.orgFocusClosure(model, "__coord__");
    assert.deepEqual([...coord.nodes], ["__coord__"]);
    assert.equal(coord.edges.size, 0);
  });
});
