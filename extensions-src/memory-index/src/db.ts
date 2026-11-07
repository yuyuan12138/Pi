/**
 * SQLite storage for the memory index.
 *
 * Layout follows the design's UNINDEXED-metadata pattern: a canonical `obs`
 * table (dedupe + drill-back ids + original content) plus a contentful FTS5
 * table whose match column `tokens` holds pre-segmented text; all metadata
 * rides along as UNINDEXED columns. The DB lives outside every repository
 * (default ~/.pi/agent/memory/index.db, WAL mode).
 */
import { DatabaseSync } from "node:sqlite";
export type { DatabaseSync };
import { createHash } from "node:crypto";
import type { Tokenizer } from "./tokenize.js";
import { createTokenizer } from "./tokenize.js";

export const SCHEMA_VERSION = "1";

export interface ObsRow {
	obs_id: string;
	entry_id: string; // compaction entry id for observations, "" for KB rows
	session_id: string; // session uuid for observations, "" for KB rows
	session_path: string; // absolute session file path, "" for KB rows
	source_path: string; // KB source file path, "" for observations
	kind: string; // "observation" | "daily" | "concept"
	project: string;
	ts: string; // ISO-8601 UTC
	content: string;
}

export interface SearchParams {
	query: string;
	project?: string;
	from?: string;
	to?: string;
	kind?: string;
	limit?: number;
}

export interface SearchHit {
	obs_id: string;
	entry_id: string;
	session_id: string;
	ts: string;
	kind: string;
	project: string;
	snippet: string;
	source_entry_ids: string[];
	source_path: string;
	rank: number;
}

const SCHEMA_SQL = `
CREATE TABLE IF NOT EXISTS meta(key TEXT PRIMARY KEY, value TEXT NOT NULL);
CREATE TABLE IF NOT EXISTS obs(
  obs_id TEXT PRIMARY KEY,
  entry_id TEXT NOT NULL DEFAULT '',
  session_id TEXT NOT NULL DEFAULT '',
  session_path TEXT NOT NULL DEFAULT '',
  source_path TEXT NOT NULL DEFAULT '',
  kind TEXT NOT NULL,
  project TEXT NOT NULL,
  ts TEXT NOT NULL,
  content TEXT NOT NULL,
  source_entry_ids TEXT NOT NULL DEFAULT '[]'
);
CREATE INDEX IF NOT EXISTS idx_obs_project_kind_ts ON obs(project, kind, ts);
CREATE VIRTUAL TABLE IF NOT EXISTS obs_fts USING fts5(
  tokens,
  obs_id UNINDEXED,
  session_id UNINDEXED,
  entry_id UNINDEXED,
  ts UNINDEXED,
  kind UNINDEXED,
  project UNINDEXED,
  tokenize='unicode61'
);
CREATE TABLE IF NOT EXISTS watermarks(
  path TEXT PRIMARY KEY,
  byte_offset INTEGER NOT NULL,
  size INTEGER NOT NULL,
  mtime_ms INTEGER NOT NULL
);
`;

export function openDb(dbPath: string): DatabaseSync {
	const db = new DatabaseSync(dbPath);
	db.exec("PRAGMA journal_mode=WAL");
	db.exec("PRAGMA synchronous=NORMAL");
	db.exec(SCHEMA_SQL);
	db.prepare("INSERT OR IGNORE INTO meta(key, value) VALUES('schema_version', ?)").run(SCHEMA_VERSION);
	return db;
}

export function getMeta(db: DatabaseSync, key: string): string | undefined {
	const row = db.prepare("SELECT value FROM meta WHERE key = ?").get(key) as { value: string } | undefined;
	return row?.value;
}

export function setMeta(db: DatabaseSync, key: string, value: string): void {
	db.prepare(
		"INSERT INTO meta(key, value) VALUES(?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value",
	).run(key, value);
}

/** Stable 12-hex id for rows that have no native memory id (KB entries). */
export function derivedId(...parts: string[]): string {
	return createHash("sha256")
		.update(parts.join("\u0000"))
		.digest("hex")
		.slice(0, 12);
}

/**
 * Insert one row into both `obs` and `obs_fts` atomically. Idempotent on
 * obs_id: an existing id is a no-op. `tokens` must be produced by the SAME
 * tokenizer mode the rest of the index uses (openIndex enforces that).
 */
