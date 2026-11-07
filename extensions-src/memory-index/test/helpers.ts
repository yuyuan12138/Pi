/** Synthetic session/compaction fixtures shared by the memory-index tests. */
import { mkdirSync, writeFileSync } from "node:fs";
import path from "node:path";

export interface FixtureObservation {
	id: string;
	content: string;
	timestamp: string; // naive local, as pi-observational-memory writes them
	sourceEntryIds?: string[];
}

export interface FixtureCompaction {
	id: string;
	timestamp: string; // ISO with Z
	observations: FixtureObservation[];
}

/** One JSONL compaction entry shaped like a real om.folded entry. */
export function compactionEntryLine(fixture: FixtureCompaction): string {
	return JSON.stringify({
		type: "compaction",
		id: fixture.id,
		parentId: "0000beef",
		timestamp: fixture.timestamp,
		summary: "Condensed memories from earlier in this session.",
		firstKeptEntryId: "1111cafe",
		tokensBefore: 4242,
		details: {
			type: "om.folded",
			version: 1,
			fullFold: false,
			observations: fixture.observations.map((o) => ({
				id: o.id,
				content: o.content,
				timestamp: o.timestamp,
				relevance: "medium",
				sourceEntryIds: o.sourceEntryIds ?? ["adff437e"],
				tokenCount: 31,
			})),
			reflections: [],
		},
	});
}

/** Write a session file (header filler lines + compaction entries). */
export function writeSessionFile(
	dir: string,
	fileName: string,
	compactions: FixtureCompaction[],
): string {
	mkdirSync(dir, { recursive: true });
	const lines: string[] = [];
	lines.push(
		JSON.stringify({ type: "session", id: fileName.replace(/\.jsonl$/, ""), cwd: dir, version: 3 }),
	);
	lines.push(
		JSON.stringify({
			type: "message",
			id: "1111aaaa",
			parentId: null,
			timestamp: compactions[0]?.timestamp ?? new Date().toISOString(),
			message: { role: "user", content: "work on the memory index" },
		}),
	);
	for (const c of compactions) lines.push(compactionEntryLine(c));
	const filePath = path.join(dir, fileName);
	writeFileSync(filePath, lines.join("\n") + "\n");
	return filePath;
}

export const OBS_A = "aa0000000001";
export const OBS_B = "bb0000000002";
export const OBS_C = "cc0000000003";
export const OBS_OLD = "dd0000000004";
