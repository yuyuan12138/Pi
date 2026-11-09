import { existsSync, openSync, readSync, closeSync, fstatSync, readdirSync, statSync } from "node:fs";
import { join } from "node:path";

/**
 * Subagent state derived from the on-disk log dirs that pi-superagent's
 * SubagentManager maintains under <cwd>/.pi/subagents/<id>/:
 *   events.jsonl   RPC event stream (append-only) — the live evidence
 *   transcript.log human-readable tool/assistant tail
 *   result.md      written once when the subagent reaches a terminal state
 * Status mapping: result.md present -> done; else last report_to_parent call
 * with status "blocked" -> blocked; else running.
 */

export type SubagentStatus = "running" | "done" | "blocked";

export interface SubagentView {
  id: string;
  /** Best-effort: first line of the child's task prompt (its first user message). */
  label: string | null;
  /** Named persistent session id, when derivable (v1: not derivable from disk; null). */
  session: string | null;
  /** Model id from the child's first assistant message (best-effort). */
  model: string | null;
  status: SubagentStatus;
  /** max(mtime) of events.jsonl / result.md, in epoch ms. */
  lastActivity: number;
  /** Last ~400 chars of the latest assistant text, or the tail of result.md when done. */
  lastExcerpt: string;
  /** result.md exists (subagent reached a terminal state). */
  result: boolean;
}

const STATUS_RANK: Record<SubagentStatus, number> = { running: 0, blocked: 1, done: 2 };

/** Natural order compare so sa2 sorts before sa10. */
export function naturalCompare(a: string, b: string): number {
  const re = /\d+|\D+/g;
  const ax = a.match(re) ?? [a];
  const bx = b.match(re) ?? [b];
  for (let i = 0; i < Math.min(ax.length, bx.length); i++) {
    const an = /^\d+$/.test(ax[i]);
    const bn = /^\d+$/.test(bx[i]);
    if (an && bn) {
      const d = Number(ax[i]) - Number(bx[i]);
      if (d !== 0) return d;
    } else if (ax[i] !== bx[i]) {
      return ax[i] < bx[i] ? -1 : 1;
    }
  }
  return ax.length - bx.length;
}

export function sortViews(views: SubagentView[]): SubagentView[] {
  return views.sort((a, b) =>
    STATUS_RANK[a.status] - STATUS_RANK[b.status] || b.lastActivity - a.lastActivity || naturalCompare(a.id, b.id));
}

/** Read at most `bytes` from the end of a file without loading the whole thing. */
export function readTail(file: string, bytes: number): string {
  let fd: number | undefined;
  try {
    fd = openSync(file, "r");
    const st = fstatSync(fd);
    const len = Math.min(st.size, bytes);
    const buf = Buffer.alloc(len);
    const read = readSync(fd, buf, 0, len, st.size - len);
    return buf.subarray(0, read).toString("utf8");
  } catch {
    return "";
  } finally {
    if (fd !== undefined) try { closeSync(fd); } catch { /* ignore */ }
  }
}

/** Read at most `bytes` from the start of a file. */
export function readHead(file: string, bytes: number): string {
  let fd: number | undefined;
  try {
    fd = openSync(file, "r");
    const buf = Buffer.alloc(bytes);
    const read = readSync(fd, buf, 0, bytes, 0);
    return buf.subarray(0, read).toString("utf8");
  } catch {
    return "";
  } finally {
    if (fd !== undefined) try { closeSync(fd); } catch { /* ignore */ }
  }
}

function firstUserTaskText(text: string): string | null {
  for (const line of text.split("\n")) {
    if (!line.includes('"role":"user"')) continue;
    try {
      const ev = JSON.parse(line) as { type?: string; message?: { role?: string; content?: Array<{ type: string; text?: string }> } };
      if (ev.type === "message_end" && ev.message?.role === "user") {
        const t = (ev.message.content ?? []).filter((c) => c.type === "text").map((c) => c.text ?? "").join(" ").trim();
        if (t) return t;
      }
    } catch { /* partial head line; skip */ }
  }
  return null;
}

