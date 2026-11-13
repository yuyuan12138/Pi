/**
 * memory-distiller — pi extension that distills session memory into atoms
 * (B1/sa52 P1a), consolidates atoms into draft concept candidates (B3/sa52
 * P1b), and maintains an injected user profile (B4/sa52 P1c).
 *
 * B1 — distillation: on `session_shutdown` + idle-debounce (60s after the
 * agent settles, canceled by the next turn), the session's NEW distilled
 * text — compaction observations, om.observations.recorded entries, and
 * subagent-report worker records — is extracted into typed memory atoms and
 * appended to knowledge-base/atoms/<project>/<date>.jsonl (append-only,
 * per-atom source_entry_ids provenance, content-hash dedup, credential
 * screening before any write). Provider-neutral LLM extraction goes through
 * the host model registry (ctx.modelRegistry.streamSimple); any LLM failure
 * degrades to conservative rule-based extraction. Watermarked per-file byte
 * offsets (PI_DISTILLER_STATE) mean each delta is read exactly once.
 *
 * B3 — consolidation: `/distill-consolidate` clusters a project's
 * accumulated atoms into DRAFT concept candidates under
 * knowledge-base/knowledge/concepts/pending-<date>/ (scope: pending +
 * approval: unreviewed + atom evidence chains; contradictions surfaced in a
 * dedicated section, never resolved). The approved concepts tree is never
 * written by this extension; compile_kb.py's scope gate stays untouched.
 * An idle-time hook is available but DISABLED by default — opt in with
 * PI_DISTILLER_CONSOLIDATE_IDLE=1 (fires only at >=40 new atoms since the
 * last run and >=12h since the last run).
 *
 * B4 — profile: `/distill-profile` regenerates the ≤2KB preference layer at
 * ~/.pi/agent/memory/profile.md (PI_PROFILE_PATH) from accepted/user-approved
 * records only (KB daily/ + approval:user-approved concepts; atoms are a
 * refresh trigger, never source content), then `before_agent_start` injects
 * it as the bounded `user-profile` system-prompt SECTION (never
 * forceSystemPrompt). Disable injection with PI_PROFILE_INJECT=0.
 *
 * No writes at load time. `/distill --dry-run` reports the planned atoms and
 * writes nothing; the same holds for the consolidate/profile dry-runs.
 *
 * Event names verified against pi 1.5.0 dist/core/extensions/types.d.ts.
 */
