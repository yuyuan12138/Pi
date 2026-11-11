import { existsSync, openSync, readSync, closeSync, fstatSync, readdirSync, statSync, readFileSync, writeSync, fsyncSync, renameSync } from "node:fs";
import { dirname, join } from "node:path";
import { usageStats, type UsageStats } from "./usage.ts";

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
  /** Named persistent session id: session-named dirs (dd08db5) carry the dir name; numeric dirs: null. */
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
  /** Spawn parent dispatch id from parent-child dir naming (e.g. "sa2" for "sa2-sa1"); null for roots. */
  spawned_by: string | null;
  /** Nesting depth from parent-child naming (0 = coordinator-spawned root); null when unknown. */
  depth: number | null;
  /** Task eras: user-message clusters split at >6h gaps (dirs are REUSED across conversations). */
  eras?: SubagentEra[];
  /** Compact whole-run usage (additive; omitted until the log scan has warmed). */
  usage?: UsageSummary;
}

/** Card-sized usage summary; full aggregates come from /sub-log `stats`. */
export interface UsageSummary {
  totalTokens: number;
  costTotal: number;
  toolCalls: number;
}

/** Per-settled-subagent record appended to <subagentsDir>/../subagents-usage.jsonl. */
export interface UsageRecord {
  id: string;
  label: string | null;
  session: string | null;
  model: string | null;
  /** Nesting depth derived from parent-child dir naming (0 = top-level, null when unknown). */
  depth: number | null;
  /** Parent subagent id when it was present in the same scan, else null. */
  spawned_by: string | null;
  startedAt: number | null;
  /** result.md mtime at settle time — the dedupe key for append-only persistence. */
  settledAt: number;
  tokens: { input: number; output: number; cacheRead: number; cacheWrite: number; reasoning: number; total: number; cost: number; framesWithUsage: number; framesWithoutUsage: number };
  tools: Record<string, number>;
  skills: string[];
  subagents: string[];
}

const STATUS_RANK: Record<SubagentStatus, number> = { running: 0, blocked: 1, done: 2 };

/** One task era inside a reused subagent dir: its own task label + time window. */
export interface SubagentEra {
  label: string;
  at: number;
  lastAt: number;
}

const ERA_GAP_MS = 6 * 3600e3;

/**
 * Split a dir's events.jsonl into task eras: every user task message starts or
 * continues an era; a gap > 6h since the era's start begins a new one (same-dir
 * eras are UNRELATED work — numeric ids were reused across conversations).
 * Timestamps come from the user message's own `timestamp` field; messages
 * without one merge into the current era (no evidence of a gap).
 */
function extractEras(evFile: string): SubagentEra[] {
  let raw: string;
  try { raw = readFileSync(evFile, "utf8"); } catch { return []; }
  const msgs: Array<{ ts: number; label: string }> = [];
  for (const line of raw.split("\n")) {
    if (!line.includes("message_start")) continue;
    try {
      const j = JSON.parse(line) as { type?: string; message?: { role?: string; timestamp?: number; content?: unknown } };
      if (j.type !== "message_start" || j.message?.role !== "user") continue;
      const c = j.message.content;
      const txt = typeof c === "string" ? c : (Array.isArray(c) ? c.map((p) => (p as { text?: string }).text ?? "").join(" ") : "");
      if (!txt.trim()) continue;
      msgs.push({ ts: typeof j.message.timestamp === "number" ? j.message.timestamp : 0, label: txt.trim().split("\n")[0].slice(0, 200) });
    } catch { /* malformed line */ }
  }
  msgs.sort((a, b) => a.ts - b.ts);
  const eras: SubagentEra[] = [];
  for (const m of msgs) {
    const last = eras[eras.length - 1];
    if (last && (m.ts === 0 || m.ts - last.at <= ERA_GAP_MS)) {
      last.lastAt = Math.max(last.lastAt, m.ts);
    } else {
      eras.push({ label: m.label, at: m.ts, lastAt: m.ts });
    }
  }
  return eras;
}

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
const STALE_RUNNING_MS = 15 * 60 * 1000; // no result + no events this long = worker stopped reporting
const DONE_SLOP_MS = 5 * 60 * 1000;      // result.md counts as current if written within this window

