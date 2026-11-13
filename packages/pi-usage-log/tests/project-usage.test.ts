/**
 * Theme D1 tests: per-project usage attribution + rollup + reconciliation.
 *
 * Layers:
 *  1. Attribution chain stages (registry root, sessionId, @-segment,
 *     topic-xN/primary with collision-token stripping, [project:...] tag,
 *     alias evidence with the 2-mention rule) — including the brief's edge
 *     cases: renamed session dirs with collision tokens, untagged legacy
 *     sessions landing in the explicit unattributed bucket.
 *  2. Rollup buckets + reconciliation against the raw record sums.
 *  3. Day-file reading (window filter, malformed lines, missing dir).
 *
 * No real user data is touched: fixtures live under os.tmpdir().
 */
import { test, describe } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import {
  attributeUsageProject,
  projectUsageRollup,
  reconcile,
  readUsageRecords,
  rollupLastDays,
  projectTag,
  parseRegistryProjects,
  dirBase,
  textMatches,
  underRoot,
  UNATTRIBUTED,
  PERSONAL_OPS,
  type RegistryProjectLite,
  type UsageRecordLike,
} from "../project-usage.ts";

const REG: RegistryProjectLite[] = [
  { id: "alpha", displayName: "Alpha platform", aliases: ["alpha", "阿尔法"], root: "/tmp/alpha", sessionId: "alpha-primary" },
  { id: "bridge", displayName: "PiAgents web bridge", aliases: ["bridge-org", "pi-web"], root: "/tmp/bridge", sessionId: "bridge-primary" },
  { id: "medical", displayName: "Medical", aliases: ["medical", "医疗"], root: "/tmp/medical", sessionId: "medical-primary" },
];

function rec(partial: Partial<UsageRecordLike>): UsageRecordLike {
  return { ts: "2026-11-13T00:00:00.000Z", tokens: { total: 100 }, cost: 0.5, ...partial };
}

// ---------------------------------------------------------------- attribution stages

describe("attribution stage (a): cwd under a canonical registry root", () => {
  test("exact root match", () => {
    assert.equal(attributeUsageProject(rec({ cwd: "/tmp/alpha" }), REG), "alpha");
  });
  test("under-root match", () => {
    assert.equal(attributeUsageProject(rec({ cwd: "/tmp/alpha/sub/dir" }), REG), "alpha");
  });
  test("path boundary: a longer sibling dir is NOT under the root", () => {
    assert.notEqual(attributeUsageProject(rec({ cwd: "/tmp/alpha-x" }), REG), "alpha");
  });
  test("root match wins over weaker session evidence", () => {
    // cwd is decisive even when the session name would suggest another project.
    assert.equal(attributeUsageProject(rec({ cwd: "/tmp/alpha", session: "medical-upstream-x1" }), REG), "alpha");
  });
  test("nested roots: the most specific (longest) root wins over the umbrella", () => {
    const reg2: RegistryProjectLite[] = [
      { id: "umbrella", displayName: "Umbrella", aliases: ["umb"], root: "/tmp/alpha", sessionId: "umbrella-primary" },
      { id: "inner", displayName: "Inner", aliases: ["inner"], root: "/tmp/alpha/inner", sessionId: "inner-primary" },
    ];
    assert.equal(attributeUsageProject(rec({ cwd: "/tmp/alpha/inner/work" }), reg2), "inner");
    assert.equal(attributeUsageProject(rec({ cwd: "/tmp/alpha/other" }), reg2), "umbrella");
  });
});

describe("attribution stage (b): exact registry sessionId", () => {
  test("project-primary session id attributes to its project", () => {
    assert.equal(attributeUsageProject(rec({ session: "medical-primary" }), REG), "medical");
  });
  test("sessionName carries it too", () => {
    assert.equal(attributeUsageProject(rec({ session: "01a1a0bc-uuid", sessionName: "alpha-primary" }), REG), "alpha");
  });
});

