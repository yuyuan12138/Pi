// reload.js — non-settled-dispatch scanner for the guard's reload_safety
// category (expansion plan A3).
//
// Before a /reload of the coordinator TUI, in-flight subagent dispatches would
// be orphaned (the 2026-11-13 restart forensics: docs/runbooks/pi-restart.md —
// /reload does not even swap module code in a long-lived process). This module
// answers one question: "are there non-settled dispatches right now?"
//
// Single source of truth: tools/restart_handoff.py (expansion plan A1) already
// implements the done/running/stale inference (done = result.md written or a
// terminal event in the events.jsonl tail; stale = no marker + >30min quiet).
// We REUSE it as a library — a python3 -c snippet imports the module and
// JSON-dumps scan_subagents() — never a JS reimplementation, so the two tools
// cannot drift apart.
//
// Failure posture: fail-open, never rejects. Any problem (python missing,
// module import error, timeout, bad JSON) resolves { ok:false, error } and the
// caller logs one "error" decision line. The scan is read-only (one `python3`
// subprocess; restart_handoff.py itself spawns only a read-only `ps` when
// snapshotting — scan_subagents does not even do that).

import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { join } from "node:path";

const execFileP = promisify(execFile);

/** Project root holding tools/restart_handoff.py and .pi/subagents/ (tests override). */
export const DEFAULT_PROJECT_ROOT = "/Users/yuyuan/PiAgents";
/** env var overriding the project root (same precedence slot as the other PI_COORDINATOR_GUARD_* vars). */
export const PROJECT_ROOT_ENV = "PI_COORDINATOR_GUARD_PROJECT_ROOT";
/** env var overriding the python interpreter (rare; tests use options instead). */
export const PYTHON_ENV = "PI_COORDINATOR_GUARD_PYTHON";
/** Subprocess timeout: the scan is a local directory read — anything slower is broken. */
export const DEFAULT_SCAN_TIMEOUT_MS = 5_000;

/** python3 -c snippet: import restart_handoff as a LIBRARY and dump scan_subagents(). */
export function scanSnippet(toolsDir, subagentsDir) {
  return (
    "import json, sys; " +
    "from pathlib import Path; " +
    `sys.path.insert(0, ${JSON.stringify(toolsDir)}); ` +
    "import restart_handoff; " +
    // scan_subagents takes a Path (calls .is_dir()), not a str.
    `print(json.dumps(restart_handoff.scan_subagents(Path(${JSON.stringify(subagentsDir)}))))`
  );
}

/** One-line human summary of the non-settled entries (for the log excerpt). */
export function nonSettledExcerpt(nonSettled, max = 200) {
  const body = nonSettled
    .map((e) => `${e.id ?? "?"} (${e.status ?? "?"})`)
    .join(", ");
  const line = `${nonSettled.length} non-settled dispatch(es): ${body}`;
  return line.length > max ? line.slice(0, max) : line;
}

/**
 * Scan <projectRoot>/.pi/subagents for non-settled dispatches using
 * restart_handoff.py's scan_subagents. Options (all optional): projectRoot,
 * pythonPath, timeoutMs, toolsDir, subagentsDir — injection points for tests.
 * Resolves { ok: true, nonSettled: [...], total } or { ok: false, error }.
 * Never rejects.
 */
export async function scanNonSettledDispatches(options = {}) {
  const root = options.projectRoot ?? process.env[PROJECT_ROOT_ENV] ?? DEFAULT_PROJECT_ROOT;
  const pythonPath = options.pythonPath ?? process.env[PYTHON_ENV] ?? "python3";
  const timeoutMs = options.timeoutMs ?? DEFAULT_SCAN_TIMEOUT_MS;
  const toolsDir = options.toolsDir ?? join(root, "tools");
  const subagentsDir = options.subagentsDir ?? join(root, ".pi", "subagents");
  try {
    const { stdout } = await execFileP(pythonPath, ["-c", scanSnippet(toolsDir, subagentsDir)], {
      timeout: timeoutMs,
    });
    const entries = JSON.parse(stdout);
    if (!Array.isArray(entries)) throw new Error("scan_subagents returned a non-array");
    return { ok: true, nonSettled: entries.filter((e) => e && e.status !== "done"), total: entries.length };
  } catch (e) {
    return { ok: false, error: String(e?.message ?? e ?? "reload scan failed") };
  }
}
