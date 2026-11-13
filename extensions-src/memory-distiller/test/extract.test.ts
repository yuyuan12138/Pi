import { describe, expect, it } from "vitest";
import { createAssistantMessageEventStream, type AssistantMessage } from "@earendil-works/pi-ai";
import {
	atomIdFor,
	buildBlocksText,
	claimHash,
	llmExtractAtoms,
	normalizeClaim,
	parseLlmAtoms,
	ruleExtractAtoms,
} from "../src/extract.js";
import type { Candidate, AtomDraft } from "../src/types.js";

function candidate(text: string, ids: string[], source: Candidate["source"] = "compaction-observation"): Candidate {
	return { text, sourceEntryIds: ids, sessionUuid: "sess-1", rawTimestamp: undefined, source };
}

function fakeStream(text: string, stopReason: AssistantMessage["stopReason"] = "stop") {
	const message: AssistantMessage = {
		role: "assistant",
		content: [{ type: "text", text }],
		api: "openai-completions" as AssistantMessage["api"],
		provider: "test",
		model: "test-model",
		usage: { input: 1, output: 1, cacheRead: 0, cacheWrite: 0 } as AssistantMessage["usage"],
		stopReason,
		timestamp: Date.now(),
	};
	const stream = createAssistantMessageEventStream();
	stream.end(message);
	return () => stream;
}

const VALID_LLM_JSON = `[
  {"kind":"decision","claim":"The atoms file format is append-only JSONL with per-line provenance ids.","evidence":"atoms are append-only","sources":[1]},
  {"kind":"preference","claim":"Users prefer watermarked incremental reads over full rescans.","evidence":"","sources":[1,2]}
]`;

describe("parseLlmAtoms (validation + provenance discipline)", () => {
	const candidates = [candidate("text one", ["id-a", "id-b"]), candidate("text two", ["id-c"])];

	it("parses valid output and unions provenance across merged blocks", () => {
		const drafts = parseLlmAtoms(VALID_LLM_JSON, candidates);
		expect(drafts).toHaveLength(2);
		expect(drafts[0]!.kind).toBe("decision");
		expect(drafts[0]!.sourceEntryIds).toEqual(["id-a", "id-b"]);
		expect(drafts[1]!.sourceEntryIds.sort()).toEqual(["id-a", "id-b", "id-c"]);
		expect(drafts.every((d) => d.origin === "llm")).toBe(true);
	});

	it("tolerates code fences and prose around the JSON array", () => {
		const drafts = parseLlmAtoms(`Sure! Here are the atoms:\n\`\`\`json\n${VALID_LLM_JSON}\n\`\`\`\nDone.`, candidates);
		expect(drafts).toHaveLength(2);
	});

	it("drops atoms with invalid kinds, empty claims, or out-of-range sources", () => {
		const bad = `[
			{"kind":"vibe","claim":"An invalid kind must never survive validation here.","sources":[1]},
			{"kind":"decision","claim":"","sources":[1]},
			{"kind":"decision","claim":"Out of range sources mean provenance cannot resolve at all.","sources":[99]},
			{"kind":"decision","claim":"A claim that is far too long. ${"x".repeat(700)}","sources":[1]}
		]`;
		expect(parseLlmAtoms(bad, candidates)).toHaveLength(0);
	});

	it("drops atoms without sources when several candidates exist (provenance is mandatory)", () => {
		const noSources = `[{"kind":"decision","claim":"A claim without sources cannot be provenance-checked properly."}]`;
		expect(parseLlmAtoms(noSources, candidates)).toHaveLength(0);
	});

	it("falls back to the single candidate when only one exists", () => {
		const one = [candidate("only text", ["solo-id"])];
		const drafts = parseLlmAtoms(`[{"kind":"work_fact","claim":"Single-candidate provenance falls back correctly here."}]`, one);
		expect(drafts).toHaveLength(1);
		expect(drafts[0]!.sourceEntryIds).toEqual(["solo-id"]);
	});

	it("throws on output with no JSON array (caller degrades)", () => {
		expect(() => parseLlmAtoms("no json here", candidates)).toThrow(/no JSON array/);
	});
});

