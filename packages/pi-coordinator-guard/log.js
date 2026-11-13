// log.js — JSONL log-writer for pi-coordinator-guard (P0 observe mode).
//
// Appends one JSON line per flagged call to
//   ~/.pi/agent/logs/coordinator-guard.jsonl   (dir 0700, file created 0600)
// ALL failures are swallowed silently: the guard must never break the session,
// so this returns true/false instead of throwing, ever.

import { appendFileSync, mkdirSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";

/** Default sink. Override in the extension via PI_COORDINATOR_GUARD_LOG. */
export const DEFAULT_LOG_PATH = join(homedir(), ".pi", "agent", "logs", "coordinator-guard.jsonl");

const EXCERPT_MAX = 200;

/**
 * Append one entry as a JSON line. Never throws.
 * @param {object} entry plain-JSON-serializable fields (ts, tool, category, pattern, excerpt, ...)
 * @param {string} [logPath] sink path; created (dir included) if missing
 * @returns {boolean} true when the line was appended
 */
export function appendGuardLog(entry, logPath = DEFAULT_LOG_PATH) {
  try {
    const e = { ...entry };
    if (typeof e.excerpt === "string" && e.excerpt.length > EXCERPT_MAX) {
      e.excerpt = e.excerpt.slice(0, EXCERPT_MAX);
    }
    mkdirSync(dirname(logPath), { recursive: true, mode: 0o700 });
    appendFileSync(logPath, `${JSON.stringify(e)}\n`, { mode: 0o600 });
    return true;
  } catch {
    return false; // swallowed: file errors never break the session
  }
}