/** Scans a .pi/subagents dir into UI-ready views, caching by mtime+size so idle subagents cost one stat per poll. */
export class SubagentScanner {
  private cache = new Map<string, CacheEntry>();

  scan(dir: string): SubagentView[] {
    let names: string[];
    try { names = readdirSync(dir); } catch { return []; }
    const idSet = new Set(names.filter((n) => /^[A-Za-z0-9][A-Za-z0-9._-]*$/.test(n)));
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
        // Usage may have finished background-warming since this view was cached.
        if (!cached.view.usage) {
          const s = usageStats(evFile);
          if (s) cached.view.usage = { totalTokens: s.tokens.total, costTotal: s.tokens.cost, toolCalls: s.toolCalls };
        }
        // Ancestry backfill for views cached before spawned_by existed.
        if (cached.view.spawned_by === undefined) {
          const a = resolveAncestry(name, idSet, new Map());
          cached.view.spawned_by = a.spawnedBy;
          cached.view.depth = a.depth;
        }
        out.push(cached.view);
        continue;
      }
      const view = this.build(name, evFile, res ? resFile : null, ev.mtimeMs, res ? res.mtimeMs : 0, idSet);
      this.cache.set(name, { evMtimeMs: ev.mtimeMs, evSize: ev.size, resMtimeMs: res?.mtimeMs ?? 0, view });
      out.push(view);
    }
    const views = sortViews(out);
    this.persistSettled(dir, views);
    return views;
  }

  private usageSummary(file: string): UsageSummary | undefined {
    const s = usageStats(file);
    if (!s) return undefined; // still warming; a later scan attaches it
    return { totalTokens: s.tokens.total, costTotal: s.tokens.cost, toolCalls: s.toolCalls };
  }

  private build(id: string, evFile: string, resFile: string | null, evMtime: number, resMtime: number, ids?: Set<string>): SubagentView {
    const eras = extractEras(evFile);
    const head = readHead(evFile, HEAD_BYTES);
    const model = /"model":"([^"]+)"/.exec(head)?.[1] ?? null;
    const label = firstUserTaskText(head);
    const usage = this.usageSummary(evFile);
    if (resFile && resMtime >= evMtime - DONE_SLOP_MS) {
      // done ONLY when the result was written (near) after the last event: a collided
      // dir can carry a STALE result.md from a previous task while a new worker
      // is actively appending events (result.md mtime << events.jsonl mtime).
      // Slop tolerates fixture/fs ordering where events.jsonl is touched last
      // within the same second as the result.
      const raw = readTail(resFile, 8192);
      const ancestry = ids ? resolveAncestry(id, ids, new Map()) : { spawnedBy: null, depth: null };
      return {
        id, label, session: deriveSession(id), model,
        status: "done",
        lastActivity: Math.max(evMtime, resMtime),
        lastExcerpt: excerpt(raw, EXCERPT_CHARS),
        result: true,
        spawned_by: ancestry.spawnedBy,
        depth: ancestry.depth,
        eras: eras.length > 1 ? eras : undefined,
        usage,
      };
    }
    const tail = readTail(evFile, TAIL_BYTES);
    const report = lastReport(tail);
    const text = lastAssistantText(tail);
    // No result and no fresh events: the worker stopped reporting (killed/aborted
    // without a receipt). Surface as blocked instead of an eternal green "running".
    const stale = !resFile && Date.now() - evMtime > STALE_RUNNING_MS;
    const ancestry = ids ? resolveAncestry(id, ids, new Map()) : { spawnedBy: null, depth: null };
    return {
      id, label, session: deriveSession(id), model,
      status: report?.status === "blocked" || stale ? "blocked" : "running",
      lastActivity: evMtime,
      lastExcerpt: text ? excerpt(text, EXCERPT_CHARS) : excerpt(report?.summary ?? "", EXCERPT_CHARS),
      result: false,
      spawned_by: ancestry.spawnedBy,
      depth: ancestry.depth,
      eras: eras.length > 1 ? eras : undefined,
      usage,
    };
  }

  // ---------- settled-subagent persistence (append-only sidecar) ----------

  private recorded: Map<string, number> | null = null;
  private recordedTried = false;

  /**
   * Append one UsageRecord per newly-settled subagent to <dir>/../subagents-usage.jsonl.
   * Append-only: existing lines are never rewritten (read-merge-write via tmp+fsync+rename);
   * a (id, settledAt) pair already recorded is skipped, a newer settle appends a new line.
   */
  private persistSettled(dir: string, views: SubagentView[]): void {
    if (!views.length) return;
    const sidecar = join(dirname(dir), "subagents-usage.jsonl");
    if (!this.recordedTried) {
      this.recordedTried = true;
      this.recorded = loadRecorded(sidecar);
      if (this.recorded === null) return; // sidecar exists but is unreadable: never risk clobbering history
    }
    if (!this.recorded) return;
    const ids = new Set(views.map((v) => v.id));
    const depths = new Map<string, number>();
    const candidates: Array<{ line: string; id: string; settledAt: number }> = [];
    for (const v of views) {
      if (v.status !== "done") continue;
      const settledAt = this.cache.get(v.id)?.resMtimeMs ?? 0;
      if (settledAt <= (this.recorded.get(v.id) ?? -1)) continue;
      const stats = usageStats(`${dir}/${v.id}/events.jsonl`);
      if (!stats) continue; // still warming; retried on a later scan
      candidates.push({ line: JSON.stringify(buildRecord(v, settledAt, stats, ids, depths, `${dir}/${v.id}/events.jsonl`)), id: v.id, settledAt });
    }
    if (!candidates.length) return;
    try {
      appendRecordsAtomic(sidecar, candidates.map((c) => c.line));
      for (const c of candidates) this.recorded.set(c.id, c.settledAt);
    } catch { /* disk failure: retried on a later scan */ }
  }
}

