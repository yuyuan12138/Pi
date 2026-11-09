/**
 * Bounded in-flight assistant buffer for the live streaming view.
 *
 * Fed by the pi extension hooks message_start / message_update / message_end
 * (assistant role only). pi emits message_update per provider stream delta with
 * the partial message, so the buffer mirrors what the terminal shows while the
 * coordinator replies: growing text plus the tool call currently being formed.
 * Everything is bounded: a huge reply cannot balloon memory or payload.
 *
 * The session JSONL only persists complete messages (at message_end), so file
 * polling can never see partial text — this hook-fed buffer is the mechanism.
 */

export const STREAM_MAX_CHARS = 8000;
export const STREAM_TOOL_PREVIEW_CHARS = 200;

export interface StreamTool {
  name: string;
  /** Bounded JSON preview of the (possibly still streaming) arguments. */
  summary: string;
}

export interface StreamSnapshot {
  /** True while an assistant message is in flight (deltas still arriving). */
  streaming: boolean;
  /** Tail (last STREAM_MAX_CHARS) of the current assistant text; "" when none. */
  text: string;
  /** Epoch ms when the current assistant message started, else null. */
  turnStartedAt: number | null;
  /** The tool call currently being formed in the partial message, if any. */
  tool: StreamTool | null;
}

export const EMPTY_STREAM: StreamSnapshot = { streaming: false, text: "", turnStartedAt: null, tool: null };

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

/** Last toolCall block of a (partial) message, as a bounded preview. */
export function toolOf(message: unknown): StreamTool | null {
  const content = (message as { content?: unknown })?.content;
  if (!Array.isArray(content)) return null;
  for (let i = content.length - 1; i >= 0; i--) {
    const c = content[i] as any;
    if (c?.type === "toolCall" && typeof c.name === "string") {
      let summary = "";
      try { summary = JSON.stringify(c.arguments) ?? ""; } catch { summary = ""; }
      return { name: c.name, summary: summary.slice(0, STREAM_TOOL_PREVIEW_CHARS) };
    }
  }
  return null;
}

function tail(text: string): string {
  return text.length > STREAM_MAX_CHARS ? text.slice(-STREAM_MAX_CHARS) : text;
}

/**
 * The extension-side state behind GET /stream. Additive to the bridge API:
 * existing endpoints and response shapes are untouched.
 */
export class StreamBuffer {
  private streaming = false;
  private text = "";
  private turnStartedAt: number | null = null;
  private tool: StreamTool | null = null;

  snapshot(): StreamSnapshot {
    return { streaming: this.streaming, text: this.text, turnStartedAt: this.turnStartedAt, tool: this.tool };
  }

  /** message_start (assistant): a fresh in-flight window. */
  startAssistant(): void {
    this.streaming = true;
    this.text = "";
    this.turnStartedAt = Date.now();
    this.tool = null;
  }

  /** message_update (assistant): replace the buffered tail with the partial message. */
  update(message: unknown): void {
    this.streaming = true;
    this.text = tail(assistantTextOf(message));
    this.tool = toolOf(message);
  }

  /**
   * message_end (assistant): the completed message replaces the live text; the
   * UI swaps its live bubble for the /main-log item (dedupe by content). A
   * toolCall-only message carries no visible text: clear it.
   */
  endAssistant(message: unknown): void {
    this.streaming = false;
    this.text = tail(assistantTextOf(message));
    this.tool = null;
  }

  /** Run settled without a final message_end (e.g. abort): stop streaming, keep text. */
  settle(): void {
    this.streaming = false;
    this.tool = null;
  }

  /** agent_start: a new run wipes stale content. */
  reset(): void {
    this.streaming = false;
    this.text = "";
    this.turnStartedAt = null;
    this.tool = null;
  }
}
