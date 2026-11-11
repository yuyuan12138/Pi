import { spawn } from "node:child_process";
import { existsSync, readFileSync, realpathSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { StringEnum } from "@earendil-works/pi-ai";
import { Type } from "typebox";
import { REPORT_TOOL, SubagentManager, truncate } from "./manager.ts";
import type { SpawnFn, SubagentInfo } from "./types.ts";
import type { Exec } from "../types.ts";

const text = (t: string) => ({ content: [{ type: "text" as const, text: t }], details: undefined });

export const CHILD_GUIDE = `You are a background subagent working for a main agent. The main agent does NOT see your transcript, tool calls or intermediate output — only what you send with ${REPORT_TOOL} and your final message.
- Call ${REPORT_TOOL} at milestones only: status "progress" after a meaningful step (not every tool call), "blocked" with a concrete question when you cannot continue without a decision, "ready" when the task is done, "failed" or "dropped" if it cannot or need not be done. Keep summaries to 1-3 sentences.
- Never ask the user questions directly; nobody is watching your session.
- You may delegate bounded sub-tasks with subagent_spawn when that helps (the per-agent spawn budget applies; a refusal error means stop spawning, not retry).
- Finish with a concise final answer (what you did, key findings, file paths). That final message is the result the main agent receives.`;

/** Inside a subagent process: report tool + reporting rules. */
export function registerSubagentChild(pi: ExtensionAPI) {
  pi.registerTool({
    name: REPORT_TOOL,
    label: "Report to parent",
    description: "Send a short milestone report to the main agent that spawned you (progress, blocked + question, ready, failed, dropped).",
    promptSnippet: "Send a brief milestone report to the main agent",
    parameters: Type.Object({
      status: StringEnum(["progress", "blocked", "ready", "failed", "dropped"] as const),
      summary: Type.String({ description: "1-3 sentences" }),
      question: Type.Optional(Type.String({ description: "For blocked: one concrete question for the main agent/user" })),
    }),
    async execute() { return text("Reported to main agent."); },
  });
  pi.on("before_agent_start", async (event) => ({ systemPrompt: event.systemPrompt + "\n\n" + CHILD_GUIDE }));
}

const fmt = (i: SubagentInfo) => {
  const last = i.reports.at(-1);
  return `${i.id} [${i.state}] ${i.label}${i.model ? ` (${i.model})` : ""} · tools:${i.toolCalls}${last ? ` · last report ${last.status}: ${last.summary}` : ""}${i.worktree ? ` · worktree ${i.worktree}` : ""}${i.session ? ` · session ${i.session}` : ""} · depth ${i.depth}${i.spawnedBy.length ? ` · spawned_by ${i.spawnedBy.join(" > ")}` : ""}`;
};

/** In the user's interactive session: spawn/steer/stop/read background subagents. */
export function registerSubagentParent(pi: ExtensionAPI, opts: { spawn?: SpawnFn; maxConcurrent?: number } = {}) {
  let mgr: SubagentManager | undefined;
  let ui: ExtensionContext["ui"] | undefined;
  const extensionPath = fileURLToPath(new URL("../index.ts", import.meta.url));
  const exec: Exec = async (c, a, o) => { const r = await pi.exec(c, a, o); return { stdout: r.stdout, stderr: r.stderr, code: r.code }; };

  const render = () => {
    if (!ui || !mgr) return;
    const l = mgr.list();
    const run = l.filter((i) => i.state === "running"), q = l.filter((i) => i.state === "queued");
    ui.setStatus("subagents", run.length || q.length ? `subagents ● ${run.length} running${q.length ? ` · ${q.length} queued` : ""}: ${run.map((i) => i.id).join(",")}` : undefined);
  };

  const manager = (ctx: ExtensionContext) => {
    ui = ctx.ui;
    mgr ??= new SubagentManager({
      spawn: opts.spawn ?? ((cmd, args, o) => spawn(cmd, args, { cwd: o.cwd, env: o.env, stdio: ["pipe", "pipe", "pipe"] })),
      exec, extensionPath, baseDir: join(ctx.cwd, ".pi", "subagents"),
      maxConcurrent: opts.maxConcurrent ?? Number(process.env.PI_SUBAGENT_MAX ?? 3),
    }, {
      deliver: (t, { wake }) => {
        // Fire-and-forget: delivery must never crash the manager (child sessions may be shutting down).
        void Promise.resolve(pi.sendMessage({ customType: "subagent-report", content: t, display: true }, wake ? { triggerTurn: true, deliverAs: "followUp" } : { deliverAs: "followUp" })).catch(() => { /* ignore */ });
      },
      onChange: render,
    });
    return mgr;
  };

  pi.on("session_start", async (_e, ctx) => { ui = ctx.ui; });
  pi.on("session_shutdown", async () => { mgr?.stopAll(); });

  pi.registerTool({
    name: "subagent_spawn",
    label: "Spawn subagent",
    description: "Start a subagent (a separate headless pi session) on a self-contained task. By default it runs in the background: returns 'spawned <id>' immediately and its milestone reports and final result arrive later as messages — do not poll or wait. Options: tools = exact tool-name allowlist for the child (a workflow limit, not a sandbox; built-in child tools only, [] disables all built-in tools; the child always keeps its report tool); session = named child session id that is created on first use and resumed on later spawns with the same id (use distinct ids for parallel tasks); wait=true = block until the subagent finishes and return its final result text as this tool's result (sync semantics, for short bounded tasks); fanout = N (1-3) = run N identical copies of the task in parallel (best-of-N): all N are tracked to a terminal state, each reports independently, and one combined result — an array of {id, status, resultText, worktree, spawned_by, depth} per member — arrives when all are terminal; with wait=true that combined array is returned directly. Selecting the best member is YOUR job, never automatic. Subagents may spawn their own subagents without any depth limit while the per-agent budget (PI_SPAWN_BUDGET, default 3; a fanout of N counts as N) lasts; exhausting it returns a clear error.",
    promptSnippet: "Delegate a self-contained task to a subagent (background by default, or synchronous with wait=true; fanout=N for best-of-N)",
    promptGuidelines: [
      "Use subagent_spawn for independent, long or parallelizable tasks; write a complete task prompt (the subagent sees none of this conversation).",
      "Use wait=true only for short, bounded tasks whose result you need immediately; keep background spawning (wait omitted) for long or parallelizable work.",
      "After a background subagent_spawn, do not poll subagent_list in a loop; subagent results are delivered to you automatically.",
      "Use isolate=true in subagent_spawn when several subagents may edit the same git repo.",
      "Use fanout=2..3 for best-of-N candidate generation on bounded, verifiable tasks (e.g. parallel attempts at the same fix); verify each member's result and keep the best — the combined result makes selection your responsibility.",
    ],
    parameters: Type.Object({
      task: Type.String({ description: "Complete, self-contained instructions" }),
      label: Type.Optional(Type.String({ description: "Short name shown in status" })),
      cwd: Type.Optional(Type.String()),
      isolate: Type.Optional(Type.Boolean({ description: "Run in a new git worktree + branch" })),
      model: Type.Optional(Type.String({ description: "pi --model pattern, e.g. deepseek/deepseek-flash" })),
      tools: Type.Optional(Type.Array(Type.String({ pattern: "^[A-Za-z_][A-Za-z0-9_.-]*$" }), {
        description: "Exact tool-name allowlist for the child: a workflow limit, not a sandbox. Built-in child tools only (read, grep, find, ls, bash, edit, write); [] disables all built-in tools (the report tool always stays); omit for pi defaults.",
      })),
      session: Type.Optional(Type.String({ pattern: "^[A-Za-z0-9](?:[A-Za-z0-9._-]*[A-Za-z0-9])?$", description: "Named child session id: created on first spawn, resumed on later spawns with the same id. Use distinct ids for parallel tasks. Omit for a fresh ephemeral session (default)." })),
      wait: Type.Optional(Type.Boolean({ description: "Block until the subagent finishes and return its final result text as this tool's result, instead of returning 'spawned <id>' immediately." })),
      fanout: Type.Optional(Type.Integer({ minimum: 1, maximum: 3, description: "Run N (1-3) identical copies of this task in parallel (best-of-N). All N are tracked; one combined result (array with one entry per member) arrives when all are terminal — you pick the winner. A fanout of N counts as N against the spawn budget." })),
    }),
    async execute(_id, p, _s, _u, ctx) {
      // Hardening (localization): confine the worker cwd to the current project so a
      // prompt-injected task cannot point a full-permission pi worker at /, ~/.pi/agent,
      // or any other sensitive directory. realpath resolves symlinks before the check.
      const cwd = p.cwd ?? ctx.cwd;
      const base = realpathSync(ctx.cwd);
      let target: string;
      try { target = realpathSync(cwd); } catch { throw new Error(`subagent cwd does not exist: ${cwd}`); }
      if (target !== base && !target.startsWith(base + "/")) throw new Error(`subagent cwd must stay inside the current project (${ctx.cwd})`);
      const { wait, ...rest } = p;
      const mgr = manager(ctx);
      const i = await mgr.spawn({ ...rest, cwd });
      const fo = i.fanout;
      if (fo && fo.total > 1) {
        if (!wait) return text(`Spawned fanout ${fo.groupId} with ${fo.total} members (${fo.memberIds.join(", ")})${rest.isolate ? ", each in its own git worktree" : ""}. Each member runs the identical task and reports independently; one combined result arrives when all are terminal. Do not poll.`);
        const combined = await mgr.waitForAll(fo.groupId);
        return text(`Fanout ${fo.groupId}: ${combined.length} results — select the best member yourself:\n${JSON.stringify(combined, null, 2)}`);
      }
      if (!wait) return text(`Spawned ${i.id} (${i.state}). Logs: ${i.logDir}. Its reports and result will arrive automatically.`);
      const fin = await mgr.waitFor(i.id);
      if (fin.state === "done") return text(fin.result || "(no final text)");
      return text(`subagent ${fin.id} ${fin.state}${fin.error ? `: ${fin.error}` : ""}${fin.result ? `\n${fin.result}` : ""}`);
    },
  });

  pi.registerTool({
    name: "subagent_list",
    label: "List subagents",
    description: "List background subagents with state and latest milestone report.",
    parameters: Type.Object({}),
    async execute(_id, _p, _s, _u, ctx) { const l = manager(ctx).list(); return text(l.length ? l.map(fmt).join("\n") : "No subagents."); },
  });

  pi.registerTool({
    name: "subagent_status",
    label: "Subagent status",
    description: "Status and all milestone reports of one subagent (no transcript).",
    parameters: Type.Object({ id: Type.String() }),
    async execute(_id, p, _s, _u, ctx) {
      const i = manager(ctx).get(p.id); if (!i) throw new Error(`no subagent ${p.id}`);
      return text([fmt(i), ...i.reports.map((r) => `- ${r.at} ${r.status}: ${r.summary}${r.question ? ` Q: ${r.question}` : ""}`)].join("\n"));
    },
  });

  pi.registerTool({
    name: "subagent_message",
    label: "Message subagent",
    description: "Steer a running subagent with a new instruction or an answer to its question.",
    parameters: Type.Object({ id: Type.String(), message: Type.String() }),
    async execute(_id, p, _s, _u, ctx) { await manager(ctx).message(p.id, p.message); return text(`Sent to ${p.id}.`); },
  });

  pi.registerTool({
    name: "subagent_stop",
    label: "Stop subagent",
    description: "Stop a queued or running subagent.",
    parameters: Type.Object({ id: Type.String() }),
    async execute(_id, p, _s, _u, ctx) { manager(ctx).stop(p.id); return text(`Stopping ${p.id}.`); },
  });

  pi.registerTool({
    name: "subagent_result",
    label: "Subagent result",
    description: "Read a subagent's final result, or (log=true) the tail of its on-disk transcript. Output is truncated; only request logs when you really need detail.",
    parameters: Type.Object({ id: Type.String(), log: Type.Optional(Type.Boolean()), maxChars: Type.Optional(Type.Number({ description: "default 4000, max 20000" })) }),
    async execute(_id, p, _s, _u, ctx) {
      const i = manager(ctx).get(p.id); if (!i) throw new Error(`no subagent ${p.id}`);
      const n = Math.min(20_000, p.maxChars ?? 4000);
      if (p.log) {
        const f = join(i.logDir, "transcript.log");
        const s = existsSync(f) ? readFileSync(f, "utf8") : "";
        return text(s.length > n ? `…[${s.length - n} earlier chars omitted; full log ${f}]\n${s.slice(-n)}` : s || "(empty log)");
      }
      return text(i.state === "done" ? truncate(i.result ?? "", n) : `${i.id} is ${i.state}${i.error ? `: ${i.error}` : ""}`);
    },
  });

  pi.registerCommand("subagent", {
    description: "Subagents: list | status <id> | stop <id|all> | log <id> | spawn <task>",
    handler: async (args, ctx) => {
      const m = manager(ctx);
      const [sub = "list", ...rest] = (args ?? "").trim().split(/\s+/);
      const arg = rest.join(" ");
      try {
        if (sub === "spawn" && arg) { const i = await m.spawn({ task: arg, cwd: ctx.cwd }); ctx.ui.notify(`spawned ${i.id}`, "info"); }
        else if (sub === "stop") { arg === "all" ? m.stopAll() : m.stop(arg); ctx.ui.notify(`stopping ${arg}`, "info"); }
        else if (sub === "status" || sub === "log") {
          const i = m.get(arg); if (!i) throw new Error(`no subagent ${arg}`);
          const f = join(i.logDir, "transcript.log");
          ctx.ui.notify(sub === "log" ? (existsSync(f) ? readFileSync(f, "utf8").slice(-3000) : "(empty)") : [fmt(i), ...i.reports.map((r) => `- ${r.status}: ${r.summary}`)].join("\n"), "info");
        } else ctx.ui.notify(m.list().map(fmt).join("\n") || "No subagents.", "info");
        render();
      } catch (e) { ctx.ui.notify(`subagent: ${(e as Error).message}`, "error"); }
    },
  });
}
