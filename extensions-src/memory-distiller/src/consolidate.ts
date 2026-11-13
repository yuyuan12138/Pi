/**
 * L2 consolidation orchestration (sa52 P1b / Theme B3): reads a project's
 * accumulated atoms/, clusters them by topic (LLM, honest rule degrade),
 * and emits DRAFT concept candidates to
 * knowledge-base/knowledge/concepts/pending-<date>/<slug>-<hash8>.md.
 *
 * Hard guarantees:
 *  - NEVER writes into the approved concepts tree (knowledge/concepts/*.md).
 *    The only writes are inside concepts/pending-<date>/ — compile_kb.py's
 *    non-recursive `concepts.glob("*.md")` never sees them, so the human
 *    approval gate and the scope gate are untouched. A candidate becomes a
 *    concept only when a human moves it out of pending/ after review.
 *  - Candidate frontmatter uses ONLY the vocabulary compile_kb.py already
 *    lints (title/updated/scope/evidence/origin/approval/last_reviewed/
 *    sources) with scope: pending + approval: unreviewed — a promoted
 *    candidate lints clean with zero compile_kb changes, and "no concept
 *    ever auto-promotes" holds structurally (this code has no path to the
 *    approved tree, asserted by tests).
 *  - Contradictions (conflicting claims on the same subject) are surfaced in
 *    a dedicated section of each candidate + the run report, never resolved.
 *  - Candidate file names are content-derived (sha256 of the sorted atom id
 *    set), so a re-run over the same atom set is an idempotent overwrite;
 *    writes are atomic (temp file + rename in the same directory).
 *  - Evidence chains run candidate → atoms → session entries: every cited
 *    atom lists its source_entry_ids (recall-compatible).
 */
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { mkdir, readFile, readdir, rename, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import type { Context, Model } from "@earendil-works/pi-ai";
import {
	buildAtomBlocks,
	boundClusters,
	consolidationSystemPrompt,
	parseLlmClusters,
	ruleClusterAtoms,
} from "./cluster.js";
import type { StreamSimpleFn } from "./extract.js";
import { atomFlagged } from "./atoms-file.js";
import { projectSlugFor, utcDateStamp } from "./atoms-file.js";
import type { Atom, ConceptCluster, ConsolidateRunStats } from "./types.js";

export const DEFAULT_CONSOLIDATE_LLM_TIMEOUT_MS = 45_000;
/** Idle hook fires only with at least this many new atoms since the last run. */
export const DEFAULT_IDLE_MIN_NEW_ATOMS = 40;
/** Minimum hours between idle-triggered consolidations (trigger-storm floor). */
export const DEFAULT_IDLE_MIN_INTERVAL_H = 12;
const MAX_REPORT_CONTRADICTIONS = 40;

export interface ConsolidateDeps {
	cwd: string;
	/** KB root override (defaults to PI_MEMORY_KB_ROOT, else <cwd>/knowledge-base). */
	kbRoot?: string;
	/** Override for the idle-hook state file (tests). */
	statePath?: string;
	now?: Date;
	log?: (...args: unknown[]) => void;
	llmTimeoutMs?: number;
	idleMinNewAtoms?: number;
	idleMinIntervalH?: number;
}

interface ConsolidateStateFile {
	version: 1;
	lastRunTs: string | null;
}

export function kbRootForConsolidation(cwd: string, kbRootOverride?: string): string {
	return kbRootOverride ?? process.env.PI_MEMORY_KB_ROOT ?? path.join(cwd, "knowledge-base");
}

export function defaultConsolidateStatePath(): string {
	return path.join(_homeDotPi(), "memory", "distiller", "consolidate-state.json");
}

function _homeDotPi(): string {
	// Same location scheme as state.ts, test-overridable via deps.statePath.
	const override = process.env.PI_DISTILLER_STATE;
	if (override) return path.join(path.dirname(override), "consolidate-state.json");
	return path.join(os.homedir(), ".pi", "agent", "memory", "distiller", "consolidate-state.json");
}

/** Load every atom in the project's atoms dir (tolerant, deduped, oldest first). */
export async function loadProjectAtoms(atomsDir: string): Promise<{ atoms: Atom[]; parseErrors: number }> {
	const atoms = new Map<string, Atom>();
	let parseErrors = 0;
	if (!existsSync(atomsDir)) return { atoms: [], parseErrors };
	let files: string[] = [];
	try {
		files = (await readdir(atomsDir)).filter((f) => f.endsWith(".jsonl")).sort();
	} catch {
		return { atoms: [], parseErrors };
	}
	for (const f of files) {
		let raw: string;
		try {
			raw = await readFile(path.join(atomsDir, f), "utf8");
		} catch {
			continue;
		}
		for (const line of raw.split("\n")) {
			const t = line.trim();
			if (!t) continue;
			try {
				const rec = JSON.parse(t) as Record<string, unknown>;
				const id = typeof rec.id === "string" ? rec.id : "";
				const claim = typeof rec.claim === "string" ? rec.claim.trim() : "";
				if (!id || !claim) continue;
				if (atoms.has(id)) continue;
				if (matchCredentialPatternOnAtom(claim, rec.evidence)) continue; // screen re-applied at read
				atoms.set(id, {
					schema: 1,
					id,
					kind: (typeof rec.kind === "string" ? rec.kind : "work_fact") as Atom["kind"],
					claim,
					evidence: typeof rec.evidence === "string" ? rec.evidence : "",
					source_entry_ids: Array.isArray(rec.source_entry_ids)
						? rec.source_entry_ids.filter((s): s is string => typeof s === "string")
						: [],
					project: typeof rec.project === "string" ? rec.project : "",
					ts: typeof rec.ts === "string" ? rec.ts : "1970-01-01T00:00:00.000Z",
					source_session: typeof rec.source_session === "string" ? rec.source_session : "",
					origin: rec.origin === "llm" ? "llm" : "rule",
					hash: typeof rec.hash === "string" ? rec.hash : "",
				});
			} catch {
				parseErrors++;
			}
		}
	}
	return {
		atoms: [...atoms.values()].sort((a, b) => a.ts.localeCompare(b.ts)),
		parseErrors,
	};
}

function matchCredentialPatternOnAtom(claim: string, evidence: unknown): boolean {
	try {
		return atomFlagged({ claim, evidence: typeof evidence === "string" ? evidence : "" }) !== null;
	} catch {
		return false;
	}
}

// ---------------------------------------------------------------------------
// Candidate rendering (promotion-ready frontmatter, KNOWN_FIELDS only).
// ---------------------------------------------------------------------------

export function candidateSlug(title: string): string {
	const slug = title
		.toLowerCase()
		.normalize("NFKD")
		.replaceAll(/[^a-z0-9\u4e00-\u9fff]+/g, "-")
		.replace(/^-+|-+$/g, "")
		.slice(0, 48);
	return slug || "candidate";
}

/** Content-derived, stable candidate file name: re-runs overwrite idempotently. */
export function candidateFileName(title: string, atomIds: string[]): string {
	const hash = createHash("sha256").update([...atomIds].sort().join("\u0000")).digest("hex").slice(0, 8);
	return `${candidateSlug(title)}-${hash}.md`;
}

function excerpt(text: string, max: number): string {
	const flat = text.replaceAll(/\s+/g, " ").trim();
	return flat.length <= max ? flat : `${flat.slice(0, max - 1)}…`;
}

/**
 * Render one draft concept candidate. Frontmatter matches the AGENTS.md
 * article format exactly; evidence cites the atoms (file + id + excerpt),
 * sources cite the atom files, and the body carries the full
 * candidate → atom → source_entry_ids chain plus the contradictions section.
 */
export function renderCandidate(
	cluster: ConceptCluster,
	atomById: Map<string, Atom>,
	project: string,
	dateStamp: string,
): string {
	const atoms = cluster.atomIds.map((id) => atomById.get(id)).filter((a): a is Atom => Boolean(a));
	const evidenceItems = [
		...new Set(
			atoms.map((a) => {
				const file = `atoms/${project}/${a.ts.slice(0, 10)}.jsonl`;
				return `project:${project}: ${file} (atom ${a.id}: ${excerpt(a.claim, 60)})`;
			}),
		),
	];
	if (evidenceItems.length === 0) evidenceItems.push(`project:${project}: atoms/${project}/ (see sources)`);
	const sourceFiles = [...new Set(atoms.map((a) => `atoms/${project}/${a.ts.slice(0, 10)}.jsonl`))];
	const sources = sourceFiles.length > 0 ? sourceFiles : [`atoms/${project}/`];

	const lines: string[] = [];
	lines.push("---");
	lines.push(`title: ${cluster.title.replaceAll(/\s+/g, " ").trim()}`);
	lines.push(`updated: ${dateStamp}`);
	lines.push("scope: pending");
	lines.push("origin: ai-generated");
	lines.push("approval: unreviewed");
	lines.push(`last_reviewed: ${dateStamp}`);
	lines.push("evidence:");
	for (const e of evidenceItems) lines.push(`  - ${e}`);
	lines.push("sources:");
	for (const s of sources) lines.push(`  - ${s}`);
	lines.push("---");
	lines.push("");
	lines.push(`# ${cluster.title.replaceAll(/\s+/g, " ").trim()}`);
	lines.push("");
	if (cluster.summary) {
		lines.push(cluster.summary);
		lines.push("");
	}
	lines.push("## Evidence chain (atoms → session entries)");
	lines.push("");
	for (const a of atoms) {
		lines.push(`- \`${a.id}\` (${a.kind}, ${a.ts}, origin=${a.origin}): ${excerpt(a.claim, 300)}`);
		lines.push(
			`  - source_entry_ids: ${a.source_entry_ids.length > 0 ? a.source_entry_ids.join(", ") : "-"} ` +
				`(resolvable via recall(); session ${a.source_session || "-"})`,
		);
	}
	lines.push("");
	lines.push("## Contradictions (surfaced, never auto-resolved)");
	lines.push("");
	if (cluster.contradictions.length === 0) {
		lines.push("None detected in this cluster. Detection is heuristic — absence of a flag is not a guarantee.");
	} else {
		for (const c of cluster.contradictions) {
			lines.push(`- **${c.subject || "shared subject"}**: \`${c.atomA}\` says "${excerpt(c.claimA, 160)}" vs ` +
				`\`${c.atomB}\` says "${excerpt(c.claimB, 160)}".${c.note ? ` (${c.note})` : ""}`);
			lines.push("  - Do not merge these claims; a human must decide which (if either) holds.");
		}
	}
	lines.push("");
	return lines.join("\n");
}

/** Run-report renderer (written as REPORT.md inside the pending dir). */
export function renderReport(stats: ConsolidateRunStats, clusters: ConceptCluster[], project: string): string {
	const lines: string[] = [];
	lines.push(`# Consolidation report — ${project} — ${stats.trigger}`);
	lines.push("");
	lines.push(
		`LLM consolidation run: ${stats.atomsRead} atom(s) read, ${stats.clusters} candidate cluster(s), ` +
			`${stats.contradictions} contradiction(s) surfaced. ${stats.dryRun ? "DRY-RUN — nothing written." : "Candidates written to this directory."}`,
	);
	if (!stats.llmUsed && stats.degradedReason) {
		lines.push("");
		lines.push(`LLM path unavailable (${stats.degradedReason}); conservative rule clustering used instead.`);
	}
	lines.push("");
	lines.push("## Candidates");
	lines.push("");
	for (const c of clusters) {
		lines.push(`- ${c.title} — atoms: ${c.atomIds.join(", ")}`);
	}
	lines.push("");
	lines.push("## Contradictions (surface-only, human gate)");
	lines.push("");
	const all = clusters.flatMap((c) => c.contradictions);
	if (all.length === 0 && stats.unattachedContradictions === 0) {
		lines.push("None detected. Heuristic detection — absence of a flag is not a guarantee.");
	} else {
		for (const c of all.slice(0, MAX_REPORT_CONTRADICTIONS)) {
			lines.push(`- **${c.subject || "shared subject"}**: \`${c.atomA}\` vs \`${c.atomB}\` — "${excerpt(c.claimA, 120)}" vs "${excerpt(c.claimB, 120)}"${c.note ? ` (${c.note})` : ""}`);
		}
		if (stats.unattachedContradictions > 0) {
			lines.push(`- ${stats.unattachedContradictions} contradiction(s) spanned clusters and are listed in neither candidate; review the atoms directly.`);
		}
	}
	lines.push("");
	lines.push(
		"This directory is DRAFT material: promote a file into knowledge/concepts/ only after human review " +
			"(compile_kb.py scope gate applies at promotion; scope: pending stays project-local until certified).",
	);
	lines.push("");
	return lines.join("\n");
}

// ---------------------------------------------------------------------------
// Idempotent atomic write helpers.
// ---------------------------------------------------------------------------

/** Atomic write: temp file + rename in the same directory (kill-safe). */
export async function atomicWrite(filePath: string, content: string): Promise<void> {
	await mkdir(path.dirname(filePath), { recursive: true });
	const tmp = `${filePath}.tmp-${process.pid}`;
	await writeFile(tmp, content, "utf8");
	await rename(tmp, filePath);
}

export function pendingDirFor(kbRoot: string, dateStamp: string): string {
	return path.join(kbRoot, "knowledge", "concepts", `pending-${dateStamp}`);
}

// ---------------------------------------------------------------------------
// State for the idle hook (opt-in; see index.ts).
// ---------------------------------------------------------------------------

export function loadConsolidateState(statePath: string): ConsolidateStateFile {
	try {
		const raw = JSON.parse(readFileSync(statePath, "utf8")) as ConsolidateStateFile;
		if (raw && raw.version === 1) return { version: 1, lastRunTs: raw.lastRunTs ?? null };
	} catch {
		// missing/corrupt: fresh state
	}
	return { version: 1, lastRunTs: null };
}

export function saveConsolidateState(statePath: string, state: ConsolidateStateFile): void {
	mkdirSync(path.dirname(statePath), { recursive: true });
	const tmp = `${statePath}.tmp-${process.pid}`;
	writeFileSync(tmp, JSON.stringify(state, null, "\t") + "\n", "utf8");
	renameSync(tmp, statePath);
}

// ---------------------------------------------------------------------------
// Orchestration.
// ---------------------------------------------------------------------------

export interface ConsolidateRegistryLike {
	streamSimple?: StreamSimpleFn;
	hasConfiguredAuth?: (model: Model<any>) => boolean;
}

export async function runConsolidation(
	deps: ConsolidateDeps,
	opts: {
		dryRun: boolean;
		trigger: string;
		model?: unknown;
		modelRegistry?: ConsolidateRegistryLike | null;
	},
): Promise<ConsolidateRunStats & { clusterList: ConceptCluster[] }> {
	const log = deps.log ?? ((...args: unknown[]) => console.error("[memory-distiller]", ...args));
	const stats: ConsolidateRunStats & { clusterList: ConceptCluster[] } = {
		trigger: opts.trigger,
		dryRun: opts.dryRun,
		llmUsed: false,
		degradedReason: null,
		atomsRead: 0,
		atomsClustered: 0,
		clusters: 0,
		candidates: 0,
		contradictions: 0,
		unattachedContradictions: 0,
		pendingDir: null,
		clusterList: [],
	};

	const project = projectSlugFor(deps.cwd);
	const kbRoot = kbRootForConsolidation(deps.cwd, deps.kbRoot);
	const atomsDir = path.join(kbRoot, "atoms", project);
	const { atoms, parseErrors } = await loadProjectAtoms(atomsDir);
	stats.atomsRead = atoms.length;
	if (parseErrors > 0) log(`consolidation: ${parseErrors} unparseable atom line(s) skipped`);
	if (atoms.length === 0) {
		log(`consolidation: no atoms for project ${project}; nothing to do`);
		return stats;
	}

	// --- clustering: LLM when possible, rules otherwise (fail-open) ---------
	let clusters: ConceptCluster[];
	const model = opts.model as Model<any> | undefined;
	const streamSimple = opts.modelRegistry?.streamSimple;
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
			const context: Context = {
				systemPrompt: consolidationSystemPrompt(),
				messages: [
					{
						role: "user",
						content: `${buildAtomBlocks(atoms)}\n\nConsolidate these atoms into concept topics now. Return [] if nothing clusters.`,
						timestamp: Date.now(),
					},
				],
			};
			const controller = new AbortController();
			const timeoutMs = deps.llmTimeoutMs ?? DEFAULT_CONSOLIDATE_LLM_TIMEOUT_MS;
			let raceTimer: ReturnType<typeof setTimeout> | undefined;
			try {
				const stream = streamSimple(model, context, { signal: controller.signal });
				const message = await Promise.race([
					stream.result(),
					new Promise<never>((_resolve, reject) => {
						raceTimer = setTimeout(() => {
							controller.abort();
							reject(new Error(`consolidation LLM timeout after ${timeoutMs}ms`));
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
				clusters = boundClusters(parseLlmClusters(text, atoms));
				stats.llmUsed = true;
			} finally {
				if (raceTimer) clearTimeout(raceTimer);
				controller.abort();
			}
		} catch (err) {
			stats.degradedReason = `llm-error: ${err instanceof Error ? err.message.slice(0, 140) : String(err)}`;
			log("consolidation LLM failed; degrading to rule clustering:", err);
			clusters = boundClusters(ruleClusterAtoms(atoms));
		}
	} else {
		stats.degradedReason = !model ? "no-model" : !streamSimple ? "no-registry-stream" : "auth-missing";
		clusters = boundClusters(ruleClusterAtoms(atoms));
	}

	const atomById = new Map(atoms.map((a) => [a.id, a]));
	stats.atomsClustered = new Set(clusters.flatMap((c) => c.atomIds)).size;
	stats.clusters = clusters.length;
	stats.clusterList = clusters;
	stats.contradictions = clusters.reduce((n, c) => n + c.contradictions.length, 0);

	// Contradictions spanning two clusters can't be attached to one candidate:
	// count them so the report can point at the atoms directly.
	const clusterOf = new Map<string, number>();
	clusters.forEach((c, i) => {
		for (const id of c.atomIds) clusterOf.set(id, i);
	});
	for (const c of clusters) {
		c.contradictions = c.contradictions.filter(
			(ct) => clusterOf.get(ct.atomA) === clusterOf.get(ct.atomB),
		);
	}
	const attached = clusters.reduce((n, c) => n + c.contradictions.length, 0);
	stats.unattachedContradictions = stats.contradictions - attached;

	// --- write candidates into pending-<date>/ (the ONLY write path) --------
	const now = deps.now ?? new Date();
	const dateStamp = utcDateStamp(now);
	const pendingDir = pendingDirFor(kbRoot, dateStamp);
	stats.pendingDir = pendingDir;
	if (!opts.dryRun) {
		for (const c of clusters) {
			const content = renderCandidate(c, atomById, project, dateStamp);
			await atomicWrite(path.join(pendingDir, candidateFileName(c.title, c.atomIds)), content);
			stats.candidates++;
		}
		await atomicWrite(path.join(pendingDir, "REPORT.md"), renderReport(stats, clusters, project));
		await saveConsolidateState(deps.statePath ?? defaultConsolidateStatePath(), {
			version: 1,
			lastRunTs: now.toISOString(),
		});
	}
	return stats;
}

/** One-line human summary for /distill-consolidate feedback. */
export function formatConsolidateStats(stats: ConsolidateRunStats): string {
	const origin = stats.llmUsed ? "llm" : `rule (${stats.degradedReason ?? "rules"})`;
	const head =
		`memory-distiller consolidate (${stats.trigger}${stats.dryRun ? ", dry-run" : ""}): ` +
		`${stats.atomsRead} atom(s) → ${stats.clusters} candidate cluster(s) via ${origin}, ` +
		`${stats.contradictions} contradiction(s) surfaced`;
	const tail = stats.dryRun ? ". Nothing written." : `. Drafts → ${stats.pendingDir}`;
	return `${head}${tail}`;
}

/** Idle-hook gate: opt-in env, >=minNewAtoms new atoms, >=minInterval since last run. */
export function shouldIdleConsolidate(
	envValue: string | undefined,
	newAtomCount: number,
	state: ConsolidateStateFile,
	now: Date,
	minNewAtoms = DEFAULT_IDLE_MIN_NEW_ATOMS,
	minIntervalH = DEFAULT_IDLE_MIN_INTERVAL_H,
): boolean {
	const enabled = envValue === "1" || envValue === "true" || envValue === "yes";
	if (!enabled) return false;
	const last = state.lastRunTs ? Date.parse(state.lastRunTs) : NaN;
	if (Number.isFinite(last) && now.getTime() - last < minIntervalH * 3600_000) return false;
	return newAtomCount >= minNewAtoms;
}
