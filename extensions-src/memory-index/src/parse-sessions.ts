/**
 * Session JSONL scanning and compaction-observation extraction.
 *
 * Sessions live at ~/.pi/agent/sessions/<escaped-cwd>/<ts>_<uuid>.jsonl with
 * one JSON entry per line (append-only). Only compaction entries contribute:
 * their details.observations[] (from pi-observational-memory's `om.folded`
 * entries) are distilled, id-carrying units — raw tool output is never read
 * or indexed. Incremental reads are watermark-driven per-file byte offsets
 * so repeated backfills are idempotent.
 */
import { readdirSync, createReadStream } from "node:fs";
import { stat } from "node:fs/promises";
import path from "node:path";
import { derivedId, getWatermark, insertObservation, setWatermark, type DatabaseSync } from "./db.js";
import type { Tokenizer } from "./tokenize.js";
import { matchCredentialPattern } from "./credentials.js";
import type { InsertStats } from "./types.js";

export interface CompactionObservation {
	obsId: string;
	content: string;
	rawTimestamp: string | undefined;
	sourceEntryIds: string[];
}

export interface ScanResult extends InsertStats {
	file: string;
	/** Byte offset the scan advanced the watermark to. */
	offset: number;
	skipped: boolean;
	parseErrors: number;
}

/** Extract the session id (uuid part) from a session file name. */
export function sessionIdFromFileName(filePath: string): string {
	const stem = path.basename(filePath).replace(/\.jsonl$/i, "");
	const idx = stem.lastIndexOf("_");
	return idx >= 0 ? stem.slice(idx + 1) : stem;
}

/**
 * Normalize the timestamp variants seen in compaction entries into
 * ISO-8601 UTC. Observation timestamps are naive local ("2026-11-03 17:28"),
 * entry timestamps are ISO with Z. Falls back to `fallback` / now.
 */
export function normalizeTimestamp(raw: string | undefined, fallback?: string): string {
	const toIso = (value: string): string | null => {
		if (!value) return null;
		// Naive local datetime ("2026-11-03 17:28" / "2026-11-03 17:28:32")
		const naive = value.match(/^(\d{4}-\d{2}-\d{2})[ T](\d{2}:\d{2}(?::\d{2})?)$/);
		if (naive?.[1] && naive[2]) {
			const d = new Date(`${naive[1]}T${naive[2]}${naive[2].length === 5 ? ":00" : ""}`);
			return Number.isNaN(d.getTime()) ? null : d.toISOString();
		}
		const d = new Date(value);
		return Number.isNaN(d.getTime()) ? null : d.toISOString();
	};
	return toIso(raw ?? "") ?? toIso(fallback ?? "") ?? new Date().toISOString();
}

interface RawCompactionEntry {
	type?: string;
	id?: string;
	timestamp?: string;
	details?: {
		observations?: Array<{
			id?: string;
			content?: string;
			timestamp?: string;
			sourceEntryIds?: string[];
		}>;
	};
}

/** Pull indexable observations out of one compaction entry object. */
export function extractObservations(entry: unknown): CompactionObservation[] {
	const details = (entry as RawCompactionEntry | null | undefined)?.details;
	const observations = details?.observations;
	if (!Array.isArray(observations)) return [];
	const out: CompactionObservation[] = [];
	for (const obs of observations) {
		const content = typeof obs?.content === "string" ? obs.content.trim() : "";
		if (!content) continue;
		out.push({
			obsId: typeof obs.id === "string" && obs.id ? obs.id : "",
			content,
			rawTimestamp: obs.timestamp,
			sourceEntryIds: Array.isArray(obs.sourceEntryIds) ? obs.sourceEntryIds.filter((s) => typeof s === "string") : [],
		});
	}
	return out;
}

// Alias kept for readability at call sites; the raw JSONL shape and the
// SessionCompactEvent.compactionEntry shape are the same object.
type RawCompactionObservation = RawCompactionEntry;

/**
 * Index one session file incrementally using the per-file byte-offset
 * watermark. Only complete lines are consumed; a partially written trailing
 * line is left for the next scan. Returns aggregate insert statistics.
 */
