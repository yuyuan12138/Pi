import { existsSync, openSync, readSync, closeSync, statSync } from "node:fs";
import { readJsonlHistory } from "./history.ts";
import { usageStats, type UsageStats } from "./usage.ts";

/**
 * Per-subagent window log: parse events.jsonl incrementally from a byte offset
 * into compact UI lines, plus the result.md content when present.
 */

export interface SubLogLine {
  kind: "tool" | "assistant" | "report" | "event";
  /** tool name, report status, or event name. */
  name?: string;
  text: string;
  /** Byte offset of the source line (client resume cursor). */
  offset: number;
}

export interface SubLogSnapshot {
  id: string;
  cursor: number;
  reset: boolean;
  lines: SubLogLine[];
  /** Tail of result.md when the subagent reached a terminal state, else null. */
  result: string | null;
  done: boolean;
  /** Whole-run usage aggregates (additive; omitted while a large cold log warms in the background). */
  stats?: UsageStats;
}

const MAX_BYTES_PER_POLL = 256 * 1024;
const MAX_TOOL_TEXT = 200;
const MAX_ASSISTANT_TEXT = 2000;
const MAX_LINES = 400;

function argPreview(args: unknown): string {
  try { return JSON.stringify(args) ?? ""; } catch { return ""; }
}

function parseLine(line: string, offset: number): SubLogLine | null {
  let ev: any;
  try { ev = JSON.parse(line); } catch { return null; }
  if (ev?.type === "tool_execution_start" && typeof ev.toolName === "string") {
    if (ev.toolName === "report_to_parent") {
      const a = ev.args ?? {};
      return { kind: "report", name: String(a.status ?? "progress"), text: String(a.summary ?? "").slice(0, 500), offset };
    }
    return { kind: "tool", name: ev.toolName, text: argPreview(ev.args).slice(0, MAX_TOOL_TEXT), offset };
  }
  if (ev?.type === "message_end" && ev.message?.role === "user") {
    const t = (ev.message.content ?? []).filter((c: any) => c?.type === "text").map((c: any) => String(c.text ?? "")).join(" ").trim();
    if (!t) return null;
    return { kind: "event", name: "task", text: t.slice(0, MAX_ASSISTANT_TEXT), offset };
  }
  if (ev?.type === "message_end" && ev.message?.role === "assistant") {
    const t = (ev.message.content ?? []).filter((c: any) => c?.type === "text").map((c: any) => String(c.text ?? "")).join("\n").trim();
    if (!t) return null;
    return { kind: "assistant", text: t.slice(0, MAX_ASSISTANT_TEXT), offset };
  }
  if (ev?.type === "agent_settled") return { kind: "event", name: "settled", text: "", offset };
  return null;
}

function readResult(resFile: string): string | null {
  if (!existsSync(resFile)) return null;
  let fd: number | undefined;
  try {
    const size = statSync(resFile).size;
    fd = openSync(resFile, "r");
    const len = Math.min(size, 8192);
    const buf = Buffer.alloc(len);
    const n = readSync(fd, buf, 0, len, size - len);
    return buf.subarray(0, n).toString("utf8").trim() || null;
  } catch {
    return null;
  } finally {
    if (fd !== undefined) try { closeSync(fd); } catch { /* ignore */ }
  }
}

/**
 * Backwards paged history for one subagent's events.jsonl (shared pager, sub parser).
 */
export function readSubHistory(
  dir: string,
  id: string,
  before: number | null,
  limit = 300,
): { id: string; lines: SubLogLine[]; oldest: number | null } {
  const r = readJsonlHistory<SubLogLine>(`${dir}/events.jsonl`, before, limit, parseLine);
  return { id, lines: r.items, oldest: r.oldest };
}

/**
 * @param dir    the subagent's log dir (<subagentsDir>/<id>)
 * @param after  client cursor; null = first poll (returns the tail)
 */
export function readSubLog(dir: string, id: string, after: number | null): SubLogSnapshot {
  const snap = readSubLogWindow(dir, id, after);
  // Additive whole-run aggregates; null (still warming) leaves the field off the payload.
  const stats = usageStats(`${dir}/events.jsonl`);
  if (stats) snap.stats = stats;
  return snap;
}

function readSubLogWindow(dir: string, id: string, after: number | null): SubLogSnapshot {
  const evFile = `${dir}/events.jsonl`;
  const resFile = `${dir}/result.md`;
  const result = readResult(resFile);
  const base: SubLogSnapshot = { id, cursor: after ?? 0, reset: false, lines: [], result, done: result !== null };
  let size: number;
  try { size = statSync(evFile).size; } catch { return { ...base, cursor: 0, reset: true, lines: [] }; }
  let start: number;
  let reset = false;
  if (after === null || !Number.isFinite(after) || after > size || after < 0) {
    start = Math.max(0, size - MAX_BYTES_PER_POLL);
    reset = true;
  } else {
    start = after;
  }
  if (start >= size) return { ...base, cursor: size, reset };
  const len = Math.min(size - start, MAX_BYTES_PER_POLL);
  let fd: number | undefined;
  let chunk: string;
  try {
    fd = openSync(evFile, "r");
    const buf = Buffer.alloc(len);
    const n = readSync(fd, buf, 0, len, start);
    chunk = buf.subarray(0, n).toString("utf8");
  } catch {
    return { ...base, cursor: start, reset: true, lines: [] };
  } finally {
    if (fd !== undefined) try { closeSync(fd); } catch { /* ignore */ }
  }
  const lastNl = chunk.lastIndexOf("\n");
  if (lastNl < 0) return { ...base, cursor: start, reset }; // one huge line; wait for it to complete
  const complete = chunk.slice(0, lastNl + 1);
  const cursor = start + Buffer.byteLength(complete, "utf8");
  const lines: SubLogLine[] = [];
  let off = start;
  for (const line of complete.split("\n")) {
    const lineOffset = off;
    off += Buffer.byteLength(line + "\n", "utf8");
    if (!line.trim()) continue;
    const parsed = parseLine(line, lineOffset);
    if (parsed) lines.push(parsed);
    if (lines.length >= MAX_LINES) break;
  }
  return { id, cursor, reset, lines, result, done: result !== null };
}
