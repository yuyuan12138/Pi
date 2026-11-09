import { test, describe, before, after } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { default as webBridge } from "../src/extension.ts";
import { createBridgeServer } from "../src/server.ts";
import { MainLogReader, readHistoryBefore } from "../src/mainlog.ts";
import {
  StreamBuffer,
  assistantTextOf,
  toolOf,
  STREAM_MAX_CHARS,
  STREAM_TOOL_PREVIEW_CHARS,
  EMPTY_STREAM,
} from "../src/stream.ts";

/** Partial assistant message factory, mirroring pi's message_update payloads. */
const partial = (content: unknown[]) => ({ role: "assistant", content });

describe("assistantTextOf / toolOf extraction", () => {
  test("joins text blocks, ignores thinking and toolCall blocks", () => {
    const m = partial([
      { type: "thinking", text: "hmm" },
      { type: "text", text: "one" },
      { type: "toolCall", name: "bash", arguments: { command: "ls" } },
      { type: "text", text: "two" },
    ]);
    assert.equal(assistantTextOf(m), "one\ntwo");
  });

  test("non-array or missing content yields empty text and no tool", () => {
    assert.equal(assistantTextOf({ role: "assistant", content: "plain" }), "");
    assert.equal(assistantTextOf(undefined), "");
    assert.equal(toolOf({ role: "assistant" }), null);
    assert.equal(toolOf(partial([{ type: "text", text: "x" }])), null);
  });

  test("toolOf picks the last toolCall block with a bounded JSON preview", () => {
    const big = { command: "x".repeat(2000) };
    const t = toolOf(partial([
      { type: "toolCall", name: "read", arguments: { path: "a" } },
      { type: "toolCall", name: "bash", arguments: big },
    ]));
    assert.equal(t?.name, "bash");
    assert.ok(t!.summary.length <= STREAM_TOOL_PREVIEW_CHARS);
    assert.ok(t!.summary.includes("xxx"));
  });

  test("unserializable arguments degrade to an empty preview", () => {
    const t = toolOf(partial([{ type: "toolCall", name: "bash", arguments: BigInt(1) }]));
    assert.deepEqual(t, { name: "bash", summary: "" });
  });
});

describe("StreamBuffer lifecycle", () => {
  test("starts neutral, grows with updates, bounds the tail", () => {
    const b = new StreamBuffer();
    assert.deepEqual(b.snapshot(), EMPTY_STREAM);
    b.startAssistant();
    assert.equal(b.snapshot().streaming, true);
    assert.equal(b.snapshot().text, "");
    assert.ok(typeof b.snapshot().turnStartedAt === "number" && b.snapshot().turnStartedAt! > 0);
    b.update(partial([{ type: "text", text: "Hello" }]));
    assert.equal(b.snapshot().text, "Hello");
    const long = "a".repeat(STREAM_MAX_CHARS + 500);
    b.update(partial([{ type: "text", text: "b".repeat(500) + long }]));
    const s = b.snapshot();
    assert.equal(s.text.length, STREAM_MAX_CHARS);
    assert.ok(s.text.endsWith(long.slice(-STREAM_MAX_CHARS))); // the tail survives, the head is dropped
  });

  test("message_end settles with the final text; toolCall-only clears it", () => {
    const b = new StreamBuffer();
    b.startAssistant();
    b.update(partial([{ type: "text", text: "growing" }]));
    b.endAssistant(partial([{ type: "text", text: "growing reply" }, { type: "toolCall", name: "bash", arguments: {} }]));
    let s = b.snapshot();
    assert.equal(s.streaming, false);
    assert.equal(s.text, "growing reply");
    assert.equal(s.tool, null);
    b.startAssistant();
    b.endAssistant(partial([{ type: "toolCall", name: "read", arguments: {} }])); // toolCall-only message
    s = b.snapshot();
    assert.equal(s.streaming, false);
    assert.equal(s.text, "");
  });

  test("update surfaces the in-flight tool call; settle and reset clear state", () => {
    const b = new StreamBuffer();
    b.startAssistant();
    b.update(partial([{ type: "toolCall", name: "bash", arguments: { command: "ls -la" } }]));
    assert.deepEqual(b.snapshot().tool, { name: "bash", summary: '{"command":"ls -la"}' });
    b.settle(); // aborted run without message_end
    assert.equal(b.snapshot().streaming, false);
    b.reset();
    assert.deepEqual(b.snapshot(), EMPTY_STREAM);
  });
});

