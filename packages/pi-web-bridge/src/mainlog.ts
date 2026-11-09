import { openSync, readSync, closeSync, fstatSync, statSync } from "node:fs";
import { readJsonlHistory, type HistoryPage } from "./history.ts";
import { usageStats, type UsageStats } from "./usage.ts";

/**
 * Incremental reader for the main session JSONL.
 *
 * The session file is append-only. We track a byte cursor and only parse the
 * newly appended complete lines, keeping a bounded ring of interesting items:
 *   - custom_message entries with customType "web-chat"  -> messages sent from the web UI
 *   - message entries with role "assistant"              -> coordinator replies (text parts only)
 * Everything else (tool calls, thinking, system, compaction, other extensions'
 * custom messages) is ignored — v1 shows exactly the web conversation.
 */

export interface MainLogItem {
  kind: "user" | "assistant" | "tool";
  /** Tool name (kind "tool" only). */
  name?: string;
  text: string;
  /** Epoch ms from the entry timestamp, when present. */
  ts: number | null;
  /** Session entry id (dedupe key for the UI); tool items use "<entryId>:t<blockIndex>". */
  id: string;
  /** Byte offset of the line this item came from (client resume cursor). */
  offset: number;
}

export interface MainLogSnapshot {
  file: string | null;
  /** Byte cursor the server has consumed. Clients echo it back as ?after=. */
  cursor: number;
  /** True when the client must replace its view with the returned items (unknown cursor / session change). */
  reset: boolean;
  items: MainLogItem[];
  /** Whole-run usage aggregates for the coordinator session (additive; omitted while warming). */
  stats?: UsageStats;
}

const MAX_ITEM_CHARS = 16_000;
const MAX_TOOL_PREVIEW_CHARS = 200;
/** Deep-read catch-up chunk when a client cursor has fallen behind the ring. */
const DEEP_READ_MAX_BYTES = 512 * 1024;
/** A single log line longer than this is skipped via the old reset path. */
const DEEP_LINE_HARD_CAP = 8 * 1024 * 1024;
/** Item bound for one deep-read response (the client walks forward over polls). */
const MAX_DEEP_ITEMS = 2000;

function toolPreview(args: unknown): string {
  try { return (JSON.stringify(args) ?? "").slice(0, MAX_TOOL_PREVIEW_CHARS); } catch { return ""; }
}

function readSlice(fd: number, start: number, len: number): string {
  const buf = Buffer.alloc(len);
  const n = readSync(fd, buf, 0, len, start);
  return buf.subarray(0, n).toString("utf8");
}

/**
 * Parse one session-JSONL line into displayable items, in message order:
 * a web-chat custom message becomes the user item; an assistant entry yields
 * its text as one item plus one compact line per toolCall block, interleaved
 * in content-array order (terminal-like activity flow). toolResult entries are
 * intentionally skipped — the call line plus the next assistant text is the
 * same information flow the terminal shows.
 */
function parseMainLine(line: string): MainLogItem[] {
  let ev: any;
  try { ev = JSON.parse(line); } catch { return []; }
  if (ev?.type === "custom_message" && ev.customType === "web-chat" && typeof ev.content === "string") {
    return [{ kind: "user", text: ev.content.slice(0, MAX_ITEM_CHARS), ts: numOr(ev.timestamp), id: String(ev.id ?? ""), offset: -1 }];
  }
  if (ev?.type === "message" && ev.message?.role === "assistant") {
    const content: any[] = Array.isArray(ev.message.content) ? ev.message.content : [];
    const id = String(ev.id ?? "");
    const ts = numOr(ev.timestamp);
    const items: MainLogItem[] = [];
    let textParts: string[] = [];
    const flushText = () => {
      const text = textParts.join("\n").trim();
      if (text) items.push({ kind: "assistant", text: text.slice(0, MAX_ITEM_CHARS), ts, id, offset: -1 });
      textParts = [];
    };
    content.forEach((c: any, i: number) => {
      if (c?.type === "text" && typeof c.text === "string") { textParts.push(c.text); return; }
      if (c?.type === "toolCall" && typeof c.name === "string") {
        flushText();
        items.push({ kind: "tool", name: c.name, text: toolPreview(c.arguments), ts, id: `${id}:t${i}`, offset: -1 });
      }
    });
    flushText();
    return items;
  }
  return [];
}

