/**
 * Bounded in-flight assistant buffer for the live streaming view.
 *
 * Fed by the pi extension hooks message_start / message_update / message_end
 * (assistant role only). pi emits message_update per provider stream delta with
 * the partial message, so the buffer mirrors what the terminal shows while the
 * coordinator replies: growing text plus the tool calls being formed. Tool
 * calls accumulate across the WHOLE run (agent_start .. agent_settled) in
 * order — the terminal shows every call line cumulatively, so the web must
 * not drop earlier calls the moment the next one starts (the old single-slot
 * `tool` field did exactly that). Everything is bounded: a huge reply cannot
 * balloon memory or payload, and the tool list is capped to the last N calls.
 *
 * The session JSONL only persists complete messages (at message_end), so file
 * polling can never see partial text — this hook-fed buffer is the mechanism.
 */

export const STREAM_MAX_CHARS = 8000;
export const STREAM_TOOL_PREVIEW_CHARS = 200;
/** Cumulative in-flight tool lines are bounded to the last N calls of a run. */
export const STREAM_MAX_TOOLS = 30;

export interface StreamTool {
  /** ToolCall id (provider-assigned); synthetic "m<msgSeq>b<index>" when a block has none. */
  id: string;
  name: string;
  /** Bounded JSON preview of the (possibly still streaming) arguments. */
  summary: string;
}

/** Legacy shape of the single-slot `tool` field (kept for backward compatibility). */
export interface StreamToolCurrent {
  name: string;
  summary: string;
}

export interface StreamSnapshot {
  /** True while an assistant message is in flight (deltas still arriving). */
  streaming: boolean;
  /** Tail (last STREAM_MAX_CHARS) of the current assistant text; "" when none. */
  text: string;
  /** Epoch ms when the current assistant message started, else null. */
  turnStartedAt: number | null;
  /** Epoch ms when the current run started (agent_start), else null. */
  runStartedAt: number | null;
  /** The tool call currently being formed in the partial message, if any (legacy single slot). */
  tool: StreamToolCurrent | null;
  /** ALL tool calls of the current run, in order, deduped by toolCall id (last STREAM_MAX_TOOLS). */
  tools: StreamTool[];
}

export const EMPTY_STREAM: StreamSnapshot = {
  streaming: false,
  text: "",
  turnStartedAt: null,
  runStartedAt: null,
  tool: null,
  tools: [],
};

/** Visible text of a (partial) message: text blocks joined by newlines, trimmed. */
export function assistantTextOf(message: unknown): string {
  const content = (message as { content?: unknown })?.content;
  if (!Array.isArray(content)) return "";
  return content
    .filter((c: any) => c?.type === "text" && typeof c.text === "string")
    .map((c: any) => c.text as string)
    .join("\n")
    .trim();
}

interface ToolBlock {
  id: string | null;
  name: string;
  summary: string;
  /** Index of the toolCall block within the message content array. */
  blockIndex: number;
}

/** All toolCall blocks of a (partial) message, in content order, as bounded previews. */
function toolBlocksOf(message: unknown): ToolBlock[] {
  const content = (message as { content?: unknown })?.content;
  if (!Array.isArray(content)) return [];
  const out: ToolBlock[] = [];
  content.forEach((c: any, i: number) => {
    if (c?.type === "toolCall" && typeof c.name === "string") {
      let summary = "";
      try { summary = JSON.stringify(c.arguments) ?? ""; } catch { summary = ""; }
      out.push({
        id: typeof c.id === "string" && c.id ? c.id : null,
        name: c.name,
        summary: summary.slice(0, STREAM_TOOL_PREVIEW_CHARS),
        blockIndex: i,
      });
    }
  });
  return out;
}

/**
 * Last toolCall block of a (partial) message, as a bounded preview — the
 * legacy single-slot view (`tool` field). New consumers should read `tools`.
 */
export function toolOf(message: unknown): StreamToolCurrent | null {
  const blocks = toolBlocksOf(message);
  const last = blocks[blocks.length - 1];
  return last ? { name: last.name, summary: last.summary } : null;
}

