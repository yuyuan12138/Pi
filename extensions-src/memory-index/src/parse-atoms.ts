/**
 * Atom indexing for the memory index (Theme B2): reads the append-only
 * `knowledge-base/atoms/<project>/<date>.jsonl` files written by the
 * memory-distiller extension and indexes them with the same FTS5 pipeline
 * as observations/KB rows. `kind: "atom"` rows carry the atom's
 * source_entry_ids verbatim, so memory_search hits stay recall-compatible
 * (those ids are pi session entry ids / observation ids).
 *
 * Atoms are append-only, so indexing uses the same per-file byte-offset
 * watermarks as session backfill (complete lines only; a torn trailing line
 * waits for the next refresh). A shrunk/rewritten file is rescanned from
 * zero; obs_id dedupe keeps that idempotent (disclosed limitation: rows from
 * lines removed by an out-of-band rewrite would linger until such a rescan
 * re-inserts the survivors — atom files are never edited in place by the
 * distiller).
 *
 * Credential screening applies per atom line; flagged lines are skipped and
 * counted, never stored. The index row's `project` column is the KB-owning
 * project (the cwd whose knowledge-base/ contains the atoms), so
 * memory_search's default project scoping works unchanged; the atom
 * record's own project slug stays in the JSON payload.
 */
import { createReadStream, readdirSync } from "node:fs";
import { stat } from "node:fs/promises";
import path from "node:path";
import { derivedId, getWatermark, insertObservation, setWatermark, type DatabaseSync } from "./db.js";
import type { Tokenizer } from "./tokenize.js";
import { matchCredentialPattern } from "./credentials.js";
import { normalizeTimestamp } from "./parse-sessions.js";
import type { InsertStats } from "./types.js";

export interface AtomIndexStats extends InsertStats {
	filesScanned: number;
	parseErrors: number;
}

interface RawAtomLine {
	id?: unknown;
	kind?: unknown;
	claim?: unknown;
	evidence?: unknown;
	source_entry_ids?: unknown;
	ts?: unknown;
	source_session?: unknown;
	hash?: unknown;
}

/** FTS content for one atom: kind-tagged claim (+ evidence when present). */
export function atomRowContent(kind: string, claim: string, evidence: string): string {
	const base = `[atom:${kind}] ${claim}`;
	return evidence ? `${base}\n\nevidence: ${evidence}` : base;
}

function emptyStats(): AtomIndexStats {
	return { inserted: 0, duplicates: 0, credentialsSkipped: 0, filesScanned: 0, parseErrors: 0 };
}

/**
 * Index one atoms file incrementally using the shared per-file byte-offset
 * watermark. Only complete lines are consumed. Returns aggregate stats.
 */
export async function indexAtomsFileIncremental(
	db: DatabaseSync,
	tokenizer: Tokenizer,
	filePath: string,
	project: string,
): Promise<AtomIndexStats & { offset: number; skipped: boolean }> {
	const stats = { ...emptyStats(), offset: 0, skipped: false };
	let info;
	try {
		info = await stat(filePath);
	} catch {
		stats.skipped = true; // file vanished; nothing to do
		return stats;
	}
	const size = info.size;
	const mtimeMs = Math.floor(info.mtimeMs);
	const wm = getWatermark(db, filePath);
	if (wm && wm.byte_offset === size && wm.mtime_ms === mtimeMs) {
		stats.offset = wm.byte_offset;
		stats.skipped = true;
		return stats;
	}
	const start = wm && size >= wm.byte_offset ? wm.byte_offset : 0;
	stats.offset = start;
	if (size === start) {
		setWatermark(db, filePath, size, size, mtimeMs);
		return stats;
	}

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

	let lastNewline = buf.lastIndexOf(0x0a);
	if (lastNewline === -1) {
		setWatermark(db, filePath, start, size, mtimeMs);
		return stats;
	}
	const complete = buf.subarray(0, lastNewline + 1);
	const newOffset = start + complete.length;

	let lineStart = 0;
	while (lineStart < complete.length) {
		let lineEnd = complete.indexOf(0x0a, lineStart);
		if (lineEnd === -1) lineEnd = complete.length;
		const line = complete.subarray(lineStart, lineEnd).toString("utf8").trim();
		lineStart = lineEnd + 1;
		if (!line) continue;
		let atom: RawAtomLine;
		try {
			atom = JSON.parse(line) as RawAtomLine;
		} catch {
			stats.parseErrors++;
			continue;
		}
		const claim = typeof atom.claim === "string" ? atom.claim.trim() : "";
		if (!claim) continue; // not an atom record
		const kind = typeof atom.kind === "string" ? atom.kind : "unknown";
		const evidence = typeof atom.evidence === "string" ? atom.evidence.trim() : "";
		const content = atomRowContent(kind, claim, evidence);
		const cred = matchCredentialPattern(content);
		if (cred) {
			stats.credentialsSkipped++;
			continue;
		}
		const sourceEntryIds = Array.isArray(atom.source_entry_ids)
			? atom.source_entry_ids.filter((s): s is string => typeof s === "string")
			: [];
		const atomId =
			typeof atom.id === "string" && atom.id
				? atom.id
				: derivedId("atom", filePath, String(lineStart), claim);
		const inserted = await insertObservation(
			db,
			tokenizer,
			{
				obs_id: atomId,
				entry_id: "",
				session_id: typeof atom.source_session === "string" ? atom.source_session : "",
				session_path: "",
				source_path: filePath,
				kind: "atom",
				project,
				ts: normalizeTimestamp(typeof atom.ts === "string" ? atom.ts : undefined),
				content,
			},
			sourceEntryIds,
		);
		if (inserted) stats.inserted++;
		else stats.duplicates++;
	}

	setWatermark(db, filePath, newOffset, size, mtimeMs);
	stats.offset = newOffset;
	return stats;
}

/**
 * Refresh all atom files under <kbRoot>/atoms/<project>/*.jsonl (one level of
 * project directories, sorted). Rows are keyed by the atom's own id with the
 * KB-owning project as the search scope.
 */
export async function refreshAtoms(
	db: DatabaseSync,
	tokenizer: Tokenizer,
	kbRoot: string,
	project: string,
): Promise<AtomIndexStats> {
	const stats = emptyStats();
	const atomsRoot = path.join(kbRoot, "atoms");
	let projectDirs: string[];
	try {
		projectDirs = readdirSync(atomsRoot, { withFileTypes: true })
			.filter((e) => e.isDirectory())
			.map((e) => e.name)
			.sort();
	} catch {
		return stats; // no atoms yet
	}
	for (const dirName of projectDirs) {
		const dir = path.join(atomsRoot, dirName);
		let files: string[];
		try {
			files = readdirSync(dir).filter((f) => f.endsWith(".jsonl")).sort();
		} catch {
			continue;
		}
		for (const f of files) {
			stats.filesScanned++;
			try {
				const r = await indexAtomsFileIncremental(db, tokenizer, path.join(dir, f), project);
				stats.inserted += r.inserted;
				stats.duplicates += r.duplicates;
				stats.credentialsSkipped += r.credentialsSkipped;
				stats.parseErrors += r.parseErrors;
			} catch {
				continue; // unreadable file: leave previous rows untouched
			}
		}
	}
	return stats;
}
