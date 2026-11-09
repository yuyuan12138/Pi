import { readFileSync } from "node:fs";
import { basename, join } from "node:path";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { createBridgeServer, type BridgeServer } from "./server.ts";

/**
 * pi-web-bridge — local web chat bridge ("mission control") for pi.
 *
 * Serves a single-file chat UI on 127.0.0.1 (default port 7788) that lets the
 * user talk to THIS pi session and read/reply to per-subagent threads.
 * Injection reuses the exact mechanism pi-superagent uses to deliver subagent
 * reports: a displayable custom message with triggerTurn so an idle agent wakes.
 *
 * Env:
 *   PI_WEB_BRIDGE_PORT     port to bind (default 7788; 0 = ephemeral, handy for tests)
 *   PI_WEB_BRIDGE_DISABLED set to "1" to skip the server entirely
 *
 * Failure posture: bind errors (e.g. another pi session already holds the port)
 * are logged and non-fatal — the pi session must never crash because of this UI.
 */
export default function webBridge(pi: ExtensionAPI) {
  if (process.env.PI_WEB_BRIDGE_DISABLED === "1") return;
  const port = Number(process.env.PI_WEB_BRIDGE_PORT || 7788);
  const cwd = process.cwd();
  const project = basename(cwd);
  const subagentsDir = () => join(cwd, ".pi", "subagents");
  let sessionFile: string | undefined;
  let server: BridgeServer | undefined;

  const log = (msg: string) => console.error(`[web-bridge] ${msg}`);

  // Same delivery path pi-superagent uses for subagent reports: a displayable
  // custom message that triggers a turn when the agent is idle, queued as a
  // follow-up when it is streaming.
  const inject = (text: string): boolean => {
    try {
      pi.sendMessage({ customType: "web-chat", content: text, display: true }, { triggerTurn: true, deliverAs: "followUp" });
      return true;
    } catch (e) {
      log(`inject failed: ${(e as Error).message}`);
      return false;
    }
  };

  try {
    server = createBridgeServer({
      project,
      inject,
      sessionFile: () => sessionFile,
      subagentsDir,
      indexHtml: () => readFileSync(new URL("./index.html", import.meta.url), "utf8"),
      log,
    });
    server.on("error", (e: Error) => log(`server error: ${e.message} (bridge inactive)`));
    server.listen(port, "127.0.0.1", () => log(`mission control on http://127.0.0.1:${(server?.address() as any)?.port ?? port}`));
    // An embedded UI server must never keep the pi process alive on its own.
    server.unref();
  } catch (e) {
    log(`failed to start: ${(e as Error).message}`);
  }

  pi.on("session_start", (_event, ctx) => {
    try { sessionFile = ctx.sessionManager.getSessionFile(); } catch { sessionFile = undefined; }
    try { ctx.ui.setStatus("webchat", server?.listening ? `web chat on 127.0.0.1:${(server.address() as any)?.port}` : undefined); } catch { /* UI optional */ }
  });

  pi.on("session_shutdown", () => {
    try { server?.closeBridge(); } catch { /* ignore */ }
  });
}