import path from "node:path";
import type { ExtensionAPI, ExtensionCommandContext, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { formatRunStats, runDistillation, type DistillRunStats } from "./distill.js";
import {
	formatConsolidateStats,
	kbRootForConsolidation,
	loadConsolidateState,
	loadProjectAtoms,
	runConsolidation,
	shouldIdleConsolidate,
	defaultConsolidateStatePath,
} from "./consolidate.js";
import { atomsDirFor, projectSlugFor } from "./atoms-file.js";
import {
	defaultProfilePath,
	defaultProfileStatePath,
	formatProfileStats,
	loadProfileState,
	profileInjectionEnabled,
	readProfileCached,
	renderProfileSection,
	runProfileRefresh,
	shouldRefreshProfile,
	PROFILE_SECTION_NAME,
	type ProfileCache,
} from "./profile.js";

export const DISTILL_COMMAND = "distill";
export const CONSOLIDATE_COMMAND = "distill-consolidate";
export const PROFILE_COMMAND = "distill-profile";

/** Idle-debounce window; minimum 5s. */
export function idleDebounceMs(): number {
	const raw = Number(process.env.PI_DISTILLER_IDLE_MS);
	if (Number.isFinite(raw) && raw >= 5000) return raw;
	return 60_000;
}

export default function memoryDistillerExtension(pi: ExtensionAPI): void {
	let timer: ReturnType<typeof setTimeout> | null = null;
	let consolidateTimer: ReturnType<typeof setTimeout> | null = null;
	let inFlight: Promise<DistillRunStats | void> | null = null;
	let consolidateInFlight = false;
	let profileInFlight = false;
	let profileCache: ProfileCache | undefined;

	const depsFor = (ctx: ExtensionContext) => ({
		cwd: ctx.sessionManager.getCwd(),
		sessionDir: ctx.sessionManager.getSessionDir(),
		model: ctx.model,
		modelRegistry: ctx.modelRegistry,
	});

	/** Single-flight wrapper: a second trigger joins the in-flight run. */
	const execute = (ctx: ExtensionContext, trigger: string, dryRun: boolean): Promise<DistillRunStats | void> => {
		if (inFlight) return inFlight;
		inFlight = runDistillation(depsFor(ctx), { dryRun, trigger })
			.then((stats) => {
				if (!dryRun && stats.written > 0) {
					console.error(
						`[memory-distiller] ${trigger}: wrote ${stats.written} atom(s) -> ${stats.atomsFile} ` +
							`(origin=${stats.llmUsed ? "llm" : `rule: ${stats.degradedReason ?? "rules"}`})`,
					);
					try {
						pi.appendEntry("memory-distiller.run", {
							trigger,
							written: stats.written,
							atomsFile: stats.atomsFile,
							llmUsed: stats.llmUsed,
							degradedReason: stats.degradedReason,
							duplicates: stats.duplicates,
							credentialsSkipped: stats.credentialsSkipped,
						});
					} catch {
						// shutdown races are fine; the atoms file is the durable record
					}
				}
				return stats;
			})
			.catch((err) => {
				console.error("[memory-distiller] run failed:", err);
			})
			.finally(() => {
				inFlight = null;
			});
		return inFlight;
	};

	// Idle-debounce: arm after the agent settles; a new turn cancels the
	// pending run. The unref'd timer never holds the process open.
	pi.on("agent_settled", (_event, ctx) => {
		if (timer) clearTimeout(timer);
		timer = setTimeout(() => {
			timer = null;
			if (ctx.isIdle() && !inFlight) void execute(ctx, "idle-debounce", false);
		}, idleDebounceMs());
		timer.unref?.();
		armConsolidate(ctx);
	});

	pi.on("agent_start", () => {
		if (timer) {
			clearTimeout(timer);
			timer = null;
		}
		if (consolidateTimer) {
			clearTimeout(consolidateTimer);
			consolidateTimer = null;
		}
	});

	pi.on("session_shutdown", async (event, ctx) => {
		if (timer) {
			clearTimeout(timer);
			timer = null;
		}
		if (consolidateTimer) {
			clearTimeout(consolidateTimer);
			consolidateTimer = null;
		}
		if (inFlight) return; // let the in-flight run finish on its own
		await execute(ctx, `shutdown:${event.reason}`, false);
		await maybeThresholdProfile(ctx);
	});

	pi.registerCommand(DISTILL_COMMAND, {
		description:
			"Distill this session's new observations into memory atoms (memory-distiller). Use --dry-run to preview without writing.",
		handler: async (args: string, ctx: ExtensionCommandContext) => {
			const dryRun = args.trim().split(/\s+/).includes("--dry-run");
			const stats = await execute(ctx, "manual", dryRun);
			if (!stats) {
				ctx.ui.notify("memory-distiller: run failed (see pi stderr)", "error");
				return;
			}
			ctx.ui.notify(formatRunStats(stats), "info");
		},
	});

	// ------------------------------------------------------------------
	// B3: consolidation (command + opt-in idle hook).
	// ------------------------------------------------------------------
	const runConsolidate = async (
		ctx: ExtensionContext | ExtensionCommandContext,
		trigger: string,
		dryRun: boolean,
	): Promise<string> => {
		if (consolidateInFlight) return "memory-distiller: consolidation already in flight";
		consolidateInFlight = true;
		try {
			const deps = depsFor(ctx);
			const stats = await runConsolidation(
				{
					cwd: deps.cwd,
					statePath: defaultConsolidateStatePath(),
				},
				{ dryRun, trigger, model: deps.model, modelRegistry: deps.modelRegistry },
			);
			if (!dryRun && stats.candidates > 0) {
				console.error(
					`[memory-distiller] ${trigger}: wrote ${stats.candidates} candidate(s) -> ${stats.pendingDir} ` +
						`(origin=${stats.llmUsed ? "llm" : `rule: ${stats.degradedReason ?? "rules"}`}, ` +
						`${stats.contradictions} contradiction(s) surfaced)`,
				);
				try {
					pi.appendEntry("memory-distiller.consolidate", {
						trigger,
						candidates: stats.candidates,
						contradictions: stats.contradictions,
						pendingDir: stats.pendingDir,
						llmUsed: stats.llmUsed,
						degradedReason: stats.degradedReason,
					});
				} catch {
					// shutdown races are fine; the pending dir is the durable record
				}
			}
			return formatConsolidateStats(stats);
		} catch (err) {
			console.error("[memory-distiller] consolidation failed:", err);
			return `memory-distiller: consolidation failed: ${err instanceof Error ? err.message : String(err)}`;
		} finally {
			consolidateInFlight = false;
		}
	};

	function armConsolidate(ctx: ExtensionContext): void {
		const idleEnabled = (() => {
			const v = process.env.PI_DISTILLER_CONSOLIDATE_IDLE;
			return v === "1" || v === "true" || v === "yes";
		})();
		if (!idleEnabled || consolidateInFlight) return;
		if (consolidateTimer) clearTimeout(consolidateTimer);
		consolidateTimer = setTimeout(() => {
			consolidateTimer = null;
			if (!ctx.isIdle()) return;
			void (async () => {
				try {
					const deps = depsFor(ctx);
					const kbRoot = kbRootForConsolidation(deps.cwd);
					const { atoms } = await loadProjectAtoms(atomsDirFor(kbRoot, projectSlugFor(deps.cwd)));
					const state = loadConsolidateState(defaultConsolidateStatePath());
					const last = state.lastRunTs ? Date.parse(state.lastRunTs) : 0;
					const newCount = atoms.filter((a) => Date.parse(a.ts) > last).length;
					if (!shouldIdleConsolidate(process.env.PI_DISTILLER_CONSOLIDATE_IDLE, newCount, state, new Date())) {
						return;
					}
					await runConsolidate(ctx, "idle-consolidate", false);
				} catch (err) {
					console.error("[memory-distiller] idle consolidation check failed:", err);
				}
			})();
		}, idleDebounceMs());
		consolidateTimer.unref?.();
	}

	pi.registerCommand(CONSOLIDATE_COMMAND, {
		description:
			"Consolidate this project's memory atoms into DRAFT concept candidates in " +
			"knowledge-base/knowledge/concepts/pending-<date>/ (scope: pending, approval: unreviewed; " +
			"contradictions surfaced, never resolved; the approved concepts tree is never written). " +
			"Use --dry-run to preview without writing.",
		handler: async (args: string, ctx: ExtensionCommandContext) => {
			const dryRun = args.trim().split(/\s+/).includes("--dry-run");
			ctx.ui.notify(await runConsolidate(ctx, "manual", dryRun), "info");
		},
	});

	// ------------------------------------------------------------------
	// B4: profile refresh (command + threshold trigger) + injection.
	// ------------------------------------------------------------------
	const runProfile = async (
		ctx: ExtensionContext | ExtensionCommandContext,
		trigger: string,
		dryRun: boolean,
	): Promise<string> => {
		if (profileInFlight) return "memory-distiller: profile refresh already in flight";
		profileInFlight = true;
		try {
			const deps = depsFor(ctx);
			const stats = await runProfileRefresh(
				{
					kbRoot: kbRootForConsolidation(deps.cwd),
					statePath: defaultProfileStatePath(),
				},
				{ dryRun, trigger, model: deps.model, modelRegistry: deps.modelRegistry },
			);
			if (!dryRun && stats.wrote) {
				console.error(`[memory-distiller] ${trigger}: profile refreshed -> ${stats.profilePath}`);
				try {
					pi.appendEntry("memory-distiller.profile", {
						trigger,
						bytes: stats.bytes,
						sourcesUsed: stats.sourcesUsed,
						llmUsed: stats.llmUsed,
						degradedReason: stats.degradedReason,
					});
				} catch {
					// shutdown races are fine; the profile file is the durable record
				}
			}
			return formatProfileStats(stats);
		} catch (err) {
			console.error("[memory-distiller] profile refresh failed:", err);
			return `memory-distiller: profile refresh failed: ${err instanceof Error ? err.message : String(err)}`;
		} finally {
			profileInFlight = false;
		}
	};

	pi.registerCommand(PROFILE_COMMAND, {
		description:
			"Regenerate the ≤2KB user preference profile (~/.pi/agent/memory/profile.md) from accepted/" +
			"user-approved knowledge-base records only. It is injected as a bounded system-prompt section " +
			"(disable with PI_PROFILE_INJECT=0). Use --dry-run to preview without writing.",
		handler: async (args: string, ctx: ExtensionCommandContext) => {
			const dryRun = args.trim().split(/\s+/).includes("--dry-run");
			ctx.ui.notify(await runProfile(ctx, "manual", dryRun), "info");
		},
	});

	// Threshold-triggered refresh (sa52 PersonaTrigger P4 port): checked at
	// shutdown; fires only when >=K new preference atoms appeared since the
	// last refresh or the profile is stale/missing. PI_PROFILE_INJECT=0 is
	// the kill switch for the whole auto side; the manual command still works.
	async function maybeThresholdProfile(ctx: ExtensionContext): Promise<void> {
		if (!profileInjectionEnabled() || profileInFlight) return;
		try {
			const deps = depsFor(ctx);
			const kbRoot = kbRootForConsolidation(deps.cwd);
			const profilePath = defaultProfilePath();
			const state = loadProfileState(defaultProfileStatePath());
			const { atoms } = await loadProjectAtoms(atomsDirFor(kbRoot, projectSlugFor(deps.cwd)));
			const prefs = atoms.filter((a) => a.kind === "preference");
			if (shouldRefreshProfile(profilePath, state, prefs, new Date())) {
				await runProfile(ctx, "threshold", false);
			}
		} catch (err) {
			console.error("[memory-distiller] profile threshold check failed:", err);
		}
	}

	// Injection: a bounded, mtime-cached `user-profile` SECTION via
	// systemPromptOptions (never the forceSystemPrompt override — that would
	// replace the whole prompt and break cacheability/transcript sections).
	pi.on("before_agent_start", (event) => {
		if (!profileInjectionEnabled()) return;
		const profilePath = defaultProfilePath();
		const { text, cache } = readProfileCached(profileCache, profilePath);
		profileCache = cache;
		if (!text) return;
		event.systemPromptOptions.sections[PROFILE_SECTION_NAME] = renderProfileSection(text);
	});
}
