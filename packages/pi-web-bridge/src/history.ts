import { openSync, readSync, closeSync, statSync } from "node:fs";

/**
 * Generic backwards-paged history over an append-only JSONL log.
 * `before` is a byte offset of a line start (or null for the file tail); returns
 * up to `limit` parsed items strictly before it in chronological order, plus
 * `oldest`: the byte offset of the oldest line examined — a line start the
 * caller echoes back as the next page's `before` — or null when the file start
 * was reached (no earlier history).
 *
 * Only lines with a terminating newline are parsed: the possibly-incomplete
 * tail fragment below `before` is skipped by construction. Lines longer than
 * one chunk (no two newlines within CHUNK_BYTES) are stepped over without
 * breaking the offsets of neighbouring lines.
 */
export interface HistoryPage<T> {
  items: T[];
  oldest: number | null;
}

const CHUNK_BYTES = 256 * 1024;
/** Lines longer than one chunk are never surfaced; only their bytes are skipped. */
const MAX_LINE_BYTES = CHUNK_BYTES;

export function readJsonlHistory<T>(
  file: string,
  before: number | null,
  limit: number,
  parse: (line: string, offset: number) => T | T[] | null,
): HistoryPage<T> {
  let st;
  try { st = statSync(file); } catch { return { items: [], oldest: null }; }
  const size = st.size;
  const pos = before === null || !Number.isFinite(before) || before > size
    ? size
    : Math.max(0, Math.floor(before));
  const items: T[] = [];
  if (limit <= 0 || pos <= 0) return { items, oldest: null };
  let fd: number | undefined;
  let oldest: number | null = null;
  try {
    fd = openSync(file, "r");
    // Backwards newline scan: absolute offsets of the last `limit + 1` newlines
    // strictly below `pos` (the extra one marks where the oldest returned line
    // starts). A chunk without any newline — a line longer than the window —
    // contributes nothing and is simply stepped over.
    const newlines: number[] = []; // descending
    const raw = Buffer.alloc(CHUNK_BYTES);
    let scanEnd = pos; // exclusive
    while (newlines.length < limit + 1 && scanEnd > 0) {
      const chunkStart = Math.max(0, scanEnd - CHUNK_BYTES);
      const n = readSync(fd, raw, 0, scanEnd - chunkStart, chunkStart);
      if (n <= 0) break;
      for (let i = n - 1; i >= 0 && newlines.length < limit + 1; i--) {
        if (raw[i] === 0x0a) newlines.push(chunkStart + i);
      }
      scanEnd = chunkStart;
    }
    // Line j (1-based, counting back from pos) terminates at newlines[j-1] and
    // starts after newlines[j], or at byte 0 when the scan reached the file
    // start. Fewer than limit+1 newlines means every line before pos was seen:
    // nothing earlier exists.
    if (newlines.length === limit + 1) oldest = newlines[limit] + 1;
    for (let j = 1; j <= limit && j <= newlines.length; j++) {
      const end = newlines[j - 1]; // offset of this line's terminating newline
      const start = j < newlines.length ? newlines[j] + 1 : 0;
      const len = end - start; // text length, excluding the newline
      if (len <= 0 || len > MAX_LINE_BYTES) continue; // empty or oversized line
      const n = readSync(fd, raw, 0, len, start);
      if (n < len) continue; // short read (file shrank): skip defensively
      const line = raw.subarray(0, n).toString("utf8");
      if (!line.trim()) continue;
      const item = parse(line, start);
      if (item) {
        // Lines are collected newest-first and reversed once at the end, so a
        // line yielding several items must contribute them reversed to keep
        // its internal order chronological after the global reverse.
        items.push(...(Array.isArray(item) ? [...item].reverse() : [item]));
      }
    }
  } catch {
    // Degrade gracefully: return whatever was collected (oldest may stay null).
  } finally {
    if (fd !== undefined) try { closeSync(fd); } catch { /* ignore */ }
  }
  items.reverse(); // collected newest-first; the page is chronological
  return { items, oldest };
}