function lastAssistantText(tail: string): string | null {
  const lines = tail.split("\n");
  for (let i = lines.length - 1; i >= 0; i--) {
    const line = lines[i];
    if (!line.includes('"role":"assistant"') || !line.includes('"text"')) continue;
    try {
      const ev = JSON.parse(line) as { type?: string; message?: { role?: string; content?: Array<{ type: string; text?: string }> } };
      if (ev.type === "message_end" && ev.message?.role === "assistant") {
        const t = (ev.message.content ?? []).filter((c) => c.type === "text").map((c) => c.text ?? "").join("\n").trim();
        if (t) return t;
      }
    } catch { /* partial tail line; skip */ }
  }
  return null;
}

function lastReport(tail: string): { status: string; summary: string } | null {
  const lines = tail.split("\n");
  for (let i = lines.length - 1; i >= 0; i--) {
    const line = lines[i];
    if (!line.includes('"toolName":"report_to_parent"') || !line.includes('"tool_execution_start"')) continue;
    try {
      const ev = JSON.parse(line) as { args?: { status?: string; summary?: string } };
      if (ev.args?.status) return { status: ev.args.status, summary: String(ev.args.summary ?? "") };
    } catch { /* skip */ }
  }
  return null;
}

function excerpt(s: string, n: number): string {
  const t = s.replace(/\s+/g, " ").trim();
  return t.length <= n ? t : "…" + t.slice(t.length - n);
}

interface CacheEntry {
  evMtimeMs: number;
  evSize: number;
  resMtimeMs: number;
  view: SubagentView;
}

const HEAD_BYTES = 512 * 1024;   // task + model live near the head (after the big system line)
const TAIL_BYTES = 64 * 1024;    // recent reports/assistant text live at the tail
const EXCERPT_CHARS = 400;

/** Scans a .pi/subagents dir into UI-ready views, caching by mtime+size so idle subagents cost one stat per poll. */
export class SubagentScanner {
  private cache = new Map<string, CacheEntry>();

  scan(dir: string): SubagentView[] {
    let names: string[];
    try { names = readdirSync(dir); } catch { return []; }
    const out: SubagentView[] = [];
    for (const name of names) {
      if (name === "sessions" || name === "worktrees") continue;
      if (!/^[A-Za-z0-9][A-Za-z0-9._-]*$/.test(name)) continue;
      const d = join(dir, name);
      let dst;
      try { dst = statSync(d); } catch { continue; }
      if (!dst.isDirectory()) continue;
      const evFile = join(d, "events.jsonl");
      const resFile = join(d, "result.md");
      let ev;
      try { ev = statSync(evFile); } catch { continue; } // events.jsonl is the minimum evidence of a subagent
      const res = existsSync(resFile) ? statSync(resFile) : null;
      const cached = this.cache.get(name);
      if (cached && cached.evMtimeMs === ev.mtimeMs && cached.evSize === ev.size && cached.resMtimeMs === (res?.mtimeMs ?? 0)) {
        out.push(cached.view);
        continue;
      }
      const view = this.build(name, evFile, res ? resFile : null, ev.mtimeMs, res ? res.mtimeMs : 0);
      this.cache.set(name, { evMtimeMs: ev.mtimeMs, evSize: ev.size, resMtimeMs: res?.mtimeMs ?? 0, view });
      out.push(view);
    }
    return sortViews(out);
  }

  private build(id: string, evFile: string, resFile: string | null, evMtime: number, resMtime: number): SubagentView {
    const head = readHead(evFile, HEAD_BYTES);
    const model = /"model":"([^"]+)"/.exec(head)?.[1] ?? null;
    const label = firstUserTaskText(head);
    if (resFile) {
      const raw = readTail(resFile, 8192);
      return {
        id, label, session: null, model,
        status: "done",
        lastActivity: Math.max(evMtime, resMtime),
        lastExcerpt: excerpt(raw, EXCERPT_CHARS),
        result: true,
      };
    }
    const tail = readTail(evFile, TAIL_BYTES);
    const report = lastReport(tail);
    const text = lastAssistantText(tail);
    return {
      id, label, session: null, model,
      status: report?.status === "blocked" ? "blocked" : "running",
      lastActivity: evMtime,
      lastExcerpt: text ? excerpt(text, EXCERPT_CHARS) : excerpt(report?.summary ?? "", EXCERPT_CHARS),
      result: false,
    };
  }
}
