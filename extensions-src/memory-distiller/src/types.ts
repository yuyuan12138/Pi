/** Shared types for the memory-distiller extension. */

export const ATOM_KINDS = [
	"preference",
	"decision",
	"constraint",
	"work_fact",
	"work_task",
	"work_method",
	"work_artifact",
] as const;

export type AtomKind = (typeof ATOM_KINDS)[number];

/**
 * One extracted, append-only memory record. Written one-JSON-per-line to
 * knowledge-base/atoms/<project>/<date>.jsonl; never edited in place.
 */
export interface Atom {
	schema: 1;
	/** Stable 12-hex id, derived from project + content hash (dedup-safe). */
	id: string;
	kind: AtomKind;
	/** Self-contained durable statement. */
	claim: string;
	/** Optional supporting quote from the source text (never invented). */
	evidence: string;
	/** pi session entry ids the atom was derived from (recall-compatible provenance). */
	source_entry_ids: string[];
	/** Project slug (directory name under knowledge-base/atoms/). */
	project: string;
	/** ISO-8601 UTC extraction time. */
	ts: string;
	/** Session uuid of the primary source file. */
	source_session: string;
	/** Extraction method: "llm" (model call) or "rule" (keyword-gated selection of source text). */
	origin: "llm" | "rule";
	/** sha256 of the normalized claim — the dedup key. */
	hash: string;
}

/**
 * A distilled, provenance-carrying text unit found in a session JSONL delta.
 * Sources are always distilled text (observations, worker reports) — never
 * raw tool output.
 */
export interface Candidate {
	text: string;
	/** Entry ids resolvable inside the same session file. */
	sourceEntryIds: string[];
	/** Session uuid of the file the candidate came from. */
	sessionUuid: string;
	rawTimestamp: string | undefined;
	source: "compaction-observation" | "om-observation" | "subagent-report";
}

/** An un-materialized atom straight from an extractor. */
export interface AtomDraft {
	kind: AtomKind;
	claim: string;
	evidence: string;
	sourceEntryIds: string[];
	sessionUuid: string;
	origin: "llm" | "rule";
}

export interface ScanStats {
	filesScanned: number;
	filesChanged: number;
	candidates: number;
	parseErrors: number;
}

export interface DistillRunStats extends ScanStats {
	trigger: string;
	dryRun: boolean;
	/** True when the LLM path produced the drafts. */
	llmUsed: boolean;
	/** Why the run degraded to rule-based extraction (null when it did not). */
	degradedReason: string | null;
	/** Atoms that survived dedup + credential screen. */
	extracted: number;
	duplicates: number;
	credentialsSkipped: number;
	/** Atoms actually appended (0 for dry-run). */
	written: number;
	atomsFile: string | null;
}