function tail(text: string): string {
  return text.length > STREAM_MAX_CHARS ? text.slice(-STREAM_MAX_CHARS) : text;
}

/** Run-scoped entry: a tool call plus the message position it came from. */
interface RunTool extends StreamTool {
  /** Monotonic per-message sequence (startAssistant order); position merge key. */
  msgSeq: number;
  /** toolCall block index within that message. */
  blockIndex: number;
}

/**
 * The extension-side state behind GET /stream. Additive to the bridge API:
 * existing endpoints and response shapes are untouched (`tool` keeps its
 * single-slot meaning; `tools` and `runStartedAt` are new fields).
 */
export class StreamBuffer {
  private streaming = false;
  private text = "";
  private turnStartedAt: number | null = null;
  private runStartedAt: number | null = null;
  /** Monotonic message counter: wall-clock turnStartedAt collides within the same millisecond. */
  private msgSeq = 0;
  private tools: RunTool[] = [];

  snapshot(): StreamSnapshot {
    // `tool` mirrors the block currently being formed in the PARTIAL message
    // (legacy semantics): the last entry of the current message while
    // streaming, else null — earlier messages' calls live on in `tools`.
    const seq = this.msgSeq;
    const current = this.streaming
      ? [...this.tools].reverse().find((t) => t.msgSeq === seq)
      : undefined;
    return {
      streaming: this.streaming,
      text: this.text,
      turnStartedAt: this.turnStartedAt,
      runStartedAt: this.runStartedAt,
      tool: current ? { name: current.name, summary: current.summary } : null,
      tools: this.tools.map(({ id, name, summary }) => ({ id, name, summary })),
    };
  }

  /** message_start (assistant): a fresh in-flight message inside the current run. */
  startAssistant(): void {
    this.streaming = true;
    this.text = "";
    this.turnStartedAt = Date.now();
    this.msgSeq++;
    if (this.runStartedAt === null) this.runStartedAt = this.turnStartedAt;
  }

  /** message_update (assistant): replace the buffered tail with the partial message. */
  update(message: unknown): void {
    this.streaming = true;
    this.text = tail(assistantTextOf(message));
    this.mergeTools(message);
  }

  /**
   * message_end (assistant): the completed message replaces the live text; the
   * UI swaps its live bubble for the /main-log item (dedupe by content). Tool
   * summaries are refined once more from the final message. A toolCall-only
   * message carries no visible text: clear it.
   */
  endAssistant(message: unknown): void {
    this.streaming = false;
    this.text = tail(assistantTextOf(message));
    this.mergeTools(message);
  }

  /**
   * Merge the message's toolCall blocks into the run-scoped list. Entries from
   * PREVIOUS messages of the run are kept in order (a new message never wipes
   * earlier calls — that was the single-slot bug); entries of the CURRENT
   * message are replaced by toolCall id, or by message+block position when a
   * block gains its real id after streaming synthetically-id-less. Bounded to
   * the last STREAM_MAX_TOOLS calls.
   */
  private mergeTools(message: unknown): void {
    const seq = this.msgSeq;
    const fresh: RunTool[] = toolBlocksOf(message).map((b) => ({
      id: b.id ?? `m${seq}b${b.blockIndex}`,
      name: b.name,
      summary: b.summary,
      msgSeq: seq,
      blockIndex: b.blockIndex,
    }));
    if (!fresh.length && !this.tools.length) return;
    const kept = this.tools.filter((t) => !fresh.some((f) =>
      f.id === t.id || (f.msgSeq === t.msgSeq && f.blockIndex === t.blockIndex)));
    this.tools = [...kept, ...fresh].slice(-STREAM_MAX_TOOLS);
  }

  /** Run settled without a final message_end (e.g. abort): stop streaming, keep text and tools. */
  settle(): void {
    this.streaming = false;
  }

  /** agent_start: a new run wipes stale content and starts a fresh tool accumulation. */
  reset(): void {
    this.streaming = false;
    this.text = "";
    this.turnStartedAt = null;
    this.runStartedAt = Date.now();
    this.tools = [];
  }
}
