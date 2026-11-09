import { test, describe, before, after } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, mkdir, writeFile } from "node:fs/promises";
import { statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { readJsonlHistory, type HistoryPage } from "../src/history.ts";
import { readHistoryBefore } from "../src/mainlog.ts";
import { readSubHistory } from "../src/sublog.ts";
import { createBridgeServer } from "../src/server.ts";

/** Write lines and return each line's start offset plus the file path. */
async function writeJsonl(dir: string, name: string, lines: string[]): Promise<{ file: string; starts: number[] }> {
  const file = join(dir, name);
  let off = 0;
  const starts: number[] = [];
  let body = "";
  for (const line of lines) {
    starts.push(off);
    body += line + "\n";
    off += Buffer.byteLength(line, "utf8") + 1;
  }
  await writeFile(file, body);
  assert.equal(statSync(file).size, off);
  return { file, starts };
}

const jparse = (line: string, offset: number): { i: number; offset: number } | null => {
  try {
    const v = JSON.parse(line) as { i?: unknown };
    if (typeof v?.i !== "number") return null;
    return { i: v.i, offset };
  } catch {
    return null;
  }
};

describe("readJsonlHistory (backwards JSONL pager)", () => {
  let dir: string;
  before(async () => { dir = await mkdtemp(join(tmpdir(), "wbhist-")); });

  test("(a) paging backwards twice reaches the file start with oldest=null", async () => {
    const lines = Array.from({ length: 6 }, (_, k) => JSON.stringify({ i: k + 1 }));
    const { file, starts } = await writeJsonl(dir, "a.jsonl", lines);
    const page1 = readJsonlHistory<{ i: number; offset: number }>(file, null, 3, jparse);
    assert.deepEqual(page1.items.map((x) => x.i), [4, 5, 6]); // newest 3, chronological
    assert.equal(page1.oldest, starts[3]); // start of the oldest returned line
    const page2 = readJsonlHistory<{ i: number; offset: number }>(file, page1.oldest, 3, jparse);
    assert.deepEqual(page2.items.map((x) => x.i), [1, 2, 3]);
    assert.equal(page2.oldest, null); // file start reached, nothing earlier
    // Echoing the terminal cursor (null) just re-serves the tail, still well-formed.
    const page3 = readJsonlHistory<{ i: number; offset: number }>(file, page2.oldest, 3, jparse);
    assert.deepEqual(page3.items.map((x) => x.i), [4, 5, 6]);
  });

  test("(b) offsets are true line starts and never overlap", async () => {
    const lines = Array.from({ length: 40 }, (_, k) => JSON.stringify({ i: k + 1, pad: "p".repeat(k * 3) }));
    const { file, starts } = await writeJsonl(dir, "b.jsonl", lines);
    const seen = new Set<number>();
    let before: number | null = null;
    let pages = 0;
    while (pages++ < 20) {
      const page: HistoryPage<{ i: number; offset: number }> = readJsonlHistory(file, before, 7, jparse);
      for (const item of page.items) {
        assert.equal(seen.has(item.offset), false, "offset seen twice across pages");
        seen.add(item.offset);
        assert.equal(starts[item.i - 1], item.offset, `item ${item.i} offset is its line start`);
      }
      if (page.oldest === null) { before = null; break; }
      before = page.oldest;
    }
    assert.equal(before, null); // exhausted the file
    assert.equal(seen.size, 40); // every line surfaced exactly once
  });

  test("(c) a >256KB single line is skipped without breaking offsets", async () => {
    const huge = JSON.stringify({ i: 2, blob: "x".repeat(300 * 1024) }); // valid JSON, over the chunk cap
    const { file, starts } = await writeJsonl(dir, "c.jsonl", [JSON.stringify({ i: 1 }), huge, JSON.stringify({ i: 3 })]);
    const page = readJsonlHistory<{ i: number; offset: number }>(file, null, 10, jparse);
    assert.deepEqual(page.items.map((x) => x.i), [1, 3]); // huge line yields no item…
    assert.equal(page.items[0].offset, starts[0]);
    assert.equal(page.items[1].offset, starts[2]); // …and the line after it keeps its true start
    assert.equal(page.oldest, null);
    // Paging from after the huge line still lands exactly on it (as a line-start cursor).
    const page2 = readJsonlHistory<{ i: number; offset: number }>(file, starts[2], 10, jparse);
    assert.deepEqual(page2.items.map((x) => x.i), [1]);
    assert.equal(page2.oldest, null);
  });

  test("(d) no trailing newline: incomplete tail line is skipped, earlier lines collected", async () => {
    const a = JSON.stringify({ i: 1 });
    const b = JSON.stringify({ i: 2 });
    const tail = JSON.stringify({ i: 3 });
    const file = join(dir, "d.jsonl");
    await writeFile(file, a + "\n" + b + "\n" + tail); // note: no final newline
    const page = readJsonlHistory<{ i: number; offset: number }>(file, null, 10, jparse);
    assert.deepEqual(page.items.map((x) => x.i), [1, 2]);
    assert.equal(page.items[1].offset, Buffer.byteLength(a, "utf8") + 1);
    assert.equal(page.oldest, null);
  });

  test("edge cases: missing file, empty file, before=0, before past EOF, mid-line before", async () => {
    const missing = join(dir, "nope.jsonl");
    assert.deepEqual(readJsonlHistory(missing, null, 5, jparse), { items: [], oldest: null });
    const empty = join(dir, "empty.jsonl");
    await writeFile(empty, "");
    assert.deepEqual(readJsonlHistory(empty, null, 5, jparse), { items: [], oldest: null });
    const lines = [JSON.stringify({ i: 1 }), JSON.stringify({ i: 2 })];
    const { file, starts } = await writeJsonl(dir, "edge.jsonl", lines);
    assert.deepEqual(readJsonlHistory(file, 0, 5, jparse).items, []);
    const tail = readJsonlHistory<{ i: number; offset: number }>(file, 10 ** 9, 5, jparse); // clamps to EOF
    assert.deepEqual(tail.items.map((x) => x.i), [1, 2]);
    const mid = Buffer.byteLength(lines[0], "utf8") / 2; // inside line 1
    const midPage = readJsonlHistory<{ i: number; offset: number }>(file, mid, 5, jparse);
    assert.deepEqual(midPage.items, []); // no complete line strictly before a mid-line offset
    assert.equal(midPage.oldest, null);
    assert.equal(starts.length, 2);
  });
});

describe("history wrappers (main log + subagent log item shapes)", () => {
  let dir: string;
  before(async () => { dir = await mkdtemp(join(tmpdir(), "wbwrap-")); });

  test("(e) readHistoryBefore returns MainLogItem shapes with line-start offsets", async () => {
    const l1 = JSON.stringify({ type: "message", message: { role: "assistant", content: [{ type: "toolCall", id: "t1" }] }, id: "m0" });
    const l2 = JSON.stringify({ type: "custom_message", customType: "web-chat", content: "hello", id: "m1", timestamp: "2026-01-01T00:00:00.000Z" });
    const l3 = "{broken json";
    const l4 = JSON.stringify({ type: "message", message: { role: "assistant", content: [{ type: "text", text: "hi there" }] }, id: "m2", timestamp: 1767225600000 });
    const { file, starts } = await writeJsonl(dir, "session.jsonl", [l1, l2, l3, l4]);
    // Whole file in one page (limit above the line count): oldest is null by contract.
    const whole = readHistoryBefore(file, null, 10);
    assert.deepEqual(whole.items.map((i) => i.kind), ["user", "assistant"]); // noise lines filtered
    assert.equal(whole.oldest, null);
    // Page with limit=1 to exercise real backwards paging across filtered lines.
    const page = readHistoryBefore(file, null, 1);
    assert.deepEqual(page.items.map((i) => i.kind), ["assistant"]);
    assert.equal(page.items[0].text, "hi there");
    assert.equal(page.items[0].id, "m2");
    assert.equal(page.items[0].ts, 1767225600000); // epoch number kept
    assert.equal(page.items[0].offset, starts[3]);
    assert.equal(page.oldest, starts[3]); // oldest examined line = the returned one itself
    const page2 = readHistoryBefore(file, page.oldest, 1);
    assert.deepEqual(page2.items, []); // the malformed line is examined and yields nothing
    assert.equal(page2.oldest, starts[2]); // frontier still advances past skipped lines
    const page3 = readHistoryBefore(file, page2.oldest, 1);
    assert.deepEqual(page3.items.map((i) => i.kind), ["user"]);
    assert.equal(page3.items[0].text, "hello");
    assert.equal(page3.items[0].id, "m1");
    assert.equal(page3.items[0].ts, Date.parse("2026-01-01T00:00:00.000Z")); // ISO string parsed
    assert.equal(page3.items[0].offset, starts[1]);
    assert.equal(page3.oldest, starts[1]); // oldest examined line = the returned one (limit=1)
    const page4 = readHistoryBefore(file, page3.oldest, 1);
    assert.deepEqual(page4.items, []); // toolCall-only assistant line carries no visible text
    assert.equal(page4.oldest, null); // file start reached
  });

  test("(e) readSubHistory returns SubLogLine shapes and pages backwards", async () => {
    const subDir = join(dir, "sa-hist");
    await mkdir(subDir);
    const TASK = JSON.stringify({ type: "message_end", message: { role: "user", content: [{ type: "text", text: "do the thing" }] } });
    const MODEL = JSON.stringify({ type: "message_start", message: { role: "assistant", content: [], model: "m" } });
    const TOOL = JSON.stringify({ type: "tool_execution_start", toolCallId: "t9", toolName: "bash", args: { cmd: "ls" } });
    const REPORT = JSON.stringify({ type: "tool_execution_start", toolCallId: "t10", toolName: "report_to_parent", args: { status: "progress", summary: "halfway" } });
    const ASSIST = JSON.stringify({ type: "message_end", message: { role: "assistant", content: [{ type: "text", text: "working on it" }] } });
    const SETTLED = JSON.stringify({ type: "agent_settled" });
    const { file, starts } = await writeJsonl(subDir, "events.jsonl", [TASK, MODEL, TOOL, REPORT, ASSIST, SETTLED]);
    const page1 = readSubHistory(subDir, "sa-hist", null, 3);
    assert.equal(page1.id, "sa-hist");
    assert.deepEqual(page1.lines.map((l) => [l.kind, l.name]), [
      ["report", "progress"], ["assistant", undefined], ["event", "settled"],
    ]); // newest 3 parseable lines, chronological; message_start filtered
    assert.equal(page1.lines[0].text, "halfway");
    assert.equal(page1.lines[1].text, "working on it");
    assert.equal(page1.lines[0].offset, starts[3]);
    assert.equal(page1.oldest, starts[3]);
    const page2 = readSubHistory(subDir, "sa-hist", page1.oldest, 3);
    assert.deepEqual(page2.lines.map((l) => [l.kind, l.name]), [["event", "task"], ["tool", "bash"]]);
    assert.equal(page2.lines[0].text, "do the thing");
    assert.equal(page2.lines[1].text, JSON.stringify({ cmd: "ls" }).slice(0, 200)); // tool args preview
    assert.equal(page2.lines[1].offset, starts[2]);
    assert.equal(page2.oldest, null);
    assert.equal(statSync(file).size > 0, true);
  });
});

describe("GET /history and /sub-history routes", () => {
  let subDir: string;
  let sessionFile: string;
  let server: ReturnType<typeof createBridgeServer>;
  let url: string;

  before(async () => {
    subDir = await mkdtemp(join(tmpdir(), "wbroute-"));
    await mkdir(join(subDir, "sa-live"));
    await writeFile(join(subDir, "sa-live", "events.jsonl"),
      JSON.stringify({ type: "message_end", message: { role: "user", content: [{ type: "text", text: "task one" }] } }) + "\n" +
      JSON.stringify({ type: "tool_execution_start", toolCallId: "t1", toolName: "bash", args: {} }) + "\n" +
      JSON.stringify({ type: "agent_settled" }) + "\n");
    const lines = Array.from({ length: 5 }, (_, k) =>
      JSON.stringify({ type: "custom_message", customType: "web-chat", content: `msg ${k + 1}`, id: `m${k + 1}` }));
    sessionFile = join(subDir, "session.jsonl");
    await writeFile(sessionFile, lines.join("\n") + "\n");
    server = createBridgeServer({
      project: "TestProj",
      inject: () => true,
      sessionFile: () => sessionFile,
      subagentsDir: () => subDir,
      indexHtml: () => "<html><body>test</body></html>",
      log: () => {},
    });
    await new Promise<void>((res) => server.listen(0, "127.0.0.1", res));
    const { port } = server.address() as { port: number };
    url = `http://127.0.0.1:${port}`;
  });
  after(() => server.closeBridge());

  test("/history serves the newest page and pages backwards via ?before=", async () => {
    const r0 = await fetch(`${url}/history`);
    assert.equal(r0.status, 200);
    const b0 = (await r0.json()) as any;
    assert.deepEqual(b0.items.map((i: any) => i.text), ["msg 1", "msg 2", "msg 3", "msg 4", "msg 5"]);
    assert.equal(b0.oldest, null); // default limit covers the whole file
    const r1 = await fetch(`${url}/history?limit=2`);
    assert.equal(r1.status, 200);
    const b1 = (await r1.json()) as any;
    assert.deepEqual(b1.items.map((i: any) => i.text), ["msg 4", "msg 5"]);
    assert.equal(typeof b1.oldest, "number");
    for (const it of b1.items) assert.equal(typeof it.offset, "number");
    const r2 = await fetch(`${url}/history?limit=2&before=${b1.oldest}`);
    assert.equal(r2.status, 200);
    const b2 = (await r2.json()) as any;
    assert.deepEqual(b2.items.map((i: any) => i.text), ["msg 2", "msg 3"]);
    assert.equal(typeof b2.oldest, "number");
    const r3 = await fetch(`${url}/history?limit=2&before=${b2.oldest}`);
    const b3 = (await r3.json()) as any;
    assert.deepEqual(b3.items.map((i: any) => i.text), ["msg 1"]);
    assert.equal(b3.oldest, null); // whole file consumed
  });

  test("/history honours ?limit= and tolerates bad ?before=", async () => {
    const r = await fetch(`${url}/history?limit=2`);
    const b = (await r.json()) as any;
    assert.equal(b.items.length, 2);
    assert.deepEqual(b.items.map((i: any) => i.text), ["msg 4", "msg 5"]);
    const bad = await fetch(`${url}/history?before=not-a-number`);
    assert.equal(bad.status, 200); // clamps to the tail instead of failing
    const bb = (await bad.json()) as any;
    assert.equal(bb.items.length, 5);
  });

  test("/sub-history serves a subagent window; unknown id is an empty 200", async () => {
    const r = await fetch(`${url}/sub-history?id=sa-live`);
    assert.equal(r.status, 200);
    const b = (await r.json()) as any;
    assert.equal(b.id, "sa-live");
    assert.deepEqual(b.lines.map((l: any) => [l.kind, l.name]), [["event", "task"], ["tool", "bash"], ["event", "settled"]]);
    assert.equal(b.oldest, null);
    const missing = await fetch(`${url}/sub-history?id=sa-ghost`);
    assert.equal(missing.status, 200);
    assert.deepEqual((await missing.json()) as any, { id: "sa-ghost", lines: [], oldest: null });
  });

  test("/sub-history rejects ids that fail SUBAGENT_ID_RE with 400", async () => {
    for (const id of ["../evil", "", "sa x", "%2e%2e"]) {
      const r = await fetch(`${url}/sub-history?id=${encodeURIComponent(id)}`);
      assert.equal(r.status, 400, id);
      const b = (await r.json()) as any;
      assert.equal(b.ok, false);
    }
  });
});