export function insertObservationWithTokens(
	db: DatabaseSync,
	row: ObsRow,
	tokens: string,
	sourceEntryIds: string[] = [],
): boolean {
	const exists = db.prepare("SELECT 1 FROM obs WHERE obs_id = ?").get(row.obs_id);
	if (exists) return false;
	db.exec("BEGIN");
	try {
		db.prepare(
			`INSERT INTO obs(obs_id, entry_id, session_id, session_path, source_path, kind, project, ts, content, source_entry_ids)
			 VALUES(?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
		).run(
			row.obs_id,
			row.entry_id,
			row.session_id,
			row.session_path,
			row.source_path,
			row.kind,
			row.project,
			row.ts,
			row.content,
			JSON.stringify(sourceEntryIds),
		);
		db.prepare(
			`INSERT INTO obs_fts(tokens, obs_id, session_id, entry_id, ts, kind, project)
			 VALUES(?, ?, ?, ?, ?, ?, ?)`,
		).run(tokens, row.obs_id, row.session_id, row.entry_id, row.ts, row.kind, row.project);
		db.exec("COMMIT");
		return true;
	} catch (err) {
		db.exec("ROLLBACK");
		throw err;
	}
}

/** Tokenize + insert in one step; the common path for all writers. */
export async function insertObservation(
	db: DatabaseSync,
	tokenizer: Tokenizer,
	row: ObsRow,
	sourceEntryIds: string[] = [],
): Promise<boolean> {
	const tokens = await tokenizer.tokenize(row.content);
	return insertObservationWithTokens(db, row, tokens, sourceEntryIds);
}

/**
 * Rebuild every `tokens` value from stored `content` with the given
 * tokenizer. Used when the tokenizer mode recorded in `meta` no longer
 * matches what is available now (e.g. @node-rs/jieba installed or removed
 * between sessions) so write-side and query-side segmentation never drift.
 */
export async function retokenizeAll(db: DatabaseSync, tokenizer: Tokenizer): Promise<number> {
	const rows = db
		.prepare("SELECT obs_id, session_id, entry_id, ts, kind, project, content FROM obs")
		.all() as unknown as ObsRow[];
	db.exec("BEGIN");
	try {
		db.exec("DELETE FROM obs_fts");
		const stmt = db.prepare(
			`INSERT INTO obs_fts(tokens, obs_id, session_id, entry_id, ts, kind, project)
			 VALUES(?, ?, ?, ?, ?, ?, ?)`,
		);
		for (const r of rows) {
			stmt.run(await tokenizer.tokenize(r.content), r.obs_id, r.session_id, r.entry_id, r.ts, r.kind, r.project);
		}
		db.exec("COMMIT");
		return rows.length;
	} catch (err) {
		db.exec("ROLLBACK");
		throw err;
	}
}

/**
 * Open (or create) the index and guarantee tokenizer-mode consistency:
 * the mode recorded in `meta` must match the currently available tokenizer,
 * otherwise the whole FTS table is rebuilt from `obs.content`.
 */
export async function openIndex(dbPath: string): Promise<{ db: DatabaseSync; tokenizer: Tokenizer; retokenized: number }> {
	const db = openDb(dbPath);
	const tokenizer = await createTokenizer();
	const stored = getMeta(db, "tokenizer");
	if (stored && stored !== tokenizer.mode) {
		const n = await retokenizeAll(db, tokenizer);
		setMeta(db, "tokenizer", tokenizer.mode);
		return { db, tokenizer, retokenized: n };
	}
	if (!stored) setMeta(db, "tokenizer", tokenizer.mode);
	return { db, tokenizer, retokenized: 0 };
}

export function deleteBySourcePath(db: DatabaseSync, sourcePath: string): void {
	const ids = db
		.prepare("SELECT obs_id FROM obs WHERE source_path = ?")
		.all(sourcePath) as Array<{ obs_id: string }>;
	if (ids.length === 0) return;
	db.exec("BEGIN");
	try {
		const delObs = db.prepare("DELETE FROM obs WHERE obs_id = ?");
		const delFts = db.prepare("DELETE FROM obs_fts WHERE obs_id = ?");
		for (const { obs_id } of ids) {
			delFts.run(obs_id);
			delObs.run(obs_id);
		}
		db.exec("COMMIT");
	} catch (err) {
		db.exec("ROLLBACK");
		throw err;
	}
}

// ---------------------------------------------------------------------------
// Watermarks (per-file byte offsets for idempotent incremental backfill)
// ---------------------------------------------------------------------------

export interface Watermark {
	byte_offset: number;
	size: number;
	mtime_ms: number;
}

export function getWatermark(db: DatabaseSync, path: string): Watermark | undefined {
	return db.prepare("SELECT byte_offset, size, mtime_ms FROM watermarks WHERE path = ?").get(path) as
		| Watermark
		| undefined;
}

export function setWatermark(db: DatabaseSync, path: string, byteOffset: number, size: number, mtimeMs: number): void {
	db.prepare(
		`INSERT INTO watermarks(path, byte_offset, size, mtime_ms) VALUES(?, ?, ?, ?)
		 ON CONFLICT(path) DO UPDATE SET byte_offset = excluded.byte_offset, size = excluded.size, mtime_ms = excluded.mtime_ms`,
	).run(path, byteOffset, size, mtimeMs);
}

// ---------------------------------------------------------------------------
// Search
// ---------------------------------------------------------------------------

/** Escape a string for use as an FTS5 double-quoted term. */
function ftsQuote(term: string): string {
	return `"${term.replaceAll('"', '""')}"`;
}

/** Normalize a date-only or full ISO input into an inclusive comparison bound. */
export function normalizeTimeBound(value: string, end: boolean): string {
	if (/^\d{4}-\d{2}-\d{2}$/.test(value)) {
		return end ? `${value}T23:59:59.999Z` : `${value}T00:00:00.000Z`;
	}
	return value;
}

/**
 * Run an FTS5 MATCH query with project/kind/time filters, bm25 ranking and a
 * recency tiebreak. Returns hits joined back to `obs` for drill-back data.
 */
export function searchMemory(
	db: DatabaseSync,
	tokenizer: Tokenizer,
	tokens: string,
	params: SearchParams,
): { hits: SearchHit[]; match: "and" | "or" } {
	const conditions: string[] = [];
	const args: string[] = [];
	if (params.project !== undefined) {
		conditions.push("obs_fts.project = ?");
		args.push(params.project);
	}
	if (params.kind !== undefined) {
		conditions.push("obs_fts.kind = ?");
		args.push(params.kind);
	}
	if (params.from !== undefined) {
		conditions.push("obs_fts.ts >= ?");
		args.push(normalizeTimeBound(params.from, false));
	}
	if (params.to !== undefined) {
		conditions.push("obs_fts.ts <= ?");
		args.push(normalizeTimeBound(params.to, true));
	}
	const where = conditions.length ? `AND ${conditions.join(" AND ")}` : "";
	const limit = Math.max(1, Math.min(params.limit ?? 10, 50));
	const base = () => `
		SELECT bm25(obs_fts) AS score,
		       o.obs_id, o.entry_id, o.session_id, o.ts, o.kind, o.project,
		       o.content, o.source_path, o.source_entry_ids
		FROM obs_fts
		JOIN obs o ON o.obs_id = obs_fts.obs_id
		WHERE obs_fts MATCH ? ${where}
		ORDER BY score ASC, obs_fts.ts DESC
		LIMIT ${limit}`;

	const run = (matchTokens: string): SearchHit[] => {
		const stmt = db.prepare(base());
		const rows = stmt.all(matchTokens, ...args) as Array<{
			score: number;
			obs_id: string;
			entry_id: string;
			session_id: string;
			ts: string;
			kind: string;
			project: string;
			content: string;
			source_path: string;
			source_entry_ids: string;
		}>;
		return rows.map((r) => ({
			obs_id: r.obs_id,
			entry_id: r.entry_id,
			session_id: r.session_id,
			ts: r.ts,
			kind: r.kind,
			project: r.project,
			snippet: makeSnippet(r.content, params.query),
			source_entry_ids: JSON.parse(r.source_entry_ids) as string[],
			source_path: r.source_path,
			rank: r.score,
		}));
	};

	const andHits = run(tokens);
	if (andHits.length > 0 || tokens.trim().split(/\s+/).length === 1) {
		return { hits: andHits, match: "and" };
	}
	// Multi-term AND matched nothing — retry with OR for recall.
	const orTokens = tokens.trim().split(/\s+/).map(ftsQuote).join(" OR ");
	return { hits: run(orTokens), match: "or" };
}

// ---------------------------------------------------------------------------
// Snippets (computed in JS from original content; CJK bigram tokens do not
// map 1:1 back onto the original text, so FTS5's own snippet() is unusable)
// ---------------------------------------------------------------------------

const SNIPPET_RADIUS = 80;

/**
 * Best-effort highlighted snippet: find the window of the original content
 * containing the most query terms (case-insensitive), else return the head.
 */
export function makeSnippet(content: string, query: string, maxLen = 200): string {
	const terms = query
		.toLowerCase()
		.split(/\s+/)
		.map((t) => t.trim())
		.filter((t) => t.length > 0);
	if (content.length <= maxLen) return content;
	const lower = content.toLowerCase();
	let bestStart = -1;
	let bestScore = -1;
	const scanStep = Math.max(1, Math.floor(SNIPPET_RADIUS / 4));
	for (let start = 0; start < Math.max(1, content.length - maxLen); start += scanStep) {
		const window = lower.slice(start, start + maxLen);
		let score = 0;
		for (const t of terms) if (window.includes(t)) score++;
		if (score > bestScore) {
			bestScore = score;
			bestStart = start;
		}
		if (bestScore === terms.length) break;
	}
	if (bestStart < 0) bestStart = 0;
	let snippet = content.slice(bestStart, bestStart + maxLen).trim();
	if (bestStart > 0) snippet = `…${snippet}`;
	if (bestStart + maxLen < content.length) snippet = `${snippet}…`;
	return snippet;
}
