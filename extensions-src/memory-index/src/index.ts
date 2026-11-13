/**
 * memory-index — cross-session SQLite FTS5 memory index for pi.
 *
 * Registers one tool, `memory_search`, over compaction observations and
 * knowledge-base entries (P0 of the memory-index design). Drill-back of
 * observations reuses pi-observational-memory's existing `recall(obs_id)`
 * tool; this extension never reimplements recovery.
 *
 * Triggers (event names verified against pi 1.3.0
 * dist/core/extensions/types.d.ts):
 *  - session_start : incremental backfill of this project's session files
 *                    (per-file byte-offset watermarks) + KB refresh
 *  - session_compact: index the fresh compaction entry's observations
 *                    immediately (dedupe makes this idempotent with backfill)
 *  - session_shutdown: close the DB (idempotent)
 *
 * Storage: ~/.pi/agent/memory/index.db (WAL), outside every repository.
 * Override for tests/tools: env PI_MEMORY_INDEX_DB (full file path).
 * KB root override: env PI_MEMORY_KB_ROOT (defaults to <cwd>/knowledge-base).
 *
 * No embeddings, no LLM calls, no raw tool-output indexing. Credential-
 * pattern matches are skipped before insert (see credentials.ts).
 */
import { existsSync } from "node:fs";
import { mkdirSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { performance } from "node:perf_hooks";
import { Type } from "@earendil-works/pi-ai";
import { defineTool, type ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { openIndex, derivedId, insertObservation, searchMemory, type DatabaseSync, type SearchHit } from "./db.js";
import type { Tokenizer } from "./tokenize.js";
import { backfillSessions, extractObservations, normalizeTimestamp } from "./parse-sessions.js";
import { refreshKnowledgeBase } from "./parse-kb.js";
import { refreshAtoms } from "./parse-atoms.js";
import { matchCredentialPattern } from "./credentials.js";
import type { CompactionEntry } from "@earendil-works/pi-coding-agent";

export const MEMORY_SEARCH_TOOL_NAME = "memory_search";

export function defaultDbPath(): string {
	if (process.env.PI_MEMORY_INDEX_DB) return process.env.PI_MEMORY_INDEX_DB;
	return path.join(os.homedir(), ".pi", "agent", "memory", "index.db");
}

/** State held for the lifetime of one loaded extension runtime. */
interface IndexState {
	db: DatabaseSync | null;
	tokenizer: Tokenizer | null;
	opening: Promise<{ db: DatabaseSync; tokenizer: Tokenizer } | null> | null;
	backfillInFlight: boolean;
}

function createState(): IndexState {
	return { db: null, tokenizer: null, opening: null, backfillInFlight: false };
}

/** Lazily open the index; returns null (and logs) when opening fails. */
async function ensureOpen(state: IndexState): Promise<{ db: DatabaseSync; tokenizer: Tokenizer } | null> {
	if (state.db && state.tokenizer) return { db: state.db, tokenizer: state.tokenizer };
	if (!state.opening) {
		const dbPath = defaultDbPath();
		state.opening = (async () => {
			try {
				mkdirSync(path.dirname(dbPath), { recursive: true });
				const opened = await openIndex(dbPath);
				state.db = opened.db;
				state.tokenizer = opened.tokenizer;
				if (opened.retokenized > 0) {
					console.error(
						`[memory-index] tokenizer mode changed; re-tokenized ${opened.retokenized} rows from stored content`,
					);
				}
				return { db: opened.db, tokenizer: opened.tokenizer };
			} catch (err) {
				console.error(`[memory-index] failed to open index at ${dbPath}:`, err);
				return null;
			} finally {
				state.opening = null;
			}
		})();
	}
	return state.opening;
}

function closeDb(state: IndexState): void {
	try {
		state.db?.close();
	} catch {
		// already closed — shutdown must stay idempotent
	}
	state.db = null;
	state.tokenizer = null;
}

/** Locate the KB root for a project: <cwd>/knowledge-base if it exists. */
export function kbRootForProject(cwd: string): string | null {
	const root = process.env.PI_MEMORY_KB_ROOT ?? path.join(cwd, "knowledge-base");
	return existsSync(root) ? root : null;
}

export default function memoryIndexExtension(pi: ExtensionAPI): void {
	const state = createState();

	pi.on("session_start", async (_event, ctx) => {
		const opened = await ensureOpen(state);
		if (!opened || state.backfillInFlight) return;
		state.backfillInFlight = true;
		try {
			const project = ctx.sessionManager.getCwd();
			const sessionDir = ctx.sessionManager.getSessionDir();
			await backfillSessions(opened.db, opened.tokenizer, sessionDir, project);
			const kbRoot = kbRootForProject(project);
			if (kbRoot) {
				await refreshKnowledgeBase(opened.db, opened.tokenizer, kbRoot, project);
				// P1/B2: distiller atoms (kind "atom") — a failure here must not kill
				// the KB refresh above.
				try {
					await refreshAtoms(opened.db, opened.tokenizer, kbRoot, project);
				} catch (err) {
					console.error("[memory-index] atoms refresh failed:", err);
				}
			}
		} catch (err) {
			console.error("[memory-index] session_start backfill failed:", err);
		} finally {
			state.backfillInFlight = false;
		}
	});

	pi.on("session_compact", async (event, ctx) => {
		const opened = await ensureOpen(state);
		if (!opened) return;
		try {
			const project = ctx.sessionManager.getCwd();
			const sessionId = ctx.sessionManager.getSessionId();
			const sessionPath = ctx.sessionManager.getSessionFile() ?? "";
			const entry = event.compactionEntry as CompactionEntry;
			for (const obs of extractObservations(entry)) {
				if (matchCredentialPattern(obs.content)) continue;
				await insertObservation(opened.db, opened.tokenizer, {
					obs_id: obs.obsId || derivedId("obs", sessionPath, entry.id ?? "", obs.content),
					entry_id: entry.id ?? "",
					session_id: sessionId,
					session_path: sessionPath,
					source_path: "",
					kind: "observation",
					project,
					ts: normalizeTimestamp(obs.rawTimestamp, entry.timestamp),
					content: obs.content,
				}, obs.sourceEntryIds);
			}
		} catch (err) {
			console.error("[memory-index] session_compact indexing failed:", err);
		}
	});

	pi.on("session_shutdown", () => {
		closeDb(state);
	});

	const memorySearchTool = defineTool({
		name: MEMORY_SEARCH_TOOL_NAME,
		label: "Memory search",
		description:
			"Search the cross-session memory index (SQLite FTS5) over distilled compaction observations and " +
			"knowledge-base daily/concept entries for this machine. Supports project scoping (defaults to the " +
			"current project), ISO date/time windows, and kind filters. For observation hits, drill back into " +
			"exact source context with recall(obs_id); session_id/entry_id locate the session file entry. " +
			"Use sparingly: at most a few searches per turn.",
		promptSnippet: "memory_search(query): lexical search over past sessions' compaction memories and KB entries.",
		promptGuidelines: [
			"Use memory_search when past sessions may already hold the needed decision, constraint, or lesson.",
			"Drill back with recall(<obs_id>) only when a hit matters and its summary is not enough.",
		],
		parameters: Type.Object({
			query: Type.String({ description: "Free-text query; CJK is segmented automatically (jieba or bigram fallback)." }),
			project: Type.Optional(
				Type.String({ description: "Project cwd to scope to. Defaults to the current project." }),
			),
			from: Type.Optional(Type.String({ description: "Inclusive lower time bound: YYYY-MM-DD or ISO-8601." })),
			to: Type.Optional(Type.String({ description: "Inclusive upper time bound: YYYY-MM-DD or ISO-8601." })),
			kind: Type.Optional(
				Type.Union(
					[
						Type.Literal("observation"),
						Type.Literal("concept"),
						Type.Literal("daily"),
						Type.Literal("atom"),
					],
					{
						description:
							"Filter by entry kind. 'atom' rows come from the memory-distiller extension " +
							"(knowledge-base/atoms/**/*.jsonl); their source_entries are pi session entry ids.",
					},
				),
			),
			limit: Type.Optional(Type.Number({ description: "Max hits, 1-50 (default 10)." })),
		}),
		async execute(_toolCallId, params, _signal, _onUpdate, ctx) {
			const opened = await ensureOpen(state);
			if (!opened) {
				return {
					content: [{ type: "text", text: "memory_search: index unavailable (see pi stderr)." }],
					details: { error: "index-unavailable" },
				};
			}
			const started = performance.now();
			const tokens = await opened.tokenizer.tokenize(params.query);
			if (!tokens.trim()) {
				return {
					content: [{ type: "text", text: "memory_search: query produced no searchable tokens." }],
					details: { hits: 0 },
				};
			}
			const project = params.project ?? ctx.sessionManager.getCwd();
			const { hits, match } = searchMemory(opened.db, opened.tokenizer, tokens, {
				query: params.query,
				project,
				from: params.from,
				to: params.to,
				kind: params.kind,
				limit: params.limit,
			});
			const elapsedMs = performance.now() - started;
			const text = formatHits(hits, { match, elapsedMs, project });
			return {
				content: [{ type: "text", text }],
				details: { hits: hits.length, match, elapsedMs, project, results: hits },
			};
		},
	});

	pi.registerTool(memorySearchTool);
}

/** Model-facing rendering of search hits. */
export function formatHits(
	hits: SearchHit[],
	meta: { match: "and" | "or"; elapsedMs: number; project: string },
): string {
	if (hits.length === 0) {
		return `memory_search: no matches (project=${meta.project}, ${meta.elapsedMs.toFixed(1)}ms).`;
	}
	const lines = [
		`memory_search: ${hits.length} hit(s), match=${meta.match}, ${meta.elapsedMs.toFixed(1)}ms, project=${meta.project}`,
		"",
	];
	for (const h of hits) {
		lines.push(`- [${h.kind}] obs_id=${h.obs_id} ts=${h.ts} rank=${h.rank.toFixed(3)}`);
		lines.push(`  session=${h.session_id || "-"} entry=${h.entry_id || "-"}${h.source_path ? ` source=${h.source_path}` : ""}`);
		if (h.source_entry_ids.length > 0) lines.push(`  source_entries=${h.source_entry_ids.join(",")}`);
		lines.push(`  ${h.snippet.replaceAll(/\s+/g, " ")}`);
	}
	lines.push("", "Drill-back: recall(<obs_id>) for exact source context of observations (pi-observational-memory);");
	lines.push("for concept/daily/atom hits, read the listed source file (atom hits also list resolvable source_entries).");
	return lines.join("\n");
}
