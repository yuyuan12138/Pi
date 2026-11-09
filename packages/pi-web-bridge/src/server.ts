import http from "node:http";
import { statSync } from "node:fs";
import { routeMessage, type RoutedMessage } from "./routing.ts";
import { SubagentScanner } from "./state.ts";
import { MainLogReader, readHistoryBefore } from "./mainlog.ts";
import { readSubLog, readSubHistory } from "./sublog.ts";
import { EMPTY_STREAM, type StreamSnapshot } from "./stream.ts";

/** Hard cap on request body size (brief: 32KB). */
export const MAX_BODY_BYTES = 32 * 1024;
/** Hard cap on a single message text (kept under the body cap so headers/JSON fit). */
export const MAX_TEXT_CHARS = 30_000;
/** Subagent id pattern shared by routing and log lookups (same shape pi-superagent uses). */
export const SUBAGENT_ID_RE = /^[A-Za-z0-9][A-Za-z0-9._-]*$/;

export interface BridgeDeps {
  /** Project name (cwd basename) stamped into injected message headers. */
  project: string;
  /** Deliver text into the running pi session. `kind` selects delivery: main-target messages steer into an in-flight turn; subagent-fallback keeps the queue-to-end behavior. Returns false if refused. */
  inject: (text: string, kind?: "main" | "subagent") => boolean;
  /** Absolute path of the current main session JSONL, when known. */
  sessionFile: () => string | undefined;
  /** Absolute path of the subagent log base dir (<cwd>/.pi/subagents). */
  subagentsDir: () => string;
  /** The single-file web UI source. */
  indexHtml: () => string;
  /** Live in-flight assistant snapshot for GET /stream (defaults to a neutral idle snapshot). */
  stream?: () => StreamSnapshot;
  /** Subagent scanner (defaults to a fresh one). */
  scanner?: SubagentScanner;
  /** Main session log reader (defaults to a fresh one). */
  mainLog?: MainLogReader;
  log?: (msg: string) => void;
}

export interface BridgeServer extends http.Server {
  /** Graceful shutdown: stops accepting, closes idle connections. */
  closeBridge(): void;
}

function sendJson(res: http.ServerResponse, code: number, body: unknown): void {
  const buf = Buffer.from(JSON.stringify(body));
  res.writeHead(code, { "Content-Type": "application/json; charset=utf-8", "Content-Length": buf.length, "Cache-Control": "no-store" });
  res.end(buf);
}

function sendText(res: http.ServerResponse, code: number, body: string, type: string): void {
  const buf = Buffer.from(body);
  res.writeHead(code, { "Content-Type": type, "Content-Length": buf.length, "Cache-Control": "no-store" });
  res.end(buf);
}

/** Read a request body with a hard cap. Resolves null when the cap is exceeded (response already sent). */
function readBody(req: http.IncomingMessage, cap: number, res: http.ServerResponse): Promise<string | null> {
  return new Promise((resolve) => {
    const chunks: Buffer[] = [];
    let size = 0;
    let done = false;
    const finish = (v: string | null) => { if (!done) { done = true; resolve(v); } };
    req.on("data", (c: Buffer) => {
      size += c.length;
      if (size > cap) {
        sendJson(res, 413, { ok: false, error: `body exceeds ${cap} bytes` });
        req.destroy();
        finish(null);
        return;
      }
      chunks.push(c);
    });
    req.on("end", () => finish(Buffer.concat(chunks).toString("utf8")));
    req.on("error", () => finish(null));
  });
}

/** True when the request came from a browser context we serve (CSRF/DNS-rebinding guard). */
function originAllowed(origin: string | undefined, port: number): boolean {
  if (origin === undefined) return true; // curl / same-origin GETs omit it
  return origin === `http://127.0.0.1:${port}` || origin === `http://localhost:${port}`;
}

function hostAllowed(host: string | undefined, port: number): boolean {
  // DNS-rebinding guard: only our own loopback names on our own port.
  return host === `127.0.0.1:${port}` || host === `localhost:${port}`;
}