function sidecarKey(id: string, settledAt: number): string {
  return `${id}@${settledAt}`;
}

/** Parse the sidecar into id -> settledAt. null means "exists but unreadable" (never write). */
function loadRecorded(sidecar: string): Map<string, number> | null {
  let bytes: Buffer;
  try {
    bytes = readFileSync(sidecar);
  } catch (e) {
    return (e as NodeJS.ErrnoException).code === "ENOENT" ? new Map() : null;
  }
  const map = new Map<string, number>();
  for (const line of bytes.toString("utf8").split("\n")) {
    if (!line.trim()) continue;
    try {
      const r = JSON.parse(line) as { id?: unknown; settledAt?: unknown };
      if (r && typeof r.id === "string" && typeof r.settledAt === "number") map.set(r.id, r.settledAt);
    } catch { /* skip malformed lines */ }
  }
  return map;
}

/** Atomic append: read current bytes, merge (never duplicate), tmp+fsync+rename. */
function appendRecordsAtomic(sidecar: string, lines: string[]): void {
  let existing = Buffer.alloc(0);
  try {
    existing = readFileSync(sidecar);
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code !== "ENOENT") throw e;
  }
  const have = new Set<string>();
  for (const line of existing.toString("utf8").split("\n")) {
    if (!line.trim()) continue;
    try {
      const r = JSON.parse(line) as { id?: unknown; settledAt?: unknown };
      if (r && typeof r.id === "string" && typeof r.settledAt === "number") have.add(sidecarKey(r.id, r.settledAt));
    } catch { /* skip malformed lines */ }
  }
  const fresh = lines.filter((l) => {
    try {
      const r = JSON.parse(l) as { id?: unknown; settledAt?: unknown };
      return !(r && typeof r.id === "string" && typeof r.settledAt === "number" && have.has(sidecarKey(r.id, r.settledAt)));
    } catch { return true; }
  });
  if (!fresh.length) return;
  const buf = Buffer.concat([existing, Buffer.from(fresh.map((l) => l + "\n").join(""), "utf8")]);
  const tmp = `${sidecar}.tmp-${process.pid}-${Date.now()}`;
  const fd = openSync(tmp, "w");
  try {
    writeSync(fd, buf);
    fsyncSync(fd);
  } finally {
    closeSync(fd);
  }
  renameSync(tmp, sidecar);
}

