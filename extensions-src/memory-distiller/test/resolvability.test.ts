/**
 * Acceptance: every atom's source_entry_ids resolve to real entry ids in the
 * session file the candidates came from (recall-compatible provenance).
 */
import { mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { runDistillation } from "../src/distill.js";
import { allEntryIdsInSessionFile, writeFixtureSession } from "./helpers.js";

describe("source_entry_ids resolvability", () => {
	it("every atom provenance id exists in the fixture session file (rule path)", async () => {
		const dir = mkdtempSync(path.join(tmpdir(), "distiller-resolve-"));
		const sessionDir = path.join(dir, "sessions");
		const sessionFile = writeFixtureSession(sessionDir, "2026-11-13T09-00-00_11112222-3333-4444-5555-666666666666.jsonl", {
			compactions: [
				{
					id: "comp1",
					timestamp: "2026-11-13T09:02:00.000Z",
					observations: [
						{
							id: "aa0000000001",
							content: "Decision: provenance ids on every atom must resolve inside the source session file.",
							timestamp: "2026-11-13 09:01",
							sourceEntryIds: ["adff437e"],
						},
					],
				},
			],
			omRecorded: {
				id: "ee0000000007",
				observations: [
					{
						id: "ee0000000008",
						content: "The recorded observation entries also carry resolvable provenance for recall drill-back.",
						timestamp: "2026-11-13 09:05",
					},
				],
			},
			subagentReport: {
				id: "ff0000000008",
				content: "Worker report: the resolvability check runs against the union of all fixture entry ids.",
			},
		});
		const stats = await runDistillation(
			{
				cwd: "/tmp/Resolve_Project",
				sessionDir,
				kbRoot: path.join(dir, "kb"),
				statePath: path.join(dir, "state.json"),
				log: () => {},
			},
			{ dryRun: false, trigger: "manual" },
		);
		expect(stats.written).toBeGreaterThan(0);

		const fixtureIds = allEntryIdsInSessionFile(sessionFile);
		const atomsFile = stats.atomsFile!;
		const lines = readFileSync(atomsFile, "utf8").split("\n").filter((l) => l.trim());
		const atoms = lines.map((l) => JSON.parse(l) as { source_entry_ids: string[]; source_session: string });
		expect(atoms.length).toBe(stats.written);
		for (const atom of atoms) {
			expect(atom.source_entry_ids.length).toBeGreaterThan(0);
			for (const id of atom.source_entry_ids) {
				expect(fixtureIds.has(id), `provenance id ${id} must exist in ${path.basename(sessionFile)}`).toBe(true);
			}
			expect(atom.source_session).toBe("11112222-3333-4444-5555-666666666666");
		}
	});
});
