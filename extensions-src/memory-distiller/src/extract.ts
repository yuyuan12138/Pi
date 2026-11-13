/**
 * Atom extraction from scanned candidates.
 *
 * LLM path: one provider-neutral nested call through the host model registry
 * (ctx.modelRegistry.streamSimple — the same composed runtime the session
 * uses, so custom providers keep working). The prompt encodes the sa52/Tencent
 * extraction discipline: better-none-than-junk, self-contained claims, merge
 * related observations, only-from-provided-text, closed kind set, mandatory
 * per-atom provenance. Any failure (no model, missing auth, transport error,
 * timeout, unparseable output) degrades to the rule-based path.
 *
 * Rule path: conservative keyword gating over the SAME candidate text. The
 * claim is always a verbatim sentence from the source — selection, never
 * fabrication. Nothing in either path invents content.
 */
import { createHash } from "node:crypto";
import type { AssistantMessageEventStream, Context, Model, SimpleStreamOptions } from "@earendil-works/pi-ai";
import { ATOM_KINDS, type AtomKind, type Candidate, type AtomDraft } from "./types.js";

export type StreamSimpleFn = (
	model: Model<any>,
	context: Context,
	options?: SimpleStreamOptions,
) => AssistantMessageEventStream;

export const MAX_LLM_BLOCKS = 40;
export const MAX_ATOMS_PER_RUN = 24;
export const MAX_CLAIM_CHARS = 600;
export const MIN_CLAIM_CHARS = 16;
export const DEFAULT_LLM_TIMEOUT_MS = 45_000;

/** Normalize a claim into the dedup key form. */
export function normalizeClaim(claim: string): string {
	return claim.trim().toLowerCase().replaceAll(/\s+/g, " ");
}

/** Content-hash of a claim (the dedup key; case/whitespace insensitive). */
export function claimHash(claim: string): string {
	return createHash("sha256").update(normalizeClaim(claim)).digest("hex");
}

/** Stable atom id: derived from project + content hash. */
export function atomIdFor(project: string, hash: string): string {
	return createHash("sha256").update(`atom\u0000${project}\u0000${hash}`).digest("hex").slice(0, 12);
}

const SYSTEM_PROMPT = `You extract durable memory atoms from a coding session's distilled observations and worker reports.

Discipline:
- Better none than junk. Extract only statements that stay true and useful outside this conversation.
- Atoms must be self-contained: no "the user", "this session", or block numbers inside the claim text.
- Merge strongly related observations into one atom and list all source block numbers in "sources".
- Use only information present in the observations. Never invent facts, names, numbers, paths, or dates.
- kind must be exactly one of: preference | decision | constraint | work_fact | work_task | work_method | work_artifact.

Output a JSON array only (no prose, no code fences), possibly empty:
[{"kind":"decision","claim":"...","evidence":"short supporting quote or empty string","sources":[1,2]}]`;

/** Render candidates as numbered, provenance-stamped blocks for the model. */
export function buildBlocksText(candidates: Candidate[]): string {
	const parts: string[] = [];
	const n = Math.min(candidates.length, MAX_LLM_BLOCKS);
	for (let i = 0; i < n; i++) {
		const c = candidates[i]!;
		const ids = c.sourceEntryIds.join(",") || "-";
		parts.push(`[${i + 1}] (${c.source}, entry_ids=${ids})\n${c.text}`);
	}
	return parts.join("\n\n");
}

/**
 * Parse + validate the model's JSON array into drafts. Tolerates code fences
 * and leading prose (first "[" to last "]"). Every surviving draft has a
 * valid closed-set kind, a bounded non-empty claim, and resolvable
 * provenance; drafts without provenance are dropped, never guessed.
 */
export function parseLlmAtoms(text: string, candidates: Candidate[]): AtomDraft[] {
	const start = text.indexOf("[");
	const end = text.lastIndexOf("]");
	if (start === -1 || end <= start) throw new Error("no JSON array in model output");
	const parsed: unknown = JSON.parse(text.slice(start, end + 1));
	if (!Array.isArray(parsed)) throw new Error("model output is not an array");
	const drafts: AtomDraft[] = [];
	for (const item of parsed) {
		if (!item || typeof item !== "object" || Array.isArray(item)) continue;
		const rec = item as Record<string, unknown>;
		const kind = rec.kind;
		const claim = typeof rec.claim === "string" ? rec.claim.trim() : "";
		if (!claim || claim.length < MIN_CLAIM_CHARS || claim.length > MAX_CLAIM_CHARS) continue;
		if (typeof kind !== "string" || !ATOM_KINDS.includes(kind as AtomKind)) continue;
		const sources = Array.isArray(rec.sources)
			? rec.sources.filter(
					(s): s is number => typeof s === "number" && Number.isInteger(s) && s >= 1 && s <= candidates.length,
				)
			: [];
		if (sources.length === 0 && candidates.length === 1) sources.push(1);
		if (sources.length === 0) continue; // provenance is mandatory
		const ids = new Set<string>();
		for (const s of sources) {
			for (const id of candidates[s - 1]!.sourceEntryIds) ids.add(id);
		}
		if (ids.size === 0) continue;
		const evidence = typeof rec.evidence === "string" ? rec.evidence.trim().slice(0, MAX_CLAIM_CHARS) : "";
		drafts.push({
			kind: kind as AtomKind,
			claim,
			evidence,
			sourceEntryIds: [...ids],
			sessionUuid: candidates[sources[0]! - 1]!.sessionUuid,
			origin: "llm",
		});
	}
	return drafts;
}

