import { openSync, readSync, closeSync, fstatSync, statSync } from "node:fs";

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
  kind: "user" | "assistant";
  text: string;
  /** Epoch ms from the entry timestamp, when present. */
  ts: number | null;
  /** Session entry id (dedupe key for the UI). */
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
}

const MAX_ITEM_CHARS = 16_000;

function parseEntry(line: string): MainLogItem | null {
  let ev: any;
  try { ev = JSON.parse(line); } catch { return null; }
  if (ev?.type === "custom_message" && ev.customType === "web-chat" && typeof ev.content === "string") {
    return { kind: "user", text: ev.content.slice(0, MAX_ITEM_CHARS), ts: numOr(ev.timestamp), id: String(ev.id ?? ""), offset: -1 };
  }
  if (ev?.type === "message" && ev.message?.role === "assistant") {
    const parts = (ev.message.content ?? []).filter((c: any) => c?.type === "text" && typeof c.text === "string").map((c: any) => c.text);
    const text = parts.join("\n").trim();
    if (!text) return null; // toolCall-only assistant messages carry no visible text
    return { kind: "assistant", text: text.slice(0, MAX_ITEM_CHARS), ts: numOr(ev.timestamp), id: String(ev.id ?? ""), offset: -1 };
  }
  return null;
}

function numOr(v: unknown): number | null {
  if (typeof v === "number" && Number.isFinite(v)) return v;
  if (typeof v === "string") { const t = Date.parse(v); return Number.isFinite(t) ? t : null; } // session JSONL uses ISO strings
  return null;
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
   */
  consume(after: number | null): MainLogSnapshot {
    this.ingest();
    const file = this.file ?? null;
    if (after === null || !Number.isFinite(after) || after > this.cursor || after < this.ringStart()) {
      return { file, cursor: this.cursor, reset: true, items: [...this.items] };
    }
    if (after === this.cursor) return { file, cursor: this.cursor, reset: false, items: [] };
    return { file, cursor: this.cursor, reset: false, items: this.items.filter((i) => i.offset > after) };
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
      const item = parseEntry(line);
      if (item) {
        item.offset = lineOffset;
        this.items.push(item);
      }
    }
    if (this.items.length > this.maxItems) this.items = this.items.slice(-this.maxItems);
  }

  /** Test/inspection hook. */
  get epochId(): number { return this.epoch; }
}
