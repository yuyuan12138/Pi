/**
 * L2 consolidation logic: topic clustering + contradiction surfacing over
 * atoms (sa52 P1b / Theme B3).
 *
 * Two paths, same discipline as L1 extraction:
 *  - LLM path: one provider-neutral call proposes topic clusters and
 *    contradictions. Contradictions (conflicting claims on the same subject)
 *    are surfaced, NEVER resolved — the prompt forbids picking a winner or
 *    blending claims.
 *  - Rule path (honest degrade): greedy Jaccard clustering over significant
 *    tokens, and a conservative negation-polarity heuristic for
 *    contradictions. Advisory by construction: every contradiction is a
 *    pointer to two real atoms for a human to judge.
 *
 * This module is pure: no filesystem, no clock — everything testable.
 */
import type { Atom, ConceptCluster, Contradiction } from "./types.js";

export const MAX_CLUSTER_INPUT = 80;
export const MAX_CLUSTERS_PER_RUN = 12;
export const MAX_TITLE_CHARS = 80;
export const MAX_SUMMARY_CHARS = 600;
export const MAX_NOTE_CHARS = 300;
/** Jaccard threshold for the rule-based greedy clustering. */
export const RULE_JACCARD_THRESHOLD = 0.3;

const SYSTEM_PROMPT = `You consolidate durable memory atoms into draft concept topics for a human-reviewed knowledge base.

Discipline:
- Cluster atoms by topic: one cluster = one durable concept a human could review as a single article.
- Better fewer well-supported clusters than many tiny ones. Do not invent topics or force atoms together.
- Use only information present in the atoms. Never invent facts, names, numbers, paths, or dates.
- CONTRADICTIONS: when two atoms make conflicting claims about the same subject, do NOT pick a winner and do NOT blend them into one claim. List the pair as a contradiction; the human decides.
- summary: 1-3 self-contained sentences faithful to the atoms in the cluster.

Output a JSON array only (no prose, no code fences), possibly empty:
[{"title":"...","summary":"...","atoms":[1,2],"contradictions":[{"atoms":[1,2],"subject":"...","note":"why these conflict"}]}]`;

export function consolidationSystemPrompt(): string {
	return SYSTEM_PROMPT;
}

/** Render atoms as numbered blocks for the consolidation model call. */
export function buildAtomBlocks(atoms: Atom[]): string {
	const parts: string[] = [];
	const n = Math.min(atoms.length, MAX_CLUSTER_INPUT);
	for (let i = 0; i < n; i++) {
		const a = atoms[i]!;
		parts.push(`[${i + 1}] (id=${a.id} kind=${a.kind} ts=${a.ts})\n${a.claim}`);
	}
	return parts.join("\n\n");
}

export interface RawClusterParse {
	title?: unknown;
	summary?: unknown;
	atoms?: unknown;
	contradictions?: unknown;
}

/**
 * Parse + validate the model's cluster array. Every surviving cluster has a
 * bounded non-empty title, >=1 valid atom index, and contradictions whose
 * atom references resolve to real atoms (dropped otherwise, never guessed).
 */
export function parseLlmClusters(text: string, atoms: Atom[]): ConceptCluster[] {
	const start = text.indexOf("[");
	const end = text.lastIndexOf("]");
	if (start === -1 || end <= start) throw new Error("no JSON array in model output");
	const parsed: unknown = JSON.parse(text.slice(start, end + 1));
	if (!Array.isArray(parsed)) throw new Error("model output is not an array");
	const clusters: ConceptCluster[] = [];
	for (const item of parsed.slice(0, MAX_CLUSTERS_PER_RUN)) {
		if (!item || typeof item !== "object" || Array.isArray(item)) continue;
		const rec = item as RawClusterParse;
		const title = typeof rec.title === "string" ? rec.title.trim().slice(0, MAX_TITLE_CHARS) : "";
		const summary = typeof rec.summary === "string" ? rec.summary.trim().slice(0, MAX_SUMMARY_CHARS) : "";
		if (!title) continue;
		const indexes = Array.isArray(rec.atoms)
			? rec.atoms.filter(
					(s): s is number => typeof s === "number" && Number.isInteger(s) && s >= 1 && s <= atoms.length,
				)
			: [];
		if (indexes.length === 0) continue; // a cluster with no atoms is nothing
		const atomIds = [...new Set(indexes.map((i) => atoms[i - 1]!.id))];
		const contradictions: Contradiction[] = [];
		if (Array.isArray(rec.contradictions)) {
			for (const c of rec.contradictions.slice(0, 8)) {
				if (!c || typeof c !== "object" || Array.isArray(c)) continue;
				const cr = c as Record<string, unknown>;
				const cIndexes = Array.isArray(cr.atoms)
					? cr.atoms.filter(
							(s): s is number => typeof s === "number" && Number.isInteger(s) && s >= 1 && s <= atoms.length,
						)
					: [];
				if (cIndexes.length < 2) continue; // a contradiction needs two sides
				const ia = cIndexes[0]!;
				const ib = cIndexes[1]!;
				if (ia === ib) continue;
				const atomA = atoms[ia - 1]!;
				const atomB = atoms[ib - 1]!;
				contradictions.push({
					atomA: atomA.id,
					atomB: atomB.id,
					claimA: atomA.claim,
					claimB: atomB.claim,
					subject:
						typeof cr.subject === "string" ? cr.subject.trim().slice(0, MAX_TITLE_CHARS) : sharedSubject(atomA, atomB),
					note: typeof cr.note === "string" ? cr.note.trim().slice(0, MAX_NOTE_CHARS) : "",
				});
			}
		}
		clusters.push({ title, summary, atomIds, contradictions });
	}
	return clusters;
}

