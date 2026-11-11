import { test, describe } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

// The org-graph model is a pure-logic block embedded in the single-file UI
// (src/index.html) between ORG-GRAPH-PURE markers: lineage derivation, the
// coordinator -> project capsules -> INSTANCE nodes (aggregated dispatches)
// hierarchy, role badges, fit scaling and the deterministic layouts. It is
// extracted here and evaluated without a DOM — SVG rendering is not tested.
const here = dirname(fileURLToPath(import.meta.url));
const html = readFileSync(join(here, "..", "src", "index.html"), "utf8");
const match = /\/\* ORG-GRAPH-PURE:BEGIN \*\/([\s\S]*?)\/\* ORG-GRAPH-PURE:END \*\//.exec(html);
if (!match) throw new Error("ORG-GRAPH-PURE block not found in src/index.html");
const org = new Function(
  `${match[1]}; return { ORG_ROLES, ORG_ROLE_GROUPS, ORG_UNATTRIBUTED, ORG_WORKING_MS, ORG_DIM_MS, ORG_DEFAULT_EXPAND_ROW, ORG_CREW_SESSION_ROLES, ORG_CREW_DISPATCH_ROLES, ORG_CREW_DISPATCH_PROJECTS, ORG_SUBPROJECT_SNAPSHOT, ORG_CREW_NAME_SNAPSHOT, ORG_PSEUDO_PROJECTS, orgSubprojectTree, orgSubprojectPathOf, orgCrewNameOf, orgCrewNameFromLabels, orgFitCrewLabel, orgEnPhrase, orgActivityText, orgBuildInvocationTree, orgLayoutTree, orgRoleGroupOf, orgDeriveParent, orgProjectOf, orgRoleShort, orgTruncW, orgClassifyRole, orgNaturalCompare, orgTrunc, orgNodeRole, orgAttribution, orgGroupByProject, orgProjectHue, orgLabelPrefix, orgDayOf, orgInstanceKeyOf, orgRegistryWorking, orgSubprojectTarget, orgHumanDay, orgRealSession, orgBuildModel, orgLayoutModel, orgLayoutVertical, ORG_LAYOUT, ORG_FIT_FLOOR, ORG_ZOOM_MAX, orgFitScale, orgFocusClosure };`,
)() as {
  ORG_ROLES: string[];
  ORG_ROLE_GROUPS: Array<{ id: string; name: string; roles: string[] }>;
  ORG_UNATTRIBUTED: string;
  ORG_WORKING_MS: number;
  ORG_DIM_MS: number;
  ORG_DEFAULT_EXPAND_ROW: number;
  ORG_CREW_SESSION_ROLES: Record<string, string>;
  ORG_CREW_DISPATCH_ROLES: Record<string, string>;
  orgNodeRole: (id: string, label: string | null, session: string | null, sessionById: Map<string, string> | null) => string | null;
  orgRoleGroupOf: (role: string) => { id: string; name: string; roles: string[] } | null;
  orgDeriveParent: (id: string, ids: Set<string>) => { parent: string | null; known: boolean };
  orgClassifyRole: (id: string, label: string | null, session: string | null) => string | null;
  orgNaturalCompare: (a: string, b: string) => number;
  orgTrunc: (s: string | null, n: number) => string;
  orgAttribution: (sub: { project?: unknown; id?: unknown; label?: unknown; session?: unknown } | null, registry: Array<Record<string, unknown>> | null, sessionById: Map<string, string> | null) => string | null;
  orgProjectOf: (sub: { project?: unknown; id?: unknown; label?: unknown; session?: unknown } | null, registry: Array<Record<string, unknown>> | null, sessionById: Map<string, string> | null) => string | null;
  orgRoleShort: (w: unknown) => string | null;
  orgTruncW: (s: unknown, maxUnits: number) => string;
  ORG_SUBPROJECT_SNAPSHOT: Array<{ project: string; id: string; displayName: string; tokens: string[] }>;
  orgSubprojectTree: (entry: Record<string, unknown> | null, key: string) => Array<Record<string, unknown>>;
  orgSubprojectPathOf: (s: Record<string, unknown> | null, tree: Array<Record<string, unknown>>) => string[] | null;
  ORG_CREW_NAME_SNAPSHOT: Array<{ ids: string[]; name: string }>;
  ORG_PSEUDO_PROJECTS: Record<string, { displayName: string; aliases: string[]; muted?: boolean }>;
  orgCrewNameOf: (members: Array<{ sub: { id: unknown; label?: unknown } }> | null) => string | null;
  orgCrewNameFromLabels: (labels: Array<unknown>) => string | null;
  orgFitCrewLabel: (base: unknown, count: number) => string;
  orgEnPhrase: (s: unknown) => string | null;
  orgActivityText: (s: unknown) => string | null;
  orgBuildInvocationTree: (subs: Array<Record<string, unknown>>, registry: Array<Record<string, unknown>> | null, view: string | null, nowMs?: number, sessionById?: Map<string, string> | null) => {
    nodes: Map<string, Record<string, unknown> & { id: string; kind: string; parent: string | null; children: Array<unknown>; row: number; sub?: string | null; display?: string | null; depth?: number | null; x?: number; y?: number }>;
    projKeys: string[];
    rootIds: string[];
  };
  orgLayoutTree: (model: unknown, wrapWidth: number, isExpanded: (id: string) => boolean) => {
    nodes: Array<Record<string, unknown> & { id: string; x?: number; y?: number }>;
    edges: Array<{ from: string; to: string; kind: string; key: string }>;
    width: number;
    height: number;
  };
  orgGroupByProject: (subs: Array<Record<string, unknown>>, registry: Array<Record<string, unknown>> | null, sessionById: Map<string, string> | null) => { keys: string[]; groups: Map<string, Array<Record<string, unknown>>> };
  orgProjectHue: (name: string | null) => number;
  orgLabelPrefix: (label: string | null) => string | null;
  orgDayOf: (ts: unknown) => string;
  orgInstanceKeyOf: (sub: Record<string, unknown> | null, sessionById: Map<string, string> | null) => { basis: "session" | "prefix" | "day"; key: string; label: string };
  orgHumanDay: (ts: unknown, nowMs: number) => string | null;
  orgRealSession: (sess: unknown) => string | null;
  orgRegistryWorking: (entry: Record<string, unknown> | null, nowMs: number) => boolean;
  orgSubprojectTarget: (sub: Record<string, unknown> | null, registry: Array<Record<string, unknown>>) => { project: string; subproject: string } | null;
  orgBuildModel: (subs: Array<Record<string, unknown>>, bridgeProject: string | null, registry: Array<Record<string, unknown>> | null, view: string | null, nowMs: number, sessionById?: Map<string, string> | null) => {
    nodes: Map<string, HNode>;
    projKeys: string[];
    maxRow: number;
    maxSpawnDepth: number;
  };
  orgLayoutModel: (model: ReturnType<typeof org.orgBuildModel>, isExpanded?: (id: string) => boolean) => OrgLayout;
  orgLayoutVertical: (model: ReturnType<typeof org.orgBuildModel>, wrapWidth: number, isExpanded?: (id: string) => boolean) => OrgLayout;
  ORG_LAYOUT: { nodeW: number; projW: number; gapX: number; rowH: number; subH: number; padX: number; padTop: number };
  ORG_FIT_FLOOR: number;
  ORG_ZOOM_MAX: number;
  orgFitScale: (width: number, height: number, panelW: number, panelH: number, zoom?: number, mode?: "v" | "h") => { fit: number; applied: number };
  orgFocusClosure: (model: OrgLayout, id: string) => { nodes: Set<string>; edges: Set<string> };
};

interface HNode {
  id: string;
  kind: "project" | "subproject" | "instance" | "agent";
  status?: string | null;
  parent: string | null;
  parentHint: string | null;
  hostId?: string | null;
  project: string;
  subproject?: string | null;
  depth: number | null;
  row: number;
  children: HNode[];
  display?: string | null;
  sub?: string | null;
  session?: string | null;
  role?: string | null;
  count?: number;
  basis?: "session" | "prefix" | "day";
  dim?: boolean;
  memberIds?: string[];
  registry?: Record<string, unknown> | null;
}