describe("attribution stage (c): role@project session segment", () => {
  test("role-...@project resolves via registry id", () => {
    assert.equal(attributeUsageProject(rec({ session: "role-coder-1@alpha" }), REG), "alpha");
  });
  test("role.name.spec@project resolves via the id before the first dot", () => {
    assert.equal(attributeUsageProject(rec({ session: "role-reviewer.r2@alpha" }), REG), "alpha");
  });
  test("unknown @-segment is not guessed", () => {
    assert.equal(attributeUsageProject(rec({ session: "role-coder-1@nowhere" }), REG), null);
  });
});

describe("attribution stage (d): session topic conventions", () => {
  test("renamed session dir with a superagent collision token still attributes (brief edge case)", () => {
    // "bridge-org-x1-2x41" -> collision suffix stripped -> topic "bridge-org" -> alias.
    assert.equal(dirBase("bridge-org-x1-2x41"), "bridge-org-x1");
    assert.equal(attributeUsageProject(rec({ session: "bridge-org-x1-2x41" }), REG), "bridge");
  });
  test("<topic>-x<N> ids", () => {
    assert.equal(attributeUsageProject(rec({ session: "medical-upstream-x1" }), REG), "medical");
  });
  test("<topic>-<N> ids (numeric tail without x)", () => {
    assert.equal(attributeUsageProject(rec({ session: "rsi-live-c12-mon-2" }), REG), null); // topic "rsi-live-c12-mon" matches no alias
    assert.equal(attributeUsageProject(rec({ session: "pi-web-2" }), REG), "bridge"); // topic "pi-web" is an alias
  });
  test("<topic>-primary (coordinator project-primary convention)", () => {
    assert.equal(attributeUsageProject(rec({ session: "pi-web-primary" }), REG), "bridge");
  });
  test("aliases shorter than 3 chars never match as bare prefixes", () => {
    const reg2: RegistryProjectLite[] = [{ id: "mc", displayName: "MC", aliases: ["mc"], root: "/tmp/mc", sessionId: "mc-primary" }];
    assert.equal(attributeUsageProject(rec({ session: "mc-upstream-x1" }), REG), null); // "mc" alias in REG? no; and no 3-char rule hit
    assert.equal(attributeUsageProject(rec({ session: "mc-thing-x1" }), reg2), null); // "mc" is 2 chars -> too weak
  });
  test("longest matching alias prefix wins", () => {
    const reg2: RegistryProjectLite[] = [
      { id: "long", displayName: "Long", aliases: ["long-alias"], root: "/tmp/l", sessionId: "long-primary" },
      { id: "short", displayName: "Short", aliases: ["long"], root: "/tmp/s", sessionId: "short-primary" },
    ];
    assert.equal(attributeUsageProject(rec({ session: "long-alias-thing-x1" }), reg2), "long");
  });
});

describe("attribution stage (e): [project:<name>] tag in task text", () => {
  test("registry id tag", () => {
    assert.equal(attributeUsageProject(rec({ task: "[project:alpha] do the thing" }), REG), "alpha");
  });
  test("alias tag (case-insensitive)", () => {
    assert.equal(attributeUsageProject(rec({ task: "brief [project:Medical] sweep" }), REG), "medical");
  });
  test("explicit personal-ops tag lands in the personal-ops bucket", () => {
    assert.equal(attributeUsageProject(rec({ task: "[project:personal-ops] lol highlights" }), REG), PERSONAL_OPS);
  });
  test("unknown tag is ignored, not guessed (falls through)", () => {
    assert.equal(attributeUsageProject(rec({ task: "[project:nowhere] mystery" }), REG), null);
  });
  test("tag beats weaker alias evidence", () => {
    // mentions both alpha and beta aliases, but the tag decides
    assert.equal(attributeUsageProject(rec({ task: "[project:alpha] also covers 阿尔法 and 医疗" }), REG), "alpha");
  });
});

describe("attribution stage (f): alias evidence + 2-mention rule", () => {
  test("exactly one project named -> attributed", () => {
    assert.equal(attributeUsageProject(rec({ task: "fix the 阿尔法 pipeline" }), REG), "alpha");
  });
  test("two projects named -> unattributed (never guessed)", () => {
    assert.equal(attributeUsageProject(rec({ task: "跨项目汇报：MC 和医疗平台" }), [
      { id: "mc", displayName: "MC", aliases: ["mc", "mineflayer"], root: "/tmp/mc", sessionId: "mc-primary" },
      ...REG,
    ]), null);
  });
  test("root path named in text -> attributed", () => {
    assert.equal(attributeUsageProject(rec({ task: "see /tmp/bridge/src for context" }), REG), "bridge");
  });
  test("ASCII aliases match on word boundaries only", () => {
    assert.equal(textMatches("restructure the mockup", "mc"), false);
    assert.equal(textMatches("fix mc now", "mc"), true);
    assert.equal(textMatches("筛查流程", "筛查"), true);
  });
});

