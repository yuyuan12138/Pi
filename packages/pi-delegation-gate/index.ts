/**
 * pi-delegation-gate: intercept `fork` tool calls through Pi's `tool_call`
 * event (extensions.md: "`tool_call` can mutate input or block execution";
 * ToolCallEventResult `{ block: true, reason }`).
 *
 * Policy: a fork call is allowed only when its text arguments contain an
 * explicit context-dependency marker `[fork-context: <reason>]`. Allowed calls
 * are logged (one JSON line per fork) to ~/.pi/agent/usage/delegation.jsonl.
 * Blocked calls receive a reason telling the model to prefer a clean-context
 * subagent.
 */
import * as fs from "node:fs";
import * as path from "node:path";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { getAgentDir } from "@earendil-works/pi-coding-agent";
import { decideForkCall, FORK_TOOL_NAME, logEntry } from "./gate.ts";

/** Log path; PI_DELEGATION_GATE_LOG overrides (used by offline tests). */
export function delegationLogPath(): string {
	const override = process.env.PI_DELEGATION_GATE_LOG;
	if (override) return override;
	return path.join(getAgentDir(), "usage", "delegation.jsonl");
}

export default function (pi: ExtensionAPI): void {
	pi.on("tool_call", async (event) => {
		if (event.toolName !== FORK_TOOL_NAME) return undefined;
		const decision = decideForkCall(event.input);
		if (!decision.allowed) {
			return { block: true, reason: decision.reason, terminate: true };
		}
		try {
			const file = delegationLogPath();
			fs.mkdirSync(path.dirname(file), { recursive: true });
			fs.appendFileSync(file, logEntry(decision.reason, event.toolCallId), "utf8");
		} catch (error) {
			// Logging is observability, not enforcement: never fail the allowed fork.
			console.error("pi-delegation-gate: failed to append log:", error);
		}
		return undefined;
	});
}
