/**
 * Tokenizer behavior: bigram fallback segmentation, jieba availability,
 * write-side/query-side consistency, and tokenizer-mode drift repair.
 */
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterAll, describe, expect, it } from "vitest";
import { openIndex, searchMemory, insertObservation } from "../src/db.js";
import { bigramTokenize, createTokenizer, detectTokenizerMode } from "../src/tokenize.js";

describe("bigram fallback segmentation", () => {
	it("emits overlapping CJK bigrams", () => {
		expect(bigramTokenize("记忆索引")).toBe("记忆 忆索 索引");
		expect(bigramTokenize("索引")).toBe("索引");
	});

	it("keeps ASCII words and handles mixed text", () => {
		expect(bigramTokenize("用 SQLite FTS5 存储")).toBe("用 SQLite FTS5 存储");
		expect(bigramTokenize("memory index 记忆")).toBe("memory index 记忆");
	});

	it("single CJK characters pass through", () => {
		expect(bigramTokenize("忆")).toBe("忆");
	});

	it("is idempotent on already-tokenized text", () => {
		const once = bigramTokenize("记忆索引设计");
		expect(bigramTokenize(once)).toBe(once);
	});
});

describe("active tokenizer", () => {
	it("detects a mode and keeps query/doc segmentation mutually consistent", async () => {
		const tokenizer = await createTokenizer();
		const mode = await detectTokenizerMode();
		expect(tokenizer.mode).toBe(mode);
		expect(["jieba", "bigram"]).toContain(mode);
		const docTokens = await tokenizer.tokenize("跨会话记忆索引检索");
		const queryTokens = await tokenizer.tokenize("记忆索引");
		expect(docTokens.split(" ")).toEqual(expect.arrayContaining(queryTokens.split(" ")));
	});
});

describe("tokenizer-mode drift repair", () => {
	const ctxRef: any = {};
	let root: string;

	it("re-tokenizes the whole index when the recorded mode changes", async () => {
		root = mkdtempSync(path.join(tmpdir(), "memidx-tok-"));
		const opened = await openIndex(path.join(root, "index.db"));
		ctxRef.db = opened.db;
		ctxRef.tokenizer = opened.tokenizer;
		expect(opened.retokenized).toBe(0);

		await insertObservation(opened.db, opened.tokenizer, {
			obs_id: "ef0000000001",
			entry_id: "e1",
			session_id: "s1",
			session_path: "",
			source_path: "",
			kind: "observation",
			project: "/tmp/proj-tok",
			ts: "2026-11-06T10:00:00.000Z",
			content: "跨会话记忆索引支持时间窗口查询与项目过滤",
		});

		// Pretend the index was built with the other tokenizer mode.
		const other = opened.tokenizer.mode === "jieba" ? "bigram" : "jieba";
		const { setMeta } = await import("../src/db.js");
		setMeta(opened.db, "tokenizer", other);

		const reopened = await openIndex(path.join(root, "index.db"));
		expect(reopened.retokenized).toBe(1);
		expect(reopened.tokenizer.mode).not.toBe(other);

		const tokens = await reopened.tokenizer.tokenize("记忆索引");
		const { hits } = searchMemory(reopened.db, reopened.tokenizer, tokens, {
			query: "记忆索引",
			project: "/tmp/proj-tok",
		});
		expect(hits.length).toBe(1);
		expect(hits[0]!.obs_id).toBe("ef0000000001");
	});

	afterAll(() => {
		try {
			ctxRef.db?.close();
		} catch {
			/* ignore */
		}
	});
});
