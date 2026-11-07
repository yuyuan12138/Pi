/**
 * Acceptance 3: idempotent re-index. Re-running backfill over the same
 * files must not create duplicate rows; appends index exactly once;
 * immediate (session_compact) indexing followed by backfill dedupes.
 */
import { appendFileSync, mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { insertObservation, openIndex } from "../src/db.js";
import { backfillSessions, indexSessionFileIncremental } from "../src/parse-sessions.js";
import { compactionEntryLine, writeSessionFile } from "./helpers.js";

let ctx: any;
let root: string;
let sessionsDir: string;
let fileA: string;

beforeAll(async () => {
	root = mkdtempSync(path.join(tmpdir(), "memidx-idem-"));
	sessionsDir = path.join(root, "sessions");
	fileA = writeSessionFile(sessionsDir, "2026-11-05T09-00-00-000Z_aaaaaaaa-1111-2222-3333-444444444444.jsonl", [
		{
			id: "beef0001",
			timestamp: "2026-11-05T10:00:00.000Z",
			observations: [{ id: "ab0000000001", content: "Watermark offsets make backfill incremental and idempotent.", timestamp: "2026-11-05 09:00" }],
		},
	]);
	ctx = await openIndex(path.join(root, "index.db"));
});

afterAll(() => {
	try {
		ctx.db.close();
	} catch {
		/* ignore */
	}
});

const rowCount = (db: any) => (db.prepare("SELECT COUNT(*) AS n FROM obs").get() as any).n;

describe("acceptance 3: idempotent re-index", () => {
	it("second backfill inserts nothing and skips files", async () => {
		const first = await backfillSessions(ctx.db, ctx.tokenizer, sessionsDir, "/tmp/proj-idem");
		expect(first.reduce((n: number, r: any) => n + r.inserted, 0)).toBe(1);
		const before = rowCount(ctx.db);

		const second = await backfillSessions(ctx.db, ctx.tokenizer, sessionsDir, "/tmp/proj-idem");
		expect(second.reduce((n: number, r: any) => n + r.inserted, 0)).toBe(0);
		expect(second.every((r: any) => r.skipped)).toBe(true);
		expect(rowCount(ctx.db)).toBe(before);
	});

	it("immediate session_compact indexing followed by backfill does not duplicate", async () => {
		// Simulate session_compact firing before the entry hits the watermark
		// scan: insert the observation directly, then run backfill over the
		// file that now contains the same compaction entry.
		appendCompaction(fileA, {
			id: "beef0002",
			timestamp: "2026-11-05T11:00:00.000Z",
			observations: [{ id: "ab0000000002", content: "Immediate compaction indexing meets the watermark dedupe.", timestamp: "2026-11-05 10:30" }],
		});
		const inserted = await insertObservation(ctx.db, ctx.tokenizer, {
			obs_id: "ab0000000002",
			entry_id: "beef0002",
			session_id: "aaaaaaaa-1111-2222-3333-444444444444",
			session_path: fileA,
			source_path: "",
			kind: "observation",
			project: "/tmp/proj-idem",
			ts: "2026-11-05T10:30:00.000Z",
			content: "Immediate compaction indexing meets the watermark dedupe.",
		});
		expect(inserted).toBe(true);
		const before = rowCount(ctx.db);
		const result = await indexSessionFileIncremental(ctx.db, ctx.tokenizer, fileA, "/tmp/proj-idem");
		expect(result.inserted).toBe(0);
		expect(result.duplicates).toBeGreaterThanOrEqual(1);
		expect(rowCount(ctx.db)).toBe(before);
		expect(fileA).toBeTruthy();
	});

	it("a partially written trailing line is indexed exactly once once complete", async () => {
		const line = compactionEntryLine({
			id: "beef0003",
			timestamp: "2026-11-05T12:00:00.000Z",
			observations: [{ id: "ab0000000003", content: "Partial line handling never double counts observations.", timestamp: "2026-11-05 11:30" }],
		});
		// Half the line, no newline yet (session mid-write).
		appendFileSync(fileA, line.slice(0, Math.floor(line.length / 2)));
		const r1 = await indexSessionFileIncremental(ctx.db, ctx.tokenizer, fileA, "/tmp/proj-idem");
		expect(r1.inserted).toBe(0);
		// The rest of the line plus the newline arrives.
		appendFileSync(fileA, line.slice(Math.floor(line.length / 2)) + "\n");
		const r2 = await indexSessionFileIncremental(ctx.db, ctx.tokenizer, fileA, "/tmp/proj-idem");
		expect(r2.inserted).toBe(1);
		// Re-scan sees the watermark and adds nothing.
		const r3 = await indexSessionFileIncremental(ctx.db, ctx.tokenizer, fileA, "/tmp/proj-idem");
		expect(r3.inserted).toBe(0);
		expect(r3.skipped).toBe(true);
	});

	it("unique obs_id constraint holds at the SQL layer", () => {
		const ids = ctx.db.prepare("SELECT obs_id, COUNT(*) AS n FROM obs GROUP BY obs_id HAVING n > 1").all();
		expect(ids).toEqual([]);
	});
});

/** Append a full compaction entry line to a session file. */
function appendCompaction(filePath: string, fixture: any): void {
	appendFileSync(filePath, compactionEntryLine(fixture) + "\n");
}
