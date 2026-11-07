/**
 * Acceptance 1 + 2: search quality, ids/timestamps, <50ms, time windows,
 * project scoping — over three synthetic session JSONLs with compaction
 * entries (plus out-of-range and other-project controls).
 */
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { openIndex, searchMemory } from "../src/db.js";
import { backfillSessions } from "../src/parse-sessions.js";
import { OBS_A, OBS_B, OBS_C, OBS_OLD, writeSessionFile } from "./helpers.js";

const PROJ_MAIN = "/tmp/fixture-project-main";
const PROJ_OTHER = "/tmp/fixture-project-other";

let ctx: { db: any; tokenizer: any; root: string };

beforeAll(async () => {
	const root = mkdtempSync(path.join(tmpdir(), "memidx-search-"));
	const sessionsMain = path.join(root, "sessions-main");
	const sessionsOther = path.join(root, "sessions-other");

	writeSessionFile(sessionsMain, "2026-11-01T09-00-00-000Z_11111111-aaaa-bbbb-cccc-dddddddddddd.jsonl", [
		{
			id: "cafe0001",
			timestamp: "2026-11-01T10:00:00.000Z",
			observations: [
				{
					id: OBS_A,
					content: "Designed the SQLite FTS5 schema for the memory index with UNINDEXED metadata columns.",
					timestamp: "2026-11-01 09:30",
					sourceEntryIds: ["adff437e"],
				},
				{
					id: OBS_OLD,
					content: "Early October notes: the memory index design review scheduled.",
					timestamp: "2026-10-01 08:00",
				},
			],
		},
	]);
	writeSessionFile(sessionsMain, "2026-11-02T09-00-00-000Z_22222222-aaaa-bbbb-cccc-dddddddddddd.jsonl", [
		{
			id: "cafe0002",
			timestamp: "2026-11-02T10:00:00.000Z",
			observations: [
				{
					id: OBS_B,
					content: "Chose jieba CJK tokenization with a bigram fallback for the memory index.",
					timestamp: "2026-11-02 15:45",
				},
			],
		},
	]);
	writeSessionFile(sessionsMain, "2026-11-03T09-00-00-000Z_33333333-aaaa-bbbb-cccc-dddddddddddd.jsonl", [
		{
			id: "cafe0003",
			timestamp: "2026-11-03T10:00:00.000Z",
			observations: [
				{
					id: OBS_C,
					content: "Credential screening runs before every memory index insert.",
					timestamp: "2026-11-03 11:20",
				},
			],
		},
	]);
	writeSessionFile(sessionsOther, "2026-11-02T09-00-00-000Z_44444444-aaaa-bbbb-cccc-dddddddddddd.jsonl", [
		{
			id: "cafe0004",
			timestamp: "2026-11-02T10:00:00.000Z",
			observations: [
				{
					id: "ee0000000005",
					content: "Other project also mentions the memory index FTS5 schema tangentially.",
					timestamp: "2026-11-02 12:00",
				},
			],
		},
	]);

	const opened = await openIndex(path.join(root, "index.db"));
	ctx = { ...opened, root };
	await backfillSessions(opened.db, opened.tokenizer, sessionsMain, PROJ_MAIN);
	await backfillSessions(opened.db, opened.tokenizer, sessionsOther, PROJ_OTHER);
});

afterAll(() => {
	try {
		ctx.db.close();
	} catch {
		/* ignore */
	}
});

describe("acceptance 1: right observation with id + ts, <50ms", () => {
	it("returns the FTS5-schema observation with correct obs_id and ts", async () => {
		const tokens = await ctx.tokenizer.tokenize("FTS5 schema");
		const t0 = performance.now();
		const { hits } = searchMemory(ctx.db, ctx.tokenizer, tokens, { query: "FTS5 schema", project: PROJ_MAIN });
		const elapsed = performance.now() - t0;
		expect(hits.length).toBeGreaterThan(0);
		expect(hits[0]!.obs_id).toBe(OBS_A);
		expect(hits[0]!.ts).toBe(new Date("2026-11-01T09:30:00").toISOString());
		expect(hits[0]!.entry_id).toBe("cafe0001");
		expect(hits[0]!.session_id).toBe("11111111-aaaa-bbbb-cccc-dddddddddddd");
		expect(hits[0]!.source_entry_ids).toContain("adff437e");
		expect(hits[0]!.snippet).toContain("FTS5");
		expect(elapsed).toBeLessThan(50);
	});

	it("searches stay under 50ms across repeated queries", async () => {
		const tokens = await ctx.tokenizer.tokenize("credential screening memory index");
		for (let i = 0; i < 5; i++) {
			const t0 = performance.now();
			searchMemory(ctx.db, ctx.tokenizer, tokens, { query: "credential screening", project: PROJ_MAIN });
			expect(performance.now() - t0).toBeLessThan(50);
		}
	});
});

describe("acceptance 2: time windows and project scoping", () => {
	it("time-window query excludes out-of-range hits", async () => {
		const tokens = await ctx.tokenizer.tokenize("memory index");
		const { hits } = searchMemory(ctx.db, ctx.tokenizer, tokens, {
			query: "memory index",
			project: PROJ_MAIN,
			from: "2026-11-02",
			to: "2026-11-03",
		});
		const ids = hits.map((h: any) => h.obs_id);
		expect(ids).toContain(OBS_B);
		expect(ids).toContain(OBS_C);
		expect(ids).not.toContain(OBS_A);
		expect(ids).not.toContain(OBS_OLD);
	});

	it("half-open windows respect inclusive bounds", async () => {
		const tokens = await ctx.tokenizer.tokenize("memory index");
		const { hits } = searchMemory(ctx.db, ctx.tokenizer, tokens, {
			query: "memory index",
			project: PROJ_MAIN,
			from: "2026-11-02",
			to: "2026-11-02",
		});
		expect(hits.map((h: any) => h.obs_id)).toEqual([OBS_B]);
	});

	it("project filter returns only that project's rows", async () => {
		const tokens = await ctx.tokenizer.tokenize("FTS5 schema memory index");
		const { hits } = searchMemory(ctx.db, ctx.tokenizer, tokens, { query: "FTS5 schema", project: PROJ_OTHER });
		expect(hits.length).toBeGreaterThan(0);
		expect(hits.every((h: any) => h.project === PROJ_OTHER)).toBe(true);
		expect(hits.map((h: any) => h.obs_id)).not.toContain(OBS_A);
	});
});
