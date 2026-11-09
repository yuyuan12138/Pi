/**
 * Browser smoke-test stub: serves the REAL src/index.html with canned bridge
 * API responses (streaming snapshot + a couple of main-log items), so the
 * headless shell renders the live UI. Not part of the test suite.
 */
import http from "node:http";
import { readFileSync } from "node:fs";

const html = readFileSync(new URL("../src/index.html", import.meta.url), "utf8");

const state = {
  project: "smoke", now: Date.now(), mainSessionAlive: true,
  main: { sessionFile: null, sessionMtime: Date.now(), alive: true },
  subagents: [{ id: "sa1", label: "demo", status: "running", model: "test-model", lastActivity: Date.now(), usage: { totalTokens: 123 } }],
};
const mainLog = {
  file: "/tmp/fake.jsonl", cursor: 500, reset: true,
  items: [
    { kind: "user", text: "hello coordinator", ts: Date.now() - 60000, id: "u1", offset: 100 },
    { kind: "assistant", text: "Done earlier.", ts: Date.now() - 30000, id: "a1", offset: 200 },
    { kind: "tool", name: "bash", text: '{"command":"ls"}', ts: Date.now() - 20000, id: "a1:t1", offset: 300 },
  ],
  stats: { toolCalls: 1, tools: [{ name: "bash", count: 1 }], subagents: [], skills: [], assistantMessages: 1, assistantTurns: 1, tokens: null, model: null, startedAt: null },
};
let ticks = 0;
let mainLogPolls = 0;
const HANDOFF = process.env.SMOKE_HANDOFF === "1";
const stream = () => {
  // Grow the text a bit per poll so the live bubble visibly streams.
  ticks++;
  if (HANDOFF) {
    // Phase A (first 3 polls): streaming; then settle on a final text.
    if (ticks <= 3) return { streaming: true, text: "Working".repeat(ticks), turnStartedAt: Date.now() - 1000, tool: null };
    return { streaming: false, text: "Final reply.", turnStartedAt: Date.now() - 9000, tool: null };
  }
  const text = "Streaming reply ".repeat(Math.min(ticks, 5)).trim();
  return { streaming: true, text, turnStartedAt: Date.now() - 1000, tool: ticks >= 2 ? { name: "bash", summary: '{"command":"sleep 1"}' } : null };
};

http.createServer((req, res) => {
  const p = (req.url ?? "/").split("?")[0];
  console.error("REQ", p);
  const body = p === "/" || p === "/index.html" ? html
    : p === "/state" ? state
    : p === "/main-log" ? (mainLogPolls++ === 0 ? mainLog : { ...mainLog, reset: false, items: HANDOFF && mainLogPolls === 3 ? [{ kind: "assistant", text: "Final reply.", ts: Date.now() - 8000, id: "a2", offset: 600 }] : [] })
    : p === "/stream" ? stream()
    : p === "/history" ? { items: [], oldest: null }
    : p === "/sub-log" ? { id: "sa1", cursor: 0, reset: true, lines: [], result: null, done: false }
    : { ok: false };
  const buf = Buffer.from(typeof body === "string" ? body : JSON.stringify(body));
  res.writeHead(200, { "Content-Type": p === "/" ? "text/html; charset=utf-8" : "application/json", "Content-Length": buf.length });
  res.end(buf);
}).listen(7899, "127.0.0.1", () => console.log("stub on 7899"));
