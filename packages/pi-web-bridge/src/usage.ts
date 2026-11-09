import { closeSync, openSync, readSync, statSync } from "node:fs";

/**
 * Whole-run usage aggregation for pi agent logs.
 *
 * Two on-disk formats are understood (a single file only ever uses one):
 *  - subagent event streams (<cwd>/.pi/subagents/<id>/events.jsonl):
 *      {"type":"tool_execution_start","toolCallId","toolName","args"}
 *      {"type":"tool_execution_end","toolCallId","toolName","result":{"content":[{type:"text",text}]}
 *      {"type":"message_end","message":{"role","content","model","timestamp","usage"}}
 *      {"type":"turn_end"}
 *  - main session JSONL (append-only session log):
 *      {"type":"message","message":{"role","content":[{type:"toolCall",id,name,arguments}|{type:"text",text}],"model","timestamp","usage"}}
 *      {"type":"message","message":{"role":"toolResult","toolCallId","content":[{type:"text",text}]}}
 *
 * Aggregation is incremental: files are append-only, so a cached aggregator
 * resumes from its byte offset and only feeds new complete lines. Large cold
 * files are warmed in the background (one bounded chunk per macrotask) so the
 * HTTP request path never blocks on a multi-megabyte scan; callers get `null`
 * until the file is warm and render client-side fallbacks meanwhile.
 */

export interface ToolCount {
  name: string;
  count: number;
}

export interface SpawnedChild {
  /** Child subagent id when the tool result announced one ("Spawned <id> …"), else null. */
  id: string | null;
  /** args.label, falling back to the first line of the task prompt. */
  label: string | null;
  session: string | null;
  model: string | null;
}

export interface TokenTotals {
  input: number;
  output: number;
  cacheRead: number;
  cacheWrite: number;
  reasoning: number;
  total: number;
  /** Sum of usage.cost.total in USD-equivalent; 0 for local/free endpoints. */
  cost: number;
  /** Assistant messages that carried a usable usage object (summed). */
  framesWithUsage: number;
  /** Assistant messages without usable usage — excluded from the sums, counted honestly. */
  framesWithoutUsage: number;
}

export interface UsageStats {
  tools: ToolCount[];
  toolCalls: number;
  subagents: SpawnedChild[];
  /** Skill names (deduped, alphabetical) detected from read/grep tool arguments. */
  skills: string[];
  /** Assistant messages carrying visible text (what the transcript shows). */
  assistantMessages: number;
  /** Model turns: turn_end events in event streams, assistant messages in session logs. */
  assistantTurns: number;
  tokens: TokenTotals;
  /** Model id from the first assistant message, when present. */
  model: string | null;
  /** First message timestamp seen in the stream (epoch ms), when present. */
  startedAt: number | null;
}

const MAX_SCAN_BYTES = 64 * 1024 * 1024; // pathological-file guard: scan the tail beyond this
const WARM_CHUNK_BYTES = 1024 * 1024;     // per-macrotask background read
const MAX_TOOLS = 50;
const MAX_SUBAGENTS = 100;

const SKILL_MD_RE = /skills\/([A-Za-z0-9][A-Za-z0-9._-]*)\/SKILL\.md/i;
const SKILL_DIR_RE = /\.pi\/skills\/([A-Za-z0-9][A-Za-z0-9._-]*)\//i;
const SPAWNED_ID_RE = /Spawned ([A-Za-z0-9][A-Za-z0-9._-]*)/;

export function emptyTokens(): TokenTotals {
  return { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, reasoning: 0, total: 0, cost: 0, framesWithUsage: 0, framesWithoutUsage: 0 };
}

export function emptyStats(): UsageStats {
  return { tools: [], toolCalls: 0, subagents: [], skills: [], assistantMessages: 0, assistantTurns: 0, tokens: emptyTokens(), model: null, startedAt: null };
}

function firstLine(s: unknown, max = 120): string | null {
  if (typeof s !== "string") return null;
  const t = s.split("\n", 1)[0].trim();
  return t ? (t.length > max ? t.slice(0, max - 1) + "…" : t) : null;
}

