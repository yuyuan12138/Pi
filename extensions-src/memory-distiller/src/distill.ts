/**
 * Orchestration: scan → extract (LLM, degrade to rules) → dedup by content
 * hash → credential screen → append-only write → watermark save.
 *
 * Invariants:
 *  - Dry-run performs everything EXCEPT the file write and the watermark
 *    save: no bytes change anywhere, and a later real run re-reads the same
 *    delta.
 *  - Watermarks are committed only after a successful run; a kill between
 *    the atom append and the watermark save causes one re-read whose
 *    content-hash dedup drops the already-written atoms.
 *  - B1 writes atoms (append-only JSONL) and the state file (atomic rename)
 *    only. There are no concept writes and no in-place state, so a kill
 *    mid-run can never leave a partial concept edit.
 */
import path from "node:path";
import type { Model } from "@earendil-works/pi-ai";
import { DistillerState, type LastRunSummary } from "./state.js";
import { scanSessionDeltas } from "./scan.js";
import {
	llmExtractAtoms,
	ruleExtractAtoms,
	MAX_ATOMS_PER_RUN,
	type StreamSimpleFn,
} from "./extract.js";
import {
	appendAtomsToFile,
	atomFlagged,
	atomsDirFor,
	atomsFileFor,
	loadKnownKeys,
	materializeAtom,
	projectSlugFor,
	utcDateStamp,
} from "./atoms-file.js";
import type { Atom, AtomDraft, DistillRunStats } from "./types.js";
export type { DistillRunStats } from "./types.js";

/** Duck-typed subset of pi's ExtensionContext.modelRegistry. */
export interface RegistryLike {
	streamSimple?: StreamSimpleFn;
	hasConfiguredAuth?: (model: Model<any>) => boolean;
}

export interface DistillDeps {
	cwd: string;
	sessionDir: string | undefined;
	model?: unknown;
	modelRegistry?: RegistryLike | null;
	/** KB root override (defaults to PI_MEMORY_KB_ROOT, else <cwd>/knowledge-base). */
	kbRoot?: string;
	statePath?: string;
	now?: Date;
	log?: (...args: unknown[]) => void;
	idleLlmTimeoutMs?: number;
	shutdownLlmTimeoutMs?: number;
}

export function kbRootForCwd(cwd: string, kbRootOverride?: string): string {
	return kbRootOverride ?? process.env.PI_MEMORY_KB_ROOT ?? path.join(cwd, "knowledge-base");
}

function shortError(message: string): string {
	return message.length > 160 ? `${message.slice(0, 157)}...` : message;
}

/** Bounded lastRun projection of the run stats (the fields worth persisting). */
function lastRunSummary(stats: DistillRunStats, at: Date): LastRunSummary {
	return {
		at: at.toISOString(),
		trigger: stats.trigger,
		scanned: stats.filesScanned,
		written: stats.written,
		llmUsed: stats.llmUsed,
		degradedReason: stats.degradedReason,
		atomsFile: stats.atomsFile,
	};
}

