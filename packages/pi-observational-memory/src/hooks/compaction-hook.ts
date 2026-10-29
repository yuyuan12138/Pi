import type {
	ExtensionAPI,
	ExtensionContext,
	SessionBeforeCompactEvent,
} from "@earendil-works/pi-coding-agent";

import type { Runtime } from "../runtime.js";
import { buildCompactionProjection, renderSummary, isSourceEntry, latestCoverageIndex,
	OM_OBSERVATIONS_RECORDED, type Entry } from "../session-ledger/index.js";

const DEFAULT_OBSERVATIONS_POOL_MAX_TOKENS = 20_000;

function observationsPoolMaxTokens(runtime: Runtime): number {
	const value = (runtime.config as { observationsPoolMaxTokens?: unknown }).observationsPoolMaxTokens;
	return typeof value === "number" && Number.isFinite(value) && value > 0
		? value
		: DEFAULT_OBSERVATIONS_POOL_MAX_TOKENS;
}

export function registerCompactionHook(pi: ExtensionAPI, runtime: Runtime): void {
	pi.on("session_before_compact", async (event: SessionBeforeCompactEvent, ctx: ExtensionContext) => {
		if (runtime.compactHookInFlight) {
			if (ctx.hasUI) {
				ctx.ui.notify(
					"Observational memory: another compaction is already in progress; cancelling duplicate",
					"warning",
				);
			}
			return { cancel: true };
		}

		runtime.compactHookInFlight = true;
		try {
			runtime.ensureConfig(ctx.cwd, ctx.isProjectTrusted());
			const { preparation, branchEntries } = event;
			const { firstKeptEntryId, tokensBefore } = preparation;
			const entries = branchEntries as Entry[];
			const cut = entries.findIndex(entry => entry.id === firstKeptEntryId);
			if (cut < 0) return;
			let lastDroppedSource = -1;
			for (let index = 0; index < cut; index++) if (isSourceEntry(entries[index])) lastDroppedSource = index;
			// Partial prepared memory must not replace an unobserved source span.
			// Let Pi's native summarizer handle that compaction instead.
			if (latestCoverageIndex(entries, OM_OBSERVATIONS_RECORDED) < lastDroppedSource) return;
			const projection = buildCompactionProjection(
				branchEntries as Entry[],
				firstKeptEntryId,
				{ observationsPoolMaxTokens: observationsPoolMaxTokens(runtime) },
			);
			const summary = renderSummary(projection.reflections, projection.observations);
			if (summary.length === 0) {
				// Decline ownership so Pi's native summarizer preserves the pre-cut context.
				return;
			}

			return {
				compaction: {
					summary,
					firstKeptEntryId,
					tokensBefore,
					details: projection.details,
				},
			};
		} finally {
			runtime.compactHookInFlight = false;
		}
	});
}
