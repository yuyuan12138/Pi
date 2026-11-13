/**
 * L3 user-profile layer (sa52 P1c / Theme B4): a ≤2KB auto-maintained
 * preference file at ~/.pi/agent/memory/profile.md (PI_PROFILE_PATH),
 * injected into every run as a `before_agent_start` prompt SECTION
 * (event.systemPromptOptions.sections["user-profile"] — never
 * forceSystemPrompt, per the sa52 spec; pi 1.5.0
 * dist/core/extensions/types.d.ts BeforeAgentStartEventBase.systemPromptOptions:
 * "Mutable prompt sections. Later handlers observe mutations made by earlier
 * handlers.").
 *
 * Source discipline (the load-bearing guarantee):
 *  - The generator reads ONLY accepted/approved records: knowledge-base
 *    daily/ entries (the accepted-results log by KB convention) and
 *    knowledge/concepts/*.md whose frontmatter carries
 *    `approval: user-approved`. Pending/unreviewed concepts are skipped.
 *  - Atoms are NEVER profile source content (AI-extracted, potentially
 *    unverified worker claims). They appear only as the refresh TRIGGER:
 *    new preference-kind atoms since the last refresh cross the threshold.
 *  - The prompt forbids deriving preferences from rejected approaches or
 *    worker-originated claims, and the rule fallback emits only verbatim
 *    sentences from the accepted corpus (selection, never fabrication).
 *
 * Updates are regenerate-and-replace (atomic temp+rename), never appends —
 * re-running cannot duplicate or grow the file. The injection reads the file
 * with an mtime cache and re-applies the 2KB budget defensively every turn.
 */