function numOr(v: unknown): number | null {
  if (typeof v === "number" && Number.isFinite(v)) return v;
  if (typeof v === "string") { const t = Date.parse(v); return Number.isFinite(t) ? t : null; } // session JSONL uses ISO strings
  return null;
}

/**
 * Backwards paged history over the session JSONL, independent of the live ring.
 * Thin wrapper over the shared readJsonlHistory pager with the main-log parser.
 */
export function readHistoryBefore(file: string, before: number | null, limit = 200): HistoryPage<MainLogItem> {
  return readJsonlHistory<MainLogItem>(file, before, limit, (line, offset) => {
    const items = parseMainLine(line);
    for (const item of items) item.offset = offset;
    return items;
  });
}

export class MainLogReader {
  private file: string | undefined;
  private cursor = 0;
  private partial = "";
  private items: MainLogItem[] = [];
  private epoch = 0;
  readonly maxItems: number;
  readonly backfillBytes: number;

  constructor(maxItems = 300, backfillBytes = 512 * 1024) {
    this.maxItems = maxItems;
    this.backfillBytes = backfillBytes;
  }

  /** Point at a (new) session file; resets state when the path changes. */
  attach(file: string | undefined): void {
    if (file === this.file) return;
    this.file = file;
    this.cursor = 0;
    this.partial = "";
    this.items = [];
    this.epoch++;
  }

  /**
   * Ingest any newly appended data, then answer a client polling with ?after=<cursor>.
   * after=null (first poll) always yields a reset snapshot with the current ring.
   *
   * `clientFile` (additive ?file= query param) is the session path the client's
   * cursor was minted against; the deep-read below only fires when it matches
   * the currently attached file, so a cursor carried across a session switch
   * can never be applied as byte math to another file.
   */
  consume(after: number | null, clientFile?: string): MainLogSnapshot {
    this.ingest();
    const file = this.file ?? null;
    // Additive whole-run aggregates, independent of the item ring; null while a large
    // cold session file is still warming in the background.
    const stats = file ? usageStats(file) ?? undefined : undefined;
    // Deep-read: when the client's cursor has fallen behind the ring start (a
    // busy turn outpacing the item ring, a suspended tab), the old ring-tail
    // reset opened a silent hole — mergeReset kept the client's older items
    // plus the newest ring items and dropped everything in between, so
    // assistant messages vanished from the middle of the view. The ring is
    // only a cache over the append-only log: serve the contiguous byte range
    // straight from the client's cursor instead (reset=false — the client
    // appends and keeps walking forward on later polls).
    if (
      file && after !== null && Number.isFinite(after) && after >= 0 &&
      after < this.ringStart() && clientFile === this.file
    ) {
      const deep = this.deepRead(after);
      if (deep) return { ...deep, stats };
    }
    if (after === null || !Number.isFinite(after) || after > this.cursor || after < this.ringStart()) {
      return { file, cursor: this.cursor, reset: true, items: [...this.items], stats };
    }
    if (after === this.cursor) return { file, cursor: this.cursor, reset: false, items: [], stats };
    // The client cursor is the byte offset where its UNDELIVERED data begins,
    // and the next log line starts exactly there — so the boundary item must
    // be INCLUDED (offset >= after). The old `>` comparison dropped the first
    // new line of every incremental batch: during a live turn, whichever
    // entry was written right after a poll (often the assistant reply text,
    // sometimes a tool line) silently never rendered — messages appearing to
    // vanish / be pushed out mid-turn.
    return { file, cursor: this.cursor, reset: false, items: this.items.filter((i) => i.offset >= after), stats };
  }

