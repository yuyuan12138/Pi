import { isToolCallEventType, type ExtensionAPI, type ExtensionContext } from "@earendil-works/pi-coding-agent";
import { Superagent } from "./agent.ts";
import { CONFIG_FILE, loadConfig } from "./config.ts";
import { checkCommand } from "./guard.ts";
import type { Exec } from "./types.ts";
import { WorkStore } from "./workitems.ts";
import { registerSubagentChild, registerSubagentParent } from "./subagent/extension.ts";

export default function superagent(pi: ExtensionAPI) {
  const isWorker = process.env.SUPERAGENT_WORKER === "1";
  const isSubagent = !!process.env.PI_SUBAGENT_ID;
  let agent: Superagent | undefined;
  let ui: ExtensionContext["ui"] | undefined;

  // Guard: always on inside worker sessions; on in the operator session while the agent is running.
  pi.on("tool_call", async (event) => {
    if (!isWorker && !agent?.active) return;
    if (isToolCallEventType("bash", event)) {
      const c = checkCommand(event.input.command);
      if (!c.ok) return { block: true, reason: `pi-superagent guard: ${c.reason}` };
    }
  });

  if (isSubagent) { registerSubagentChild(pi); return; }
  if (isWorker) return;

  registerSubagentParent(pi);

  const exec: Exec = async (cmd, args, opts) => {
    const r = await pi.exec(cmd, args, opts);
    return { stdout: r.stdout, stderr: r.stderr, code: r.code };
  };

  const render = () => {
    if (!ui || !agent) return;
    const s = agent.store;
    const n = (st: Parameters<typeof s.byStatus>[0]) => s.byStatus(st).length;
    ui.setStatus("superagent", agent.active
      ? `superagent ● ${agent.cfg.repo} run:${n("running")} q:${n("queued")} ?:${n("needs-human")}${agent.lastError ? " ⚠" : ""}`
      : "superagent ○ stopped");
  };

  const statusLines = () => {
    if (!agent) return ["superagent not started"];
    const lines = [
      `repo ${agent.cfg.repo}  mention ${agent.cfg.mention}  ${agent.active ? "running" : "stopped"}${agent.cfg.dryRun ? " (dry-run)" : ""}`,
      `last poll ${agent.lastPoll ?? "-"}${agent.lastError ? `  error: ${agent.lastError}` : ""}`,
    ];
    for (const i of agent.store.state.items.slice(-15).reverse()) lines.push(`${i.status.padEnd(11)} #${i.issue} ${i.id} @${i.author} ${i.prUrl ?? i.error?.slice(0, 60) ?? i.request.slice(0, 60)}`);
    return lines;
  };

  pi.registerCommand("superagent", {
    description: "pi-superagent: start | stop | status | poll",
    getArgumentCompletions: (p) => ["start", "stop", "status", "poll"].filter((x) => x.startsWith(p)).map((x) => ({ value: x, label: x })),
    handler: async (args, ctx) => {
      ui = ctx.ui;
      const sub = (args || "status").trim().split(/\s+/)[0];
      try {
        if (sub === "start") {
          if (agent?.active) return ctx.ui.notify("superagent already running", "info");
          const cfg = await loadConfig(ctx.cwd);
          const store = await WorkStore.forCwd(ctx.cwd).load();
          agent = new Superagent(cfg, store, exec, ctx.cwd, { onChange: render });
          agent.start();
          ctx.ui.notify(`superagent watching ${cfg.repo} for ${cfg.mention}`, "info");
        } else if (sub === "stop") {
          agent?.stop();
          ctx.ui.notify("superagent stopped", "info");
        } else if (sub === "poll") {
          if (!agent) throw new Error("run /superagent start first");
          await agent.poll();
        } else {
          ctx.ui.setWidget("superagent", statusLines());
          ctx.ui.notify(statusLines().join("\n"), "info");
        }
        render();
      } catch (e) {
        ctx.ui.notify(`superagent: ${(e as Error).message}${sub === "start" ? ` (config: ${CONFIG_FILE})` : ""}`, "error");
      }
    },
  });

  pi.on("session_shutdown", async () => { agent?.stop(); });
}