describe("attribution edge cases (brief)", () => {
  test("untagged legacy session (uuid, no cwd, no task) -> unattributed", () => {
    assert.equal(attributeUsageProject(rec({ session: "01a1a0bc-ef90-739b-bcbe-b7ce1a2722b8" }), REG), null);
  });
  test("empty registry -> everything unattributed, never guessed", () => {
    assert.equal(attributeUsageProject(rec({ cwd: "/tmp/alpha", session: "alpha-primary", task: "[project:alpha]" }), []), null);
  });
  test("prose mention of the word project is not a tag", () => {
    assert.equal(projectTag("the project-tag convention applies"), null);
    assert.equal(projectTag("[project:PiAgents] build D1"), "PiAgents");
  });
});

// ---------------------------------------------------------------- rollup + reconciliation

describe("rollup buckets and reconciliation", () => {
  const records: UsageRecordLike[] = [
    rec({ session: "alpha-primary", tokens: { total: 1000 }, cost: 0.1 }),                 // alpha (sessionId)
    rec({ cwd: "/tmp/alpha/x", tokens: { total: 500 }, cost: 0.2 }),                       // alpha (cwd)
    rec({ session: "bridge-org-x1-2x41", tokens: { total: 2000 }, cost: 0.4 }),            // bridge (collision token)
    rec({ task: "[project:personal-ops] highlights", tokens: { total: 300 }, cost: 0.01 }),// personal-ops
    rec({ session: "01a1a0bc-uuid", tokens: { total: 700 }, cost: 0.07 }),                 // unattributed
    rec({ task: "跨项目：alpha 和 医疗", tokens: { total: 100 }, cost: 0.02 }),             // unattributed (2-mention)
  ];
  const rollup = projectUsageRollup(records, REG, { since: "2026-11-06T00:00:00.000Z", until: "2026-11-13T00:00:00.000Z" });

  test("per-project buckets", () => {
    const alpha = rollup.projects.find((p) => p.projectId === "alpha");
    const bridge = rollup.projects.find((p) => p.projectId === "bridge");
    assert.equal(alpha?.tokens, 1500);
    assert.equal(alpha?.turns, 2);
    assert.equal(alpha?.sessions, 1);
    assert.ok(Math.abs((alpha?.cost ?? 0) - 0.3) < 1e-9); // float-safe: 0.1 + 0.2
    assert.equal(bridge?.tokens, 2000);
    assert.equal(bridge?.displayName, "PiAgents web bridge");
  });
  test("explicit buckets stay explicit", () => {
    assert.equal(rollup.personalOps.tokens, 300);
    assert.equal(rollup.unattributed.tokens, 800);
    assert.equal(rollup.unattributed.turns, 2);
    assert.ok(!rollup.projects.some((p) => p.projectId === UNATTRIBUTED || p.projectId === PERSONAL_OPS));
  });
  test("sorted by tokens desc", () => {
    assert.deepEqual(rollup.projects.map((p) => p.projectId), ["bridge", "alpha"]);
  });
  test("reconciliation: buckets + totals == raw sums, exactly", () => {
    const raw = records.reduce((s, r) => s + (r.tokens?.total ?? 0), 0);
    const rawCost = records.reduce((s, r) => s + (r.cost ?? 0), 0);
    assert.equal(rollup.totals.tokens, raw);
    assert.equal(rollup.totals.cost, rawCost);
    assert.equal(rollup.totals.records, records.length);
    const check = reconcile(rollup, records);
    assert.equal(check.ok, true, check.detail);
  });
  test("reconciliation detects a corrupted rollup (negative test)", () => {
    const broken = { ...rollup, totals: { ...rollup.totals, tokens: rollup.totals.tokens + 1 } };
    assert.equal(reconcile(broken, records).ok, false);
  });
  test("empty input: zero buckets, reconciliation holds", () => {
    const empty = projectUsageRollup([], REG, { since: "2026-11-06T00:00:00.000Z", until: "2026-11-13T00:00:00.000Z" });
    assert.equal(empty.totals.tokens, 0);
    assert.equal(reconcile(empty, []).ok, true);
  });
});