/**
 * Numeric-style dir ids: sa<N> roots and their fanout/lineage chains
 * ("sa13-a", "sa2-sa1", "sa9-b-sa1", dd08db5-suffixed "sa27-k3f9"). Anything
 * else under .pi/subagents is a persistent session dir named after the session
 * verbatim ("medical-upstream-x1", "rsi-live-c12-mon-2") — those carry no
 * numeric lineage and their dir name IS the session id.
 */
const NUMERIC_DIR_RE = /^sa\d+(?:-[A-Za-z0-9]+)*$/;

/**
 * Session id for a subagents dir name; null when the dir is numeric-style.
 * Session dirs may carry the superagent collision suffix ("-2x41", a trailing
 * -[0-9a-z]{4} token): /state reports the CLEAN session id so consumers see
 * the session the dir was named after.
 */
export function deriveSession(name: string): string | null {
  if (NUMERIC_DIR_RE.test(name)) return null;
  return name.replace(/-([0-9a-z]{4})$/, "") || name;
}

/**
 * Parent-child naming (e.g. "sa2-sa1") resolves depth when the parent id is
 * present in the same scan. Session-named dirs have no numeric lineage: a
 * clean null (never a fabricated parent from a dash cut through the session
 * name), and never a crash.
 */
function resolveAncestry(id: string, ids: Set<string>, depths: Map<string, number>): { spawnedBy: string | null; depth: number | null } {
  if (!NUMERIC_DIR_RE.test(id)) return { spawnedBy: null, depth: null };
  const cut = id.lastIndexOf("-");
  if (cut <= 0) return { spawnedBy: null, depth: 0 };
  const parent = id.slice(0, cut);
  if (!ids.has(parent)) return { spawnedBy: null, depth: 0 };
  let parentDepth = depths.get(parent);
  if (parentDepth === undefined) {
    parentDepth = resolveAncestry(parent, ids, depths).depth ?? 0;
    depths.set(parent, parentDepth);
  }
  return { spawnedBy: parent, depth: parentDepth + 1 };
}

function buildRecord(v: SubagentView, settledAt: number, stats: UsageStats, ids: Set<string>, depths: Map<string, number>, evFile: string): UsageRecord {
  const { spawnedBy, depth } = resolveAncestry(v.id, ids, depths);
  let startedAt = stats.startedAt;
  if (startedAt === null) {
    try {
      const st = statSync(evFile);
      startedAt = st.birthtimeMs > 0 ? st.birthtimeMs : st.ctimeMs;
    } catch { startedAt = null; }
  }
  const tools: Record<string, number> = {};
  for (const t of stats.tools) tools[t.name] = t.count;
  return {
    id: v.id,
    label: v.label ? (v.label.length > 200 ? v.label.slice(0, 199) + "…" : v.label) : null,
    session: v.session,
    model: stats.model ?? v.model,
    depth,
    spawned_by: spawnedBy,
    startedAt,
    settledAt,
    tokens: { ...stats.tokens },
    tools,
    skills: stats.skills,
    subagents: stats.subagents.map((c) => c.id).filter((x): x is string => x !== null),
  };
}