import { existsSync, mkdirSync, readFileSync, renameSync, statSync, writeFileSync } from "node:fs";
import { mkdir, readFile, readdir, rename, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import type { AssistantMessageEventStream, Context, Model, SimpleStreamOptions } from "@earendil-works/pi-ai";
import type { ProfileRunStats } from "./types.js";

export const MAX_PROFILE_BYTES = 2048;
export const PROFILE_SECTION_NAME = "user-profile";
export const DEFAULT_PROFILE_STALE_DAYS = 30;
export const DEFAULT_PROFILE_MIN_NEW_ATOMS = 15;
const MAX_SOURCE_BLOCKS = 60;
const MAX_SOURCE_BLOCK_CHARS = 4000;
const DEFAULT_LLM_TIMEOUT_MS = 45_000;
const RULE_MAX_PREFERENCES = 8;

export type StreamSimpleFn = (
	model: Model<any>,
	context: Context,
	options?: SimpleStreamOptions,
) => AssistantMessageEventStream;

export function defaultProfilePath(): string {
	if (process.env.PI_PROFILE_PATH) return process.env.PI_PROFILE_PATH;
	return path.join(os.homedir(), ".pi", "agent", "memory", "profile.md");
}

/** Injection kill switch: "0"/"false"/"no" disables section injection. */
export function profileInjectionEnabled(): boolean {
	const v = process.env.PI_PROFILE_INJECT;
	return !(v === "0" || v === "false" || v === "no");
}

export interface ProfileDeps {
	kbRoot: string;
	profilePath?: string;
	/** Override for the refresh-state file (tests). */
	statePath?: string;
	now?: Date;
	log?: (...args: unknown[]) => void;
	llmTimeoutMs?: number;
}

interface ProfileStateFile {
	version: 1;
	lastRefreshTs: string | null;
}

export function defaultProfileStatePath(): string {
	const override = process.env.PI_DISTILLER_STATE;
	if (override) return path.join(path.dirname(override), "profile-state.json");
	return path.join(os.homedir(), ".pi", "agent", "memory", "distiller", "profile-state.json");
}

// ---------------------------------------------------------------------------
// Source corpus: accepted/approved records ONLY.
// ---------------------------------------------------------------------------

export interface ProfileSourceBlock {
	text: string;
	source: string;
}

/** Minimal frontmatter scanner: returns the raw meta map or null. */
export function parseFrontmatter(text: string): Map<string, string | string[]> | null {
	const m = /^---\r?\n([\s\S]*?)\r?\n---/.exec(text);
	if (!m) return null;
	const meta = new Map<string, string | string[]>();
	let currentList: string | null = null;
	for (const line of m[1]!.split(/\r?\n/)) {
		if (/^\s*- /.test(line)) {
			const key = currentList ?? "sources";
			const list = meta.get(key);
			const value = line.replace(/^\s*- /, "").trim();
			if (Array.isArray(list)) list.push(value);
			else meta.set(key, [value]);
			continue;
		}
		const idx = line.indexOf(":");
		if (idx > 0) {
			const key = line.slice(0, idx).trim();
			const value = line.slice(idx + 1).trim();
			meta.set(key, value);
			currentList = value === "" ? key : null;
		}
	}
	return meta;
}

/** A concept qualifies as a profile source ONLY when user-approved. */
export function conceptIsUserApproved(text: string): boolean {
	const meta = parseFrontmatter(text);
	if (!meta) return false;
	return meta.get("approval") === "user-approved";
}

/**
 * Assemble the accepted-record corpus: every daily/ entry + every
 * `approval: user-approved` concept. Newest daily files first, bounded.
 */
export async function collectProfileSources(kbRoot: string): Promise<ProfileSourceBlock[]> {
	const blocks: ProfileSourceBlock[] = [];
	const dailyDir = path.join(kbRoot, "daily");
	if (existsSync(dailyDir)) {
		let files: string[] = [];
		try {
			files = (await readdir(dailyDir)).filter((f) => f.endsWith(".md")).sort().reverse();
		} catch {
			files = [];
		}
		for (const f of files) {
			if (blocks.length >= MAX_SOURCE_BLOCKS) break;
			try {
				const raw = await readFile(path.join(dailyDir, f), "utf8");
				blocks.push({
					text: raw.slice(0, MAX_SOURCE_BLOCK_CHARS),
					source: `daily/${f}`,
				});
			} catch {
				continue;
			}
		}
	}
	const conceptsDir = path.join(kbRoot, "knowledge", "concepts");
	if (existsSync(conceptsDir)) {
		let files: string[] = [];
		try {
			files = (await readdir(conceptsDir)).filter((f) => f.endsWith(".md")).sort();
		} catch {
			files = [];
		}
		for (const f of files) {
			if (blocks.length >= MAX_SOURCE_BLOCKS) break;
			try {
				const raw = await readFile(path.join(conceptsDir, f), "utf8");
				// The gate: unreviewed/pending concepts NEVER reach the generator.
				if (!conceptIsUserApproved(raw)) continue;
				blocks.push({
					text: raw.slice(0, MAX_SOURCE_BLOCK_CHARS),
					source: `knowledge/concepts/${f} (user-approved)`,
				});
			} catch {
				continue;
			}
		}
	}
	return blocks;
}

// ---------------------------------------------------------------------------
// Generators: LLM first, verbatim-sentence rule fallback.
// ---------------------------------------------------------------------------

const PROFILE_SYSTEM_PROMPT = `You maintain a compact user-profile for a coding agent: stable USER preferences only.

Extract ONLY durable preferences about how the user wants work done:
- Language and communication style (e.g. deliverable language, verbosity).
- Working style (e.g. reports, review gates, delegation expectations).
- Standing workflow choices the user has made.

Hard rules:
- Use only the provided records. Never invent preferences.
- A lesson about a rejected technical approach is NOT a user preference. Never record rejected hypotheses, failed experiments, or worker/engineer claims as preferences.
- Worker- or agent-originated statements are NOT user preferences unless the record clearly shows the user decided or approved them.
- Keep each bullet short, imperative, and self-contained ("Deliverables: English unless asked otherwise").

Output markdown only, no code fences, this exact shape and nothing else:
# User profile
- Language: ...
- Style: ...
- Workflow: ...
Maximum 1200 characters.`;

export function profileSystemPrompt(): string {
	return PROFILE_SYSTEM_PROMPT;
}

function buildSourceText(blocks: ProfileSourceBlock[]): string {
	return blocks
		.slice(0, MAX_SOURCE_BLOCKS)
		.map((b) => `### ${b.source}\n${b.text}`)
		.join("\n\n");
}

/** Parse the model's markdown output into a bounded profile body. */
export function parseProfileMarkdown(text: string): string {
	let body = text.trim();
	const fence = /```(?:markdown)?\r?\n([\s\S]*?)```/.exec(body);
	if (fence) body = fence[1]!.trim();
	if (!/^#\s+User profile\b/m.test(body)) {
		// Tolerate a missing header: prepend the canonical one.
		body = `# User profile\n${body.replace(/^#+\s*User profile.*$/gim, "").trim()}`;
	}
	return body;
}

const PREFERENCE_SENTENCE =
	/\b(?:prefer(?:s|ence)?\b|\balways use\b|\bnever use\b|\buser (?:wants|requires|asked|decided|chose)\b|偏好|更喜欢|要求)/i;

/** Rule fallback: verbatim preference sentences from the accepted corpus. */
export function ruleGenerateProfile(blocks: ProfileSourceBlock[]): string {
	const lines: string[] = ["# User profile"];
	let count = 0;
	for (const b of blocks) {
		if (count >= RULE_MAX_PREFERENCES) break;
		for (const sentence of b.text.split(/(?<=[。！？.!?])\s+|\n+/)) {
			if (count >= RULE_MAX_PREFERENCES) break;
			const s = sentence.trim().replaceAll(/\s+/g, " ");
			if (s.length < 16 || s.length > 200) continue;
			if (!PREFERENCE_SENTENCE.test(s)) continue;
			lines.push(`- ${s} (source: ${b.source})`);
			count++;
		}
	}
	return lines.join("\n");
}

/** Enforce the ≤2KB budget at a line boundary, appending an honest marker. */
export function enforceProfileBudget(body: string, maxBytes = MAX_PROFILE_BYTES): string {
	const buf = Buffer.from(body, "utf8");
	if (buf.length <= maxBytes) return body;
	const marker = `\n<!-- truncated to ${maxBytes} bytes budget -->`;
	const room = maxBytes - Buffer.byteLength(marker, "utf8");
	const cut = body.lastIndexOf("\n", room);
	const truncated = cut > 0 ? body.slice(0, cut) : Buffer.from(body, "utf8").subarray(0, Math.max(room, 0)).toString("utf8");
	return `${truncated}${marker}`;
}

async function llmGenerateProfile(
	blocks: ProfileSourceBlock[],
	opts: { model: Model<any>; streamSimple: StreamSimpleFn; timeoutMs?: number },
): Promise<string> {
	const timeoutMs = opts.timeoutMs ?? DEFAULT_LLM_TIMEOUT_MS;
	const controller = new AbortController();
	let raceTimer: ReturnType<typeof setTimeout> | undefined;
	try {
		const context: Context = {
			systemPrompt: PROFILE_SYSTEM_PROMPT,
			messages: [
				{
					role: "user",
					content: `${buildSourceText(blocks)}\n\nGenerate the user profile now.`,
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
					reject(new Error(`profile LLM timeout after ${timeoutMs}ms`));
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
		const parsed = parseProfileMarkdown(text);
		if (parsed.replace(/^#\s+User profile\s*$/m, "").trim().length < 8) {
			throw new Error("profile output had no usable content");
		}
		return parsed;
	} finally {
		if (raceTimer) clearTimeout(raceTimer);
		controller.abort();
	}
}

// ---------------------------------------------------------------------------
// State + threshold trigger (port of PersonaTrigger P4, simplified).
// ---------------------------------------------------------------------------

export function loadProfileState(statePath: string): ProfileStateFile {
	try {
		const raw = JSON.parse(readFileSync(statePath, "utf8")) as ProfileStateFile;
		if (raw && raw.version === 1) return { version: 1, lastRefreshTs: raw.lastRefreshTs ?? null };
	} catch {
		// missing/corrupt: fresh
	}
	return { version: 1, lastRefreshTs: null };
}

export function saveProfileState(statePath: string, state: ProfileStateFile): void {
	mkdirSync(path.dirname(statePath), { recursive: true });
	const tmp = `${statePath}.tmp-${process.pid}`;
	writeFileSync(tmp, JSON.stringify(state, null, "\t") + "\n", "utf8");
	renameSync(tmp, statePath);
}

/**
 * Threshold trigger: refresh when the profile is missing, stale
 * (>30 days), or >=minNewAtoms preference-kind atoms appeared since the
 * last refresh. Atoms are a TRIGGER only, never source content.
 */
export function shouldRefreshProfile(
	profilePath: string,
	state: ProfileStateFile,
	preferenceAtoms: { ts: string }[],
	now: Date,
	staleDays = DEFAULT_PROFILE_STALE_DAYS,
	minNewAtoms = DEFAULT_PROFILE_MIN_NEW_ATOMS,
): boolean {
	try {
		const st = statSync(profilePath);
		const last = state.lastRefreshTs ? Date.parse(state.lastRefreshTs) : st.mtimeMs;
		if (now.getTime() - last > staleDays * 86400_000) return true;
		const cutoff = Number.isFinite(last) ? new Date(last).toISOString() : new Date(st.mtimeMs).toISOString();
		return preferenceAtoms.filter((a) => a.ts > cutoff).length >= minNewAtoms;
	} catch {
		return true; // missing/unreadable profile: refresh
	}
}

// ---------------------------------------------------------------------------
// Orchestration.
// ---------------------------------------------------------------------------

export interface ProfileRegistryLike {
	streamSimple?: StreamSimpleFn;
	hasConfiguredAuth?: (model: Model<any>) => boolean;
}

export async function runProfileRefresh(
	deps: ProfileDeps,
	opts: {
		dryRun: boolean;
		trigger: string;
		model?: unknown;
		modelRegistry?: ProfileRegistryLike | null;
	},
): Promise<ProfileRunStats> {
	const log = deps.log ?? ((...args: unknown[]) => console.error("[memory-distiller]", ...args));
	const stats: ProfileRunStats = {
		trigger: opts.trigger,
		dryRun: opts.dryRun,
		llmUsed: false,
		degradedReason: null,
		sourcesUsed: 0,
		bytes: 0,
		wrote: false,
		profilePath: deps.profilePath ?? defaultProfilePath(),
	};

	const blocks = await collectProfileSources(deps.kbRoot);
	stats.sourcesUsed = blocks.length;
	if (blocks.length === 0) {
		log("profile: no accepted-record sources found; leaving any existing profile untouched");
		return stats;
	}

	const model = opts.model as Model<any> | undefined;
	const streamSimple = opts.modelRegistry?.streamSimple;
	let body: string;
	let authOk = false;
	if (model && streamSimple && typeof opts.modelRegistry?.hasConfiguredAuth === "function") {
		try {
			authOk = opts.modelRegistry.hasConfiguredAuth(model);
		} catch {
			authOk = false;
		}
	}
	if (model && streamSimple && authOk) {
		try {
			body = await llmGenerateProfile(blocks, { model, streamSimple, timeoutMs: deps.llmTimeoutMs });
			stats.llmUsed = true;
		} catch (err) {
			stats.degradedReason = `llm-error: ${err instanceof Error ? err.message.slice(0, 140) : String(err)}`;
			log("profile LLM failed; degrading to verbatim rule selection:", err);
			body = ruleGenerateProfile(blocks);
		}
	} else {
		stats.degradedReason = !model ? "no-model" : !streamSimple ? "no-registry-stream" : "auth-missing";
		body = ruleGenerateProfile(blocks);
	}

	body = enforceProfileBudget(body);
	stats.bytes = Buffer.byteLength(body, "utf8");

	if (!opts.dryRun && stats.profilePath) {
		await mkdir(path.dirname(stats.profilePath), { recursive: true });
		const tmp = `${stats.profilePath}.tmp-${process.pid}`;
		await writeFile(tmp, body + "\n", "utf8");
		await rename(tmp, stats.profilePath);
		stats.wrote = true;
		await saveProfileState(deps.statePath ?? defaultProfileStatePath(), {
			version: 1,
			lastRefreshTs: (deps.now ?? new Date()).toISOString(),
		});
	}
	return stats;
}

export function formatProfileStats(stats: ProfileRunStats): string {
	const origin = stats.llmUsed ? "llm" : `rule (${stats.degradedReason ?? "rules"})`;
	const head =
		`memory-distiller profile (${stats.trigger}${stats.dryRun ? ", dry-run" : ""}): ` +
		`${stats.sourcesUsed} accepted-record source(s) → ${stats.bytes}B via ${origin}`;
	const tail = stats.dryRun ? ". Nothing written." : stats.wrote ? `. Wrote ${stats.profilePath}.` : ". No write.";
	return `${head}${tail}`;
}

// ---------------------------------------------------------------------------
// Injection (before_agent_start): mtime-cached read + defensive re-cap.
// ---------------------------------------------------------------------------

export interface ProfileCache {
	path: string;
	mtimeMs: number;
	text: string | null;
}

/** Read the profile with an mtime cache; returns null when absent/empty. */
export function readProfileCached(cache: ProfileCache | undefined, profilePath: string): { text: string | null; cache: ProfileCache } {
	try {
		const st = statSync(profilePath);
		if (cache && cache.path === profilePath && cache.mtimeMs === Math.floor(st.mtimeMs)) {
			return { text: cache.text, cache };
		}
		const raw = readFileSync(profilePath, "utf8").trim();
		const text = raw ? enforceProfileBudget(raw) : null;
		return { text, cache: { path: profilePath, mtimeMs: Math.floor(st.mtimeMs), text } };
	} catch {
		return { text: null, cache: { path: profilePath, mtimeMs: 0, text: null } };
	}
}

/**
 * The exact string injected as the `user-profile` system-prompt section.
 * Bounded by construction; the header states the provenance discipline so
 * the model treats it as fallible context, not instructions.
 */
export function renderProfileSection(text: string): string {
	const capped = enforceProfileBudget(text);
	return `<user_profile>\n${capped}\n</user_profile>\n\n` +
		"(Auto-maintained preference layer distilled from accepted/user-approved records. " +
		"Treat as fallible context: verify against newer user statements when they conflict.)";
}