export async function indexSessionFileIncremental(
	db: DatabaseSync,
	tokenizer: Tokenizer,
	filePath: string,
	project: string,
): Promise<ScanResult> {
	const result: ScanResult = {
		file: filePath,
		inserted: 0,
		duplicates: 0,
		credentialsSkipped: 0,
		parseErrors: 0,
		offset: 0,
		skipped: false,
	};
	let info;
	try {
		info = await stat(filePath);
	} catch {
		result.skipped = true; // file vanished (branch rewrite); nothing to do
		return result;
	}
	const size = info.size;
	const mtimeMs = Math.floor(info.mtimeMs);
	const wm = getWatermark(db, filePath);
	if (wm && wm.byte_offset === size && wm.mtime_ms === mtimeMs) {
		result.offset = wm.byte_offset;
		result.skipped = true;
		return result;
	}
	// A shrunk file was replaced/rewritten: rescan from zero. obs_id dedupe
	// keeps the result idempotent.
	const start = wm && size >= wm.byte_offset ? wm.byte_offset : 0;
	result.offset = start;
	if (size === start) {
		setWatermark(db, filePath, size, size, mtimeMs);
		return result;
	}

	const sessionId = sessionIdFromFileName(filePath);
	const chunks: Buffer[] = [];
	await new Promise<void>((resolve, reject) => {
		const stream = createReadStream(filePath, { start, end: size - 1 });
		stream.on("data", (chunk: string | Buffer) => {
			if (Buffer.isBuffer(chunk)) chunks.push(chunk);
		});
		stream.on("error", reject);
		stream.on("end", () => resolve());
	});
	const buf = Buffer.concat(chunks);

	// Only complete lines count; keep the tail (no trailing newline yet).
	let lastNewline = buf.lastIndexOf(0x0a);
	if (lastNewline === -1) {
		// Nothing complete to parse; still record the watermark start.
		setWatermark(db, filePath, start, size, mtimeMs);
		return result;
	}
	const complete = buf.subarray(0, lastNewline + 1);
	const newOffset = start + complete.length;

	const insertRow = async (entry: RawCompactionEntry) => {
		for (const obs of extractObservations(entry)) {
			const cred = matchCredentialPattern(obs.content);
			if (cred) {
				result.credentialsSkipped++;
				continue;
			}
			const obsId = obs.obsId || derivedObservationId(filePath, entry.id, obs.content);
			const inserted = await insertObservation(
				db,
				tokenizer,
				{
					obs_id: obsId,
					entry_id: typeof entry.id === "string" ? entry.id : "",
					session_id: sessionId,
					session_path: filePath,
					source_path: "",
					kind: "observation",
					project,
					ts: normalizeTimestamp(obs.rawTimestamp, entry.timestamp),
					content: obs.content,
				},
				obs.sourceEntryIds,
			);
			if (inserted) result.inserted++;
			else result.duplicates++;
		}
	};

	let lineStart = 0;
	while (lineStart < complete.length) {
		let lineEnd = complete.indexOf(0x0a, lineStart);
		if (lineEnd === -1) lineEnd = complete.length;
		const line = complete.subarray(lineStart, lineEnd).toString("utf8").trim();
		lineStart = lineEnd + 1;
		if (!line) continue;
		let entry: RawCompactionEntry;
		try {
			entry = JSON.parse(line) as RawCompactionEntry;
		} catch {
			result.parseErrors++;
			continue;
		}
		if (entry?.type !== "compaction") continue;
		await insertRow(entry);
	}

	setWatermark(db, filePath, newOffset, size, mtimeMs);
	result.offset = newOffset;
	return result;
}

/** Deterministic id for observations that somehow lack their own id. */
function derivedObservationId(filePath: string, entryId: string | undefined, content: string): string {
	return derivedId("obs", filePath, entryId ?? "", content);
}

/** Backfill every *.jsonl session file in a directory (sorted, incremental). */
export async function backfillSessions(
	db: DatabaseSync,
	tokenizer: Tokenizer,
	sessionDir: string,
	project: string,
): Promise<ScanResult[]> {
	let files: string[];
	try {
		files = readdirSync(sessionDir).filter((f) => f.endsWith(".jsonl")).sort();
	} catch {
		return [];
	}
	const results: ScanResult[] = [];
	for (const f of files) {
		results.push(await indexSessionFileIncremental(db, tokenizer, path.join(sessionDir, f), project));
	}
	return results;
}