function textFromContent(content: unknown): string {
  if (!Array.isArray(content)) return "";
  let out = "";
  for (const c of content) {
    if (c && typeof c === "object" && (c as { type?: string }).type === "text" && typeof (c as { text?: unknown }).text === "string") {
      out += (out ? "\n" : "") + (c as { text: string }).text;
    }
  }
  return out;
}

function numOr(v: unknown): number | null {
  if (typeof v === "number" && Number.isFinite(v)) return v;
  if (typeof v === "string") { const t = Date.parse(v); return Number.isFinite(t) ? t : null; }
  return null;
}

/** Mutable accumulator. feedLine() is cheap: substring pre-filters before any JSON.parse. */
export class UsageAggregator {
  /** Byte offset of the last complete line fed (resume cursor for append-only files). */
  offset = 0;
  private counts = new Map<string, number>();
  private toolCalls = 0;
  private spawned: SpawnedChild[] = [];
  private pendingSpawns = new Map<string, number>(); // toolCallId -> index into spawned
  private skills = new Set<string>();
  private assistantMessages = 0;
  private assistantEnds = 0;
  private turns = 0;
  private sawTurnEvents = false;
  private tokens: TokenTotals = emptyTokens();
  private model: string | null = null;
  private startedAt: number | null = null;

  feedLine(line: string): void {
    // 1. subagent event streams: tool_execution_start
    if (line.includes('"tool_execution_start"')) {
      let ev: { toolCallId?: unknown; toolName?: unknown; args?: unknown } | null = null;
      try { ev = JSON.parse(line); } catch { return; }
      const name = typeof ev?.toolName === "string" ? ev.toolName : null;
      if (!name) return;
      this.countTool(name, ev?.args, ev?.toolCallId);
      return;
    }
    // 2. subagent event streams: tool_execution_end (resolve spawned child ids)
    if (line.includes('"tool_execution_end"')) {
      if (this.pendingSpawns.size === 0) return;
      let ev: { toolCallId?: unknown; result?: unknown } | null = null;
      try { ev = JSON.parse(line); } catch { return; }
      const callId = typeof ev?.toolCallId === "string" ? ev.toolCallId : null;
      const idx = callId !== null ? this.pendingSpawns.get(callId) : undefined;
      if (callId === null || idx === undefined) return;
      this.pendingSpawns.delete(callId);
      const child = this.spawned[idx];
      if (child && !child.id) {
        const m = SPAWNED_ID_RE.exec(textFromContent((ev as { result?: { content?: unknown } }).result?.content));
        if (m) child.id = m[1];
      }
      return;
    }
    // 3. subagent event streams: message_end (assistant messages + usage)
    if (line.includes('"type":"message_end"')) {
      let ev: { message?: { role?: unknown; content?: unknown; model?: unknown; timestamp?: unknown; usage?: unknown } } | null = null;
      try { ev = JSON.parse(line); } catch { return; }
      const msg = ev?.message;
      if (!msg || msg.role !== "assistant") return;
      this.assistantEnds++;
      if (!this.model && typeof msg.model === "string") this.model = msg.model;
      if (this.startedAt === null) this.startedAt = numOr(msg.timestamp);
      const usage = (msg.usage ?? null) as Record<string, unknown> | null;
      if (usage && typeof usage === "object") this.sumUsage(usage);
      else this.tokens.framesWithoutUsage++;
      if (textFromContent(msg.content).trim()) this.assistantMessages++;
      return;
    }
    // 4. subagent event streams: turn_end (one per completed model turn)
    if (line.includes('"type":"turn_end"')) {
      this.sawTurnEvents = true;
      this.turns++;
      return;
    }
    // 5. session JSONL: message entries (assistant with toolCall blocks, toolResult results)
    if (line.includes('"type":"message"')) {
      let ev: { message?: { role?: unknown; content?: unknown; model?: unknown; timestamp?: unknown; usage?: unknown; toolCallId?: unknown } } | null = null;
      try { ev = JSON.parse(line); } catch { return; }
      const msg = ev?.message;
      if (!msg || typeof msg !== "object") return;
      const role = msg.role;
      if (role === "assistant") {
        // Session logs have no turn markers: every assistant message is one turn.
        this.turns++;
        if (!this.model && typeof msg.model === "string") this.model = msg.model;
        if (this.startedAt === null) this.startedAt = numOr(msg.timestamp);
        const usage = (msg.usage ?? null) as Record<string, unknown> | null;
        if (usage && typeof usage === "object") this.sumUsage(usage);
        else this.tokens.framesWithoutUsage++;
        if (textFromContent(msg.content).trim()) this.assistantMessages++;
        if (Array.isArray(msg.content)) {
          for (const c of msg.content) {
            if (c && typeof c === "object" && (c as { type?: string }).type === "toolCall") {
              const call = c as { id?: unknown; name?: unknown; arguments?: unknown };
              if (typeof call.name === "string") this.countTool(call.name, call.arguments, call.id);
            }
          }
        }
      } else if (role === "toolResult") {
        if (this.pendingSpawns.size === 0 || typeof msg.toolCallId !== "string") return;
        const idx = this.pendingSpawns.get(msg.toolCallId);
        if (idx === undefined) return;
        this.pendingSpawns.delete(msg.toolCallId);
        const child = this.spawned[idx];
        if (child && !child.id) {
          const m = SPAWNED_ID_RE.exec(textFromContent(msg.content));
          if (m) child.id = m[1];
        }
      }
      return;
    }
  }

