/**
 * Message routing for POST /message.
 *
 * The coordinator's own pi session is the only injection target that exists from
 * inside this extension: pi-superagent's steer pathway writes to a child process
 * stdin held privately by its SubagentManager, and the pi extension API exposes no
 * cross-extension tool invocation. So per the bridge spec, messages aimed at a
 * subagent are injected into the main session with a machine-parseable header that
 * the coordinator forwards via its own subagent_message tool.
 */

export type RoutedMessage =
  | { ok: true; kind: "main"; text: string }
  | { ok: true; kind: "subagent-fallback"; id: string; text: string }
  | { ok: false; error: string };

const TARGET_SUBAGENT_RE = /^subagent:([A-Za-z0-9][A-Za-z0-9._-]*)$/;

/**
 * Validate a POST /message payload and build the exact text to inject.
 * `project` is stamped into the header so the coordinator can tell which
 * project the message belongs to.
 */
export function routeMessage(target: unknown, text: unknown, project: string, maxTextChars: number): RoutedMessage {
  if (typeof target !== "string" || target.length === 0) return { ok: false, error: "target must be \"main\" or \"subagent:<id>\"" };
  if (typeof text !== "string" || text.trim().length === 0) return { ok: false, error: "text must be a non-empty string" };
  const body = text.trim();
  if (body.length > maxTextChars) return { ok: false, error: `text exceeds ${maxTextChars} chars` };
  if (target === "main") {
    return { ok: true, kind: "main", text: `[web-chat · project:${project}] ${body}` };
  }
  const m = TARGET_SUBAGENT_RE.exec(target);
  if (m) {
    return { ok: true, kind: "subagent-fallback", id: m[1], text: `[web-chat · for-subagent:${m[1]}] ${body}` };
  }
  return { ok: false, error: "target must be \"main\" or \"subagent:<id>\"" };
}
