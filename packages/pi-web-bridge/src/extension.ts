import { readFileSync } from "node:fs";
import { basename, join } from "node:path";
import type { ExtensionAPI, MessageEndEvent, MessageStartEvent, MessageUpdateEvent } from "@earendil-works/pi-coding-agent";
import { createBridgeServer, type BridgeServer } from "./server.ts";
import { StreamBuffer } from "./stream.ts";
import type { ProjectUsageRollup } from "../../pi-usage-log/project-usage.ts";

/** Which surface POST /message routed to (drives the delivery decision). */
export type InjectKind = "main" | "subagent";

/** The custom message shape the bridge injects (unchanged format: caller pre-stamps the routing header). */
export interface InjectedMessage {
  customType: string;
  content: string;
  display: boolean;
}

/** sendMessage options chosen by the injection decision. */
export interface InjectionOptions {
  triggerTurn: boolean;
  deliverAs: "steer" | "followUp";
}

/**
 * Delivery decision for an injected message.
 *
 * - Main-target while the session is streaming: "steer". pi delivers the custom
 *   message after the current assistant turn's tool calls have executed and their
 *   results are persisted, right before the next LLM call (the agent loop polls
 *   the steering queue exactly at that boundary), so a long-running turn no longer
 *   hides the reply until the whole run ends. This is the same boundary
 *   pi-telegram's telegram-steer packets target; the in-flight-tool-call hazard
 *   its own canSubmit guards cover (active tool executions, compaction, aborted
 *   context) cannot occur here because pi itself holds the message until the
 *   boundary — it never appends between a tool call and its result.
 * - Idle main-target and every subagent-target: "followUp", the exact previous
 *   behavior. When idle pi ignores deliverAs entirely (triggerTurn starts the
 *   run), so idle delivery is unchanged.
 *
 * pi re-checks the real streaming state inside sendCustomMessage, so a stale
 * `streaming` flag can only land the message on the other safe native path
 * (steer while idle behaves like triggerTurn; followUp while streaming queues
 * as before) — it can never lose or corrupt the message.
 */
export function injectionOptions(kind: InjectKind, streaming: boolean): InjectionOptions {
  return { triggerTurn: true, deliverAs: kind === "main" && streaming ? "steer" : "followUp" };
}

/** Sink createInjector pushes into: pi.sendMessage in production, a capture array in tests. */
export type MessageSink = (message: InjectedMessage, options: InjectionOptions) => unknown;

/**
 * Build the deps.inject implementation. The text arrives with its routing header
 * already applied; the only decision left is how pi should deliver it.
 */
export function createInjector(send: MessageSink, isStreaming: () => boolean, log: (msg: string) => void) {
  return (text: string, kind: InjectKind = "main"): boolean => {
    try {
      send({ customType: "web-chat", content: text, display: true }, injectionOptions(kind, isStreaming()));
      return true;
    } catch (e) {
      log(`inject failed: ${(e as Error).message}`);
      return false;
    }
  };
}

/**
 * Theme D1 wiring: the /projects panel's per-project usage rollup, produced by
 * pi-usage-log's project-usage module (same attribution chain as documented
 * there). The module is imported lazily and the rollup RE-COMPUTED in the
 * background on a 60s TTL: the /projects route polls synchronously every ~3s,
 * so the sync getter serves the last completed rollup (null until the first
 * one is warm) — the same null-while-warming pattern the bridge's usage.ts
 * uses for large logs. Any failure (sibling package missing, unreadable
 * usage dir) logs once and yields null: the panel renders without usage7d.
 */
function createUsage7dSource(log: (msg: string) => void): () => ProjectUsageRollup | null {
  const TTL_MS = 60_000;
  let cached: { at: number; value: ProjectUsageRollup | null } | null = null;
  let warming = false;
  const warm = (): void => {
    if (warming) return;
    warming = true;
    import("../../pi-usage-log/project-usage.ts")
      .then((m) => {
        const registry = m.loadRegistryProjects();
        const value = m.rollupLastDays(m.DEFAULT_USAGE_DIR, registry, 7);
        cached = { at: Date.now(), value };
      })
      .catch((e) => {
        log(`usage7d source unavailable: ${(e as Error)?.message ?? e}`);
        cached = { at: Date.now(), value: null }; // degrade honestly for one TTL window
      })
      .finally(() => { warming = false; });
  };
  return () => {
    if (!cached || Date.now() - cached.at >= TTL_MS) warm();
    return cached?.value ?? null;
  };
}

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

  // pi exposes no streaming query to a plain HTTP-server closure, so track the
  // run lifecycle. A missed event is harmless: sendCustomMessage re-checks the
  // real state and the stale flag merely degrades to the previous behavior.
  const stream = new StreamBuffer();
  let streaming = false;
  pi.on("agent_start", () => { streaming = true; stream.reset(); });
  pi.on("agent_settled", () => { streaming = false; stream.settle(); });

  // Live streaming buffer for GET /stream: pi emits message_update per provider
  // delta with the partial assistant message, so the web UI can grow the reply
  // text live (terminal parity). Handlers are pure in-memory updates and must
  // never disturb the run — hence the catch-alls.
  pi.on("message_start", (event: MessageStartEvent) => {
    try { if (event.message?.role === "assistant") stream.startAssistant(); } catch { /* observation only */ }
  });
  pi.on("message_update", (event: MessageUpdateEvent) => {
    try { if (event.message?.role === "assistant") stream.update(event.message); } catch { /* observation only */ }
  });
  pi.on("message_end", (event: MessageEndEvent) => {
    try { if (event.message?.role === "assistant") stream.endAssistant(event.message); } catch { /* observation only */ }
  });

  // Displayable web-chat custom message: wake the idle agent exactly as before;
  // while a turn streams, main-target messages steer into it instead of waiting.
  const inject = createInjector(
    (message, options) => { pi.sendMessage(message, options); },
    () => streaming,
    log,
  );

  try {
    server = createBridgeServer({
      project,
      inject,
      sessionFile: () => sessionFile,
      subagentsDir,
      indexHtml: () => readFileSync(new URL("./index.html", import.meta.url), "utf8"),
      stream: () => stream.snapshot(),
      usage7d: createUsage7dSource(log),
      log,
    });
    // A /reload rebinds this extension while the OLD bridge instance tears
    // down. closeBridge() now force-closes its tracked sockets, so the port
    // frees immediately; this retry is pure defense (e.g. two reloads
    // racing): on EADDRINUSE re-listen a few times before declaring inactivity.
    let bindRetries = 0;
    const bind = () => {
      server?.listen(port, "127.0.0.1", () => log(`mission control on http://127.0.0.1:${(server?.address() as any)?.port ?? port}`));
    };
    server.on("error", (e: NodeJS.ErrnoException) => {
      if (e?.code === "EADDRINUSE" && bindRetries < 5) {
        bindRetries++;
        log(`port ${port} busy (EADDRINUSE), retrying bind (${bindRetries}/5) in 500ms`);
        const t = setTimeout(bind, 500);
        t.unref?.();
        return;
      }
      log(`server error: ${e.message} (bridge inactive)`);
    });
    bind();
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
