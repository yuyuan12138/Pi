import { test, describe, before, after } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync, readFileSync, appendFileSync } from "node:fs";
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
  STREAM_MAX_TOOLS,
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
    assert.equal(b.snapshot().tool, null); // legacy slot is streaming-only
    b.reset();
    const s = b.snapshot();
    assert.equal(s.streaming, false);
    assert.equal(s.text, "");
    assert.equal(s.turnStartedAt, null);
    assert.equal(s.tool, null);
    assert.deepEqual(s.tools, []);
    assert.ok(typeof s.runStartedAt === "number" && s.runStartedAt > 0); // fresh run epoch
  });

  test("tool calls accumulate across the run: multiple blocks, several messages, in order", () => {
    const b = new StreamBuffer();
    b.startAssistant();
    // two toolCall blocks in one partial message: both lines, content order
    b.update(partial([
      { type: "text", text: "working" },
      { type: "toolCall", id: "tcA", name: "subagent_spawn", arguments: { task: "do things" } },
      { type: "toolCall", id: "tcB", name: "bash", arguments: { command: "sleep 1" } },
    ]));
    assert.deepEqual(b.snapshot().tools, [
      { id: "tcA", name: "subagent_spawn", summary: '{"task":"do things"}' },
      { id: "tcB", name: "bash", summary: '{"command":"sleep 1"}' },
    ]);
    // next assistant message of the SAME run: earlier calls stay, new one appends
    b.endAssistant(partial([
      { type: "text", text: "working" },
      { type: "toolCall", id: "tcA", name: "subagent_spawn", arguments: { task: "do things" } },
      { type: "toolCall", id: "tcB", name: "bash", arguments: { command: "sleep 1" } },
    ]));
    b.startAssistant();
    b.update(partial([
      { type: "text", text: "next step" },
      { type: "toolCall", id: "tcC", name: "read", arguments: { path: "a.txt" } },
    ]));
    assert.deepEqual(b.snapshot().tools.map((t) => t.id), ["tcA", "tcB", "tcC"]);
    // legacy single slot mirrors the CURRENT message's last block only
    assert.deepEqual(b.snapshot().tool, { name: "read", summary: '{"path":"a.txt"}' });
    // ...and is null while streaming a message that has no tool call yet
    b.startAssistant();
    b.update(partial([{ type: "text", text: "thinking" }]));
    assert.equal(b.snapshot().tool, null);
    assert.deepEqual(b.snapshot().tools.map((t) => t.id), ["tcA", "tcB", "tcC"]);
    b.reset();
    assert.deepEqual(b.snapshot().tools, []); // a new run wipes the accumulation
  });

  test("a repeated toolCall id updates in place (summary refinement, no duplicate)", () => {
    const b = new StreamBuffer();
    b.startAssistant();
    b.update(partial([{ type: "toolCall", id: "tcX", name: "bash", arguments: { command: "sle" } }]));
    b.update(partial([{ type: "toolCall", id: "tcX", name: "bash", arguments: { command: "sleep 3600" } }]));
    const s = b.snapshot();
    assert.equal(s.tools.length, 1);
    assert.deepEqual(s.tools[0], { id: "tcX", name: "bash", summary: '{"command":"sleep 3600"}' });
  });

  test("id-less blocks get a stable synthetic id; a late real id replaces it in place", () => {
    const b = new StreamBuffer();
    b.startAssistant();
    b.update(partial([{ type: "toolCall", name: "bash", arguments: { command: "ls" } }]));
    const synthetic = b.snapshot().tools[0].id;
    assert.ok(synthetic.startsWith("m"));
    // same block (same message + position) now carries its real id
    b.update(partial([{ type: "toolCall", id: "toolu_1", name: "bash", arguments: { command: "ls" } }]));
    const s = b.snapshot();
    assert.deepEqual(s.tools, [{ id: "toolu_1", name: "bash", summary: '{"command":"ls"}' }]);
  });

  test("the run tool list is bounded to the last STREAM_MAX_TOOLS calls", () => {
    const b = new StreamBuffer();
    b.startAssistant();
    const blocks: unknown[] = [];
    for (let i = 0; i < STREAM_MAX_TOOLS + 5; i++) {
      blocks.push({ type: "toolCall", id: `t${i}`, name: "bash", arguments: { n: i } });
    }
    b.update(partial(blocks));
    const s = b.snapshot();
    assert.equal(s.tools.length, STREAM_MAX_TOOLS);
    assert.equal(s.tools[0].id, "t5"); // oldest dropped
    assert.equal(s.tools[s.tools.length - 1].id, `t${STREAM_MAX_TOOLS + 4}`);
  });

  test("toolOf stays a bounded single-slot view of the last block (legacy shape)", () => {
    const t = toolOf(partial([
      { type: "toolCall", id: "a", name: "read", arguments: { path: "x" } },
      { type: "toolCall", id: "b", name: "bash", arguments: { command: "y" } },
    ]));
    assert.deepEqual(t, { name: "bash", summary: '{"command":"y"}' }); // no id: legacy consumers unaffected
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
      assert.deepEqual(await get(), { streaming: false, text: "", turnStartedAt: null, runStartedAt: null, tool: null, tools: [] });

      // run starts, user message_start is ignored, assistant streams
      handlers.get("agent_start")?.({}, {});
      handlers.get("message_start")?.({ type: "message_start", message: { role: "user", content: [{ type: "text", text: "hi" }] } }, {});
      let runSnap = await get();
      assert.equal(runSnap.streaming, false);
      assert.equal(runSnap.text, "");
      assert.equal(runSnap.turnStartedAt, null);
      assert.equal(runSnap.tool, null);
      assert.deepEqual(runSnap.tools, []);
      assert.ok(typeof runSnap.runStartedAt === "number" && runSnap.runStartedAt > 0);
      const runEpoch = runSnap.runStartedAt;

      handlers.get("message_start")?.({ type: "message_start", message: { role: "assistant", content: [] } }, {});
      let snap = await get();
      assert.equal(snap.streaming, true);
      assert.equal(snap.text, "");
      assert.ok(snap.turnStartedAt > 0);
      assert.deepEqual(snap.tools, []);

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
      assert.equal(snap.tools.length, 1); // cumulative list carries an id
      assert.equal(snap.tools[0].name, "bash");
      assert.ok(typeof snap.tools[0].id === "string" && snap.tools[0].id.length > 0);
      assert.equal(snap.runStartedAt, runEpoch); // same run

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

      // THE BUG: the next assistant message of the run forms a different tool —
      // the earlier call must STAY in the cumulative list (terminal parity).
      handlers.get("message_start")?.({ type: "message_start", message: { role: "assistant", content: [] } }, {});
      handlers.get("message_update")?.({
        type: "message_update",
        message: partial([{ type: "text", text: "next" }, { type: "toolCall", id: "tcB", name: "read", arguments: { path: "a.txt" } }]),
      }, {});
      snap = await get();
      assert.equal(snap.streaming, true);
      assert.deepEqual(snap.tools.map((t) => [t.id, t.name]), [[snap.tools[0].id, "bash"], ["tcB", "read"]]);
      assert.deepEqual(snap.tool, { name: "read", summary: '{"path":"a.txt"}' }); // single slot = current message only
      handlers.get("message_end")?.({
        type: "message_end",
        message: partial([{ type: "text", text: "next" }, { type: "toolCall", id: "tcB", name: "read", arguments: { path: "a.txt" } }]),
      }, {});
      snap = await get();
      assert.equal(snap.streaming, false);
      assert.equal(snap.tools.length, 2); // tools survive the settle window for the UI handoff

      // a toolCall-only assistant message clears the text
      handlers.get("message_start")?.({ type: "message_start", message: { role: "assistant", content: [] } }, {});
      handlers.get("message_end")?.({ type: "message_end", message: partial([{ type: "toolCall", name: "read", arguments: {} }]) }, {});
      snap = await get();
      assert.equal(snap.streaming, false);
      assert.equal(snap.text, "");

      // next run wipes stale content (incl. the tool accumulation); abort settles without losing text
      handlers.get("agent_start")?.({}, {});
      runSnap = await get();
      assert.equal(runSnap.streaming, false);
      assert.equal(runSnap.text, "");
      assert.equal(runSnap.turnStartedAt, null);
      assert.equal(runSnap.tool, null);
      assert.deepEqual(runSnap.tools, []);
      assert.ok(typeof runSnap.runStartedAt === "number" && runSnap.runStartedAt >= runEpoch);
      handlers.get("message_start")?.({ type: "message_start", message: { role: "assistant", content: [] } }, {});
      handlers.get("message_update")?.({ type: "message_update", message: partial([{ type: "text", text: "partial" }]) }, {});
      handlers.get("agent_settled")?.({ type: "agent_settled", aborted: true }, {});
      snap = await get();
      assert.equal(snap.streaming, false);
      assert.equal(snap.text, "partial"); // kept so the UI can hand off to /main-log
      assert.equal(snap.tools.length, 0);
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

  test("incremental polls deliver the entry that starts exactly at the client cursor", () => {
    // Regression: the client cursor is the byte where UNDELIVERED data begins,
    // and the next appended line starts exactly there. The old `offset > after`
    // filter dropped that boundary entry — during a live turn, the first log
    // line after every poll (often the assistant reply text) silently never
    // reached the UI.
    const dir = mkdtempSync(join(tmpdir(), "web-bridge-incr-"));
    const f = join(dir, "session.jsonl");
    try {
      const mk = (id, n) => JSON.stringify({ type: "custom_message", id, timestamp: `2026-01-01T00:00:0${n}.000Z`, customType: "web-chat", content: `msg ${id}` });
      writeFileSync(f, mk("a", 0) + "\n");
      const reader = new MainLogReader();
      reader.attach(f);
      let snap = reader.consume(null);
      assert.equal(snap.reset, true);
      const seen = snap.items.map((i) => i.id);
      let cursor = snap.cursor;
      for (let n = 1; n <= 3; n++) {
        appendFileSync(f, mk(String.fromCharCode(97 + n), n) + "\n");
        snap = reader.consume(cursor);
        assert.equal(snap.reset, false);
        seen.push(...snap.items.map((i) => i.id));
        cursor = snap.cursor;
      }
      assert.deepEqual(seen, ["a", "b", "c", "d"]); // every entry delivered exactly once
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe("main log deep-read (catch-up below the ring start)", () => {
  test("a cursor behind the ring serves the contiguous byte range, not a gappy ring tail", () => {
    const dir = mkdtempSync(join(tmpdir(), "web-bridge-deep-"));
    const file = join(dir, "session.jsonl");
    try {
      // 340 parseable user entries: the 300-item ring keeps only the last 300,
      // so any cursor before the 41st line falls below the ring start.
      const offsets: number[] = [];
      const chunks: string[] = [];
      for (let i = 1; i <= 340; i++) {
        const line = JSON.stringify({
          type: "custom_message", id: `u${i}`, timestamp: "2026-01-01T00:00:00.000Z",
          customType: "web-chat", content: `message ${i} ${"x".repeat(80)}`,
        });
        offsets.push(chunks.reduce((n, c) => n + Buffer.byteLength(c), 0));
        chunks.push(line + "\n");
      }
      writeFileSync(file, chunks.join(""));
      const size = Buffer.byteLength(chunks.join(""));

      const reader = new MainLogReader();
      reader.attach(file);
      const first = reader.consume(null);
      assert.equal(first.reset, true);
      assert.equal(first.items.length, 300); // ring tail
      assert.ok(first.items[0].offset > offsets[9]); // lines 1..40 are already out of the ring

      // A client whose cursor sits at line 10 (below the ring start) with the
      // matching ?file= gets a CONTIGUOUS deep-read from its own cursor...
      const deep = reader.consume(offsets[9], file);
      assert.equal(deep.reset, false);
      assert.equal(deep.cursor, size); // whole gap fits one 512KB chunk
      assert.equal(deep.items.length, 331); // lines 10..340
      assert.equal(deep.items[0].id, "u10");
      assert.equal(deep.items[0].offset, offsets[9]);
      for (let i = 0; i < deep.items.length; i++) assert.equal(deep.items[i].id, `u${10 + i}`);

      // ...while a stale/absent file identity keeps the old reset behavior
      const stale = reader.consume(offsets[9], join(dir, "other.jsonl"));
      assert.equal(stale.reset, true);
      assert.equal(stale.items.length, 300);
      const noFile = reader.consume(offsets[9]);
      assert.equal(noFile.reset, true);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test("deep-read walks forward over polls when the gap exceeds the byte cap", () => {
    const dir = mkdtempSync(join(tmpdir(), "web-bridge-deep2-"));
    const file = join(dir, "session.jsonl");
    try {
      // ~6000 lines x ~120B ≈ 720KB: more than one 512KB deep-read chunk.
      const chunks: string[] = [];
      for (let i = 1; i <= 6000; i++) {
        chunks.push(JSON.stringify({
          type: "custom_message", id: `u${i}`, timestamp: "2026-01-01T00:00:00.000Z",
          customType: "web-chat", content: `message ${i} ${"y".repeat(60)}`,
        }) + "\n");
      }
      writeFileSync(file, chunks.join(""));
      const size = Buffer.byteLength(chunks.join(""));

      const reader = new MainLogReader();
      reader.attach(file);
      reader.consume(null); // warm the ring
      let after: number | null = 0;
      let total = 0;
      let polls = 0;
      while (after !== null && after < size && polls < 10) {
        const snap = reader.consume(after, file);
        assert.equal(snap.reset, false);
        for (const it of snap.items) assert.equal(it.id, `u${1 + total + snap.items.indexOf(it)}`); // no gaps, no dups
        total += snap.items.length;
        polls++;
        after = snap.cursor;
      }
      assert.equal(after, size); // walked all the way to the live frontier
      assert.equal(total, 6000); // every item delivered exactly once
      assert.ok(polls >= 2); // genuinely chunked
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
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

  test("cumulative in-flight tool lines: keyed append, settled-twin consumption", () => {
    assert.match(html, /live-tools/); // keyed container in the live bubble
    assert.match(html, /dataset\.tid/); // one line per toolCall id, updated in place
    assert.match(html, /snap\.tools/); // cumulative run list from GET /stream
    assert.match(html, /runStartedAt/); // run-boundary detection (server reset)
    assert.match(html, /coverSettledTools/); // settled twins consume live lines exactly once
    assert.match(html, /argsCover/); // name+args matching against /main-log tool items
  });

  test("live bubble consume guard is strict: an older entry can never blank fresh text", () => {
    // 571d045 follow-up: the suffix fallback previously tolerated a 2000ms
    // window in which the PREVIOUS message's entry could consume the live
    // bubble of a short repetitive reply. The guard is now message-start strict.
    assert.match(html, /ts < live\.startedAt - 300/);
    assert.doesNotMatch(html, /live\.startedAt - 2000/);
  });

  test("resume keeps byte cursors; the server deep-reads the gap (no reset merge holes)", () => {
    assert.match(html, /file=\$\{encodeURIComponent\(w\.file\)\}/); // /main-log echoes the session file
    assert.match(html, /Byte cursors stay valid across suspension/);
    assert.doesNotMatch(html, /fullRebuild/); // cursor-nulling rebuild removed
  });

  test("file upload/download UI wiring (attach, drop, chip, /file links)", () => {
    assert.match(html, /id="file-input"/);
    assert.match(html, /id="attach"/);
    assert.match(html, /\/file\?name=\$\{encodeURIComponent/); // upload POST
    assert.match(html, /\[web-chat file\]/); // auto-send referencing message
    assert.match(html, /dataTransfer\?\.files/); // drag-drop onto the composer
    assert.match(html, /className = "chip"/); // file chip rendering
    assert.match(html, /download target="_blank"/); // assistant /file/<name> links
    assert.match(html, /uploading\\u2026|uploading…/); // pending upload state
  });
});
