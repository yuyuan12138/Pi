/**
 * B3 (sa52 P1b / L2 consolidation) tests: clustering validation, contradiction
 * surfacing (never resolution), the pending-dir write contract (never the
 * approved concepts tree), idempotency, dry-run, LLM degrade, and the idle
 * hook gate.
 */
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
	buildAtomBlocks,
	parseLlmClusters,
	ruleClusterAtoms,
	ruleClusterTitle,
	ruleFindContradictions,
	tokenizeForClustering,
} from "../src/cluster.js";
import {
	candidateFileName,
	loadProjectAtoms,
	pendingDirFor,
	renderCandidate,
	runConsolidation,
	shouldIdleConsolidate,
} from "../src/consolidate.js";
import type { Atom, ConceptCluster } from "../src/types.js";
import { fakeConsolidateStreamFactory } from "./llm-fixtures.js";

const envKeys = ["PI_MEMORY_KB_ROOT", "PI_DISTILLER_STATE"] as const;
afterEach(() => {
	for (const k of envKeys) delete process.env[k];
});

let seq = 0;
function atom(claim: string, over: Partial<Atom> = {}): Atom {
	seq++;
	return {
		schema: 1,
		id: over.id ?? `atom${String(seq).padStart(8, "0")}`,
		kind: over.kind ?? "decision",
		claim,
		evidence: over.evidence ?? "",
		source_entry_ids: over.source_entry_ids ?? ["e1", "e2"],
		project: over.project ?? "proj",
		ts: over.ts ?? `2026-11-1${(seq % 9) + 1}T10:0${seq % 10}:00.000Z`,
		source_session: over.source_session ?? "sess-1",
		origin: over.origin ?? "llm",
		hash: over.hash ?? "hash",
	};
}

function writeAtomsDir(dir: string, atoms: Atom[]): string {
	mkdirSync(dir, { recursive: true });
	writeFileSync(path.join(dir, "2026-11-13.jsonl"), atoms.map((a) => JSON.stringify(a)).join("\n") + "\n");
	return dir;
}

function consolidateFixture(atoms: Atom[]) {
	const dir = mkdtempSync(path.join(tmpdir(), "distiller-consolidate-"));
	const kbRoot = path.join(dir, "kb");
	writeAtomsDir(path.join(kbRoot, "atoms", "proj"), atoms);
	return { dir, kbRoot, deps: { cwd: "/tmp/Proj", kbRoot, statePath: path.join(dir, "consolidate-state.json"), log: () => {} } };
}

// ---------------------------------------------------------------------------
// Pure clustering / contradiction logic.
// ---------------------------------------------------------------------------

describe("tokenizeForClustering", () => {
	it("keeps significant ascii tokens and CJK bigrams", () => {
		const tokens = tokenizeForClustering("The distiller uses watermarked reads; 记忆蒸馏管线");
		expect(tokens).toContain("distiller");
		expect(tokens).toContain("watermarked");
		expect(tokens).not.toContain("the");
		expect(tokens).toContain("记忆");
		expect(tokens).toContain("忆蒸");
	});
});

