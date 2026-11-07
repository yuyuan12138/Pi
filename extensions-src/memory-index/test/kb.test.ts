/**
 * KB indexing: daily sections + concept files, frontmatter timestamps,
 * idempotent refresh, in-place edit handling, project scoping.
 */
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { openIndex, searchMemory } from "../src/db.js";
import { kbEntriesForFile, refreshKnowledgeBase, splitDailySections, parseFrontmatter } from "../src/parse-kb.js";

let ctx: any;
let kbRoot: string;
const PROJ = "/tmp/proj-kb";

beforeAll(async () => {
	const root = mkdtempSync(path.join(tmpdir(), "memidx-kb-"));
	kbRoot = path.join(root, "knowledge-base");
	mkdirSync(path.join(kbRoot, "daily"), { recursive: true });
	mkdirSync(path.join(kbRoot, "knowledge", "concepts"), { recursive: true });

	writeFileSync(
		path.join(kbRoot, "daily", "2026-11-04.md"),
		[
			"# 2026-11-04",
			"",
			"## Compaction observation format verified",
			"- details.observations carry 12-hex ids and sourceEntryIds for drill-back.",
			"",
			"## Watermark design chosen",
			"- Per-file byte offsets keep session backfill incremental.",
			"",
		].join("\n"),
	);
	writeFileSync(
		path.join(kbRoot, "knowledge", "concepts", "memory-scoping.md"),
		[
			"---",
			"title: Memory scoping",
			"updated: 2026-11-01",
			"scope: project:PiAgents",
			"approval: unreviewed",
			"---",
			"",
			"# Memory scoping",
			"",
			"Scoped retrieval beats a naive global memory pool (arXiv 2609.29144).",
			"",
		].join("\n"),
	);

	ctx = await openIndex(path.join(root, "index.db"));
});

afterAll(() => {
	try {
		ctx.db.close();
	} catch {
		/* ignore */
	}
});

describe("KB parsing", () => {
	it("splits daily files into ## sections", () => {
		const sections = splitDailySections("# 2026-11-04\n\n## A\nbody a\n\n## B\nbody b\n");
		expect(sections).toHaveLength(2);
		expect(sections[0]!.heading).toBe("A");
		expect(sections[1]!.body).toContain("body b");
	});

	it("parses frontmatter scalars and ignores lists", () => {
		const fm = parseFrontmatter("---\ntitle: T\nupdated: 2026-11-01\nscope: pending\nevidence:\n  - x\n---\nbody");
		expect(fm.title).toBe("T");
		expect(fm.updated).toBe("2026-11-01");
		expect(fm.scope).toBe("pending");
		expect(fm.evidence).toBeUndefined();
	});

	it("builds one row per daily section and one per concept", () => {
		const daily = kbEntriesForFile(path.join(kbRoot, "daily", "2026-11-04.md"), kbRoot);
		expect(daily).toHaveLength(2);
		expect(daily.every((e) => e.kind === "daily" && e.ts === "2026-11-04T12:00:00.000Z")).toBe(true);
		const concept = kbEntriesForFile(path.join(kbRoot, "knowledge", "concepts", "memory-scoping.md"), kbRoot);
		expect(concept).toHaveLength(1);
		expect(concept[0]?.kind).toBe("concept");
		expect(concept[0]?.ts).toBe("2026-11-01T12:00:00.000Z");
		expect(concept[0]?.content).not.toContain("approval:");
	});
});

describe("KB refresh + search", () => {
	it("indexes daily + concept rows with project scoping", async () => {
		const stats = await refreshKnowledgeBase(ctx.db, ctx.tokenizer, kbRoot, PROJ);
		expect(stats.inserted).toBe(3);
		const tokens = await ctx.tokenizer.tokenize("watermark byte offsets");
		const { hits } = searchMemory(ctx.db, ctx.tokenizer, tokens, { query: "watermark byte offsets", project: PROJ, kind: "daily" });
		expect(hits).toHaveLength(1);
		expect(hits[0]!.kind).toBe("daily");
		expect(hits[0]!.source_path).toBe(path.join(kbRoot, "daily", "2026-11-04.md"));
	});

	it("re-refresh is idempotent and reflects edits", async () => {
		// Refresh replaces each file's rows (delete-by-source then insert), so
		// a no-change refresh reports rebuilds while the row set is stable.
		const idsBefore = ctx.db.prepare("SELECT obs_id FROM obs WHERE kind IN ('daily','concept') ORDER BY obs_id").all();
		const stats2 = await refreshKnowledgeBase(ctx.db, ctx.tokenizer, kbRoot, PROJ);
		expect(stats2.inserted).toBe(3);
		const count = (ctx.db.prepare("SELECT COUNT(*) AS n FROM obs WHERE kind IN ('daily','concept')").get() as any).n;
		expect(count).toBe(3);
		const idsAfter = ctx.db.prepare("SELECT obs_id FROM obs WHERE kind IN ('daily','concept') ORDER BY obs_id").all();
		expect(idsAfter).toEqual(idsBefore); // same stable obs_ids, zero duplicates

		// In-place edit: append a new section to the daily file.
		writeFileSync(
			path.join(kbRoot, "daily", "2026-11-04.md"),
			[
				"# 2026-11-04",
				"",
				"## Compaction observation format verified",
				"- details.observations carry 12-hex ids and sourceEntryIds for drill-back.",
				"",
				"## Watermark design chosen",
				"- Per-file byte offsets keep session backfill incremental.",
				"",
				"## New evening section",
				"- Decide on atom extraction triggers next week.",
				"",
			].join("\n"),
		);
		const stats3 = await refreshKnowledgeBase(ctx.db, ctx.tokenizer, kbRoot, PROJ);
		// The refresh rebuilds every file's rows: 3 daily sections (one new) + 1 concept.
		expect(stats3.inserted).toBe(4);
		const count3 = (ctx.db.prepare("SELECT COUNT(*) AS n FROM obs WHERE kind IN ('daily','concept')").get() as any).n;
		expect(count3).toBe(4);
	});

	it("concept search by content works through the same pipeline", async () => {
		const tokens = await ctx.tokenizer.tokenize("scoped retrieval global memory pool");
		const { hits } = searchMemory(ctx.db, ctx.tokenizer, tokens, { query: "scoped retrieval", project: PROJ, kind: "concept" });
		expect(hits).toHaveLength(1);
		expect(hits[0]!.kind).toBe("concept");
		expect(hits[0]!.ts).toBe("2026-11-01T12:00:00.000Z");
	});
});
