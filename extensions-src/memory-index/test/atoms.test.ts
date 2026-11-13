/**
 * Theme B2 acceptance: kind:"atom" is un-stubbed — fixture atoms written by
 * the distiller (append-only JSONL under <kbRoot>/atoms/<project>/) are
 * indexed by the same FTS5 pipeline, searchable with kind:"atom", carry
 * resolvable source_entry_ids, and the credential screen + watermarks +
 * idempotency semantics hold.
 */
import { mkdtempSync, appendFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { openIndex, searchMemory, type DatabaseSync } from "../src/db.js";
import type { Tokenizer } from "../src/tokenize.js";
import { refreshAtoms, atomRowContent } from "../src/parse-atoms.js";

let dir: string;
let kbRoot: string;
let opened: { db: DatabaseSync; tokenizer: Tokenizer };
const PROJECT = "/tmp/atoms-fixture-project";

// Slack-shaped token (same rationale as the distiller tests: flagged by the
// credential screen, clean for the repo's staged-content git guard).
const CRED_LINE = JSON.stringify({
	schema: 1,
	id: "deadbeefdead",
	kind: "work_fact",
	claim: "Decision: the staging deploy used bot token xoxb-fake000000000-fake000000000 during rollout.",
	evidence: "",
	source_entry_ids: ["ff0000000008"],
	project: "atoms-fixture-project",
	ts: "2026-11-13T09:00:00.000Z",
	source_session: "1111aaaa",
	origin: "rule",
	hash: "0".repeat(64),
});

function atomLine(id: string, kind: string, claim: string, sourceIds: string[]): string {
	return JSON.stringify({
		schema: 1,
		id,
		kind,
		claim,
		evidence: "",
		source_entry_ids: sourceIds,
		project: "atoms-fixture-project",
		ts: "2026-11-13T09:00:00.000Z",
		source_session: "1111aaaa",
		origin: "rule",
		hash: "0".repeat(64),
	});
}

beforeAll(async () => {
	dir = mkdtempSync(path.join(tmpdir(), "memidx-atoms-"));
	kbRoot = path.join(dir, "kb");
	const atomsDir = path.join(kbRoot, "atoms", "atoms-fixture-project");
	const { mkdirSync } = await import("node:fs");
	mkdirSync(atomsDir, { recursive: true });
	writeFileSync(
		path.join(atomsDir, "2026-11-13.jsonl"),
		[
			atomLine("aa00000000aa", "decision", "The renderer ships behind the FTS5BM25 feature flag for one week.", ["adff437e", "aa0000000001"]),
			atomLine("bb00000000bb", "preference", "We prefer append-only JSONL for every audit-critical write path.", ["ee0000000007"]),
			"{ this line is torn and stays unparsed",
			CRED_LINE,
			"",
		].join("\n"),
	);
	process.env.PI_MEMORY_INDEX_DB = path.join(dir, "index.db");
	opened = await openIndex(process.env.PI_MEMORY_INDEX_DB);
});

afterAll(() => {
	try {
		opened.db.close();
	} finally {
		delete process.env.PI_MEMORY_INDEX_DB;
	}
});

describe("refreshAtoms (kind: atom un-stubbed)", () => {
	it("indexes fixture atoms; search returns them with resolvable source_entry_ids", async () => {
		const stats = await refreshAtoms(opened.db, opened.tokenizer, kbRoot, PROJECT);
		expect(stats.filesScanned).toBe(1);
		expect(stats.inserted).toBe(2);
		expect(stats.parseErrors).toBe(1); // torn line tolerated
		expect(stats.credentialsSkipped).toBe(1); // slack-shaped token skipped

		const { hits } = searchMemory(opened.db, opened.tokenizer, await opened.tokenizer.tokenize("FTS5BM25"), {
			query: "FTS5BM25",
			project: PROJECT,
			kind: "atom",
		});
		expect(hits).toHaveLength(1);
		expect(hits[0]!.kind).toBe("atom");
		expect(hits[0]!.obs_id).toBe("aa00000000aa");
		expect(hits[0]!.source_entry_ids).toEqual(["adff437e", "aa0000000001"]);
		expect(hits[0]!.snippet).toContain("[atom:decision]");
	});

	it("atom hits are invisible to other projects (scoping is real)", async () => {
		const { hits } = searchMemory(opened.db, opened.tokenizer, await opened.tokenizer.tokenize("FTS5BM25"), {
			query: "FTS5BM25",
			project: "/tmp/some-other-project",
			kind: "atom",
		});
		expect(hits).toHaveLength(0);
	});

	it("re-running the refresh is idempotent (watermarks + obs_id dedupe)", async () => {
		const stats = await refreshAtoms(opened.db, opened.tokenizer, kbRoot, PROJECT);
		expect(stats.inserted).toBe(0);
		expect(stats.duplicates).toBe(0);
		expect(stats.filesScanned).toBe(1);
	});

	it("a NEW appended atom is indexed incrementally (no full re-read)", async () => {
		const atomsDir = path.join(kbRoot, "atoms", "atoms-fixture-project");
		appendFileSync(
			path.join(atomsDir, "2026-11-13.jsonl"),
			atomLine("cc00000000cc", "work_fact", "The atom index reuses the same watermarks table as session backfill.", [
				"ff0000000008",
			]) + "\n",
		);
		const stats = await refreshAtoms(opened.db, opened.tokenizer, kbRoot, PROJECT);
		expect(stats.inserted).toBe(1);
		const { hits } = searchMemory(opened.db, opened.tokenizer, await opened.tokenizer.tokenize("watermarks"), {
			query: "watermarks",
			project: PROJECT,
			kind: "atom",
		});
		expect(hits).toHaveLength(1);
		expect(hits[0]!.obs_id).toBe("cc00000000cc");
	});

	it("no credential-flavored atom content ever lands in the index", async () => {
		const rows = opened.db.prepare("SELECT COUNT(*) AS n FROM obs WHERE content LIKE '%xoxb-%'").all() as Array<{ n: number }>;
		expect(rows[0]!.n).toBe(0);
	});

	it("atomRowContent keeps claims kind-tagged and evidence attached", () => {
		expect(atomRowContent("decision", "Claim text.", "quote")).toBe("[atom:decision] Claim text.\n\nevidence: quote");
		expect(atomRowContent("decision", "Claim text.", "")).toBe("[atom:decision] Claim text.");
	});
});