describe("parseLlmClusters (validation discipline)", () => {
	const atoms = [atom("alpha claim about watermarks"), atom("beta claim about watermarks"), atom("gamma claim about storage")];

	it("parses valid clusters and resolves atom references", () => {
		const out = parseLlmClusters(
			`[{"title":"Watermarks","summary":"s","atoms":[1,2],"contradictions":[{"atoms":[1,2],"subject":"reads","note":"why"}]}]`,
			atoms,
		);
		expect(out).toHaveLength(1);
		expect(out[0]!.atomIds).toEqual([atoms[0]!.id, atoms[1]!.id]);
		expect(out[0]!.contradictions[0]!.atomA).toBe(atoms[0]!.id);
	});

	it("tolerates code fences", () => {
		const out = parseLlmClusters("```json\n[{\"title\":\"T\",\"summary\":\"\",\"atoms\":[3],\"contradictions\":[]}]\n```", atoms);
		expect(out).toHaveLength(1);
		expect(out[0]!.atomIds).toEqual([atoms[2]!.id]);
	});

	it("drops clusters with empty titles or out-of-range atom indexes", () => {
		const out = parseLlmClusters(
			`[{"title":"","summary":"","atoms":[1],"contradictions":[]},{"title":"X","summary":"","atoms":[99],"contradictions":[]},{"title":"Y","summary":"","atoms":[],"contradictions":[]}]`,
			atoms,
		);
		expect(out).toHaveLength(0);
	});

	it("drops contradictions with fewer than two resolvable sides", () => {
		const out = parseLlmClusters(
			`[{"title":"T","summary":"","atoms":[1,2],"contradictions":[{"atoms":[1,1],"subject":"s"},{"atoms":[1,42],"subject":"s"},{"atoms":[2,3],"subject":"ok"}]}]`,
			atoms,
		);
		expect(out[0]!.contradictions).toHaveLength(1);
		expect(out[0]!.contradictions[0]!.atomA).toBe(atoms[1]!.id);
		expect(out[0]!.contradictions[0]!.atomB).toBe(atoms[2]!.id);
	});

	it("throws on non-JSON output (caller degrades to rules)", () => {
		expect(() => parseLlmClusters("no json here", atoms)).toThrow();
	});
});

describe("ruleClusterAtoms + ruleFindContradictions (honest degrade)", () => {
	it("clusters overlapping claims and separates distinct ones", () => {
		const atoms = [
			atom("The distiller writes atoms with per-file watermarked byte offsets."),
			atom("Distiller watermarks track per-file byte offsets so deltas are read once."),
			atom("The deploy pipeline runs database migrations before the web tier."),
		];
		const clusters = ruleClusterAtoms(atoms);
		expect(clusters.length).toBeGreaterThanOrEqual(2);
		const wm = clusters.find((c) => c.atomIds.includes(atoms[0]!.id))!;
		expect(wm.atomIds).toContain(atoms[1]!.id);
		expect(wm.atomIds).not.toContain(atoms[2]!.id);
	});

	it("surfaces negation-polarity conflicts on a shared subject, never resolves them", () => {
		const atoms = [
			atom("We never use SQLite for the memory index."),
			atom("We use SQLite for the memory index because it needs no daemon."),
		];
		const contradictions = ruleFindContradictions(atoms);
		expect(contradictions).toHaveLength(1);
		expect(contradictions[0]!.atomA).toBe(atoms[0]!.id);
		expect(contradictions[0]!.atomB).toBe(atoms[1]!.id);
		expect(contradictions[0]!.claimA).toBe(atoms[0]!.claim); // verbatim, unmodified
	});

	it("does not flag same-polarity or disjoint-subject pairs", () => {
		const a = atom("Always write integration tests before merging a feature.");
		const b = atom("Integration tests run on every merge in this repository.");
		expect(ruleFindContradictions([a, b])).toHaveLength(0);
		const c = atom("Never deploy on Fridays without a rollback plan.");
		const d = atom("The renderer must not crash when a texture is missing.");
		expect(ruleFindContradictions([c, d])).toHaveLength(0);
	});

	it("rule cluster title is deterministic from frequent tokens", () => {
		const members = [atom("watermark offsets in the distiller"), atom("distiller watermark offsets per file")];
		expect(ruleClusterTitle(members)).toBe(ruleClusterTitle([...members].reverse()));
	});
});

// ---------------------------------------------------------------------------
// Orchestration + write contract.
// ---------------------------------------------------------------------------

