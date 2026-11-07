/**
 * Tokenization for the memory FTS index.
 *
 * FTS5 `unicode61` does not segment CJK text: a run of Chinese characters
 * becomes one giant token and only exact-run matches hit. Both supported
 * modes therefore pre-segment text on the write side AND on the query side
 * into a space-joined `tokens` string that unicode61 indexes verbatim
 * (the same write-side/query-side alignment used by TencentDB-Agent-Memory's
 * core/store/tokenize.ts).
 *
 * Modes:
 *  - "jieba":  @node-rs/jieba cutForSearch (lazy import; native module).
 *  - "bigram": dependency-free fallback — overlapping CJK bigrams, ASCII
 *              words kept whole. Disclosed degraded CJK recall (some CJK
 *              two-character words share no bigram with the query).
 *
 * The mode used at write time is recorded in the DB `meta` table; a mismatch
 * on a later open triggers a full re-tokenize from stored `content`.
 */

export type TokenizerMode = "jieba" | "bigram";

export interface Tokenizer {
	readonly mode: TokenizerMode;
	/** Tokenize arbitrary text into the space-joined FTS `tokens` form. */
	tokenize(text: string): Promise<string>;
}

const CJK_RUN = /[\p{Script=Han}\p{Script=Hiragana}\p{Script=Katakana}\p{Script=Hangul}]+/gu;

/** Internal segmentation of one contiguous CJK run into tokens. */
function bigramTokens(run: string): string[] {
	if (run.length <= 1) return [run];
	const out: string[] = [];
	for (let i = 0; i < run.length - 1; i++) out.push(run.slice(i, i + 2));
	return out;
}

/**
 * Split text into the space-joined token form without jieba: CJK runs become
 * overlapping bigrams, everything else is left as whitespace-separated words.
 */
export function bigramTokenize(text: string): string {
	const parts: string[] = [];
	let last = 0;
	for (const m of text.matchAll(CJK_RUN)) {
		const before = text.slice(last, m.index);
		if (before.trim()) parts.push(...before.trim().split(/\s+/));
		parts.push(...bigramTokens(m[0]));
		last = m.index + m[0].length;
	}
	const tail = text.slice(last);
	if (tail.trim()) parts.push(...tail.trim().split(/\s+/));
	return parts.filter(Boolean).join(" ");
}

/** Lazy holder for the jieba module; import failure is cached as `null`. */
let jiebaPromise: Promise<{ cutForSearch(s: string): string[] } | null> | null = null;

async function loadJieba(): Promise<{ cutForSearch(s: string): string[] } | null> {
	if (!jiebaPromise) {
		jiebaPromise = (async () => {
			try {
				const mod: any = await import("@node-rs/jieba");
				const jieba = mod.default ?? mod;
				if (typeof jieba?.cutForSearch !== "function") return null;
				// Smoke-test the native binding once; a broken install must fall
				// back instead of poisoning the index with thrown errors.
				const probe = jieba.cutForSearch("记忆索引");
				return Array.isArray(probe) ? jieba : null;
			} catch {
				return null;
			}
		})();
	}
	return jiebaPromise;
}

/** Probe which tokenizer mode is available without holding a Tokenizer. */
export async function detectTokenizerMode(): Promise<TokenizerMode> {
	return (await loadJieba()) ? "jieba" : "bigram";
}

/** Create the process-wide tokenizer. Jieba is preferred, bigram is the fallback. */
export async function createTokenizer(): Promise<Tokenizer> {
	const jieba = await loadJieba();
	if (jieba) {
		return {
			mode: "jieba",
			async tokenize(text: string): Promise<string> {
				try {
					return jieba
						.cutForSearch(text)
						.map((t) => t.trim())
						.filter(Boolean)
						.join(" ");
				} catch {
					return bigramTokenize(text);
				}
			},
		};
	}
	return { mode: "bigram", tokenize: async (text) => bigramTokenize(text) };
}
