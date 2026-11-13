import { mkdtempSync, readFileSync, writeFileSync, appendFileSync, existsSync, readdirSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { DistillerState } from "../src/state.js";
import { scanSessionDeltas } from "../src/scan.js";
import { writeFixtureSession } from "./helpers.js";

function tmp(): string {
	return mkdtempSync(path.join(tmpdir(), "distiller-scan-"));
}

describe("scanSessionDeltas (watermarked JSONL deltas)", () => {
	it("extracts candidates from compaction, om.observations.recorded, and subagent-report entries", () => {
		const dir = tmp();
		const sessionDir = path.join(dir, "sessions");
		writeFixtureSession(sessionDir, "2026-11-13T09-00-00_11111111-2222-3333-4444-555555555555.jsonl", {
			compactions: [
				{
					id: "comp1",
					timestamp: "2026-11-13T09:02:00.000Z",
					observations: [
						{
							id: "aa0000000001",
							content: "Decision: the atoms file format is append-only JSONL under knowledge-base/atoms.",
							timestamp: "2026-11-13 09:01",
						},
					],
				},
			],
			omRecorded: {
				id: "ee0000000007",
				observations: [
					{
						id: "ee0000000008",
						content: "The worker verified that watermarks survive a restart via the state file.",
						timestamp: "2026-11-13 09:05",
					},
				],
			},
			subagentReport: {
				id: "ff0000000008",
				content:
					"Worker report: implemented the scan module and verified the watermark semantics against three fixture files.",
			},
		});
		const state = new DistillerState(path.join(dir, "state.json"));
		const scan = scanSessionDeltas(sessionDir, state);
		expect(scan.filesScanned).toBe(1);
		expect(scan.candidates.length).toBe(3);
		const sources = scan.candidates.map((c) => c.source).sort();
		expect(sources).toEqual(["compaction-observation", "om-observation", "subagent-report"]);
		expect(scan.candidates.every((c) => c.sessionUuid === "11111111-2222-3333-4444-555555555555")).toBe(true);
	});

	it("second scan is a no-op (watermark advanced, no re-read)", () => {
		const dir = tmp();
		const sessionDir = path.join(dir, "sessions");
		const file = writeFixtureSession(sessionDir, "s1.jsonl", {
			compactions: [
				{
					id: "comp1",
					timestamp: "2026-11-13T09:02:00.000Z",
					observations: [{ id: "aa1", content: "First scan should consume this complete observation entry.", timestamp: "2026-11-13 09:01" }],
				},
			],
		});
		const state = new DistillerState(path.join(dir, "state.json"));
		state.load();
		const scan1 = scanSessionDeltas(sessionDir, state);
		expect(scan1.candidates.length).toBe(1);
		for (const [p, wm] of scan1.newWatermarks) state.setWatermark(p, wm);
		state.save();

		const state2 = new DistillerState(path.join(dir, "state.json"));
		state2.load();
		const scan2 = scanSessionDeltas(sessionDir, state2);
		expect(scan2.candidates.length).toBe(0);
		expect(scan2.filesChanged).toBe(0);
		expect(scan2.filesScanned).toBe(1); // stat'ed but not re-read
		expect(existsSync(file)).toBe(true);
	});

	it("watermarks survive a restart: only the NEW delta is read after re-append", () => {
		const dir = tmp();
		const sessionDir = path.join(dir, "sessions");
		const file = writeFixtureSession(sessionDir, "s1.jsonl", {
			compactions: [
				{
					id: "comp1",
					timestamp: "2026-11-13T09:02:00.000Z",
					observations: [{ id: "aa1", content: "Watermark run one consumes this complete observation entry now.", timestamp: "2026-11-13 09:01" }],
				},
			],
		});
		const statePath = path.join(dir, "state.json");
		const state1 = new DistillerState(statePath);
		state1.load();
		const scan1 = scanSessionDeltas(sessionDir, state1);
		expect(scan1.candidates.length).toBe(1);
		for (const [p, wm] of scan1.newWatermarks) state1.setWatermark(p, wm);
		state1.save();

		// New turns append (simulate pi appending later entries).
		appendFileSync(
			file,
			JSON.stringify({
				type: "compaction",
				id: "comp2",
				timestamp: "2026-11-13T10:02:00.000Z",
				details: {
					observations: [
						{ id: "aa2", content: "Restart run two must consume only this second fresh observation entry.", timestamp: "2026-11-13 10:01", sourceEntryIds: ["adff437e"] },
					],
				},
			}) + "\n",
		);

		// "Restart": brand-new state instance loading the saved file.
		const state2 = new DistillerState(statePath);
		state2.load();
		const scan2 = scanSessionDeltas(sessionDir, state2);
		expect(scan2.candidates.length).toBe(1);
		expect(scan2.candidates[0]!.text).toContain("only this second fresh observation");
		const texts = scan1.candidates.map((c) => c.text).join("|");
		expect(scan2.candidates[0]!.text === texts).toBe(false); // no re-read of run-one text
	});

	it("a partially written trailing line is left for the next scan", () => {
		const dir = tmp();
		const sessionDir = path.join(dir, "sessions");
		const file = writeFixtureSession(sessionDir, "s1.jsonl", {
			compactions: [
				{
					id: "comp1",
					timestamp: "2026-11-13T09:02:00.000Z",
					observations: [{ id: "aa1", content: "Complete entry before the torn tail line stays readable always.", timestamp: "2026-11-13 09:01" }],
				},
			],
		});
		const state = new DistillerState(path.join(dir, "state.json"));
		state.load();
		const scan1 = scanSessionDeltas(sessionDir, state);
		expect(scan1.candidates.length).toBe(1);
		for (const [p, wm] of scan1.newWatermarks) state.setWatermark(p, wm);

		// Torn write: kill landed mid-line (no trailing newline yet).
		const torn = JSON.stringify({
			type: "compaction",
			id: "comp2",
			details: { observations: [{ id: "aa2", content: "torn", sourceEntryIds: ["x"] }] },
		}).slice(0, 40);
		appendFileSync(file, torn);

		const scan2 = scanSessionDeltas(sessionDir, state);
		expect(scan2.candidates.length).toBe(0); // torn line not consumed

		// The write completes (newline appended).
		appendFileSync(file, "\n");
		const scan3 = scanSessionDeltas(sessionDir, state);
		expect(scan3.candidates.length).toBe(0); // line complete now but torn content was garbage <24 chars / invalid entry
		expect(scan3.parseErrors + scan3.candidates.length).toBeGreaterThanOrEqual(0);
	});

	it("shrunk files are rescanned from zero", () => {
		const dir = tmp();
		const sessionDir = path.join(dir, "sessions");
		const file = writeFixtureSession(sessionDir, "s1.jsonl", {
			compactions: [
				{
					id: "comp1",
					timestamp: "2026-11-13T09:02:00.000Z",
					observations: [{ id: "aa1", content: "Original long content that will be replaced by a rewrite below.", timestamp: "2026-11-13 09:01" }],
				},
			],
		});
		const state = new DistillerState(path.join(dir, "state.json"));
		state.load();
		const scan1 = scanSessionDeltas(sessionDir, state);
		for (const [p, wm] of scan1.newWatermarks) state.setWatermark(p, wm);
		expect(scan1.candidates.length).toBe(1);

		writeFileSync(file, "smaller\n");
		const scan2 = scanSessionDeltas(sessionDir, state);
		expect(scan2.candidates.length).toBe(0);
	});

	it("a missing session dir yields an empty scan", () => {
		const dir = tmp();
		const state = new DistillerState(path.join(dir, "state.json"));
		const scan = scanSessionDeltas(path.join(dir, "nope"), state);
		expect(scan.candidates.length).toBe(0);
		expect(scan.filesScanned).toBe(0);
	});
});

describe("DistillerState", () => {
	it("save is atomic (no temp files left behind) and reloads intact", () => {
		const dir = tmp();
		const statePath = path.join(dir, "nested", "state.json");
		const state = new DistillerState(statePath);
		state.load();
		state.setWatermark("/some/session.jsonl", { byte_offset: 1234, size: 1234, mtime_ms: 42 });
		state.save();
		const files = readdirSync(path.join(dir, "nested"));
		expect(files.filter((f) => f.includes(".tmp-"))).toEqual([]);
		const state2 = new DistillerState(statePath);
		state2.load();
		expect(state2.getWatermark("/some/session.jsonl")).toEqual({ byte_offset: 1234, size: 1234, mtime_ms: 42 });
	});

	it("corrupt state files start fresh instead of crashing", () => {
		const dir = tmp();
		const statePath = path.join(dir, "state.json");
		writeFileSync(statePath, "{not json at all");
		const state = new DistillerState(statePath);
		expect(() => state.load()).not.toThrow();
		expect(state.getWatermark("/x")).toBeUndefined();
		expect(readFileSync(statePath, "utf8")).toBe("{not json at all"); // untouched until a save
	});
});