describe("runConsolidation (rule path)", () => {
	const ATOMS = [
		atom("The distiller writes atoms only after dedup and credential screening pass."),
		atom("Distiller watermarks track per-file byte offsets so each delta is read once."),
		atom("We prefer dispatching bounded coding tasks to clean-context subagents."),
		atom("Never store credentials in the knowledge base; screening runs before any write."),
	];

	it("writes draft candidates ONLY under concepts/pending-<date>/ and never the approved tree", async () => {
		const f = consolidateFixture(ATOMS);
		const stats = await runConsolidation(f.deps, { dryRun: false, trigger: "test" });
		expect(stats.llmUsed).toBe(false);
		expect(stats.atomsRead).toBe(ATOMS.length);
		expect(stats.candidates).toBeGreaterThan(0);

		const conceptsDir = path.join(f.kbRoot, "knowledge", "concepts");
		const pendingDir = pendingDirFor(f.kbRoot, "2026-11-13").replace("2026-11-13", ""); // any date
		expect(existsSync(conceptsDir)).toBe(true);
		// The approved tree (direct .md children) must stay EMPTY.
		const approvedMd = readdirSync(conceptsDir).filter((n) => n.endsWith(".md"));
		expect(approvedMd).toEqual([]);
		// Everything written lives inside a pending-<date>/ subdirectory.
		const subdirs = readdirSync(conceptsDir, { withFileTypes: true }).filter((e) => e.isDirectory());
		expect(subdirs.length).toBeGreaterThan(0);
		expect(subdirs.every((e) => /^pending-\d{4}-\d{2}-\d{2}$/.test(e.name))).toBe(true);

		const candidateFile = readdirSync(path.join(conceptsDir, subdirs[0]!.name)).find((n) => n.endsWith(".md") && n !== "REPORT.md")!;
		const content = readFileSync(path.join(conceptsDir, subdirs[0]!.name, candidateFile), "utf8");
		expect(content).toContain("scope: pending");
		expect(content).toContain("approval: unreviewed");
		expect(content).not.toContain("scope: global");
		expect(content).toContain("source_entry_ids");
		expect(content).toContain("Contradictions (surfaced, never auto-resolved)");
	});

	it("writes a REPORT.md with the surfaced contradictions", async () => {
		const f = consolidateFixture(ATOMS);
		await runConsolidation(f.deps, { dryRun: false, trigger: "test" });
		const conceptsDir = path.join(f.kbRoot, "knowledge", "concepts");
		const subdir = readdirSync(conceptsDir, { withFileTypes: true }).filter((e) => e.isDirectory())[0]!.name;
		const report = readFileSync(path.join(conceptsDir, subdir, "REPORT.md"), "utf8");
		expect(report).toContain("Consolidation report");
		expect(report).toContain("surface-only, human gate");
	});

	it("is idempotent: re-running over the same atoms rewrites the same candidate files", async () => {
		const f = consolidateFixture(ATOMS);
		await runConsolidation(f.deps, { dryRun: false, trigger: "first" });
		const conceptsDir = path.join(f.kbRoot, "knowledge", "concepts");
		const subdir = readdirSync(conceptsDir, { withFileTypes: true }).filter((e) => e.isDirectory())[0]!.name;
		const before = readdirSync(path.join(conceptsDir, subdir)).sort();
		await runConsolidation(f.deps, { dryRun: false, trigger: "second" });
		const after = readdirSync(path.join(conceptsDir, subdir)).sort();
		expect(after).toEqual(before); // same content-derived names, no duplicates
	});

	it("dry-run writes nothing anywhere", async () => {
		const f = consolidateFixture(ATOMS);
		const stats = await runConsolidation(f.deps, { dryRun: true, trigger: "test" });
		expect(stats.clusters).toBeGreaterThan(0);
		expect(stats.candidates).toBe(0);
		const conceptsDir = path.join(f.kbRoot, "knowledge", "concepts");
		expect(existsSync(conceptsDir)).toBe(false);
		expect(existsSync(path.join(f.dir, "consolidate-state.json"))).toBe(false);
	});

	it("skips credential-flagged atoms at read time", async () => {
		const flagged = atom("Decision: the staging deploys used bot token xoxb-fake000000000-fake000000000 during rollout.");
		const f = consolidateFixture([flagged, atom("An unrelated durable claim about the deploy pipeline ordering.")]);
		const { atoms } = await loadProjectAtoms(path.join(f.kbRoot, "atoms", "proj"));
		expect(atoms).toHaveLength(1);
	});

	it("degrades honestly when the LLM produces garbage", async () => {
		const f = consolidateFixture(ATOMS);
		const registry = { streamSimple: fakeConsolidateStreamFactory({ mode: "garbage" }), hasConfiguredAuth: () => true };
		const stats = await runConsolidation(f.deps, {
			dryRun: false,
			trigger: "test",
			model: { id: "test" },
			modelRegistry: registry,
		});
		expect(stats.llmUsed).toBe(false);
		expect(stats.degradedReason).toContain("llm-error");
		expect(stats.clusters).toBeGreaterThan(0); // rule fallback still delivered
	});

	it("uses the LLM path when available and honors its contradictions", async () => {
		const f = consolidateFixture(ATOMS);
		const registry = { streamSimple: fakeConsolidateStreamFactory({ mode: "good" }), hasConfiguredAuth: () => true };
		const stats = await runConsolidation(f.deps, {
			dryRun: false,
			trigger: "test",
			model: { id: "test" },
			modelRegistry: registry,
		});
		expect(stats.llmUsed).toBe(true);
		expect(stats.contradictions).toBeGreaterThanOrEqual(1);
		// The LLM-attached contradiction must land inside one candidate file.
		const conceptsDir = path.join(f.kbRoot, "knowledge", "concepts");
		const subdir = readdirSync(conceptsDir, { withFileTypes: true }).filter((e) => e.isDirectory())[0]!.name;
		const all = readdirSync(path.join(conceptsDir, subdir))
			.filter((n) => n.endsWith(".md") && n !== "REPORT.md")
			.map((n) => readFileSync(path.join(conceptsDir, subdir, n), "utf8"))
			.join("\n");
		expect(all).toContain("conflicting claims on the same subject");
	});
});

