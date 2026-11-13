// pi-coordinator-guard — P0 OBSERVE MODE ONLY for the main coordinator session.
//
// Structural enforcement beats prompt reminders (research sa36: opencode's
// {edit,write}→deny permission set, Aider's no-edit-path architect, CrewAI's
// manager toolset hard-fail). P0 runs in observe mode: every main-session tool
// call is classified and would-deny decisions are logged — the call itself is
// NEVER blocked, modified, or delayed. After 1-2 days the user reviews the log
// and decides whether to flip enforcement; that flip is a user decision.
//
// What is classified (would_deny candidates):
//   (a) mutating_bash             — git commit/push/reset/clean, rm -rf, mv or
//                                   `>` overwrite outside obvious temp,
//                                   brew/npm/pip installs, kill/pkill/killall,
//                                   curl|wget piped into a shell;
//   (b) edit_write                — edit/write targeting a path outside the
//                                   PI_COORDINATOR_GUARD_ALLOW allowlist (P0
//                                   default: empty — the turn's attributed
//                                   project space is not yet derivable, so the
//                                   target path is simply logged);
//   (d) dispatch_missing_project_tag — subagent_spawn whose task/arguments lack
//                                   the literal [project:<name>] token. Observe
//                                   only, in every mode, per scope decision.
//   (c) everything else passes through untouched, unlogged.
//
// Enforce stub: PI_COORDINATOR_GUARD=enforce would deny (b) only; default is
// observe. Flipping is a user decision AFTER reviewing the log (see README).
//
// Scope: the MAIN coordinator session only. Worker sessions are spawned by
// pi-superagent with `--mode rpc --no-extensions ... -e <extensionPath>`
// (packages/pi-superagent/src/subagent/manager.ts), so this extension is never
// loaded in workers and never sees their traffic.
//
// Failure posture: the handler wraps everything in try/catch and swallows all
// errors — a broken guard must never break the session.

import { classifyToolCall } from "./classify.js";
import { appendGuardLog, DEFAULT_LOG_PATH } from "./log.js";

/** env var selecting the mode: "enforce" | anything else (default "observe"). */
export const MODE_ENV = "PI_COORDINATOR_GUARD";
/** env var: colon-separated path prefixes exempt from the edit/write flag. */
export const ALLOW_ENV = "PI_COORDINATOR_GUARD_ALLOW";
/** env var: log sink override (default ~/.pi/agent/logs/coordinator-guard.jsonl). */
export const LOG_PATH_ENV = "PI_COORDINATOR_GUARD_LOG";

export function resolveMode(env = process.env) {
  return env[MODE_ENV] === "enforce" ? "enforce" : "observe";
}

export function resolveAllowlist(env = process.env) {
  const raw = env[ALLOW_ENV];
  if (!raw) return [];
  return String(raw).split(":").map((s) => s.trim()).filter(Boolean);
}

export function resolveLogPath(env = process.env) {
  return env[LOG_PATH_ENV] || DEFAULT_LOG_PATH;
}

/**
 * Build the tool_call handler. Options override env resolution (for tests).
 * The handler classifies, logs would-deny decisions, and (only in enforce mode,
 * only for edit_write) returns { block, reason }. It NEVER throws.
 */
export function createGuard(options = {}) {
  const mode = options.mode ?? resolveMode();
  const allowlist = options.allowlist ?? resolveAllowlist();
  const logPath = options.logPath ?? resolveLogPath();

  return async function guardToolCall(event) {
    try {
      const { category, pattern, excerpt } = classifyToolCall(event?.toolName, event?.input, { allowlist });
      if (category === "passthrough") return undefined;

      // Enforce mode denies (b) edit_write only; (a) mutating_bash and
      // (d) dispatch_missing_project_tag stay observe-only in P0.
      const blocked = mode === "enforce" && category === "edit_write";
      appendGuardLog(
        {
          ts: new Date().toISOString(),
          mode,
          decision: blocked ? "denied" : "would_deny",
          tool: event?.toolName,
          category,
          pattern,
          excerpt,
          toolCallId: event?.toolCallId,
        },
        logPath,
      );
      if (blocked) {
        return {
          block: true,
          reason:
            `pi-coordinator-guard (enforce): ${event?.toolName} target is outside the ` +
            `guard allowlist — dispatch this edit to a subagent (the coordinator session ` +
            `does not edit inline). Decision logged to ${logPath}.`,
        };
      }
    } catch {
      // Swallowed silently: guard failures must never break the session.
    }
    return undefined;
  };
}

/** Extension entry point: registers exactly one tool_call handler. */
export default function coordinatorGuardExtension(pi) {
  try {
    pi.on("tool_call", createGuard());
  } catch {
    // Swallowed silently.
  }
}