describe("webBridge /stream wiring over a fake ExtensionAPI", () => {
  test("assistant message hooks fill the buffer; /stream serves it live", async () => {
    const previousPort = process.env.PI_WEB_BRIDGE_PORT;
    const previousDisabled = process.env.PI_WEB_BRIDGE_DISABLED;
    delete process.env.PI_WEB_BRIDGE_DISABLED;
    process.env.PI_WEB_BRIDGE_PORT = "0";
    try {
      const handlers = new Map<string, (event: unknown, ctx: unknown) => void>();
      const pi = {
        on: (type: string, handler: (event: unknown, ctx: unknown) => void) => { handlers.set(type, handler); return pi; },
        sendMessage: () => {},
      };
      webBridge(pi as unknown as ExtensionAPI);
      for (const t of ["message_start", "message_update", "message_end", "agent_start", "agent_settled"]) {
        assert.ok(handlers.has(t), `handler registered: ${t}`);
      }

      let status: string | undefined;
      const uiCtx = { ui: { setStatus: (_k: string, v: string) => { status = v; } } };
      for (let i = 0; i < 50 && !(status ?? "").includes("127.0.0.1:"); i++) {
        handlers.get("session_start")?.({}, uiCtx);
        if (!(status ?? "").includes("127.0.0.1:")) await new Promise((r) => setTimeout(r, 10));
      }
      const m = /127\.0\.0\.1:(\d+)/.exec(status ?? "");
      assert.ok(m, `no bridge port in status: ${status}`);
      const url = `http://127.0.0.1:${m![1]}`;
      const get = async () => (await fetch(`${url}/stream`)).json();

      // idle before anything happened
      assert.deepEqual(await get(), { streaming: false, text: "", turnStartedAt: null, tool: null });

      // run starts, user message_start is ignored, assistant streams
      handlers.get("agent_start")?.({}, {});
      handlers.get("message_start")?.({ type: "message_start", message: { role: "user", content: [{ type: "text", text: "hi" }] } }, {});
      assert.deepEqual(await get(), { streaming: false, text: "", turnStartedAt: null, tool: null });

      handlers.get("message_start")?.({ type: "message_start", message: { role: "assistant", content: [] } }, {});
      let snap = await get();
      assert.equal(snap.streaming, true);
      assert.equal(snap.text, "");
      assert.ok(snap.turnStartedAt > 0);

      handlers.get("message_update")?.({
        type: "message_update",
        message: partial([{ type: "thinking", text: "..." }, { type: "text", text: "Working on it" }]),
      }, {});
      snap = await get();
      assert.equal(snap.streaming, true);
      assert.equal(snap.text, "Working on it");

      // a tool call starts forming mid-message
      handlers.get("message_update")?.({
        type: "message_update",
        message: partial([{ type: "text", text: "Working on it" }, { type: "toolCall", name: "bash", arguments: { command: "ls" } }]),
      }, {});
      snap = await get();
      assert.deepEqual(snap.tool, { name: "bash", summary: '{"command":"ls"}' });

      // huge deltas are bounded to the tail
      const tail = "z".repeat(STREAM_MAX_CHARS);
      handlers.get("message_update")?.({
        type: "message_update",
        message: partial([{ type: "text", text: "y".repeat(3000) + tail }]),
      }, {});
      snap = await get();
      assert.equal(snap.text.length, STREAM_MAX_CHARS);
      assert.ok(snap.text.endsWith(tail));

      // message_end settles: streaming stops, final text stays for the UI handoff
      handlers.get("message_end")?.({ type: "message_end", message: partial([{ type: "text", text: "y".repeat(3000) + tail }]) }, {});
      snap = await get();
      assert.equal(snap.streaming, false);
      assert.equal(snap.text.length, STREAM_MAX_CHARS);
      assert.equal(snap.tool, null);

      // a toolCall-only assistant message clears the text
      handlers.get("message_start")?.({ type: "message_start", message: { role: "assistant", content: [] } }, {});
      handlers.get("message_end")?.({ type: "message_end", message: partial([{ type: "toolCall", name: "read", arguments: {} }]) }, {});
      snap = await get();
      assert.equal(snap.streaming, false);
      assert.equal(snap.text, "");

      // next run wipes stale content; abort settles without losing text
      handlers.get("agent_start")?.({}, {});
      assert.deepEqual(await get(), { streaming: false, text: "", turnStartedAt: null, tool: null });
      handlers.get("message_start")?.({ type: "message_start", message: { role: "assistant", content: [] } }, {});
      handlers.get("message_update")?.({ type: "message_update", message: partial([{ type: "text", text: "partial" }]) }, {});
      handlers.get("agent_settled")?.({ type: "agent_settled", aborted: true }, {});
      snap = await get();
      assert.equal(snap.streaming, false);
      assert.equal(snap.text, "partial"); // kept so the UI can hand off to /main-log
    } finally {
      if (previousPort === undefined) delete process.env.PI_WEB_BRIDGE_PORT;
      else process.env.PI_WEB_BRIDGE_PORT = previousPort;
      if (previousDisabled === undefined) delete process.env.PI_WEB_BRIDGE_DISABLED;
      else process.env.PI_WEB_BRIDGE_DISABLED = previousDisabled;
    }
  });
});