  /**
   * Contiguous catch-up read from a client byte cursor that has fallen behind
   * the ring. Bounded per response; the client keeps polling and walks forward.
   * Returns null when no progress is possible (a single line beyond the hard
   * cap) so the caller falls back to the ring-tail reset.
   */
  private deepRead(from: number): MainLogSnapshot | null {
    const file = this.file;
    if (!file) return null;
    let size: number;
    try { size = statSync(file).size; } catch { return null; }
    const limit = Math.min(this.cursor, size);
    if (from >= limit) return null;
    let fd: number | undefined;
    let chunk = "";
    let end = Math.min(limit, from + DEEP_READ_MAX_BYTES);
    try {
      fd = openSync(file, "r");
      chunk = readSlice(fd, from, end - from);
      // A single line longer than the chunk (a huge toolResult, say): keep
      // reading until a newline shows up so the cursor can jump past it —
      // otherwise the client would poll the same offset forever.
      let guard = 0;
      while (!chunk.includes("\n") && end < limit && guard++ < 16 && end - from <= DEEP_LINE_HARD_CAP) {
        const next = Math.min(limit, end + DEEP_READ_MAX_BYTES);
        chunk += readSlice(fd, end, next - end);
        end = next;
      }
    } catch {
      return null;
    } finally {
      if (fd !== undefined) try { closeSync(fd); } catch { /* ignore */ }
    }
    const lastNl = chunk.lastIndexOf("\n");
    if (lastNl < 0) return null; // one giant line beyond the hard cap: old reset behavior
    const complete = chunk.slice(0, lastNl + 1);
    const lines = complete.split("\n");
    if (lines[lines.length - 1] === "") lines.pop(); // split artifact of the trailing newline
    const items: MainLogItem[] = [];
    let off = from;
    let consumed = from;
    for (const line of lines) {
      const lineOffset = off;
      off += Buffer.byteLength(line + "\n", "utf8");
      consumed = off;
      if (!line.trim()) continue;
      for (const item of parseMainLine(line)) {
        item.offset = lineOffset;
        items.push(item);
      }
      if (items.length >= MAX_DEEP_ITEMS) break;
    }
    return { file, cursor: consumed, reset: false, items };
  }

  private ringStart(): number {
    return this.items.length ? this.items[0].offset : this.cursor;
  }

  private ingest(): void {
    if (!this.file) return;
    let st;
    try { st = statSync(this.file); } catch { return; }
    if (st.size < this.cursor) { // file replaced/truncated: start over
      this.cursor = 0;
      this.partial = "";
      this.items = [];
      this.epoch++;
    }
    if (st.size === this.cursor) return;
    let buf: string;
    if (this.cursor === 0 && st.size > this.backfillBytes) {
      // Attach to a big existing session: backfill only the tail, aligned to the next line start.
      let fd: number | undefined;
      try {
        fd = openSync(this.file, "r");
        const start = st.size - this.backfillBytes;
        const len = st.size - start;
        const raw = Buffer.alloc(len);
        const n = readSync(fd, raw, 0, len, start);
        let s = raw.subarray(0, n).toString("utf8");
        const nl = s.indexOf("\n");
        if (nl >= 0) s = s.slice(nl + 1); // drop the partial first line
        buf = s;
        this.cursor = st.size; // everything read here is complete lines; remainder stays for next poll
      } catch {
        return;
      } finally {
        if (fd !== undefined) try { closeSync(fd); } catch { /* ignore */ }
      }
      buf = buf + this.partial;
      this.partial = "";
      this.absorb(buf, st.size);
      return;
    }
    let fd: number | undefined;
    try {
      fd = openSync(this.file, "r");
      const len = st.size - this.cursor;
      const raw = Buffer.alloc(len);
      const n = readSync(fd, raw, 0, len, this.cursor);
      buf = this.partial + raw.subarray(0, n).toString("utf8");
    } catch {
      return;
    } finally {
      if (fd !== undefined) try { closeSync(fd); } catch { /* ignore */ }
    }
    const lastNl = buf.lastIndexOf("\n");
    if (lastNl < 0) { this.partial = buf; return; }
    this.partial = buf.slice(lastNl + 1);
    const complete = buf.slice(0, lastNl + 1);
    this.cursor = st.size - Buffer.byteLength(this.partial, "utf8");
    this.absorb(complete, this.cursor);
  }

  /** Parse complete lines, advance the ring, remember per-item offsets. */
  private absorb(complete: string, endOffset: number): void {
    const lines = complete.split("\n");
    // Offset bookkeeping: walk lines and accumulate byte lengths up to endOffset.
    let off = endOffset - Buffer.byteLength(complete, "utf8");
    for (const line of lines) {
      const lineBytes = Buffer.byteLength(line + "\n", "utf8");
      const lineOffset = off;
      off += lineBytes;
      if (!line.trim()) continue;
      for (const item of parseMainLine(line)) {
        item.offset = lineOffset;
        this.items.push(item);
      }
    }
    if (this.items.length > this.maxItems) this.items = this.items.slice(-this.maxItems);
  }

  /** Test/inspection hook. */
  get epochId(): number { return this.epoch; }
}