// ---------------------------------------------------------------- day-file reading

describe("readUsageRecords", () => {
  const dir = join(mkdtempSync(join(tmpdir(), "usage-d1-")), "usage");
  const DAY1 = "2026-11-12";
  const DAY2 = "2026-11-13";
  const line = (r: UsageRecordLike) => JSON.stringify(r);

  test("reads in-window records across day files, filters stale ts, skips malformed lines", () => {
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, `${DAY1}.jsonl`), [
      line(rec({ ts: "2026-11-12T10:00:00.000Z", session: "alpha-primary", tokens: { total: 10 } })),
      "{corrupt",
      line(rec({ ts: "2026-11-12T23:59:00.000Z", session: "alpha-primary", tokens: { total: 20 } })),
    ].join("\n") + "\n");
    writeFileSync(join(dir, `${DAY2}.jsonl`), line(rec({ ts: "2026-11-13T01:00:00.000Z", session: "bridge-primary", tokens: { total: 30 } })) + "\n");
    // Out-of-window day file (older than the 7d window ending 2026-11-13): must be skipped.
    writeFileSync(join(dir, "2026-10-01.jsonl"), line(rec({ ts: "2026-10-01T00:00:00.000Z", tokens: { total: 999999 } })) + "\n");

    const now = Date.parse("2026-11-13T12:00:00.000Z");
    const { records, filesRead, since } = readUsageRecords(dir, 7, now);
    assert.equal(records.length, 3);
    assert.equal(filesRead.length, 2);
    assert.equal(since, new Date(now - 7 * 24 * 3600e3).toISOString());
    const rollup = projectUsageRollup(records, REG, { since, until: new Date(now).toISOString(), filesRead });
    assert.equal(rollup.totals.tokens, 60);
    assert.equal(reconcile(rollup, records).ok, true);
  });

  test("missing dir degrades to zero records (never throws)", () => {
    const { records, filesRead } = readUsageRecords(join(tmpdir(), "usage-d1-does-not-exist"), 7, Date.now());
    assert.deepEqual(records, []);
    assert.deepEqual(filesRead, []);
  });

  test("rollupLastDays end-to-end on fixture files (registry + note behavior)", () => {
    const r = rollupLastDays(dir, REG, 7, Date.parse("2026-11-13T12:00:00.000Z"));
    assert.equal(r.totals.tokens, 60);
    assert.equal(r.projects.length, 2);
    assert.equal(r.note, undefined);
    const empty = rollupLastDays(dir, [], 7, Date.parse("2026-11-13T12:00:00.000Z"));
    assert.equal(empty.note, "project registry unavailable or empty — everything is unattributed by design");
  });

  test("cleanup", () => { rmSync(dir, { recursive: true, force: true }); });
});

// ---------------------------------------------------------------- tolerant registry parse

describe("parseRegistryProjects", () => {
  test("keeps registered projects with id/aliases/root/sessionId", () => {
    const projects = parseRegistryProjects(JSON.stringify({
      schemaVersion: 1,
      projects: [
        { id: "alpha", displayName: "Alpha", aliases: ["a1"], root: "/tmp/alpha", sessionId: "alpha-primary", status: "registered" },
        { id: "off", status: "disabled", aliases: [], root: "/x", sessionId: "off-primary" },
        { id: "", aliases: [] },
        "garbage",
      ],
    }));
    assert.equal(projects.length, 1);
    assert.equal(projects[0].id, "alpha");
    assert.deepEqual(projects[0].aliases, ["a1"]);
  });
  test("garbage input -> [] (never throws)", () => {
    assert.deepEqual(parseRegistryProjects("not json"), []);
    assert.deepEqual(parseRegistryProjects(null), []);
    assert.deepEqual(parseRegistryProjects("{}"), []);
  });
});