describe("candidate naming + rendering", () => {
	it("candidate file names are content-derived (stable across re-runs)", () => {
		expect(candidateFileName("My Topic", ["a", "b"])).toBe(candidateFileName("My Topic", ["b", "a"]));
		expect(candidateFileName("My Topic", ["a", "b"])).not.toBe(candidateFileName("My Topic", ["a", "c"]));
		expect(candidateFileName("存储后端", ["a"])).toMatch(/[\u4e00-\u9fff]/);
	});

	it("renderCandidate keeps the full evidence chain and never emits global scope", () => {
		const a1 = atom("claim one about watermarks");
		const a2 = atom("claim two about watermarks");
		const cluster: ConceptCluster = { title: "Watermarks", summary: "s", atomIds: [a1.id, a2.id], contradictions: [] };
		const rendered = renderCandidate(cluster, new Map([[a1.id, a1], [a2.id, a2]]), "proj", "2026-11-13");
		expect(rendered).toContain("scope: pending");
		expect(rendered).toMatch(/title: Watermarks/);
		expect(rendered).toContain(a1.source_entry_ids.join(", "));
		expect(rendered).toContain("recall()");
		expect(rendered).not.toMatch(/^scope: global/m);
	});
});

describe("idle consolidation gate (disabled by default)", () => {
	const state = { version: 1 as const, lastRunTs: null };

	it("is off unless explicitly opted in", () => {
		expect(shouldIdleConsolidate(undefined, 100, state, new Date())).toBe(false);
		expect(shouldIdleConsolidate("0", 100, state, new Date())).toBe(false);
	});

	it("requires the atom threshold when opted in", () => {
		expect(shouldIdleConsolidate("1", 39, state, new Date())).toBe(false);
		expect(shouldIdleConsolidate("1", 40, state, new Date())).toBe(true);
	});

	it("respects the minimum interval between runs", () => {
		const recent = { version: 1 as const, lastRunTs: new Date(Date.now() - 3600_000).toISOString() };
		expect(shouldIdleConsolidate("1", 100, recent, new Date())).toBe(false);
		const old = { version: 1 as const, lastRunTs: new Date(Date.now() - 13 * 3600_000).toISOString() };
		expect(shouldIdleConsolidate("1", 45, old, new Date())).toBe(true);
	});
});

describe("buildAtomBlocks", () => {
	it("renders numbered provenance-stamped blocks", () => {
		const a = atom("claim");
		const blocks = buildAtomBlocks([a]);
		expect(blocks).toContain(`[1] (id=${a.id} kind=decision ts=${a.ts})`);
	});
});