export function createBridgeServer(deps: BridgeDeps): BridgeServer {
  const scanner = deps.scanner ?? new SubagentScanner();
  const mainLog = deps.mainLog ?? new MainLogReader();
  const log = deps.log ?? (() => {});

  const server = http.createServer((req, res) => {
    handle(req, res).catch((err: unknown) => {
      try { sendJson(res, 500, { ok: false, error: String((err as Error)?.message ?? err) }); } catch { /* socket gone */ }
    });
  });

  async function handle(req: http.IncomingMessage, res: http.ServerResponse): Promise<void> {
    const port = req.socket.localPort ?? 0;
    if (!hostAllowed(req.headers.host, port)) return sendJson(res, 403, { ok: false, error: "forbidden host" });
    if (!originAllowed(req.headers.origin, port)) return sendJson(res, 403, { ok: false, error: "forbidden origin" });
    const method = req.method ?? "";
    if (method !== "GET" && method !== "POST") {
      res.setHeader("Allow", "GET, POST");
      return sendJson(res, 405, { ok: false, error: "method not allowed" });
    }
    const url = new URL(req.url ?? "/", `http://127.0.0.1:${port}`);
    const path = url.pathname;

    if (method === "GET" && (path === "/" || path === "/index.html")) {
      return sendText(res, 200, deps.indexHtml(), "text/html; charset=utf-8");
    }
    if (method === "GET" && path === "/state") {
      const sf = deps.sessionFile();
      let sessionMtime: number | null = null;
      if (sf) { try { sessionMtime = statSync(sf).mtimeMs; } catch { sessionMtime = null; } }
      let subs: ReturnType<SubagentScanner["scan"]> = [];
      try { subs = scanner.scan(deps.subagentsDir()); } catch (e) { log(`state scan failed: ${(e as Error).message}`); }
      return sendJson(res, 200, {
        project: deps.project,
        now: Date.now(),
        mainSessionAlive: true, // the bridge runs inside the session it serves: a response implies liveness
        main: { sessionFile: sf ?? null, sessionMtime, alive: true },
        subagents: subs,
      });
    }
    if (method === "GET" && path === "/stream") {
      // Live in-flight assistant view; additive — existing routes/shapes unchanged.
      return sendJson(res, 200, deps.stream?.() ?? EMPTY_STREAM);
    }
    if (method === "GET" && path === "/main-log") {
      const after = url.searchParams.get("after");
      mainLog.attach(deps.sessionFile());
      const snap = mainLog.consume(after === null ? null : Number(after));
      return sendJson(res, 200, snap);
    }
    if (method === "GET" && path === "/history") {
      const sf = deps.sessionFile();
      if (!sf) return sendJson(res, 200, { items: [], oldest: null });
      const beforeRaw = url.searchParams.get("before");
      const before = beforeRaw === null ? null : Number(beforeRaw);
      const limit = Math.min(500, Math.max(1, Number(url.searchParams.get("limit")) || 200));
      return sendJson(res, 200, readHistoryBefore(sf, before, limit));
    }
    if (method === "GET" && path === "/sub-history") {
      const id = url.searchParams.get("id") ?? "";
      if (!SUBAGENT_ID_RE.test(id)) return sendJson(res, 400, { ok: false, error: "invalid subagent id" });
      const beforeRaw = url.searchParams.get("before");
      const before = beforeRaw === null ? null : Number(beforeRaw);
      const limit = Math.min(1000, Math.max(1, Number(url.searchParams.get("limit")) || 300));
      return sendJson(res, 200, readSubHistory(`${deps.subagentsDir()}/${id}`, id, before, limit));
    }
    if (method === "GET" && path === "/sub-log") {
      const id = url.searchParams.get("id") ?? "";
      const afterRaw = url.searchParams.get("after");
      const after = afterRaw === null ? null : Number(afterRaw);
      if (!SUBAGENT_ID_RE.test(id)) return sendJson(res, 400, { ok: false, error: "invalid subagent id" });
      const dir = `${deps.subagentsDir()}/${id}`;
      const out = readSubLog(dir, id, after);
      return sendJson(res, 200, out);
    }
    if (method === "POST" && path === "/message") {
      const raw = await readBody(req, MAX_BODY_BYTES, res);
      if (raw === null) return; // cap exceeded; response already sent
      let parsed: unknown;
      try { parsed = JSON.parse(raw); } catch { return sendJson(res, 400, { ok: false, error: "invalid JSON" }); }
      const { target, text } = (parsed ?? {}) as Record<string, unknown>;
      const routed: RoutedMessage = routeMessage(target, text, deps.project, MAX_TEXT_CHARS);
      if (!routed.ok) return sendJson(res, 400, { ok: false, error: routed.error });
      if (routed.kind === "subagent-fallback") {
        // Only forward for subagents the coordinator actually knows about (typo protection).
        let known = false;
        try { known = scanner.scan(deps.subagentsDir()).some((s) => s.id === routed.id); } catch { known = false; }
        if (!known) return sendJson(res, 404, { ok: false, error: `unknown subagent ${routed.id}` });
      }
      const accepted = deps.inject(routed.text, routed.kind === "main" ? "main" : "subagent");
      if (!accepted) return sendJson(res, 503, { ok: false, error: "session is shutting down; message not delivered" });
      return sendJson(res, 200, routed.kind === "main"
        ? { ok: true, routed: "main" }
        : { ok: true, routed: "main-for-subagent", id: routed.id });
    }
    return sendJson(res, 404, { ok: false, error: "not found" });
  }

  return Object.assign(server, {
    closeBridge() {
      mainLog.attach(undefined);
      server.close();
    },
  });
}