describe("GET /stream over createBridgeServer", () => {
  test("serves the injected snapshot; neutral default when the dep is absent", async () => {
    const server = createBridgeServer({
      project: "demo",
      inject: () => true,
      sessionFile: () => undefined,
      subagentsDir: () => "/nonexistent",
      indexHtml: () => "<html></html>",
      stream: () => ({ streaming: true, text: "live", turnStartedAt: 42, tool: null }),
    });
    const port = await new Promise<number>((resolve) => {
      server.listen(0, "127.0.0.1", () => resolve((server.address() as { port: number }).port));
    });
    server.unref();
    try {
      const r = await fetch(`http://127.0.0.1:${port}/stream`);
      assert.equal(r.status, 200);
      assert.deepEqual(await r.json(), { streaming: true, text: "live", turnStartedAt: 42, tool: null });

      const bare = createBridgeServer({
        project: "demo",
        inject: () => true,
        sessionFile: () => undefined,
        subagentsDir: () => "/nonexistent",
        indexHtml: () => "<html></html>",
      });
      const port2 = await new Promise<number>((resolve) => {
        bare.listen(0, "127.0.0.1", () => resolve((bare.address() as { port: number }).port));
      });
      bare.unref();
      try {
        const r2 = await fetch(`http://127.0.0.1:${port2}/stream`);
        assert.equal(r2.status, 200);
        assert.deepEqual(await r2.json(), EMPTY_STREAM);
      } finally {
        bare.close();
      }
    } finally {
      server.close();
    }
  });
});

describe("main log tool items (terminal-parity activity lines)", () => {
  const dir = mkdtempSync(join(tmpdir(), "web-bridge-stream-"));
  const file = join(dir, "session.jsonl");
  before(() => {
    const lines = [
      JSON.stringify({ type: "custom_message", id: "e1", timestamp: "2026-01-01T00:00:00.000Z", customType: "web-chat", content: "hello" }),
      JSON.stringify({
        type: "message", id: "e2", timestamp: "2026-01-01T00:00:01.000Z",
        message: {
          role: "assistant",
          content: [
            { type: "text", text: "Let me check." },
            { type: "toolCall", id: "tc1", name: "bash", arguments: { command: "ls" } },
            { type: "toolCall", id: "tc2", name: "read", arguments: { path: "a.txt" } },
          ],
        },
      }),
      JSON.stringify({
        type: "message", id: "e3", timestamp: "2026-01-01T00:00:02.000Z",
        message: { role: "toolResult", toolCallId: "tc1", toolName: "bash", content: [{ type: "text", text: "out" }], isError: false },
      }),
      JSON.stringify({
        type: "message", id: "e4", timestamp: "2026-01-01T00:00:03.000Z",
        message: { role: "assistant", content: [{ type: "toolCall", id: "tc3", name: "grep", arguments: { pattern: "x" } }] },
      }),
    ];
    writeFileSync(file, lines.join("\n") + "\n");
  });
  after(() => rmSync(dir, { recursive: true, force: true }));

  test("assistant entries emit text plus interleaved tool lines in content order", () => {
    const reader = new MainLogReader();
    reader.attach(file);
    const snap = reader.consume(null);
    assert.equal(snap.reset, true);
    assert.deepEqual(snap.items.map((i) => [i.kind, i.name ?? i.text.slice(0, 13)]), [
      ["user", "hello"],
      ["assistant", "Let me check."],
      ["tool", "bash"],
      ["tool", "read"],
      ["tool", "grep"],
    ]);
    const tool = snap.items[2];
    assert.equal(tool.name, "bash");
    assert.equal(tool.text, '{"command":"ls"}');
    assert.equal(tool.id, "e2:t1"); // entry id + block index: stable dedupe key
    assert.ok(tool.ts === Date.parse("2026-01-01T00:00:01.000Z"));
  });

  test("history paging returns the same interleaved order with offsets", () => {
    const page = readHistoryBefore(file, null, 50);
    assert.deepEqual(page.items.map((i) => i.kind), ["user", "assistant", "tool", "tool", "tool"]);
    for (const it of page.items) assert.ok(it.offset >= 0);
    const ids = page.items.map((i) => i.id);
    assert.equal(new Set(ids).size, ids.length); // unique dedupe keys
  });
});

describe("index.html live-streaming wiring", () => {
  const html = readFileSync(join(import.meta.dirname, "..", "src", "index.html"), "utf8");

  test("inline script parses as JavaScript", () => {
    const m = /<script>([\s\S]*?)<\/script>/.exec(html);
    assert.ok(m, "inline script found");
    assert.doesNotMatch(html, /<script\s+src=/i); // still zero external resources
    assert.doesNotThrow(() => new Function(m![1])); // compile-only check
  });

  test("polls /stream and renders the live bubble", () => {
    assert.match(html, /\/stream/);
    assert.match(html, /setInterval\(pollStream, 600\)/);
    assert.match(html, /msg assistant live/);
    assert.match(html, /cursor-blink/);
  });
});