  private countTool(name: string, args: unknown, toolCallId: unknown): void {
    this.counts.set(name, (this.counts.get(name) ?? 0) + 1);
    this.toolCalls++;
    if ((name === "read" || name === "grep") && args !== null && args !== undefined) {
      let argsText: string;
      try { argsText = typeof args === "string" ? args : JSON.stringify(args) ?? ""; } catch { argsText = ""; }
      const m = SKILL_MD_RE.exec(argsText) ?? SKILL_DIR_RE.exec(argsText);
      if (m) this.skills.add(m[1]);
    }
    if (name === "subagent_spawn" && this.spawned.length < MAX_SUBAGENTS) {
      const a = (args ?? {}) as { label?: unknown; task?: unknown; session?: unknown; model?: unknown };
      this.spawned.push({
        id: null,
        label: firstLine(a.label) ?? firstLine(a.task),
        session: typeof a.session === "string" ? a.session : null,
        model: typeof a.model === "string" ? a.model : null,
      });
      const idx = this.spawned.length - 1;
      if (typeof toolCallId === "string") {
        this.pendingSpawns.set(toolCallId, idx);
        if (this.pendingSpawns.size > 128) { // drop oldest unresolved to bound memory
          const oldest = this.pendingSpawns.keys().next().value;
          if (oldest !== undefined) this.pendingSpawns.delete(oldest);
        }
      }
    }
  }

  private sumUsage(u: Record<string, unknown>): void {
    const n = (v: unknown): number => (typeof v === "number" && Number.isFinite(v) ? v : 0);
    const cost = (u.cost ?? null) as Record<string, unknown> | null;
    this.tokens.input += n(u.input);
    this.tokens.output += n(u.output);
    this.tokens.cacheRead += n(u.cacheRead);
    this.tokens.cacheWrite += n(u.cacheWrite);
    this.tokens.reasoning += n(u.reasoning);
    this.tokens.total += n(u.totalTokens);
    this.tokens.cost += cost && typeof cost === "object" ? n(cost.total) : 0;
    this.tokens.framesWithUsage++;
  }

  snapshot(): UsageStats {
    const tools = [...this.counts.entries()]
      .map(([name, count]) => ({ name, count }))
      .sort((a, b) => b.count - a.count || (a.name < b.name ? -1 : 1))
      .slice(0, MAX_TOOLS);
    return {
      tools,
      toolCalls: this.toolCalls,
      subagents: this.spawned.map((c) => ({ ...c })),
      skills: [...this.skills].sort(),
      assistantMessages: this.assistantMessages,
      assistantTurns: this.sawTurnEvents ? this.turns : Math.max(this.turns, this.assistantEnds),
      tokens: { ...this.tokens },
      model: this.model,
      startedAt: this.startedAt,
    };
  }
}

interface CacheEntry {
  agg: UsageAggregator;
  warm: boolean;
  feeding: boolean;
}

