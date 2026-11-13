/**
 * Incremental, watermarked scanning of pi session JSONL deltas.
 *
 * Candidate sources (all distilled text, never raw tool output):
 *  - `compaction` entries: details.observations[] (pi-observational-memory)
 *  - `custom` entries with customType "om.observations.recorded": data.observations[]
 *  - `custom_message` entries with customType "subagent-report": the report text
 *
 * Only complete lines are consumed; a partially written trailing line stays
 * in place and the watermark lands on the last newline boundary, so the
 * entry is picked up once it is complete. A shrunk file was replaced/rewritten:
 * rescan from zero (dedup-by-content-hash keeps the outcome idempotent).
 */
import { closeSync, openSync, readdirSync, readSync, statSync } from "node:fs";
import path from "node:path";
import type { Candidate } from "./types.js";
import type { DistillerState } from "./state.js";

/** Distilled observations/shorter worker notes below this are noise. */
export const MIN_CANDIDATE_CHARS = 24;

/** Extract the session uuid from a pi session file name ("<ts>_<uuid>.jsonl"). */
export function sessionIdFromFileName(filePath: string): string {
	const stem = path.basename(filePath).replace(/\.jsonl$/i, "");
	const idx = stem.lastIndexOf("_");
	return idx >= 0 ? stem.slice(idx + 1) : stem;
}

export interface ScanResult {
	candidates: Candidate[];
	/** Per-file watermarks the scan advanced to; apply only after the run succeeds. */
	newWatermarks: Map<string, { byte_offset: number; size: number; mtime_ms: number }>;
	filesScanned: number;
	filesChanged: number;
	parseErrors: number;
}

interface RawObservationLike {
	id?: unknown;
	content?: unknown;
	timestamp?: unknown;
	sourceEntryIds?: unknown;
}

function observationCandidate(
	obs: RawObservationLike,
	entryId: unknown,
	sessionUuid: string,
	source: Candidate["source"],
): Candidate | null {
	const content = typeof obs?.content === "string" ? obs.content.trim() : "";
	if (content.length < MIN_CANDIDATE_CHARS) return null;
	const ids = new Set<string>();
	if (typeof obs?.id === "string" && obs.id) ids.add(obs.id);
	if (Array.isArray(obs?.sourceEntryIds)) {
		for (const s of obs.sourceEntryIds) if (typeof s === "string" && s) ids.add(s);
	}
	if (typeof entryId === "string" && entryId) ids.add(entryId);
	if (ids.size === 0) return null; // provenance is mandatory
	return {
		text: content,
		sourceEntryIds: [...ids],
		sessionUuid,
		rawTimestamp: typeof obs?.timestamp === "string" ? obs.timestamp : undefined,
		source,
	};
}

/** Pull distiller candidates out of one parsed session JSONL entry. */
export function extractCandidatesFromEntry(entry: unknown, sessionUuid: string): Candidate[] {
	const out: Candidate[] = [];
	if (!entry || typeof entry !== "object") return out;
	const rec = entry as Record<string, unknown>;
	if (rec.type === "compaction") {
		const details = rec.details as Record<string, unknown> | undefined;
		const observations = details?.observations;
		if (Array.isArray(observations)) {
			for (const obs of observations) {
				const c = observationCandidate(obs as RawObservationLike, rec.id, sessionUuid, "compaction-observation");
				if (c) out.push(c);
			}
		}
	} else if (rec.type === "custom" && rec.customType === "om.observations.recorded") {
		const data = rec.data as Record<string, unknown> | undefined;
		const observations = data?.observations;
		if (Array.isArray(observations)) {
			for (const obs of observations) {
				const c = observationCandidate(obs as RawObservationLike, rec.id, sessionUuid, "om-observation");
				if (c) out.push(c);
			}
		}
	} else if (rec.type === "custom_message" && rec.customType === "subagent-report") {
		const content = rec.content;
		let text = "";
		if (typeof content === "string") text = content.trim();
		else if (Array.isArray(content)) {
			text = content
				.filter((p): p is { type: "text"; text: string } => Boolean(p) && (p as { type?: string }).type === "text")
				.map((p) => p.text)
				.join("\n")
				.trim();
		}
		if (text.length >= MIN_CANDIDATE_CHARS && typeof rec.id === "string" && rec.id) {
			out.push({
				text,
				sourceEntryIds: [rec.id],
				sessionUuid,
				rawTimestamp: undefined,
				source: "subagent-report",
			});
		}
	}
	return out;
}

/**
 * Scan every *.jsonl in the session directory incrementally using the state's
 * watermarks. Returns candidates plus the watermarks to commit after the run
 * succeeds (dry-runs and failed runs simply never commit them).
 */
export function scanSessionDeltas(sessionDir: string, state: DistillerState): ScanResult {
	const result: ScanResult = {
		candidates: [],
		newWatermarks: new Map(),
		filesScanned: 0,
		filesChanged: 0,
		parseErrors: 0,
	};
	let files: string[];
	try {
		files = readdirSync(sessionDir).filter((f) => f.endsWith(".jsonl")).sort();
	} catch {
		return result; // no session dir yet
	}
	for (const f of files) {
		const filePath = path.join(sessionDir, f);
		result.filesScanned++;
		let size: number;
		let mtimeMs: number;
		try {
			const st = statSync(filePath);
			size = st.size;
			mtimeMs = Math.floor(st.mtimeMs);
		} catch {
			continue; // vanished mid-scan
		}
		const wm = state.getWatermark(filePath);
		if (wm && wm.byte_offset === size && wm.mtime_ms === mtimeMs) continue; // unchanged
		const start = wm && size >= wm.byte_offset ? wm.byte_offset : 0;
		const sessionUuid = sessionIdFromFileName(filePath);
		if (size === start) {
			result.newWatermarks.set(filePath, { byte_offset: size, size, mtime_ms: mtimeMs });
			continue;
		}
		let buf: Buffer;
		try {
			const fd = openSync(filePath, "r");
			try {
				buf = Buffer.alloc(size - start);
				const read = readSync(fd, buf, 0, size - start, start);
				if (read < buf.length) buf = buf.subarray(0, read);
			} finally {
				closeSync(fd);
			}
		} catch {
			continue;
		}
		const lastNewline = buf.lastIndexOf(0x0a);
		if (lastNewline === -1) continue; // nothing complete yet; watermark stays
		const complete = buf.subarray(0, lastNewline + 1);
		const newOffset = start + complete.length;
		let lineStart = 0;
		while (lineStart < complete.length) {
			let lineEnd = complete.indexOf(0x0a, lineStart);
			if (lineEnd === -1) lineEnd = complete.length;
			const line = complete.subarray(lineStart, lineEnd).toString("utf8").trim();
			lineStart = lineEnd + 1;
			if (!line) continue;
			let entry: unknown;
			try {
				entry = JSON.parse(line);
			} catch {
				result.parseErrors++;
				continue;
			}
			for (const c of extractCandidatesFromEntry(entry, sessionUuid)) result.candidates.push(c);
		}
		result.newWatermarks.set(filePath, { byte_offset: newOffset, size, mtime_ms: mtimeMs });
		result.filesChanged++;
	}
	return result;
}
