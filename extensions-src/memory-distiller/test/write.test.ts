import { existsSync, mkdtempSync, readdirSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { runDistillation, formatRunStats, kbRootForCwd } from "../src/distill.js";
import { DistillerState } from "../src/state.js";
import { fakeStreamSimpleFactory, CRED_FIXTURE_TEXT } from "./llm-fixtures.js";
import { writeFixtureSession } from "./helpers.js";

function tmp(): string {
	return mkdtempSync(path.join(tmpdir(), "distiller-write-"));
}

interface Fixture {
	dir: string;
	sessionDir: string;
	kbRoot: string;
	statePath: string;
	deps: Parameters<typeof runDistillation>[0];
}

function fixture(opts?: { credentialObservation?: boolean }): Fixture {
	const dir = tmp();
	const sessionDir = path.join(dir, "sessions");
	writeFixtureSession(sessionDir, "s1.jsonl", {
		compactions: [
			{
				id: "comp1",
				timestamp: "2026-11-13T09:02:00.000Z",
				observations: [
					{
						id: "aa1",
						content: "Decision: the distiller writes atoms only after dedup and credential screening pass.",
						timestamp: "2026-11-13 09:01",
					},
					{
						id: "aa2",
						content: "We prefer watermarked incremental reads so repeated runs never re-read old deltas.",
						timestamp: "2026-11-13 09:01",
					},
				],
			},
		],
		credentialObservation: opts?.credentialObservation,
	});
	const kbRoot = path.join(dir, "kb");
	const statePath = path.join(dir, "state.json");
	return {
		dir,
		sessionDir,
		kbRoot,
		statePath,
		deps: { cwd: "/tmp/Fake_Project", sessionDir, kbRoot, statePath, log: () => {} },
	};
}

function atomsFiles(f: Fixture, project = "fake_project"): string[] {
	const dir = path.join(f.kbRoot, "atoms", project);
	if (!existsSync(dir)) return [];
	return readdirSync(dir).filter((x) => x.endsWith(".jsonl")).sort();
}

function readAtoms(f: Fixture, project = "fake_project"): Array<Record<string, unknown>> {
	const out: Array<Record<string, unknown>> = [];
	for (const file of atomsFiles(f, project)) {
		for (const line of readFileSync(path.join(f.kbRoot, "atoms", project, file), "utf8").split("\n")) {
			const t = line.trim();
			if (!t) continue;
			out.push(JSON.parse(t) as Record<string, unknown>);
		}
	}
	return out;
}

describe("runDistillation write path (Theme B1 acceptance)", () => {
	it("/distill --dry-run writes nothing (no atoms file, no watermark advancement)", async () => {
		const f = fixture();
		const stats = await runDistillation(f.deps, { dryRun: true, trigger: "manual" });
		expect(stats.candidates).toBe(2);
		expect(stats.extracted).toBeGreaterThan(0);
		expect(stats.written).toBe(0);
		expect(stats.atomsFile).toBeNull();
		expect(existsSync(f.kbRoot)).toBe(false); // nothing created at all
		expect(existsSync(f.statePath)).toBe(false); // dry-run: not even lastRun diagnostics
		// watermark must NOT advance on dry-run: a later real run re-reads the delta
		const stats2 = await runDistillation(f.deps, { dryRun: false, trigger: "manual" });
		expect(stats2.written).toBe(stats.extracted);
	});

	it("real run appends atoms with provenance + dedup keys; second identical run is all-duplicates", async () => {
		const f = fixture();
		const stats = await runDistillation(f.deps, { dryRun: false, trigger: "idle-debounce" });
		expect(stats.written).toBe(stats.extracted);
		expect(stats.atomsFile).toContain(path.join("atoms", "fake_project"));
		const atoms = readAtoms(f);
		expect(atoms.length).toBe(stats.written);
		for (const a of atoms) {
			expect(a.schema).toBe(1);
			expect(a.project).toBe("fake_project");
			expect((a.source_entry_ids as string[]).length).toBeGreaterThan(0);
			expect(typeof a.hash).toBe("string");
			expect(a.id).toMatch(/^[0-9a-f]{12}$/);
			expect(["llm", "rule"]).toContain(a.origin);
		}

		// Kill-simulation: state lost before watermark save → full re-read →
		// content-hash dedup collapses everything; nothing is written twice.
		const { unlinkSync } = await import("node:fs");
		unlinkSync(f.statePath);
		const stats2 = await runDistillation(f.deps, { dryRun: false, trigger: "idle-debounce" });
		expect(stats2.candidates).toBe(2);
		expect(stats2.duplicates).toBe(stats.written);
		expect(stats2.written).toBe(0);
		expect(readAtoms(f)).toHaveLength(atoms.length);
	});

	it("credential fixture is skipped BEFORE any write (slack-shaped token, git-guard-safe)", async () => {
		const f = fixture({ credentialObservation: true });
		const stats = await runDistillation(f.deps, { dryRun: false, trigger: "manual" });
		expect(stats.credentialsSkipped).toBe(1);
		const all = readAtoms(f).map((a) => JSON.stringify(a));
		expect(all.some((s) => s.includes(CRED_FIXTURE_TEXT))).toBe(false);
		expect(all.some((s) => s.includes("xoxb-"))).toBe(false);
	});

	it("LLM path is used when a model + auth + streamSimple exist; drafts carry origin=llm", async () => {
		const f = fixture();
		const deps = {
			...f.deps,
			model: { provider: "test", id: "test-model" },
			modelRegistry: {
				hasConfiguredAuth: () => true,
				streamSimple: fakeStreamSimpleFactory(),
			},
		};
		const stats = await runDistillation(deps, { dryRun: false, trigger: "idle-debounce" });
		expect(stats.llmUsed).toBe(true);
		expect(stats.degradedReason).toBeNull();
		const atoms = readAtoms(f);
		expect(atoms.every((a) => a.origin === "llm")).toBe(true);
	});

	it("LLM failure degrades to rule-based extraction (never fabricates, still writes)", async () => {
		const f = fixture();
		const deps = {
			...f.deps,
			model: { provider: "test", id: "test-model" },
			modelRegistry: {
				hasConfiguredAuth: () => true,
				streamSimple: fakeStreamSimpleFactory({ mode: "garbage" }),
			},
		};
		const stats = await runDistillation(deps, { dryRun: false, trigger: "idle-debounce" });
		expect(stats.llmUsed).toBe(false);
		expect(stats.degradedReason).toContain("llm-error");
		expect(stats.written).toBeGreaterThan(0);
		expect(readAtoms(f).every((a) => a.origin === "rule")).toBe(true);
	});

	it("no model at all → rule-based with honest degradedReason=no-model", async () => {
		const f = fixture();
		const stats = await runDistillation(f.deps, { dryRun: false, trigger: "session_shutdown:quit" });
		expect(stats.llmUsed).toBe(false);
		expect(stats.degradedReason).toBe("no-model");
		expect(stats.written).toBeGreaterThan(0);
	});

	it("zero-candidate runs advance watermarks but write no files", async () => {
		const f = fixture();
		await runDistillation(f.deps, { dryRun: false, trigger: "manual" });
		// second run: everything watermarked, no new candidates
		const stats2 = await runDistillation(f.deps, { dryRun: false, trigger: "manual" });
		expect(stats2.candidates).toBe(0);
		expect(stats2.written).toBe(0);
		expect(existsSync(f.statePath)).toBe(true);
		// zero-yield run is still recorded honestly in lastRun diagnostics
		const st = new DistillerState(f.statePath);
		st.load();
		expect(st.getLastRun()).toMatchObject({ trigger: "manual", written: 0 });
	});

	it("no session dir → clean empty run", async () => {
		const f = fixture();
		const stats = await runDistillation({ ...f.deps, sessionDir: undefined }, { dryRun: false, trigger: "manual" });
		expect(stats.candidates).toBe(0);
		expect(stats.written).toBe(0);
	});

	it("LLM-failure degrade persists a bounded lastRun into state.json (degradedReason recoverable)", async () => {
		// Regression: the 2026-11-13 21:05 idle run wrote 23 atoms via the rule
		// degrade but its degradedReason went only to console.error — lost.
		const f = fixture();
		const deps = {
			...f.deps,
			model: { provider: "test", id: "test-model" },
			modelRegistry: {
				hasConfiguredAuth: () => true,
				streamSimple: fakeStreamSimpleFactory({ mode: "garbage" }),
			},
		};
		const stats = await runDistillation(deps, { dryRun: false, trigger: "idle-debounce" });
		expect(stats.llmUsed).toBe(false);
		expect(stats.degradedReason).toContain("llm-error");
		const st = new DistillerState(f.statePath);
		st.load();
		const last = st.getLastRun();
		expect(last).toBeTruthy();
		// bounded key set, exactly as specified
		expect(Object.keys(last!).sort()).toEqual(
			["at", "atomsFile", "degradedReason", "llmUsed", "scanned", "trigger", "written"],
		);
		expect(last!.trigger).toBe("idle-debounce");
		expect(last!.scanned).toBe(stats.filesScanned);
		expect(last!.written).toBe(stats.written);
		expect(last!.llmUsed).toBe(false);
		expect(last!.degradedReason).toBe(stats.degradedReason);
		expect(last!.atomsFile).toBe(stats.atomsFile);
		expect(Number.isNaN(Date.parse(last!.at))).toBe(false); // ISO timestamp
	});
});

describe("kill-safety invariants", () => {
	it("state saves leave no temp files and parse back", async () => {
		const f = fixture();
		await runDistillation(f.deps, { dryRun: false, trigger: "manual" });
		const stateDir = path.dirname(f.statePath);
		const leftovers = readdirSync(stateDir).filter((n) => n.includes(".tmp-"));
		expect(leftovers).toEqual([]);
		JSON.parse(readFileSync(f.statePath, "utf8")); // valid JSON
	});

	it("atoms files contain only complete JSONL lines (append batches, never torn by us)", async () => {
		const f = fixture();
		await runDistillation(f.deps, { dryRun: false, trigger: "manual" });
		for (const file of atomsFiles(f)) {
			const raw = readFileSync(path.join(f.kbRoot, "atoms", "fake_project", file), "utf8");
			expect(raw.endsWith("\n")).toBe(true);
			for (const line of raw.split("\n")) {
				if (line.trim()) expect(() => JSON.parse(line)).not.toThrow();
			}
		}
	});
});

describe("misc", () => {
	it("kbRootForCwd honors override > env > <cwd>/knowledge-base", () => {
		expect(kbRootForCwd("/x", "/override")).toBe("/override");
		const prev = process.env.PI_MEMORY_KB_ROOT;
		process.env.PI_MEMORY_KB_ROOT = "/from-env";
		expect(kbRootForCwd("/x")).toBe("/from-env");
		if (prev === undefined) delete process.env.PI_MEMORY_KB_ROOT;
		else process.env.PI_MEMORY_KB_ROOT = prev;
		expect(kbRootForCwd("/x")).toBe(path.join("/x", "knowledge-base"));
	});

	it("formatRunStats is honest about dry-run and degrade reason", async () => {
		const f = fixture();
		const stats = await runDistillation(f.deps, { dryRun: true, trigger: "manual" });
		const text = formatRunStats(stats);
		expect(text).toContain("dry-run");
		expect(text).toContain("Nothing written");
		expect(text).toContain("no-model");
	});
});