const cache = new Map<string, CacheEntry>();
const warmQueue: Array<{ file: string; entry: CacheEntry }> = [];
let warmScheduled = false;

function readChunk(file: string, entry: CacheEntry, start: number, maxBytes: number): void {
  const len = Math.min(maxBytes, MAX_SCAN_BYTES);
  let text = "";
  let n = 0;
  let fd: number | undefined;
  try {
    fd = openSync(file, "r");
    const buf = Buffer.alloc(len);
    n = readSync(fd, buf, 0, len, start);
    text = buf.toString("utf8", 0, n);
  } catch {
    return;
  } finally {
    if (fd !== undefined) try { closeSync(fd); } catch { /* ignore */ }
  }
  const nl = text.lastIndexOf("\n");
  if (nl < 0) {
    // No complete line in this range (pathological single huge line): skip it to avoid stalling.
    entry.agg.offset = start + n;
    return;
  }
  const complete = text.slice(0, nl + 1);
  for (const line of complete.split("\n")) {
    if (line) entry.agg.feedLine(line);
  }
  entry.agg.offset = start + Buffer.byteLength(complete, "utf8");
}

function scanRangeSync(file: string, entry: CacheEntry, from: number, to: number): void {
  let start = from;
  while (start < to) {
    const end = Math.min(to, start + WARM_CHUNK_BYTES);
    readChunk(file, entry, start, end - start);
    start = entry.agg.offset <= start ? to : entry.agg.offset; // readChunk guarantees forward progress
  }
}

function scheduleWarm(file: string, entry: CacheEntry): void {
  if (entry.feeding) return;
  entry.feeding = true;
  warmQueue.push({ file, entry });
  if (warmScheduled) return;
  warmScheduled = true;
  const tick = (): void => {
    const job = warmQueue[0];
    if (!job) {
      warmScheduled = false;
      return;
    }
    const e = job.entry;
    try {
      const st = statSync(job.file);
      if (st.size < e.agg.offset) { // truncated/replaced: start over
        e.agg = new UsageAggregator();
      }
      readChunk(job.file, e, e.agg.offset, Math.min(WARM_CHUNK_BYTES, Math.max(0, st.size - e.agg.offset) || WARM_CHUNK_BYTES));
      if (e.agg.offset >= st.size) {
        e.warm = true;
        e.feeding = false;
        warmQueue.shift();
      }
    } catch {
      e.warm = true; // file vanished: stop warming, serve what we have
      e.feeding = false;
      warmQueue.shift();
    }
    setImmediate(tick);
  };
  setImmediate(tick);
}

/**
 * Whole-run usage for `file`. Returns null while a large cold file is still
 * warming in the background (callers omit the optional field); empty stats
 * when the file is missing. Inline-scans files up to `inlineLimit` bytes.
 */
export function usageStats(file: string, inlineLimit = 256 * 1024): UsageStats | null {
  let st;
  try { st = statSync(file); } catch {
    return emptyStats(); // no log yet: honest empty inventory
  }
  const entry = cache.get(file);
  if (!entry) {
    const fresh: CacheEntry = { agg: new UsageAggregator(), warm: false, feeding: false };
    cache.set(file, fresh);
    if (st.size <= inlineLimit) {
      scanRangeSync(file, fresh, 0, st.size);
      fresh.warm = true;
      return fresh.agg.snapshot();
    }
    scheduleWarm(file, fresh);
    return null;
  }
  if (st.size < entry.agg.offset) { // truncated/replaced: rescan from scratch
    entry.agg = new UsageAggregator();
    entry.warm = false;
  }
  if (entry.warm) {
    if (st.size > entry.agg.offset) {
      try { scanRangeSync(file, entry, entry.agg.offset, st.size); } catch { /* keep previous stats */ }
    }
    return entry.agg.snapshot();
  }
  if (st.size <= inlineLimit && !entry.feeding) {
    scanRangeSync(file, entry, entry.agg.offset, st.size);
    entry.warm = true;
    return entry.agg.snapshot();
  }
  if (!entry.feeding) scheduleWarm(file, entry);
  return null;
}