describe("llmExtractAtoms (provider-neutral call via injected streamSimple)", () => {
	const candidates = [candidate("observation text for the model", ["id-1"])];

	it("returns drafts on a well-formed response", async () => {
		const drafts = await llmExtractAtoms(candidates, {
			model: { provider: "test", id: "test-model" } as any,
			streamSimple: fakeStream(VALID_LLM_JSON) as any,
		});
		expect(drafts).toHaveLength(2);
		expect(drafts[0]!.origin).toBe("llm");
	});

	it("throws on garbage output (degrade path)", async () => {
		await expect(
			llmExtractAtoms(candidates, {
				model: {} as any,
				streamSimple: fakeStream("complete nonsense") as any,
			}),
		).rejects.toThrow(/no JSON array/);
	});

	it("throws on error stopReason (degrade path)", async () => {
		await expect(
			llmExtractAtoms(candidates, {
				model: {} as any,
				streamSimple: fakeStream(VALID_LLM_JSON, "error") as any,
			}),
		).rejects.toThrow(/stopReason=error/);
	});

	it("times out a hung stream and aborts it (bounded call)", async () => {
		// A stream that is created but never ended: result() never settles.
		const hung = createAssistantMessageEventStream();
		await expect(
			llmExtractAtoms(candidates, {
				model: {} as any,
				streamSimple: (() => hung) as any,
				timeoutMs: 120,
			}),
		).rejects.toThrow(/timeout/);
	}, 5000);
});

describe("ruleExtractAtoms (no-LLM degrade; selection never fabrication)", () => {
	it("gates sentences by keyword and keeps the claim verbatim from the source", () => {
		const candidates = [
			candidate(
				"Decision: we will use SQLite for the index. The weather in Lisbon is nice today. We prefer append-only files for audit trails.",
				["id-9"],
			),
		];
		const drafts = ruleExtractAtoms(candidates);
		expect(drafts).toHaveLength(2);
		const full = candidates[0]!.text;
		for (const d of drafts) {
			expect(full).toContain(d.claim); // fabrication-free: claim is a substring
			expect(d.origin).toBe("rule");
			expect(d.sourceEntryIds).toEqual(["id-9"]);
		}
		expect(drafts.map((d) => d.kind).sort()).toEqual(["decision", "preference"]);
	});

	it("yields nothing for text without any trigger pattern", () => {
		expect(ruleExtractAtoms([candidate("An utterly ordinary sentence about the weather and lunch plans.", ["id-1"])])).toHaveLength(0);
	});
});

describe("dedup keys (content hash)", () => {
	it("hash is insensitive to case and whitespace; id is stable per project+hash", () => {
		const h1 = claimHash("Atoms Are  Append-Only");
		const h2 = claimHash("atoms are append-only");
		expect(h1).toBe(h2);
		expect(atomIdFor("piagents", h1)).toBe(atomIdFor("piagents", h2));
		expect(atomIdFor("piagents", h1)).not.toBe(atomIdFor("other", h1));
		expect(atomIdFor("piagents", h1)).toMatch(/^[0-9a-f]{12}$/);
		expect(normalizeClaim("  A   B\tC ")).toBe("a b c");
	});

	it("identical claims across runs collapse to one draft hash (dedup precondition)", () => {
		const drafts: AtomDraft[] = ruleExtractAtoms([
			candidate("Decision: we will use SQLite for the index.", ["id-1"]),
			candidate("decision: we will use SQLite for the index.", ["id-2"]),
		]);
		expect(drafts).toHaveLength(2);
		const hashes = new Set(drafts.map((d) => claimHash(d.claim)));
		expect(hashes.size).toBe(1); // same content → same hash → dedup collapses on write
	});
});

describe("buildBlocksText", () => {
	it("numbers blocks and carries provenance ids into the prompt", () => {
		const text = buildBlocksText([candidate("alpha content", ["x1"]), candidate("beta content", ["y1", "y2"])]);
		expect(text).toContain("[1] (compaction-observation, entry_ids=x1)");
		expect(text).toContain("[2] (compaction-observation, entry_ids=y1,y2)");
		expect(text).toContain("alpha content");
	});
});
