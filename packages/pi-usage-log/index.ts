import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { appendFileSync, mkdirSync, readFileSync, existsSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { rollupLastDays, loadRegistryProjects, formatBucketLine, DEFAULT_COORDINATOR_DB } from "./project-usage.ts";

const USAGE_DIR = join(homedir(), ".pi", "agent", "usage");

interface UsageRecord {
	ts: string;
	cwd: string;
	session: string;
	/** Additive (Theme D1): human session name, when the session has one. */
	sessionName?: string;
	/** Additive (Theme D1): first line of the most recent user message (<=200 chars) — carries the [project:<name>] tag evidence. */
	task?: string;
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
	// Last user message text (Theme D1): the task the session is currently
	// executing — carries the [project:<name>] tag + alias evidence the
	// per-project attribution needs. First line only, bounded, local-only log.
	let lastUserText: string | undefined;
	pi.on("message_start", (event) => {
		try {
			const m = (event as { message?: { role?: string; content?: unknown } }).message;
			if (!m || m.role !== "user") return;
			const c = m.content;
			const txt = typeof c === "string" ? c : (Array.isArray(c) ? c.map((p) => (p as { text?: string }).text ?? "").join(" ") : "");
			const line = txt.split("\n", 1)[0].replace(/\s+/g, " ").trim();
			lastUserText = line ? (line.length > 200 ? line.slice(0, 199) + "\u2026" : line) : undefined;
		} catch { /* observation only — must never disturb the session */ }
	});

	pi.registerCommand("usage", {
		description: "Show token/cost usage summary from the local usage log",
		handler: async (args, ctx) => {
			// `/usage project [days]` — Theme D1 per-project rollup (default 7 days).
			// Reconciliation of the buckets against the raw JSONL sums is pinned by
			// the package test suite and reported by cli.ts on every run.
			const argv = String(args ?? "").trim().split(/\s+/).filter(Boolean);
			if (argv[0] === "project") {
				const days = Math.max(1, Math.min(90, Number(argv[1]) || 7));
				const registry = loadRegistryProjects(DEFAULT_COORDINATOR_DB);
				const rollup = rollupLastDays(USAGE_DIR, registry, days);
				const lines = [`Per-project usage, last ${days} day(s) (${rollup.since} .. ${rollup.until}):`];
				for (const p of rollup.projects) {
					lines.push(`  ${p.projectId} (${p.displayName}): ${p.tokens.toLocaleString()} tokens, $${p.cost.toFixed(4)}, ${p.turns} turns, ${p.sessions} sessions`);
				}
				lines.push(formatBucketLine("  personal-ops (explicit tag)", rollup.personalOps));
				lines.push(formatBucketLine("  unattributed (no evidence)", rollup.unattributed));
				if (rollup.note) lines.push(`  note: ${rollup.note}`);
				lines.push(formatBucketLine("TOTAL", rollup.totals));
				ctx.ui.sendMessage(lines.join("\n"));
				return;
			}
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
				const key = `${r.session ?? "unknown"} ${r.model ?? "unknown"}`;
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
		// Attribution inputs (Theme D1): cwd (typed field is ctx.cwd; the old
		// ctx.workingDir read produced NO cwd in production records — keep both
		// for forward/backward safety), session id, human session name, and the
		// current task line. Additive fields; old consumers ignore them.
		const ctxAny = ctx as unknown as { cwd?: string; workingDir?: string };
		const sm = ctx.sessionManager as unknown as { getSessionId?: () => string; getSessionName?: () => string | undefined; sessionId?: string };
		let sessionId: string | undefined;
		try { sessionId = sm?.getSessionId?.(); } catch { sessionId = undefined; }
		let sessionName: string | undefined;
		try { sessionName = sm?.getSessionName?.(); } catch { sessionName = undefined; }
		writeLine({
			ts: new Date().toISOString(),
			cwd: ctxAny.cwd ?? ctxAny.workingDir ?? "unknown",
			session: sessionId ?? sm?.sessionId ?? "unknown",
			sessionName,
			task: lastUserText,
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
