/** Synthetic session/compaction/worker fixtures shared by the distiller tests. */
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
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

export interface FixtureOmRecorded {
	id: string; // the custom entry's id
	observations: FixtureObservation[];
}

export interface FixtureSubagentReport {
	id: string;
	content: string;
}

/**
 * Slack-shaped token inside a decision sentence: drafted by the rule extractor
 * (decision trigger) then caught by the credential screen before any write —
 * and safe for the repo's staged-content guard, which blocks AKIA/sk-/ghp_-
 * shaped strings at commit time (hence this git-guard-clean token shape).
 */
export const CRED_FIXTURE_TEXT =
	"Decision: the staging deploys used bot token xoxb-fake000000000-fake000000000 during rollout.";

export const ENTRY_MSG = "adff437e"; // a regular message entry id atoms can cite

/** One JSONL line per fixture entry, shaped like real pi session entries. */
export function fixtureSessionLines(opts: {
	compactions?: FixtureCompaction[];
	omRecorded?: FixtureOmRecorded;
	subagentReport?: FixtureSubagentReport;
	credentialObservation?: boolean;
}): string[] {
	const lines: string[] = [];
	lines.push(JSON.stringify({ type: "session", id: "fixture-session-uuid", cwd: "/tmp/fixture", version: 3 }));
	lines.push(
		JSON.stringify({
			type: "message",
			id: ENTRY_MSG,
			parentId: null,
			timestamp: "2026-11-13T09:00:00.000Z",
			message: { role: "user", content: "work on the memory distiller" },
		}),
	);
	for (const c of opts.compactions ?? []) {
		lines.push(
			JSON.stringify({
				type: "compaction",
				id: c.id,
				parentId: ENTRY_MSG,
				timestamp: c.timestamp,
				summary: "Condensed memories from earlier in this session.",
				firstKeptEntryId: ENTRY_MSG,
				tokensBefore: 4242,
				details: {
					type: "om.folded",
					version: 1,
					fullFold: false,
					observations: c.observations.map((o) => ({
						id: o.id,
						content: o.content,
						timestamp: o.timestamp,
						relevance: "medium",
						sourceEntryIds: o.sourceEntryIds ?? [ENTRY_MSG],
						tokenCount: 31,
					})),
					reflections: [],
				},
			}),
		);
	}
	if (opts.omRecorded) {
		lines.push(
			JSON.stringify({
				type: "custom",
				customType: "om.observations.recorded",
				id: opts.omRecorded.id,
				parentId: ENTRY_MSG,
				timestamp: "2026-11-13T09:05:00.000Z",
				data: {
					observations: opts.omRecorded.observations.map((o) => ({
						id: o.id,
						content: o.content,
						timestamp: o.timestamp,
						relevance: "high",
						sourceEntryIds: o.sourceEntryIds ?? [ENTRY_MSG],
						tokenCount: 28,
					})),
					coversUpToId: ENTRY_MSG,
				},
			}),
		);
	}
	if (opts.subagentReport) {
		lines.push(
			JSON.stringify({
				type: "custom_message",
				customType: "subagent-report",
				id: opts.subagentReport.id,
				parentId: ENTRY_MSG,
				timestamp: "2026-11-13T09:10:00.000Z",
				content: opts.subagentReport.content,
				display: true,
			}),
		);
	}
	if (opts.credentialObservation) {
		lines.push(
			JSON.stringify({
				type: "custom",
				customType: "om.observations.recorded",
				id: "cc0000000009",
				parentId: ENTRY_MSG,
				timestamp: "2026-11-13T09:15:00.000Z",
				data: {
					observations: [
						{
							id: "cc000000000a",
							content: `${CRED_FIXTURE_TEXT} It was only used for the staging deploy.`,
							timestamp: "2026-11-13 09:14",
							relevance: "medium",
							sourceEntryIds: [ENTRY_MSG],
							tokenCount: 30,
						},
					],
					coversUpToId: ENTRY_MSG,
				},
			}),
		);
	}
	return lines;
}

/** Write a session file with fixture entries; returns its path. */
export function writeFixtureSession(
	sessionDir: string,
	fileName: string,
	opts: Parameters<typeof fixtureSessionLines>[0],
): string {
	mkdirSync(sessionDir, { recursive: true });
	const filePath = path.join(sessionDir, fileName);
	writeFileSync(filePath, fixtureSessionLines(opts).join("\n") + "\n");
	return filePath;
}

/**
 * All entry ids defined anywhere in a session JSONL file (resolvability
 * oracle): top-level entry ids plus nested observation ids (compaction
 * details.observations[].id and om.observations.recorded data.observations[].id —
 * the same ids pi-observational-memory's recall(obs_id) resolves).
 */
export function allEntryIdsInSessionFile(filePath: string): Set<string> {
	const ids = new Set<string>();
	const collectObservations = (container: unknown): void => {
		if (!container || typeof container !== "object") return;
		const observations = (container as { observations?: unknown }).observations;
		if (!Array.isArray(observations)) return;
		for (const obs of observations) {
			if (obs && typeof obs === "object" && typeof (obs as { id?: unknown }).id === "string") {
				ids.add((obs as { id: string }).id);
			}
		}
	};
	for (const line of readFileSync(filePath, "utf8").split("\n")) {
		const t = line.trim();
		if (!t) continue;
		try {
			const rec = JSON.parse(t) as {
				id?: unknown;
				type?: unknown;
				customType?: unknown;
				details?: unknown;
				data?: unknown;
			};
			if (typeof rec.id === "string") ids.add(rec.id);
			if (rec.type === "compaction") collectObservations(rec.details);
			if (rec.type === "custom" && rec.customType === "om.observations.recorded") collectObservations(rec.data);
		} catch {
			/* ignore */
		}
	}
	return ids;
}
