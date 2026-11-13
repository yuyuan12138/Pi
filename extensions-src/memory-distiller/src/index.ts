/**
 * memory-distiller — pi extension that distills session memory into atoms.
 *
 * sa52 P1a (Theme B1): on `session_shutdown` + idle-debounce (60s after the
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
 * No writes at load time. `/distill` runs the same pass manually;
 * `/distill --dry-run` reports the planned atoms and writes nothing.
 *
 * Event names verified against pi 1.5.0 dist/core/extensions/types.d.ts.
 */
import type { ExtensionAPI, ExtensionCommandContext, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { formatRunStats, runDistillation, type DistillRunStats } from "./distill.js";

export const DISTILL_COMMAND = "distill";

/** Idle-debounce window; minimum 5s. */
export function idleDebounceMs(): number {
	const raw = Number(process.env.PI_DISTILLER_IDLE_MS);
	if (Number.isFinite(raw) && raw >= 5000) return raw;
	return 60_000;
}

export default function memoryDistillerExtension(pi: ExtensionAPI): void {
	let timer: ReturnType<typeof setTimeout> | null = null;
	let inFlight: Promise<DistillRunStats | void> | null = null;

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
	});

	pi.on("agent_start", () => {
		if (timer) {
			clearTimeout(timer);
			timer = null;
		}
	});

	pi.on("session_shutdown", async (event, ctx) => {
		if (timer) {
			clearTimeout(timer);
			timer = null;
		}
		if (inFlight) return; // let the in-flight run finish on its own
		await execute(ctx, `shutdown:${event.reason}`, false);
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
}