interface OrgLayout {
  coordinator: { id: string; x: number; y: number };
  nodes: Array<{
    id: string; kind: "project" | "subproject" | "instance" | "agent"; x: number; y: number; w: number; h: number; row: number;
    depth: number | null; parent: string | null; parentHint: string | null; hostId: string | null; project: string;
    display: string | null; sub: string | null; status: string | null; childIds: string[];
    collapsible: boolean; collapsed: boolean; hiddenCount: number;
    count: number | null; basis: "session" | "prefix" | "day" | null; session: string | null; dim: boolean; memberIds: string[] | null;
  }>;
  edges: Array<{ from: string; to: string; kind: "entry" | "crew_of" | "dispatch" | "spawn" | "sub"; dashed: boolean; key: string; d: string }>;
  width: number;
  height: number;
  maxDepth: number;
}

const NOW = 1_700_000_000_000;
const sub = (id: string, extra: Record<string, unknown> = {}) => ({ id, status: "running", ...extra });
const iso = (msAgo: number) => new Date(NOW - msAgo).toISOString();
const parsePath = (d: string): { xs: number[]; ys: number[] } => {
  const xs: number[] = [];
  const ys: number[] = [];
  for (const [, cmd, args] of d.matchAll(/([MHV])\s*([\d.\- ]+)/g)) {
    const nums = args.trim().split(/\s+/).map(Number);
    if (cmd === "H") xs.push(...nums);
    else if (cmd === "V") ys.push(...nums);
    else nums.forEach((v, i) => (i % 2 === 0 ? xs : ys).push(v));
  }
  return { xs, ys };
};

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
  test("explicit per-sub project wins; the bridge's own project is NOT a fallback", () => {
    assert.equal(org.orgAttribution({ project: "alpha" }, [], null), "alpha");
    assert.equal(org.orgAttribution({ project: "  beta  " }, null, null), "beta");
    assert.equal(org.orgAttribution({ project: "   " }, [], null), null); // blank is not attribution
    assert.equal(org.orgAttribution({}, [], null), null); // no evidence -> honest unattributed
  });
  test("session @project segment resolves against registry + manifest pseudo-projects", () => {
    const registry = [{ id: "minecraft", displayName: "MC", aliases: [], root: "" }];
    assert.equal(org.orgProjectOf({ id: "x1", session: "role-tech-lead@minecraft.rsi" }, registry, null), "minecraft");
    assert.equal(org.orgProjectOf({ id: "x2", session: "role-coder-2@PiAgents.bridge" }, registry, null), "PiAgents.bridge");
  });
  test("manifest snapshot: dispatch id + task token (reused ids need the token)", () => {
    assert.equal(org.orgProjectOf({ id: "sa13-a", label: "Remove the recursive-spawn depth cap in the pi-superagent extension" }, [], null), "PiAgents.harness");
    // sa14 was BOTH minecraft RSI fixes and an AGENT-ORG design pass — token decides
    assert.equal(org.orgProjectOf({ id: "sa14", label: "任务：closed-loop RSI driver defect fixes (wave_loop.py)" }, [], null), "minecraft");
    assert.equal(org.orgProjectOf({ id: "sa14", label: "任务：AGENT-ORG rev: decomposition protocol" }, [], null), "PiAgents-org");
    // same id, unrelated label -> no attribution (never yesterday's project)
    assert.equal(org.orgProjectOf({ id: "sa14", label: "任务：在飞书里给 bot 发一条测试消息" }, [], null), null);
  });
  test("PRIMARY-DELIVERABLE rule supersedes cross-project for documented rows", () => {
    const registry = [
      { id: "medical", displayName: "Medical platform", root: "", aliases: ["medical", "医疗"] },
      { id: "minecraft", displayName: "MC", root: "", aliases: ["minecraft", "mc"] },
      { id: "blog", displayName: "Blog", root: "", aliases: ["blog"] },
    ];
    // the weekly-report docx PRODUCES an org document -> PiAgents-org, even
    // though its text mentions MC and 医疗平台
    assert.equal(org.orgProjectOf({ id: "sa16", label: "任务：在飞书新建一个 docx 文档《组会汇报》，整理 MC 和医疗平台的工作" }, registry, null), "PiAgents-org");
    // blog drafts name minecraft content, but the DELIVERABLE is the post -> blog
    assert.equal(org.orgProjectOf({ id: "sa80", label: "You are the writer role. Draft a blog post about the user's personal Pi-agent architecture; the MC RSI story is background" }, registry, null), "blog");
    assert.equal(org.orgProjectOf({ id: "sa82", label: "The user rejected the first draft of the Pi-agent blog post. Rewrite both versions." }, registry, null), "blog");
    // personal ops: fits no registered project
    assert.equal(org.orgProjectOf({ id: "sa56", label: "Render the final LoL highlights compilation" }, registry, null), "personal-ops");
    assert.equal(org.orgProjectOf({ id: "sa90", label: "Reconcile a WeChat bill export into the user's WPS cloud ledger" }, registry, null), "personal-ops");
    // the cross-project rule still applies where no deliverable row exists
    assert.equal(org.orgProjectOf({ id: "w9", label: "任务：按甲方规范改医疗管理系统的筛查判别逻辑" }, registry, null), "medical");
    assert.equal(org.orgProjectOf({ id: "wx", label: "任务：整理 MC 和医疗平台的工作纪要" }, registry, null), null); // undocumented two-mention label
  });
  test("personal-ops bucket: muted pseudo-project, absent when empty", () => {
    assert.equal(org.ORG_PSEUDO_PROJECTS["personal-ops"].muted, true);
    const registry = [{ id: "alpha", displayName: "Alpha Colony", lastActivity: iso(60_000) }];
    const withPersonal = org.orgBuildModel([sub("sa56", { label: "Render the final LoL highlights compilation" })], "bridge", registry, null, NOW);
    assert.ok(withPersonal.projKeys.includes("personal-ops"));
    assert.ok(!withPersonal.projKeys.includes(org.ORG_UNATTRIBUTED), "unattributed bucket dissolved");
    // a build with NO personal/unattributed dispatches renders neither bucket
    const clean = org.orgBuildModel([sub("s1", { project: "alpha" })], "bridge", registry, null, NOW);
    assert.ok(!clean.projKeys.includes("personal-ops"));
    assert.ok(!clean.projKeys.includes(org.ORG_UNATTRIBUTED));
  });
  test("label evidence: registry root paths and aliases (word-boundary for ASCII)", () => {
    const registry = [
      { id: "medical", displayName: "Medical platform", root: "/Users/yuyuan/projects/mobile-medical/medical-system", aliases: ["medical", "医疗"] },
      { id: "minecraft", displayName: "MC", root: "/Users/yuyuan/PiAgents/remote-agent/operations/20261029", aliases: ["minecraft", "mc"] },
    ];
    assert.equal(org.orgProjectOf({ id: "w1", label: "任务：按甲方规范改医疗管理系统的筛查判别逻辑" }, registry, null), "medical");
    assert.equal(org.orgProjectOf({ id: "w2", label: "Wave-33 HOT: replace the staircase-pit doctrine" }, registry, null), "minecraft");
    assert.equal(org.orgProjectOf({ id: "w3", label: "Review the quarterly numbers carefully" }, registry, null), null); // no alias hit -> null
    assert.equal(org.orgProjectOf({ id: "w4", label: "Design the org-graph page mockup" }, registry, null), "PiAgents.bridge"); // pseudo-project alias
  });
  test("grouping: attributed keys sorted, unattributed last, never guessed", () => {
    const { keys, groups } = org.orgGroupByProject(
      [sub("sa3", { project: "beta" }), sub("sa1", { project: "alpha" }), sub("sa2")],
      [],
      null,
    );
    assert.deepEqual(keys, ["alpha", "beta", org.ORG_UNATTRIBUTED]);
    assert.equal(groups.get("alpha")![0].id, "sa1");
    const un = org.orgGroupByProject([sub("sa9")], null, null);
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

describe("instance aggregation key (session -> shared label prefix -> dispatch day)", () => {
  test("explicit session wins; the main-log join map is honored", () => {
    assert.deepEqual(org.orgInstanceKeyOf({ id: "sa1", session: "bridge-org-x1" }, null), { basis: "session", key: "sess:bridge-org-x1", label: "bridge-org-x1" });
    const join = new Map([["sa2", "bridge-org-x1"]]);
    assert.deepEqual(org.orgInstanceKeyOf({ id: "sa2" }, join), { basis: "session", key: "sess:bridge-org-x1", label: "bridge-org-x1" });
    const empty = new Map<string, string>();
    assert.equal(org.orgInstanceKeyOf({ id: "sa2" }, empty).basis, "day"); // no label -> dispatch day
  });
  test("shared label prefix (>= 6 chars) is the first fallback", () => {
    assert.equal(org.orgInstanceKeyOf({ id: "sa1", label: "Review the quarterly numbers carefully" }, null).basis, "prefix");
    assert.match(org.orgInstanceKeyOf({ id: "sa1", label: "Review the quarterly numbers carefully" }, null).key, /^pre:review the quarterly/);
  });
  test("dispatch day is the last fallback; short/missing labels go straight to day", () => {
    const day = org.orgInstanceKeyOf({ id: "sa1", label: "hi", lastActivity: NOW }, null);
    assert.equal(day.basis, "day");
    assert.match(day.key, /^day:\d{4}-\d{2}-\d{2}$/);
    assert.equal(org.orgInstanceKeyOf({ id: "sa1" }, null).label, "undated");
  });
  test("orgDayOf is deterministic per local calendar day", () => {
    assert.equal(org.orgDayOf(NOW), org.orgDayOf(NOW + 3600e3));
  });
  test("orgTrunc ellipsizes", () => {
    assert.equal(org.orgTrunc("abcdefgh", 5), "abcd\u2026");
    assert.equal(org.orgTrunc("abc", 5), "abc");
  });
});

describe("humanized label rules (no raw keys ever)", () => {
  test("orgHumanDay: today / same-year Mon DD / older year with year / unknown", () => {
    assert.equal(org.orgHumanDay(NOW, NOW), "today");
    const sameYear = org.orgHumanDay(NOW - 3 * 86400e3, NOW);
    assert.match(sameYear!, /^(Nov|Dec|Oct) \d{1,2}$/); // short month + day, no year, tz-safe
    assert.match(org.orgHumanDay(NOW - 400 * 86400e3, NOW)!, /^(Jan|Feb|Mar|Apr|May|Jun|Jul|Aug|Sep|Oct|Nov|Dec) \d{1,2}, 2022$/); // older year keeps the year
    assert.equal(org.orgHumanDay(undefined, NOW), null);
  });
  test("orgRealSession: dates and letter-less ids are not real sessions", () => {
    assert.equal(org.orgRealSession("bridge-org-x1"), "bridge-org-x1");
    assert.equal(org.orgRealSession("2026-11-11"), null); // a date is not a session
    assert.equal(org.orgRealSession("12345"), null);
    assert.equal(org.orgRealSession(null), null);
  });
  test("unnamed instance with unknown session renders 'unnamed · <Mon DD>' — never a bare ISO key", () => {
    const registry = [{ id: "alpha", displayName: "Alpha Colony", lastActivity: iso(60_000) }];
    const m = org.orgBuildModel(
      [sub("sa50", { project: "alpha", lastActivity: NOW - 30 * 3600e3 }), sub("sa51", { project: "alpha", lastActivity: NOW - 30 * 3600e3 })],
      "bridge", registry, null, NOW,
    );
    const inst = [...m.nodes.values()].find((n) => n.kind === "instance")!;
    assert.match(inst.display!, /^unnamed \u00b7 [A-Z][a-z]{2} \d{1,2}$/);
    assert.doesNotMatch(inst.display!, /\d{4}-\d{2}-\d{2}/);
    assert.match(inst.sub!, /\u00d72$/);
  });
  test("date-like session ids fall through to the humanized fallback", () => {
    const registry = [{ id: "alpha", displayName: "Alpha Colony", lastActivity: iso(60_000) }];
    const m = org.orgBuildModel(
      [sub("sa99", { project: "alpha", session: "2026-11-11", lastActivity: NOW - 3600e3 })],
      "bridge", registry, null, NOW,
    );
    const inst = [...m.nodes.values()].find((n) => n.kind === "instance")!;
    assert.match(inst.display!, /^unnamed \u00b7 /);
  });
  test("dispatch subtitle: role, else 'dispatch' — never a lone em dash", () => {
    const registry = [{ id: "alpha", displayName: "Alpha Colony", lastActivity: iso(60_000) }];
    const m = org.orgBuildModel(
      [sub("sa16", { project: "alpha" }), sub("sa42", { project: "alpha" })],
      "bridge", registry, null, NOW,
    );
    assert.equal(m.nodes.get("sa16")!.sub, "coder.frontend");
    assert.equal(m.nodes.get("sa42")!.sub, "dispatch");
  });
});

describe("recursive subproject hierarchy", () => {
  const TREE = [
    { id: "core", displayName: "Core Pipeline", aliases: [], tokens: [], children: [
      { id: "parser", displayName: "Parser", aliases: ["parser"], tokens: [], children: [] },
    ] },
    { id: "ops", displayName: "Ops", aliases: [], tokens: [], children: [] },
  ];
  test("orgSubprojectTree: registry tree passes through + snapshot appends + dedupes", () => {
    const tree = org.orgSubprojectTree({ subprojects: TREE }, "alpha");
    assert.deepEqual(tree.map((n) => n.id), ["core", "ops"]);
    const med = org.orgSubprojectTree({}, "medical");
    assert.deepEqual(med.map((n) => n.id), ["three-tier-screening"]); // snapshot-only project
    const both = org.orgSubprojectTree({ subprojects: [{ id: "three-tier-screening", displayName: "TT" }] }, "medical");
    assert.equal(both.length, 1); // snapshot does not duplicate a registry id
  });
  test("orgSubprojectPathOf: explicit id at depth 2, tokens, ambiguity, prefix collapse", () => {
    assert.deepEqual(org.orgSubprojectPathOf({ project: "parser" }, TREE), ["core", "parser"]);
    assert.deepEqual(org.orgSubprojectPathOf({ project: "ops" }, TREE), ["ops"]);
    assert.deepEqual(org.orgSubprojectPathOf({ label: "fix the parser queue" }, TREE), ["core", "parser"]);
    assert.equal(org.orgSubprojectPathOf({ label: "nothing matches here" }, TREE), null);
    // label matches BOTH ops and parser -> ambiguous -> null
    const amb = [{ ...TREE[0], aliases: ["shared"], children: [] }, { ...TREE[1], aliases: ["shared"], children: [] }];
    assert.equal(org.orgSubprojectPathOf({ label: "the shared queue" }, amb), null);
    // ancestor + descendant both match -> collapse to the deeper path
    const deep = [{ id: "core", displayName: "Core", aliases: ["core"], tokens: [], children: [
      { id: "leaf", displayName: "Leaf", aliases: ["core"], tokens: [], children: [] },
    ] }];
    assert.deepEqual(org.orgSubprojectPathOf({ label: "core work" }, deep), ["core", "leaf"]);
    // medical snapshot: label evidence routes to three-tier-screening
    assert.deepEqual(org.orgSubprojectPathOf({ label: "任务：在已有的 feature/three-tier-screening 分支上对齐编码" }, org.orgSubprojectTree({}, "medical")), ["three-tier-screening"]);
  });
  // registry wire format: nested `subprojects` arrays (orgSubprojectTree
  // normalizes them to `children` internally)
  const REG_TREE = [
    { id: "core", displayName: "Core Pipeline", subprojects: [
      { id: "parser", displayName: "Parser", subprojects: [] },
    ] },
    { id: "ops", displayName: "Ops", subprojects: [] },
  ];
  test("orgSubprojectTarget: recursive explicit routing", () => {
    const registry = [{ id: "alpha", displayName: "Alpha", aliases: [], root: "", subprojects: REG_TREE }];
    assert.deepEqual(org.orgSubprojectTarget({ project: "parser" }, registry), { project: "alpha", subproject: "parser" });
    assert.deepEqual(org.orgSubprojectTarget({ project: "core" }, registry), { project: "alpha", subproject: "core" });
    assert.deepEqual(org.orgSubprojectTarget({ project: "alpha" }, registry), null); // the project itself is not a sub
  });
  test("orgProjectOf: an explicit subproject id attributes to its ROOT project", () => {
    const registry = [{ id: "alpha", displayName: "Alpha", aliases: [], root: "", subprojects: REG_TREE }];
    assert.equal(org.orgProjectOf({ id: "w1", project: "parser", label: "" }, registry, null), "alpha");
  });
  test("orgBuildModel: nested crews/dispatches attach to their innermost subproject", () => {
    const registry = [{ id: "alpha", displayName: "Alpha Colony", aliases: [], root: "", lastActivity: iso(60_000), subprojects: REG_TREE }];
    const m = org.orgBuildModel(
      [sub("sa60", { project: "parser" }), sub("sa61", { project: "core" }), sub("sa62", { project: "alpha", label: "plain alpha work" })],
      "bridge", registry, "alpha", NOW,
    );
    const core = m.nodes.get("__sub:alpha:core")!;
    const parser = m.nodes.get("__sub:alpha:core.parser")!;
    assert.ok(core && parser);
    assert.equal(parser.parent, core.id); // sub-sub nests under its parent sub
    const coreInst = core.children.find((c) => c.kind === "instance")!;
    const parserInst = parser.children.find((c) => c.kind === "instance")!;
    const rootInst = (m.nodes.get("__proj:alpha")!.children).find((c) => c.kind === "instance")!;
    assert.ok(coreInst && parserInst && rootInst);
    assert.equal(coreInst.subproject, "core");
    assert.equal(parserInst.subproject, "parser");
    assert.equal(rootInst.subproject, null); // directly under the project
    // instance ids carry the sp trail so same aggregation keys never collide
    assert.match(coreInst.id, /__inst:alpha:core:/);
    assert.match(parserInst.id, /__inst:alpha:core\.parser:/);
  });
  test("orgBuildModel: an empty subproject still renders as a capsule under its parent", () => {
    const registry = [{ id: "alpha", displayName: "Alpha Colony", aliases: [], root: "", lastActivity: iso(60_000), subprojects: TREE }];
    const m = org.orgBuildModel([sub("sa1", { label: "plain work" })], "bridge", registry, "alpha", NOW);
    const ops = m.nodes.get("__sub:alpha:ops")!;
    assert.ok(ops && ops.children.length === 0);
  });
});

describe("crew naming (no 'unnamed' when evidence exists)", () => {
  test("orgCrewNameFromLabels: dominant bigram (the digest-cards example)", () => {
    assert.equal(org.orgCrewNameFromLabels(["digest cards batch 1", "digest cards batch 2", "digest cards queue"]), "digest cards");
    assert.equal(org.orgCrewNameFromLabels(["You are the writer role. Draft a blog post", "You are the writer role. Edit a blog post"]), "blog post");
    // role words are stopwords — never a crew name
    assert.notEqual(org.orgCrewNameFromLabels(["You are the operator role. Restart things", "You are the operator role. Check things"]), "operator");
  });
  test("orgCrewNameFromLabels: no shared token -> null (honest floor)", () => {
    assert.equal(org.orgCrewNameFromLabels(["restart the probe service", "migrate the database schema"]), null);
    assert.equal(org.orgCrewNameFromLabels([null, null]), null);
  });
  test("orgCrewNameOf: snapshot id-set majority, minority falls through", () => {
    const member = (id: string) => ({ sub: { id, label: `unrelated task ${id}` } });
    const wave = ["sa9", "sa12", "sa13"].map(member);
    assert.equal(org.orgCrewNameOf(wave), "feishu mcp"); // 3/3 hit the documented set
    const mixed = ["sa9", "sa12", "sx1", "sx2", "sx3"].map(member);
    assert.notEqual(org.orgCrewNameOf(mixed), "feishu mcp"); // 2/5 = not a majority
    assert.equal(org.orgCrewNameOf([{ sub: { id: "sa40-sa1", label: null } }]), "emo bgm fetch"); // single-member crew
  });
  test("orgFitCrewLabel: the count survives truncation of a long CJK name", () => {
    assert.equal(org.orgFitCrewLabel("feishu mcp", 9), "feishu mcp ·×9");
    const long = "监控一个正在运行的minecraft";
    const out = org.orgFitCrewLabel(long, 2);
    assert.match(out, /·×2$/);
    let units = 0;
    for (const ch of out) { const c = ch.codePointAt(0) ?? 0; units += c >= 0x2e80 && c <= 0x9fff ? 2 : 1; }
    assert.ok(units <= 20, `units=${units}`);
  });
  test("orgBuildModel: named crew label carries name + count; floor crew stays honest", () => {
    const registry = [{ id: "alpha", displayName: "Alpha Colony", lastActivity: iso(60_000) }];
    const m = org.orgBuildModel(
      [sub("sx1", { project: "alpha", label: "digest cards batch 1", lastActivity: NOW - 3600e3 }),
       sub("sx2", { project: "alpha", label: "digest cards batch 2", lastActivity: NOW - 3700e3 })],
      "bridge", registry, "alpha", NOW,
    );
    const inst = [...m.nodes.values()].find((n) => n.kind === "instance")!;
    assert.match(inst.display!, /digest cards ·×2$/);
    assert.equal(inst.sub, "instance crew"); // the date/count moved out of the subtitle
    // zero-evidence floor crew: still 'unnamed · <day>'
    const m2 = org.orgBuildModel(
      [sub("sy1", { project: "alpha", lastActivity: NOW - 30 * 3600e3 }), sub("sy2", { project: "alpha", lastActivity: NOW - 30 * 3600e3 })],
      "bridge", registry, "alpha", NOW,
    );
    const floor = [...m2.nodes.values()].find((n) => n.kind === "instance")!;
    assert.match(floor.display!, /^unnamed · /);
    assert.match(floor.sub!, /·×2$/);
  });
  test("backfill attribution rows: sa10/sa20/sa84 resolve with token evidence", () => {
    assert.equal(org.orgProjectOf({ id: "sa10", label: "任务：安装 cloudflare/security-audit-skill 到 Pi，验证能加载。" }, [], null), "PiAgents.harness");
    assert.equal(org.orgProjectOf({ id: "sa20", label: "任务：建一个全新的、专门**写文档**的 subagent 角色（role），并把已知的用户偏好固化进它的 skill" }, [], null), "PiAgents-org");
    assert.equal(org.orgProjectOf({ id: "sa84", label: "You are the writer role. Rewrite /Users/yuyuan/PiAgents/README.md (repo = github.com/yuyuan12138/Pi.git)" }, [], null), "PiAgents-org");
  });
});

describe("activity preamble stripping", () => {
  test("role preambles drop their first sentence", () => {
    assert.equal(org.orgActivityText("You are the operator role. Reconcile a WeChat bill export into the ledger."), "Reconcile a WeChat bill export into the ledger.");
    assert.equal(org.orgActivityText("ROLE: visual designer. Deliverable: a PREMIUM redesign direction."), "Deliverable: a PREMIUM redesign direction.");
    assert.equal(org.orgActivityText("You are a READ-ONLY reviewer (correctness review). You propose; you never edit."), "You propose; you never edit.");
  });
  test("design-a-standalone opener drops to the next clause", () => {
    assert.equal(org.orgActivityText("Design a STANDALONE HTML mockup of an org-graph page. This is a design candidate."), "This is a design candidate.");
  });
  test("markdown headers and bracket tags are stripped", () => {
    assert.equal(org.orgActivityText("[project:minecraft] backfill graph.json to v1"), "backfill graph.json to v1");
    assert.equal(org.orgActivityText("# Heading\nReal work sentence here"), "Real work sentence here");
  });
  test("short/empty remainder -> null (caller falls to the next source)", () => {
    assert.equal(org.orgActivityText("You are the operator role."), null);
    assert.equal(org.orgActivityText("[project:x]"), null);
    assert.equal(org.orgActivityText(""), null);
  });
  test("orgBuildModel: activity skips the preamble sentence entirely", () => {
    const registry = [{ id: "alpha", displayName: "Alpha Colony", lastActivity: iso(60_000) }];
    const m = org.orgBuildModel(
      [sub("sa1", { project: "alpha", label: "You are the operator role. Fix the parser queue overflow", lastActivity: NOW - 1000 })],
      "bridge", registry, "alpha", NOW,
    );
    assert.ok(String(m.nodes.get("__proj:alpha")!.sub).startsWith("Fix the parser queue"));
  });
});

describe("invocation tree (project/agent alternate by real spawn lineage)", () => {
  const REG = [
    { id: "minecraft", displayName: "Minecraft", aliases: ["minecraft", "mc"], root: "", subprojects: [] },
  ];
  test("spawn lineage nests a dispatch under its parent dispatch, not at rank 2", () => {
    const m = org.orgBuildInvocationTree(
      [sub("sa8", { label: "Run the minecraft rsi episode loop" }),
       sub("sa8-a", { spawned_by: "sa8", label: "Remove the recursive-spawn depth cap in pi-superagent" })],
      REG, null, NOW,
    );
    assert.ok(m.nodes.has("__hop:__coord__:minecraft"), "coordinator -> minecraft hop");
    const sa8 = m.nodes.get("sa8")!;
    assert.equal(sa8.parent, "__hop:__coord__:minecraft");
    assert.equal(sa8.row, 2);
    assert.ok(String(sa8.sub).startsWith("d1 · "), `sub=${sa8.sub}`);
    assert.ok(m.nodes.has("__hop:sa8:PiAgents.harness"), "cross-project hop inserted under sa8");
    const sa8a = m.nodes.get("sa8-a")!;
    assert.equal(sa8a.parent, "__hop:sa8:PiAgents.harness"); // nested, NOT at row 2
    assert.equal(sa8a.row, 4);
    assert.ok(String(sa8a.sub).startsWith("d2 · "), `sub=${sa8a.sub}`);
  });
  test("cross-project children share ONE hop; same-project children attach directly", () => {
    const m = org.orgBuildInvocationTree(
      [sub("sa8", { label: "Run the minecraft rsi episode loop" }),
       sub("sa8-a", { spawned_by: "sa8", label: "Remove the recursive-spawn depth cap in pi-superagent" }),
       sub("sa8-b", { spawned_by: "sa8", label: "BoN: also remove the depth cap" }),
       sub("sa8-c", { spawned_by: "sa8", label: "pi-superagent cap removal, third candidate" }),
       sub("sa8-x", { spawned_by: "sa8", label: "minecraft rsi continuation work" })],
      REG, null, NOW,
    );
    const hop = m.nodes.get("__hop:sa8:PiAgents.harness")!;
    const kids = (hop.children as Array<{ id: string }>).map((c) => c.id).sort();
    assert.deepEqual(kids, ["sa8-a", "sa8-b", "sa8-c"]); // fanout shares the hop + parent
    const sa8x = m.nodes.get("sa8-x")!;
    assert.equal(sa8x.parent, "sa8"); // same-project child attaches DIRECTLY
  });
  test("unknown-parent dispatch hangs under its project hop (no invented lineage)", () => {
    const m = org.orgBuildInvocationTree(
      [sub("sa22", { label: "minecraft rsi regen world" }), sub("sa23", { label: "minecraft rsi monitor episode" })],
      REG, null, NOW,
    );
    const hop = m.nodes.get("__hop:__coord__:minecraft")!;
    const kids = (hop.children as Array<{ id: string }>).map((c) => c.id).sort();
    assert.deepEqual(kids, ["sa22", "sa23"]); // both roots under one hop
  });
  test("view filter keeps the viewed project's dispatches + ancestor chains", () => {
    const m = org.orgBuildInvocationTree(
      [sub("sa8", { label: "Run the minecraft rsi episode loop" }),
       sub("sa8-a", { spawned_by: "sa8", label: "Remove the recursive-spawn depth cap in pi-superagent" })],
      REG, "PiAgents.harness", NOW,
    );
    assert.ok(m.nodes.has("sa8-a"), "kept");
    assert.ok(m.nodes.has("sa8"), "ancestor chain kept");
    const mcHop = m.nodes.get("__hop:__coord__:minecraft");
    assert.ok(mcHop && (mcHop.children as Array<{ id: string }>).length === 1, "minecraft hop keeps only the ancestor chain (sa8)");
  });
  test("layout: arbitrary depth wraps and bounds; edges are invocations", () => {
    const m = org.orgBuildInvocationTree(
      [sub("sa8", { label: "Run the minecraft rsi episode loop" }),
       sub("sa8-a", { spawned_by: "sa8", label: "Remove the recursive-spawn depth cap in pi-superagent" })],
      REG, null, NOW,
    );
    const laid = org.orgLayoutTree(m, 1200, () => true);
    const byId = new Map(laid.nodes.map((n) => [n.id, n]));
    const hop = byId.get("__hop:__coord__:minecraft")!;
    const sa8 = byId.get("sa8")!;
    const deepHop = byId.get("__hop:sa8:PiAgents.harness")!;
    assert.ok((sa8.y ?? 0) > (hop.y ?? 0) && (deepHop.y ?? 0) > (sa8.y ?? 0), "alternating rows descend");
    const kinds = laid.edges.map((e) => e.kind);
    assert.ok(kinds.includes("entry") && kinds.includes("dispatch") && kinds.includes("sub"), kinds.join(","));
    assert.equal(laid.edges.every((e) => e.key === e.from + ">" + e.to), true);
    assert.ok(laid.width <= 1200 + 60, `width ${laid.width}`);
  });
});

describe("English-only rendering (CJK glosses or falls through)", () => {
  test("orgEnPhrase: known phrases gloss, unknown CJK -> null", () => {
    assert.equal(org.orgEnPhrase("\u7ec4\u4f1a\u6c47\u62a5 docx"), "weekly report docx");
    assert.equal(org.orgEnPhrase("\u76d1\u63a7 a running episode"), "monitor a running episode");
    assert.equal(org.orgEnPhrase("\u8bfb\u8fd9\u5957 Pi agent \u73af\u5883\u914d\u7f6e"), null); // untranslatable -> null
    assert.equal(org.orgEnPhrase("plain english"), "plain english");
  });
  test("orgCrewNameFromLabels: CJK runs survive only when fully glossed", () => {
    assert.equal(org.orgCrewNameFromLabels(["\u76d1\u63a7 a running episode", "\u76d1\u63a7 the next episode"]), "episode monitor");
    assert.equal(org.orgCrewNameFromLabels(["\u8bfb\u8fd9\u5957\u73af\u5883\u914d\u7f6e", "\u8bfb\u90a3\u5957\u73af\u5883\u914d\u7f6e"]), null); // untranslatable -> no name
  });
  test("orgBuildModel: activity line falls to the newest English-renderable dispatch", () => {
    const registry = [{ id: "alpha", displayName: "Alpha Colony", lastActivity: iso(60_000) }];
    const m = org.orgBuildModel(
      [sub("sa1", { project: "alpha", label: "\u4efb\u52a1\uff1a\u5728\u98de\u4e66\u65b0\u5efa\u4e00\u4e2a docx \u6587\u6863", lastActivity: NOW - 1000 }),
       sub("sa2", { project: "alpha", label: "Fix the parser queue overflow", lastActivity: NOW - 2000 })],
      "bridge", registry, "alpha", NOW,
    );
    const proj = m.nodes.get("__proj:alpha")!;
    assert.ok(String(proj.sub).startsWith("Fix the parser queue")); // newest Chinese label skipped, next renders (truncated to fit)
  });
  test("orgBuildModel: work-hint title with CJK renders as the ASCII dir name", () => {
    const registry = [{ id: "alpha", displayName: "Alpha Colony", lastActivity: iso(60_000),
      work: { dir: "2026-11-11-project-space", title: "\u9879\u76ee\u7a7a\u95f4\u6587\u6863\u5c42\u843d\u5730", worker: null, at: new Date(NOW - 60000).toISOString() } }];
    const m = org.orgBuildModel([sub("sa1", { project: "alpha" })], "bridge", registry, "alpha", NOW);
    assert.ok(String(m.nodes.get("__proj:alpha")!.sub).startsWith("2026-11-11-project")); // ASCII dir name, no CJK
  });
});

describe("width-aware truncation (CJK counts double)", () => {
  test("mixed-script labels fit a fixed pixel budget", () => {
    const long = "继续 Minecraft RSI 木剑循环，用土柱布局修复掉落几何卡死";
    const cut = org.orgTruncW(long, 21);
    assert.ok(cut.endsWith("\u2026"));
    // units: CJK x2 + ASCII x1 must not exceed the budget
    let units = 0;
    for (const ch of cut.replace("\u2026", "")) units += /[\u2e80-\u9fff\uff00-\uffef\u3000-\u303f]/.test(ch) ? 2 : 1;
    assert.ok(units <= 21, `units=${units}`);
    assert.equal(org.orgTruncW("short", 21), "short");
    assert.equal(org.orgTruncW("tech-lead · Backfill graph.json to GRAPH-SCHEMA v1", 21), "tech-lead · Backfill\u2026");
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
    assert.equal(org.orgSubprojectTarget({ project: "alpha" }, registry), null);
    assert.equal(org.orgSubprojectTarget({}, registry), null);
  });
});

describe("hierarchy model: coordinator -> projects -> instance crews -> dispatches", () => {
  const registry = [
    { id: "alpha", displayName: "Alpha Colony", lastActivity: iso(5 * 60_000) },
    { id: "beta", displayName: "Beta Works" },
    { id: "gamma", displayName: "Gamma Hold", lastActivity: iso(2 * 60_000) },
  ];
  const subs = [
    sub("sa1", { project: "alpha", session: "crew-a", lastActivity: NOW - 3600e3 }),
    sub("sa1-a", { project: "alpha", session: "crew-a", lastActivity: NOW - 7200e3 }),
    sub("sa1-a-b", { project: "alpha", session: "crew-a", lastActivity: NOW - 2 * 3600e3 }),
    sub("saX", { project: "alpha", session: "solo-x", lastActivity: NOW - 48 * 3600e3 }),
    sub("sa2", { project: "beta", session: "crew-b" }),
    sub("sa2-sa1", { project: "beta", session: "crew-b" }),
    sub("role-coder", { label: "review the quarterly numbers carefully" }),
    sub("sa3", { label: "review the quarterly numbers thoroughly" }),
    sub("sa9-x"),
  ];
  const model = org.orgBuildModel(subs, "bridge", registry, null, NOW);

  test("project layer: registry projects (bucketed or working) + extra buckets, in payload order", () => {
    assert.deepEqual(model.projKeys, ["alpha", "beta", "gamma", org.ORG_UNATTRIBUTED]);
    const proj = [...model.nodes.values()].filter((n) => n.kind === "project");
    assert.equal(proj.length, 4);
    assert.equal(model.nodes.get("__proj:alpha")!.display, "Alpha Colony");
    assert.equal(model.nodes.get("__proj:" + org.ORG_UNATTRIBUTED)!.registry, null);
  });
  test("3 dispatches with one session = ONE instance node (aggregated, counted)", () => {
    const insts = [...model.nodes.values()].filter((n) => n.kind === "instance");
    const crewA = model.nodes.get("__inst:alpha:sess-crew-a")!;
    assert.equal(crewA.kind, "instance");
    assert.equal(crewA.count, 3);
    assert.equal(crewA.display, "crew-a"); // name is the session; role moved to the subtitle
    assert.equal(crewA.sub, "dispatch \u00b7\u00d73"); // mixed member evidence -> neutral kind word, never a bare em dash
    assert.deepEqual(crewA.memberIds, ["sa1", "sa1-a", "sa1-a-b"]);
    assert.equal(crewA.basis, "session");
    assert.equal(crewA.session, "crew-a");
    assert.equal(insts.length, 5); // crew-a, solo-x, crew-b, prefix-pair, undated-day
  });
  test("member dispatches hide under the instance; lineage nests within the crew", () => {
    const inst = model.nodes.get("__inst:alpha:sess-crew-a")!;
    assert.equal(inst.row, 2); // project row 1 + 1
    assert.deepEqual(inst.children.map((c) => c.id), ["sa1"]); // spawn root of the crew
    assert.equal(inst.children[0].depth, 0);
    assert.equal(model.nodes.get("sa1-a")!.depth, 1);
    assert.equal(model.nodes.get("sa1-a-b")!.depth, 2);
    assert.equal(model.nodes.get("sa1-a")!.row, 4);
    assert.equal(model.maxSpawnDepth, 2);
  });
  test("quiet crews dim (no recent activity) but still occupy exactly one node", () => {
    assert.equal(model.nodes.get("__inst:alpha:sess-solo-x")!.dim, true);
    assert.equal(model.nodes.get("__inst:alpha:sess-crew-a")!.dim, false);
  });
  test("fallback clustering: shared label prefix groups; lonely prefixes fall back to day", () => {
    const p1 = model.nodes.get(`__inst:${org.ORG_UNATTRIBUTED}:pre-review-the-quarterly`)!;
    assert.equal(p1.basis, "prefix");
    assert.equal(p1.count, 2); // role-coder + sa3 share the 20-char prefix
    const day = [...model.nodes.values()].find((n) => n.kind === "instance" && n.basis === "day");
    assert.ok(day && day.count === 1 && day.memberIds![0] === "sa9-x");
  });
  test("unique sessions cluster by themselves (singleton instances)", () => {
    const solo = model.nodes.get("__inst:alpha:sess-solo-x")!;
    assert.equal(solo.count, 1);
    assert.deepEqual(solo.memberIds, ["saX"]);
  });
  test("agents with no attribution gather under the explicit unattributed node", () => {
    const un = org.orgBuildModel([sub("sa9")], null, registry, null, NOW);
    assert.deepEqual(un.projKeys, ["alpha", "gamma", org.ORG_UNATTRIBUTED]);
    const pn = un.nodes.get("__proj:" + org.ORG_UNATTRIBUTED)!;
    assert.equal(pn.display, "unattributed · 1");
    const inst = pn.children.find((c) => c.kind === "instance")!;
    assert.equal(inst.count, 1);
  });
  test("pure idle: no subagents at all means no project layer (coordinator + note)", () => {
    const idle = org.orgBuildModel([], "bridge", registry, null, NOW);
    assert.deepEqual(idle.projKeys, []);
    assert.equal(idle.nodes.size, 0);
  });
  test("single-project view: one subtree, project node present even when empty", () => {
    const beta = org.orgBuildModel(subs, "bridge", registry, "beta", NOW);
    assert.deepEqual(beta.projKeys, ["beta"]);
    const insts = [...beta.nodes.values()].filter((n) => n.kind === "instance");
    assert.equal(insts.length, 1);
    const empty = org.orgBuildModel([], "bridge", registry, "gamma", NOW);
    assert.equal(empty.nodes.get("__proj:gamma")!.kind, "project");
    assert.equal(empty.nodes.get("__proj:gamma")!.children.length, 0);
  });
  test("cross-project parents become honest dashed roots inside the crew", () => {
    const lone = org.orgBuildModel([sub("sa2-sa1", { project: "alpha", session: "crew-x" })], "bridge", [], null, NOW);
    const n = lone.nodes.get("sa2-sa1")!;
    assert.equal(n.parent, null);
    assert.equal(n.parentHint, "sa2");
    assert.equal(n.depth, 0);
  });
  test("v2 subprojects: intermediate nodes render when registry data exists, never fabricated", () => {
    const reg2 = [{ id: "alpha", displayName: "Alpha Colony", subprojects: [{ id: "alpha-web", displayName: "Alpha Web" }] }];
    const m = org.orgBuildModel(
      [sub("sa1", { project: "alpha", session: "crew-a" })],
      "bridge", reg2, null, NOW,
    );
    const sp = m.nodes.get("__sub:alpha:alpha-web")!;
    assert.equal(sp.kind, "subproject");
    assert.equal(sp.row, 2);
    const inst = [...m.nodes.values()].find((n) => n.kind === "instance")!;
    assert.equal(inst.row, 2); // instances and subprojects share the aggregate band
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
    sub("sa1", { project: "alpha", session: "crew-a" }),
    sub("sa1-a", { project: "alpha", session: "crew-a" }),
    sub("sa1-a-b", { project: "alpha", session: "crew-a" }),
    sub("sa2", { project: "beta", session: "crew-b" }),
    sub("sa2-sa1", { project: "beta", session: "crew-b" }),
    sub("sa9-x", { status: "done" }),
  ];
  const layout = org.orgLayoutModel(org.orgBuildModel(subs, "bridge", registry, null, NOW));

  test("same input -> identical output (no physics, no randomness)", () => {
    const again = org.orgLayoutModel(org.orgBuildModel(subs, "bridge", registry, null, NOW));
    assert.equal(JSON.stringify(layout), JSON.stringify(again));
  });
  test("rows: coordinator 0, projects 1, instances 2, dispatches below; spawn depth kept as dN", () => {
    const { padTop, rowH } = org.ORG_LAYOUT;
    assert.equal(layout.coordinator.y, padTop);
    const byId = new Map(layout.nodes.map((n) => [n.id, n]));
    for (const n of layout.nodes) assert.equal(n.y, padTop + n.row * rowH);
    assert.equal(byId.get("__proj:alpha")!.row, 1);
    assert.equal(byId.get("__inst:alpha:sess-crew-a")!.row, 2);
    assert.equal(byId.get("sa1")!.row, 3);
    assert.equal(byId.get("sa1")!.depth, 0);
    assert.equal(byId.get("sa1-a-b")!.depth, 2);
    assert.equal(layout.maxDepth, 2);
  });
  test("typed edges: entry, crew_of to instances, dispatch to members, spawn between dispatches", () => {
    const byKey = new Map(layout.edges.map((e) => [e.key, e]));
    assert.equal(byKey.get("__coord__>__proj:alpha")!.kind, "entry");
    assert.equal(byKey.get("__proj:alpha>__inst:alpha:sess-crew-a")!.kind, "crew_of");
    assert.equal(byKey.get("__inst:alpha:sess-crew-a>sa1")!.kind, "dispatch");
    assert.equal(byKey.get("sa1>sa1-a")!.kind, "spawn");
    assert.equal(layout.edges.filter((e) => e.kind === "entry").length, 4); // alpha, beta, gamma (working) + bridge bucket
  });
  test("parents center over their children", () => {
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
  test("natural id order: sa2 sorts before sa10", () => {
    assert.ok(org.orgNaturalCompare("sa2", "sa10") < 0);
    assert.ok(org.orgNaturalCompare("sa10", "sa2") > 0);
  });
});

describe("node roles: crew-manifest snapshot + priority chain", () => {
  test("(a) explicit role-<name> in id or session wins", () => {
    assert.equal(org.orgNodeRole("role-coder", null, null, null), "coder");
    assert.equal(org.orgNodeRole("sa5", "unrelated", "role-planner", null), "planner");
  });
  test("(b) crew manifest: known session ids map to profile.spec", () => {
    assert.equal(org.ORG_CREW_SESSION_ROLES["bridge-org-x1"], "coder.frontend");
    assert.equal(org.ORG_CREW_SESSION_ROLES["agent-org-x1"], "designer.org");
    assert.equal(org.ORG_CREW_SESSION_ROLES["mc-episode-ops"], "operator.episodes");
    assert.equal(org.orgNodeRole("sa9", null, "bridge-org-x1", null), "coder.frontend");
    const join = new Map([["sa1", "agent-org-x1"]]); // /state session null -> main-log join
    assert.equal(org.orgNodeRole("sa1", null, null, join), "designer.org");
  });
  test("(b2) today's dispatch-id snapshot covers the manifest wave", () => {
    assert.equal(org.ORG_CREW_DISPATCH_ROLES["sa16"], "coder.frontend");
    assert.equal(org.ORG_CREW_DISPATCH_ROLES["sa13"], "coder.infra");
    assert.equal(org.ORG_CREW_DISPATCH_ROLES["sa15"], "operator.monitoring");
    assert.equal(org.ORG_CREW_DISPATCH_ROLES["sa12"], "designer.org");
    assert.equal(org.orgNodeRole("sa16", "Projects panel in mission-control UI", null, null), "coder.frontend");
  });
  test("(c) label-keyword inference next; unknown -> null ('—' at render)", () => {
    assert.equal(org.orgNodeRole("sa99", "act as reviewer of the diff", null, null), "reviewer");
    assert.equal(org.orgNodeRole("sa99", "nothing actionable here", null, null), null);
  });
  test("instance role: session manifest role wins; mixed member evidence -> em dash", () => {
    const registry = [{ id: "alpha", displayName: "Alpha Colony", lastActivity: iso(60_000) }];
    const m = org.orgBuildModel(
      [sub("sa1", { project: "alpha", session: "bridge-org-x1" }), sub("sa1-a", { project: "alpha", session: "bridge-org-x1" })],
      "bridge", registry, null, NOW,
    );
    const inst = [...m.nodes.values()].find((n) => n.kind === "instance")!;
    assert.equal(inst.role, "coder.frontend");
    assert.equal(inst.display, "bridge-org-x1");
    assert.match(inst.sub!, /coder\.frontend \u00b7\u00d72$/); // full role fits the subtitle budget
    const m2 = org.orgBuildModel(
      [sub("sa1", { project: "alpha", session: "crew-a" }), sub("sa1-a", { project: "alpha", session: "crew-a" })],
      "bridge", registry, null, NOW,
    );
    const inst2 = [...m2.nodes.values()].find((n) => n.kind === "instance")!;
    assert.equal(inst2.role, null); // sa1 -> coder.frontend (dispatch snapshot), sa1-a -> unknown
  });
  test("agents carry their resolved role on the model node", () => {
    const m = org.orgBuildModel([sub("sa16", { project: "alpha" })], "bridge", [], null, NOW);
    assert.equal(m.nodes.get("sa16")!.role, "coder.frontend");
  });
});

describe("vertical wrapped layout (default)", () => {
  const registry = [{ id: "alpha", displayName: "Alpha Colony", lastActivity: iso(60_000) }];
  const wide = org.orgBuildModel(
    Array.from({ length: 25 }, (_, i) => sub(`sa${i + 1}`, { project: "alpha", session: "crew" })),
    "bridge", registry, null, NOW,
  );
  const wrapW = 1112; // 7 columns at 140+12 spacing
  const allOpen = () => true;
  const layout = org.orgLayoutVertical(wide, wrapW, allOpen);

  test("same input -> identical output", () => {
    const again = org.orgLayoutVertical(wide, wrapW, allOpen);
    assert.equal(JSON.stringify(layout), JSON.stringify(again));
  });
  test("wide dispatch layers wrap into sub-rows; width stays inside the panel", () => {
    const row3 = layout.nodes.filter((n) => n.row === 3);
    assert.equal(row3.length, 25);
    const columns = Math.floor((wrapW - 2 * org.ORG_LAYOUT.padX + org.ORG_LAYOUT.gapX) / (org.ORG_LAYOUT.nodeW + org.ORG_LAYOUT.gapX));
    const subRows = Math.ceil(25 / columns);
    const ys = new Set(row3.map((n) => n.y));
    assert.equal(ys.size, subRows);
    const { padTop, subH } = org.ORG_LAYOUT;
    for (const [i, n] of row3.entries()) {
      assert.equal(n.y, padTop + 3 * subH + Math.floor(i / columns) * subH);
      assert.equal(n.x, Math.round(org.ORG_LAYOUT.padX + (i % columns) * (org.ORG_LAYOUT.nodeW + org.ORG_LAYOUT.gapX) + org.ORG_LAYOUT.nodeW / 2));
    }
    assert.ok(layout.width <= wrapW + 2, `width ${layout.width} > wrap ${wrapW}`);
    assert.ok(layout.height > 3 * org.ORG_LAYOUT.subH);
  });
  test("wrapped edges route without crossing pills; all path coords inside the canvas", () => {
    assert.ok(layout.edges.some((e) => /H 8 /.test(e.d)), "multi-band edges use the left rail");
    assert.ok(layout.edges.some((e) => !/H 8 /.test(e.d)), "adjacent-band edges stay elbows");
    for (const e of layout.edges) {
      const { xs, ys } = parsePath(e.d);
      for (const x of xs) assert.ok(x >= -1 && x <= layout.width + 1, `edge ${e.key} x=${x} outside ${layout.width}`);
      for (const y of ys) assert.ok(y >= -1 && y <= layout.height + 1, `edge ${e.key} y=${y} outside ${layout.height}`);
    }
  });
});

describe("collapsible branches and instances", () => {
  const registry = [{ id: "alpha", displayName: "Alpha Colony", lastActivity: iso(60_000) }];
  const model = org.orgBuildModel(
    [sub("sa1", { project: "alpha", session: "crew-a" }), sub("sa1-a", { project: "alpha", session: "crew-a" }), sub("sa1-a-b", { project: "alpha", session: "crew-a" }), sub("sa2", { project: "alpha", session: "crew-b" })],
    "bridge", registry, null, NOW,
  );
  // the renderer's default rule: rows <= 2 open, instances always collapsed
  const rendererDefault = (id: string) => {
    const n = model.nodes.get(id)!;
    if (n.kind === "instance") return false;
    return n.row <= org.ORG_DEFAULT_EXPAND_ROW;
  };

  test("default: instance crews start collapsed (aggregate first), dispatches hidden", () => {
    const layout = org.orgLayoutVertical(model, 1200, rendererDefault);
    const byId = new Map(layout.nodes.map((n) => [n.id, n]));
    assert.equal(byId.get("__inst:alpha:sess-crew-a")!.collapsed, true);
    assert.equal(byId.get("__inst:alpha:sess-crew-a")!.hiddenCount, 3);
    assert.equal(byId.get("sa1"), undefined); // member dispatches pruned
    assert.equal(byId.get("__inst:alpha:sess-crew-b")!.hiddenCount, 1);
    assert.equal(byId.get("__proj:alpha")!.collapsed, false); // projects show their crews
  });
  test("expanding an instance reveals exactly its member dispatches", () => {
    const layout = org.orgLayoutVertical(model, 1200, (id) => id === "__inst:alpha:sess-crew-a" || rendererDefault(id));
    const byId = new Map(layout.nodes.map((n) => [n.id, n]));
    assert.equal(byId.get("sa1")!.row, 3);
    assert.equal(byId.get("sa1")!.depth, 0);
    assert.equal(byId.get("sa1-a"), undefined); // nested dispatch needs its own parent expanded
    assert.equal(byId.get("sa2"), undefined); // other crew still collapsed
    assert.equal(layout.nodes.filter((n) => n.kind === "agent").length, 1);
    const all = org.orgLayoutVertical(model, 1200, () => true);
    assert.equal(all.nodes.filter((n) => n.kind === "agent").length, 4); // full expansion reveals the whole crew
  });
  test("collapsing a subtree shrinks the bounding box; re-expanding restores it", () => {
    const full = org.orgLayoutVertical(model, 1200, () => true);
    const collapsedProj = org.orgLayoutVertical(model, 1200, (id) => (id === "__proj:alpha" ? false : true));
    assert.ok(collapsedProj.height < full.height);
    assert.equal(collapsedProj.nodes.filter((n) => n.kind === "agent").length, 0);
    assert.equal(collapsedProj.nodes.find((n) => n.id === "__proj:alpha")!.hiddenCount, 6); // 2 instances + 4 dispatches
    const restored = org.orgLayoutVertical(model, 1200, () => true);
    assert.equal(restored.height, full.height);
    assert.equal(restored.nodes.length, full.nodes.length);
  });
  test("horizontal alternate honors collapse too", () => {
    const full = org.orgLayoutModel(model);
    const pruned = org.orgLayoutModel(model, (id) => id !== "__inst:alpha:sess-crew-a");
    assert.ok(!pruned.nodes.some((n) => n.id === "sa1"));
    assert.ok(full.nodes.some((n) => n.id === "sa1"));
    assert.equal(pruned.nodes.find((n) => n.id === "__inst:alpha:sess-crew-a")!.hiddenCount, 3);
  });
  test("fit re-invariant holds after collapse (width still fits)", () => {
    const layout = org.orgLayoutVertical(model, 1112, rendererDefault);
    const fit = org.orgFitScale(layout.width, layout.height, 1112, 700, 1, "v");
    assert.equal(fit.applied * layout.width <= 1112 + 0.001, true);
  });
});

describe("fit-to-panel scaling", () => {
  test("fit never upscales and is the default applied scale", () => {
    const r = org.orgFitScale(1000, 200, 800, 600, 1);
    assert.equal(r.fit, 0.8);
    assert.equal(r.applied, 0.8);
  });
  test("height can be the binding dimension on wide short panels", () => {
    const r = org.orgFitScale(400, 400, 1200, 300, 1, "h");
    assert.equal(r.fit, 0.75);
  });
  test("small trees never upscale past 100%", () => {
    const r = org.orgFitScale(160, 68, 1200, 700, 1);
    assert.equal(r.fit, 1);
    assert.equal(r.applied, 1);
  });
  test("vertical mode fits width only: depth is cheap, height scrolls", () => {
    const v = org.orgFitScale(400, 2000, 800, 300, 1, "v");
    assert.equal(v.fit, 1); // height ignored — 2000px tree scrolls inside the panel
    const h = org.orgFitScale(400, 2000, 800, 300, 1, "h");
    assert.equal(h.fit, 0.15); // horizontal still fits both axes
    const narrow = org.orgFitScale(400, 2000, 300, 300, 1, "v");
    assert.equal(narrow.fit, 0.75); // width still binds in vertical mode
  });
  test("downscale floors; zoom clamps to [floor, max] in applied terms", () => {
    const r = org.orgFitScale(20000, 300, 390, 600, 1);
    assert.equal(r.fit, org.ORG_FIT_FLOOR);
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
    const idle = org.orgLayoutVertical(org.orgBuildModel([], "bridge", registry, null, NOW), 800);
    assert.equal(idle.nodes.length, 0);
    assert.equal(idle.edges.length, 0);
    assert.ok(idle.coordinator.x > 0);
    assert.ok(idle.width < 400);
  });
  test("clicking a project node highlights exactly its subtree, whatever the expansion", () => {
    const m = org.orgBuildModel(
      [sub("sa1", { project: "alpha", session: "crew-a" }), sub("sa1-a", { project: "alpha", session: "crew-a" })],
      "bridge", registry, null, NOW,
    );
    // renderer-default shape: projects expanded, instance crews collapsed
    const collapsed = org.orgLayoutModel(m, (id) => m.nodes.get(id)!.kind !== "instance");
    const proj = org.orgFocusClosure(collapsed, "__proj:alpha");
    assert.deepEqual([...proj.nodes].sort(), ["__coord__", "__inst:alpha:sess-crew-a", "__proj:alpha"]);
    assert.ok(proj.edges.has("__proj:alpha>__inst:alpha:sess-crew-a"));
    const expanded = org.orgLayoutModel(org.orgBuildModel(
      [sub("sa1", { project: "alpha", session: "crew-a" }), sub("sa1-a", { project: "alpha", session: "crew-a" })],
      "bridge", registry, null, NOW,
    ), () => true);
    const projOpen = org.orgFocusClosure(expanded, "__proj:alpha");
    assert.ok(projOpen.nodes.has("sa1-a"));
    assert.ok(projOpen.edges.has("__inst:alpha:sess-crew-a>sa1"));
  });
  test("dispatch focus walks up through its instance and project to the coordinator", () => {
    const model = org.orgLayoutModel(org.orgBuildModel(
      [sub("sa1", { project: "alpha", session: "crew-a" }), sub("sa1-a", { project: "alpha", session: "crew-a" }), sub("sa2", { project: "beta", session: "crew-b" })],
      "bridge", registry, null, NOW,
    ), () => true);
    const deep = org.orgFocusClosure(model, "sa1-a");
    assert.deepEqual([...deep.nodes].sort(), ["__coord__", "__inst:alpha:sess-crew-a", "__proj:alpha", "sa1", "sa1-a"]);
    assert.ok(deep.edges.has("sa1>sa1-a"));
    assert.ok(deep.edges.has("__inst:alpha:sess-crew-a>sa1"));
    const coord = org.orgFocusClosure(model, "__coord__");
    assert.deepEqual([...coord.nodes], ["__coord__"]);
    assert.equal(coord.edges.size, 0);
  });
});