/**
 * One provider-neutral LLM call. Bounded by an abort signal AND a hard race
 * timer; throws on transport errors, non-"stop" stop reasons, timeouts, and
 * unparseable output (caller degrades to rules).
 */
export async function llmExtractAtoms(
	candidates: Candidate[],
	opts: { model: Model<any>; streamSimple: StreamSimpleFn; timeoutMs?: number },
): Promise<AtomDraft[]> {
	const timeoutMs = opts.timeoutMs ?? DEFAULT_LLM_TIMEOUT_MS;
	const controller = new AbortController();
	let raceTimer: ReturnType<typeof setTimeout> | undefined;
	try {
		const context: Context = {
			systemPrompt: SYSTEM_PROMPT,
			messages: [
				{
					role: "user",
					content: `${buildBlocksText(candidates)}\n\nExtract atoms now. Return [] if nothing durable.`,
					timestamp: Date.now(),
				},
			],
		};
		const stream = opts.streamSimple(opts.model, context, { signal: controller.signal });
		const message = await Promise.race([
			stream.result(),
			new Promise<never>((_resolve, reject) => {
				raceTimer = setTimeout(() => {
					controller.abort();
					reject(new Error(`distiller LLM timeout after ${timeoutMs}ms`));
				}, timeoutMs);
			}),
		]);
		if (message.stopReason !== "stop") {
			throw new Error(message.errorMessage || `unexpected model stopReason=${message.stopReason}`);
		}
		const text = message.content
			.filter((c): c is { type: "text"; text: string } => c.type === "text")
			.map((c) => c.text)
			.join("");
		return parseLlmAtoms(text, candidates);
	} finally {
		if (raceTimer) clearTimeout(raceTimer);
		controller.abort(); // no-op once the request settled; prevents orphans on timeout
	}
}

interface RulePattern {
	kind: AtomKind;
	re: RegExp;
}

/**
 * Conservative trigger patterns; the matched sentence itself becomes the
 * claim. Word boundaries are placed per-alternative: a trailing \b after a
 * punctuation-ending alternative ("decision:") can never match, and \b
 * around CJK alternatives never matches (Han chars are non-word in JS
 * regex), so ASCII alternatives carry explicit boundaries and CJK ones none.
 */
const RULES: RulePattern[] = [
	{ kind: "decision", re: /(?:\bdecided to\b|\bdecision\s*[:：]|\bwe (?:will |'ll )?(?:use|adopt|switch to|switched to)\b|拍板|决定采用)/i },
	{ kind: "preference", re: /(?:\bprefer(?:s|ence)?\b|\balways use\b|\bnever use\b|偏好|更喜欢)/i },
	{ kind: "constraint", re: /(?:\bconstraint\b|\bmust not\b|\bcannot be\b|\bhard requirement\b|不得|不能|必须)/i },
	{ kind: "work_fact", re: /(?:\blearned that\b|\bdiscovered that\b|\bturns out\b|\bTIL\b|\bit (?:is|was) actually\b)/i },
	{ kind: "work_task", re: /(?:\btodo\s*[:：]|\bnext step\b|\bfollow-?up\s*[:：]|待办|下一步)/i },
	{ kind: "work_method", re: /(?:\bworkflow\s*[:：]|\brecipe\s*[:：]|\bhow to\b|\bmethod\s*[:：]|步骤是|流程是)/i },
	{ kind: "work_artifact", re: /(?:\bdeliverable\b|\bartifact\s*[:：]|产出物?)/i },
];

/**
 * Rule-based extraction: keyword-gated SELECTION of verbatim source sentences.
 * Guaranteed fabrication-free (claim ⊆ source text) and bounded per run.
 */
export function ruleExtractAtoms(candidates: Candidate[]): AtomDraft[] {
	const drafts: AtomDraft[] = [];
	for (const c of candidates) {
		if (drafts.length >= MAX_ATOMS_PER_RUN) break;
		for (const rawSentence of c.text.split(/(?<=[。！？.!?])\s+|\n+/)) {
			if (drafts.length >= MAX_ATOMS_PER_RUN) break;
			const sentence = rawSentence.trim().replaceAll(/\s+/g, " ");
			if (sentence.length < MIN_CLAIM_CHARS || sentence.length > 400) continue;
			const rule = RULES.find((r) => r.re.test(sentence));
			if (!rule) continue;
			drafts.push({
				kind: rule.kind,
				claim: sentence,
				evidence: "",
				sourceEntryIds: [...c.sourceEntryIds],
				sessionUuid: c.sessionUuid,
				origin: "rule",
			});
		}
	}
	return drafts;
}
