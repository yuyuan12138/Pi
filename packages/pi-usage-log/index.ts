import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { appendFileSync, mkdirSync, readFileSync, existsSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

const USAGE_DIR = join(homedir(), ".pi", "agent", "usage");

interface UsageRecord {
	ts: string;
	cwd: string;
	session: string;
	turn: number;
	model: string;
	stopReason: string;
	tokens: { input: number; output: number; cacheRead: number; cacheWrite: number; total: number };
	cost: number;
	tools: string[];
	contextPercent: number | null;
}

function dayFile(): string {
	const now = new Date();
	const day = now.toISOString().slice(0, 10);
	return join(USAGE_DIR, `${day}.jsonl`);
}

function writeLine(record: UsageRecord): void {
	try {
		mkdirSync(USAGE_DIR, { recursive: true });
		appendFileSync(dayFile(), JSON.stringify(record) + "\n", "utf8");
	} catch {
		// Monitoring must never break the session.
	}
}

export default function usageLog(pi: ExtensionAPI): void {
	pi.registerCommand("usage", {
		description: "Show token/cost usage summary from the local usage log",
		handler: async (_args, ctx) => {
			const file = dayFile();
			if (!existsSync(file)) {
				ctx.ui.sendMessage(`No usage records yet today (${file} does not exist).`);
				return;
			}
			const lines = readFileSync(file, "utf8").split("\n").filter(Boolean);
			const sessions = new Map<string, { turns: number; total: number; cost: number; tools: number; model: string }>();
			let grandTotal = 0;
			let grandCost = 0;
			for (const line of lines) {
				let r: UsageRecord;
				try {
					r = JSON.parse(line) as UsageRecord;
				} catch {
					continue;
				}
				const key = `${r.session} ${r.model}`;
				const s = sessions.get(key) ?? { turns: 0, total: 0, cost: 0, tools: 0, model: r.model };
				s.turns += 1;
				s.total += r.tokens.total;
				s.cost += r.cost;
				s.tools += r.tools?.length ?? 0;
				sessions.set(key, s);
				grandTotal += r.tokens.total;
				grandCost += r.cost;
			}
			const rows = [...sessions.entries()]
				.sort((a, b) => b[1].total - a[1].total)
				.map(([key, s]) => `${key}: ${s.turns} turns, ${s.total.toLocaleString()} tokens, ${s.tools} tool calls, $${s.cost.toFixed(4)}`);
			ctx.ui.sendMessage(
				[`Usage today (${file}):`, ...rows, `TOTAL: ${grandTotal.toLocaleString()} tokens, $${grandCost.toFixed(4)}`].join("\n"),
			);
		},
	});

	pi.on("turn_end", (event, ctx) => {
		const message = event.message as {
			model?: string;
			usage?: { input: number; output: number; cacheRead: number; cacheWrite: number; totalTokens: number; cost?: { total?: number } };
			stopReason?: string;
		};
		if (!message.usage) return;
		const tools = (event.toolResults ?? []).map((r: { toolName?: string }) => r.toolName ?? "unknown");
		writeLine({
			ts: new Date().toISOString(),
			cwd: ctx.workingDir,
			session: ctx.sessionManager.sessionId ?? "unknown",
			turn: event.turnIndex,
			model: message.model ?? String(ctx.model ?? "unknown"),
			stopReason: message.stopReason ?? "unknown",
			tokens: {
				input: message.usage.input,
				output: message.usage.output,
				cacheRead: message.usage.cacheRead,
				cacheWrite: message.usage.cacheWrite,
				total: message.usage.totalTokens,
			},
			cost: message.usage.cost?.total ?? 0,
			tools,
			contextPercent: ctx.getContextUsage()?.percent ?? null,
		});
	});
}