export async function runDistillation(
	deps: DistillDeps,
	opts: { dryRun: boolean; trigger: string },
): Promise<DistillRunStats> {
	const log = deps.log ?? ((...args: unknown[]) => console.error("[memory-distiller]", ...args));
	const stats: DistillRunStats = {
		trigger: opts.trigger,
		dryRun: opts.dryRun,
		filesScanned: 0,
		filesChanged: 0,
		candidates: 0,
		parseErrors: 0,
		llmUsed: false,
		degradedReason: null,
		extracted: 0,
		duplicates: 0,
		credentialsSkipped: 0,
		written: 0,
		atomsFile: null,
	};

	const state = new DistillerState(deps.statePath);
	state.load();
	const now = deps.now ?? new Date();
	if (!deps.sessionDir) {
		log("no session dir; nothing to distill");
		return stats;
	}

	const scan = scanSessionDeltas(deps.sessionDir, state);
	stats.filesScanned = scan.filesScanned;
	stats.filesChanged = scan.filesChanged;
	stats.candidates = scan.candidates.length;
	stats.parseErrors = scan.parseErrors;

	const commitWatermarks = () => {
		for (const [filePath, wm] of scan.newWatermarks) state.setWatermark(filePath, wm);
		// Persist the bounded run diagnostics with the same atomic save (additive
		// key). Dry-runs never reach this, so they still write nothing anywhere;
		// the no-session-dir early return above also stays write-free.
		state.setLastRun(lastRunSummary(stats, now));
		state.save();
	};

	if (scan.candidates.length === 0) {
		if (!opts.dryRun) commitWatermarks(); // advance past processed lines even with zero yield
		return stats;
	}

	const project = projectSlugFor(deps.cwd);
	const kbRoot = kbRootForCwd(deps.cwd, deps.kbRoot);
	const atomsDir = atomsDirFor(kbRoot, project);

	// --- extraction: LLM when possible, rules otherwise (fail-open) ---------
	let drafts: AtomDraft[];
	const model = deps.model as Model<any> | undefined;
	const streamSimple = deps.modelRegistry?.streamSimple;
	let authOk = false;
	if (model && streamSimple && typeof deps.modelRegistry?.hasConfiguredAuth === "function") {
		try {
			authOk = deps.modelRegistry.hasConfiguredAuth(model);
		} catch {
			authOk = false;
		}
	}
	if (model && streamSimple && authOk) {
		const timeoutMs = opts.trigger.startsWith("shutdown")
			? (deps.shutdownLlmTimeoutMs ?? 12_000)
			: (deps.idleLlmTimeoutMs ?? 45_000);
		try {
			drafts = await llmExtractAtoms(scan.candidates, { model, streamSimple, timeoutMs });
			stats.llmUsed = true;
		} catch (err) {
			stats.degradedReason = `llm-error: ${shortError(err instanceof Error ? err.message : String(err))}`;
			log("LLM extraction failed; degrading to rule-based extraction:", err);
			drafts = ruleExtractAtoms(scan.candidates);
		}
	} else {
		stats.degradedReason = !model ? "no-model" : !streamSimple ? "no-registry-stream" : "auth-missing";
		drafts = ruleExtractAtoms(scan.candidates);
	}

	// --- materialize + dedup + credential screen ----------------------------
	const known = await loadKnownKeys(atomsDir);
	const seenHashes = new Set(known.hashes);
	const seenIds = new Set(known.ids);
	const toWrite: Atom[] = [];
	for (const draft of drafts.slice(0, MAX_ATOMS_PER_RUN)) {
		const atom = materializeAtom(draft, project, now);
		if (seenHashes.has(atom.hash) || seenIds.has(atom.id)) {
			stats.duplicates++;
			continue;
		}
		const flagged = atomFlagged(atom);
		if (flagged) {
			stats.credentialsSkipped++;
			continue;
		}
		seenHashes.add(atom.hash);
		seenIds.add(atom.id);
		toWrite.push(atom);
	}
	stats.extracted = toWrite.length;

	// --- write + commit watermarks (dry-run: neither) -----------------------
	if (!opts.dryRun) {
		if (toWrite.length > 0) {
			const file = atomsFileFor(kbRoot, project, utcDateStamp(now));
			await appendAtomsToFile(file, toWrite);
			stats.written = toWrite.length;
			stats.atomsFile = file;
		}
		commitWatermarks();
	}
	return stats;
}

/** One-line human summary for /distill feedback and tests. */
export function formatRunStats(stats: DistillRunStats): string {
	const origin = stats.llmUsed
		? "llm"
		: stats.degradedReason
			? `rule (${stats.degradedReason})`
			: "rule";
	const head = `memory-distiller (${stats.trigger}${stats.dryRun ? ", dry-run" : ""}): ` +
		`${stats.candidates} candidate(s) from ${stats.filesChanged} changed file(s) → ` +
		`${stats.extracted} atom(s) via ${origin}`;
	const tail = stats.dryRun
		? ". Nothing written."
		: stats.atomsFile
			? `. Appended to ${stats.atomsFile}.`
			: ". No new atoms.";
	const extras: string[] = [];
	if (stats.duplicates > 0) extras.push(`${stats.duplicates} duplicate(s) dropped`);
	if (stats.credentialsSkipped > 0) extras.push(`${stats.credentialsSkipped} credential-flagged skipped`);
	if (stats.parseErrors > 0) extras.push(`${stats.parseErrors} unparsed line(s)`);
	return `${head}${extras.length ? ` [${extras.join(", ")}]` : ""}${tail}`;
}
