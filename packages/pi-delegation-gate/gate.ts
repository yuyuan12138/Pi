/**
 * Delegation gate: pure policy logic, isolated for offline unit testing.
 *
 * A `fork` tool call must carry an explicit context-dependency justification,
 * e.g. `[fork-context: needs live conversation state X]`, inside its text
 * arguments. Without it the gate rejects the call and points the model at a
 * clean-context subagent instead (fork copies the entire primary conversation
 * into the child; see ~/.pi/agent/AGENTS.md delegation policy).
 */

export const FORK_TOOL_NAME = "fork";
export const FORK_CONTEXT_MARKER = /\[fork-context:\s*([^\]]+?)\s*\]/;

export interface ForkGateDecision {
	allowed: boolean;
	/** Justification text when allowed, or rejection message when blocked. */
	reason: string;
}

export function extractForkReason(input: unknown): string | undefined {
	if (typeof input !== "object" || input === null) return undefined;
	let reason: string | undefined;
	for (const value of Object.values(input as Record<string, unknown>)) {
		if (typeof value !== "string") continue;
		const match = value.match(FORK_CONTEXT_MARKER);
		if (match?.[1]?.trim() && reason === undefined) {
			reason = match[1].trim();
		}
	}
	return reason;
}

export function decideForkCall(input: unknown): ForkGateDecision {
	const reason = extractForkReason(input);
	if (reason) return { allowed: true, reason };
	return {
		allowed: false,
		reason:
			"Delegation gate: fork copies the full primary conversation into the child. " +
			"State the concrete live-context dependency by including " +
			"[fork-context: <reason>] in the fork task, or use a clean-context " +
			"subagent instead (preferred when a written brief suffices).",
	};
}

export function logEntry(reason: string, toolCallId: string): string {
	return (
		JSON.stringify({
			timestamp: new Date().toISOString(),
			tool: FORK_TOOL_NAME,
			toolCallId,
			reason,
		}) + "\n"
	);
}