// ---------------------------------------------------------------------------
// Rule path: deterministic, conservative, fabrication-free.
// ---------------------------------------------------------------------------

const STOPWORDS = new Set([
	"the","and","for","with","this","that","from","are","was","were","not","but","has","have","had","its","their",
	"when","then","than","into","only","over","also","use","used","using","uses","must","should","can","will","been",
	"being","them","they","there","here","what","which","while","after","before","during","between","because","about",
	"under","above","each","any","all","one","two","new","per","via","out","off","own","same","such","very","just",
	"never","always","cannot","don","doesn","isn","aren","won","shouldn","wouldn","couldn",
]);

/**
 * Significant tokens for clustering: ASCII words >=3 chars (stopwords removed)
 * plus CJK character bigrams (Pi conversations are Chinese-heavy; single Han
 * chars are too ambiguous, so adjacent-pair bigrams carry the topical signal).
 */
export function tokenizeForClustering(text: string): string[] {
	const tokens: string[] = [];
	const ascii = text.toLowerCase().match(/[a-z0-9][a-z0-9_-]{2,}/g) ?? [];
	for (const w of ascii) if (!STOPWORDS.has(w)) tokens.push(w);
	const cjk = text.match(/[\u4e00-\u9fff]+/g) ?? [];
	for (const run of cjk) {
		const chars = [...run];
		for (let i = 0; i + 1 < chars.length; i++) tokens.push(chars[i]! + chars[i + 1]!);
	}
	return tokens;
}

function jaccard(a: Set<string>, b: Set<string>): number {
	if (a.size === 0 || b.size === 0) return 0;
	let inter = 0;
	for (const t of a) if (b.has(t)) inter++;
	return inter / (a.size + b.size - inter);
}

/** Greedy agglomerative clustering in atom order (oldest first). */
export function ruleClusterAtoms(atoms: Atom[]): ConceptCluster[] {
	const ordered = [...atoms].sort((a, b) => a.ts.localeCompare(b.ts));
	const tokenSets = ordered.map((a) => new Set(tokenizeForClustering(a.claim)));
	const groups: number[][] = [];
	for (let i = 0; i < ordered.length; i++) {
		let best = -1;
		let bestScore = 0;
		for (let g = 0; g < groups.length; g++) {
			let score = 0;
			for (const j of groups[g] ?? []) {
				score = Math.max(score, jaccard(tokenSets[i]!, tokenSets[j]!));
				if (score >= RULE_JACCARD_THRESHOLD) break;
			}
			if (score > bestScore) {
				bestScore = score;
				best = g;
			}
		}
		if (best >= 0 && bestScore >= RULE_JACCARD_THRESHOLD) groups[best]!.push(i);
		else groups.push([i]);
	}
	return groups
		.slice(0, MAX_CLUSTERS_PER_RUN)
		.map((g) => {
			const members = g.map((i) => ordered[i]!);
			return {
				title: ruleClusterTitle(members),
				summary: "",
				atomIds: members.map((a) => a.id),
				contradictions: ruleFindContradictions(members),
			};
		});
}

/** Deterministic title from the most frequent significant tokens. */
export function ruleClusterTitle(members: Atom[]): string {
	const freq = new Map<string, number>();
	for (const a of members) {
		for (const t of new Set(tokenizeForClustering(a.claim))) freq.set(t, (freq.get(t) ?? 0) + 1);
	}
	const top = [...freq.entries()]
		.sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]))
		.slice(0, 3)
		.map(([t]) => t);
	return (top.join(", ") || "uncategorized").slice(0, MAX_TITLE_CHARS);
}

const NEG_RE = /\b(?:never|not|cannot|can't|mustn'?t|don'?t|do not|no longer|stopped)\b|不(?:得|能|要|再)|禁止/i;

/**
 * Conservative contradiction heuristic for the rule path: two atoms that
 * share a significant subject token where exactly one claim is negated
 * (e.g. "never use X" vs "we use X"). Deliberately over-cautious: false
 * positives are acceptable (a human reviews every contradiction); misses on
 * subtler conflicts are a disclosed limitation of the degrade path.
 */
export function ruleFindContradictions(members: Atom[]): Contradiction[] {
	const out: Contradiction[] = [];
	for (let i = 0; i < members.length; i++) {
		for (let j = i + 1; j < members.length; j++) {
			const a = members[i]!;
			const b = members[j]!;
			const negA = NEG_RE.test(a.claim);
			const negB = NEG_RE.test(b.claim);
			if (negA === negB) continue; // same polarity: not a conflict signal
			const tokensA = new Set(tokenizeForClustering(a.claim));
			const tokensB = new Set(tokenizeForClustering(b.claim));
			const shared = [...tokensA].filter((t) => tokensB.has(t));
			if (shared.length === 0) continue;
			out.push({
				atomA: a.id,
				atomB: b.id,
				claimA: a.claim,
				claimB: b.claim,
				subject: shared.slice(0, 3).join(", "),
				note: "rule heuristic: shared subject with opposing polarity — human review required",
			});
			if (out.length >= 8) return out;
		}
	}
	return out;
}

/** Shared significant tokens between two claims (subject fallback). */
export function sharedSubject(a: Atom, b: Atom): string {
	const ta = new Set(tokenizeForClustering(a.claim));
	const tb = new Set(tokenizeForClustering(b.claim));
	const shared = [...ta].filter((t) => tb.has(t));
	return shared.slice(0, 3).join(", ");
}

/** Cap clusters to a bounded, deterministic slice. */
export function boundClusters(clusters: ConceptCluster[]): ConceptCluster[] {
	return clusters.slice(0, MAX_CLUSTERS_PER_RUN);
}
