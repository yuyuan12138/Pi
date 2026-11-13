// pi-coordinator-guard — per-category enforcement for the main coordinator session.
//
// Structural enforcement beats prompt reminders (research sa36: opencode's
// {edit,write}→deny permission set, Aider's no-edit-path architect, CrewAI's
// manager toolset hard-fail). The P0 observe period (commits 699f8ea+) produced
// the evidence; on 2026-11-13 the user decided: process rigor matters — make it
// controllable-but-enforced. This is per-category enforcement, not blanket P0.
//
// Per-category semantics:
//   edit_write                   — enforce mode DENIES edit/write whose target
//                                  resolves outside the effective allowlist
//                                  (code defaults ∪ config "allow" ∪ env).
//                                  Observe mode logs only.
//   dispatch_missing_project_tag — enforce mode DENIES subagent_spawn without the
//                                  literal [project:<name>] token. Observe logs only.
//   dispatch_unknown_project     — enforce mode DENIES a subagent_spawn whose
//                                  [project:<name>] tag names a project that is NOT in
//                                  the coordinator registry. Observe logs only. The
//                                  registry is read (read-only) with a 60s TTL cache;
//                                  a registry READ failure fails OPEN to the format-only
//                                  check with one warning line in the JSONL sink — format
//                                  stays the primary gate, a db hiccup must not brick
//                                  dispatching. Membership mirrors the coordinator router
//                                  (id / alias / canonical root, see registry.js).
//   mutating_bash                — LOG-ONLY IN EVERY MODE. Deliberate, user-ratified
//                                  scope: git push/reset, process cleanup (kill),
//                                  and package installs are legitimate main-session
//                                  duties (release coordination, tunnel/worker
//                                  hygiene) — blocking them mid-session costs more
//                                  than it protects. Upgrade is evidence-gated:
//                                  revisit only when the observe log shows a
//                                  concrete false-negative class.
//   reload_safety                — OBSERVE-ONLY THIS WAVE (expansion plan A3,
//                                  2026-11-13): a tool-call-visible /reload attempt
//                                  (tmux send-keys or quoted "/reload" command text)
//                                  while .pi/subagents shows non-settled dispatches
//                                  is logged as would_deny and NEVER blocked. The
//                                  enforce flip is a USER decision (plan §7 / D3a
//                                  pattern): review the JSONL log first. The
//                                  non-settled inference is not reimplemented —
//                                  reload.js imports tools/restart_handoff.py's
//                                  scan_subagents() as a library (python3 -c), so
//                                  the done/running/stale semantics stay single-
//                                  sourced with the restart runbook's handoff
//                                  ledger. Scan failure logs decision "error"
//                                  (pattern reload_scan_failed) and never blocks.
//                                  A TUI-typed /reload produces no tool call and is
//                                  therefore out of scope by construction.
//
// Mode resolution (per tool call, precedence env > config file > default):
//   1. PI_COORDINATOR_GUARD env, when set: "enforce" → enforce, anything else → observe.
//   2. ~/.pi/agent/coordinator-guard.json, read live via a stat+mtime cache
//      (edits apply without /reload): {"version":1,"mode":"observe|enforce","allow":[...]}.
//   3. Safe default: observe.
// Missing/corrupt config falls back to observe and logs the parse error once
// per file change to the JSONL sink.
//
// Deny contract: pi 1.5.0 ToolCallEventResult { block?: boolean, reason?: string }
// (dist/core/extensions/types.d.ts) — re-verified against the installed types.
//
// Scope: the MAIN coordinator session only. Worker sessions are spawned by
// pi-superagent with `--mode rpc --no-extensions ... -e <extensionPath>`
// (packages/pi-superagent/src/subagent/manager.ts), so this extension is never
// loaded in workers and never sees their traffic. Division of labor with the
// spawner (pi-superagent/src/subagent/manager.ts): because workers run
// --no-extensions, the guard cannot see sub-spawns — the manager enforces the
// tag FORMAT at the spawn chokepoint for every path (root and nested), while
// REGISTRY truth (does <name> exist?) stays here, where the registry db and the
// coordinator router live. The manager deliberately does not duplicate registry
// validation.
//
// Failure posture: the handler wraps everything in try/catch and swallows all
// errors — a broken guard must never break the session.

import { classifyToolCall, extractProjectTags, DEFAULT_ALLOWLIST } from "./classify.js";
import { appendGuardLog, DEFAULT_LOG_PATH } from "./log.js";
import { createConfigLoader, DEFAULT_CONFIG_PATH } from "./config.js";
import { readRegistryProjects, registryProjectId, DEFAULT_REGISTRY_DB } from "./registry.js";
import { scanNonSettledDispatches, nonSettledExcerpt, PROJECT_ROOT_ENV } from "./reload.js";

const EXCERPT_MAX = 200;

function head(s) {
  return String(s).slice(0, EXCERPT_MAX);
}

/** env var overriding the mode: "enforce" | anything else (forces observe). */
export const MODE_ENV = "PI_COORDINATOR_GUARD";
/** env var: colon-separated path prefixes ADDED to the edit/write allowlist. */
export const ALLOW_ENV = "PI_COORDINATOR_GUARD_ALLOW";
/** env var: log sink override (default ~/.pi/agent/logs/coordinator-guard.jsonl). */
export const LOG_PATH_ENV = "PI_COORDINATOR_GUARD_LOG";
/** Re-exported from reload.js: env var overriding the project root for the reload_safety scan. */
export { PROJECT_ROOT_ENV };

/** Legacy env-only resolution (kept for compatibility): default observe. */
export function resolveMode(env = process.env) {
  return env[MODE_ENV] === "enforce" ? "enforce" : "observe";
}

/** Tri-state env mode: undefined when unset (→ the config file decides). */
export function resolveEnvMode(env = process.env) {
  const v = env[MODE_ENV];
  if (v === undefined) return undefined;
  return v === "enforce" ? "enforce" : "observe";
}

/** Parse the env allowlist (colon-separated); additive to the code defaults. */
export function resolveAllowlist(env = process.env) {
  const raw = env[ALLOW_ENV];
  if (!raw) return [];
  return String(raw).split(":").map((s) => s.trim()).filter(Boolean);
}

export function resolveLogPath(env = process.env) {
  return env[LOG_PATH_ENV] || DEFAULT_LOG_PATH;
}

/** Effective allowlist = code defaults ∪ config "allow" ∪ env (all additive). */
export function buildAllowlist(configAllow = [], env = process.env) {
  return [...DEFAULT_ALLOWLIST, ...configAllow, ...resolveAllowlist(env)];
}

/** Actionable deny reason for an out-of-allowlist edit/write (names path + allowlist). */
export function editWriteDenyReason(toolName, targetPath, allowlist, logPath) {
  const roots = allowlist.map((r) => JSON.stringify(r)).join(", ");
  return (
    `pi-coordinator-guard (enforce): ${toolName} target ${JSON.stringify(targetPath)} is OUTSIDE the ` +
    `guard allowlist. Allowed roots: ${roots}. To sanction another root, add it to "allow" in ` +
    `~/.pi/agent/coordinator-guard.json. The coordinator session edits only via dispatched subagents — ` +
    `hand this edit to a subagent. Decision logged to ${logPath}.`
  );
}

/** Actionable deny reason for an untagged subagent_spawn dispatch. */
export function spawnDenyReason(logPath) {
  return (
    `pi-coordinator-guard (enforce): subagent_spawn is missing the required [project:<name>] token. ` +
    `Prefix the task with the attributed project, e.g. "[project:PiAgents] ...". ` +
    `Decision logged to ${logPath}.`
  );
}

/**
 * Actionable deny reason for a spawn tag naming an unregistered project: names the
 * offending tag and lists the registered project ids so the dispatch is one edit away
 * from valid. Registered ids are the canonical routing identifiers; aliases are also
 * accepted at check time (router parity) but are not listed to keep the reason short.
 */
export function unknownProjectDenyReason(tagName, registeredIds, logPath) {
  const ids = (registeredIds ?? []).map((id) => JSON.stringify(id)).join(", ");
  return (
    `pi-coordinator-guard (enforce): subagent_spawn tag [project:${tagName}] names a project that is NOT in the coordinator registry. ` +
    `Registered project ids: ${ids || "(none)"}. Use one of these ids in the tag, or register the project with the coordinator first. ` +
    `Decision logged to ${logPath}.`
  );
}

/**
 * Build the tool_call handler. Options override live resolution (for tests /
 * hard pinning): mode pins the mode, allowlist pins the whole allowlist,
 * configPath redirects the config file, env swaps the env source; projectRoot /
 * pythonPath / scanTimeoutMs pin the reload_safety subagent scan (tests).
 * The handler classifies, logs would-deny/denied decisions, and returns
 * { block: true, reason } per the pi 1.5.0 ToolCallEventResult contract. It NEVER throws.
 */
export function createGuard(options = {}) {
  const pinnedMode = options.mode;
  const pinnedAllowlist = options.allowlist;
  const envSource = options.env ?? process.env;
  const logPath = options.logPath ?? resolveLogPath(envSource);
  const configPath = options.configPath ?? DEFAULT_CONFIG_PATH;
  const registryPath = options.registryPath ?? DEFAULT_REGISTRY_DB;
  // Identity of the registry read whose failure was last warned about: readRegistryProjects
  // returns the same cached object within the TTL window, so a new object means a fresh read
  // (or a state change) and the warning fires once per read, not once per tool call.
  let registryWarnedFor = null;
  const loadConfig = createConfigLoader({
    configPath,
    onError: (message) => {
      appendGuardLog(
        {
          ts: new Date().toISOString(),
          mode: "unknown",
          decision: "error",
          tool: "_config",
          category: "config_error",
          pattern: "config_parse_error",
          excerpt: configPath,
          error: message,
        },
        logPath,
      );
    },
  });

  return async function guardToolCall(event) {
    try {
      const cfg = loadConfig(); // stat-cached; re-read live on mtime change
      const mode = pinnedMode ?? resolveEnvMode(envSource) ?? cfg.mode;
      const allowlist = pinnedAllowlist ?? buildAllowlist(cfg.allow, envSource);

      let { category, pattern, excerpt } = classifyToolCall(event?.toolName, event?.input, { allowlist });
      let unknownTag = null;
      let registeredIds = null;
      if (event?.toolName === "subagent_spawn" && category === "passthrough") {
        // Tag format is fine — validate the name(s) against the coordinator registry
        // (TTL-cached read; fail-open on read errors, see registry.js + header).
        const reg = readRegistryProjects(registryPath);
        if (reg.projects === null) {
          if (reg !== registryWarnedFor) {
            registryWarnedFor = reg;
            appendGuardLog(
              {
                ts: new Date().toISOString(),
                mode,
                decision: "error",
                tool: "_registry",
                category: "registry_unavailable",
                pattern: "registry_read_failed",
                excerpt: registryPath,
                error: reg.error,
              },
              logPath,
            );
          }
        } else {
          registeredIds = reg.projects.filter((p) => p.status === "registered").map((p) => p.id);
          const tags = extractProjectTags(event?.input) ?? [];
          unknownTag = tags.find((t) => registryProjectId(reg.projects, t) === null) ?? null;
          if (unknownTag !== null) {
            category = pattern = "dispatch_unknown_project";
            const task = event?.input && typeof event.input.task === "string" ? event.input.task : JSON.stringify(event?.input ?? {});
            excerpt = head(String(task));
          }
        }
      }
      if (category === "passthrough") return undefined;

      // reload_safety (A3): OBSERVE-ONLY this wave — log and pass through, never
      // block, in every mode. The scan reuses restart_handoff.py's inference
      // (see reload.js); a safe reload (everything settled) passes silently.
      if (category === "reload_safety") {
        const scan = await scanNonSettledDispatches({
          projectRoot: options.projectRoot ?? envSource[PROJECT_ROOT_ENV],
          pythonPath: options.pythonPath,
          timeoutMs: options.scanTimeoutMs,
        });
        if (scan.ok && scan.nonSettled.length === 0) return undefined;
        appendGuardLog(
          {
            ts: new Date().toISOString(),
            mode,
            decision: scan.ok ? "would_deny" : "error",
            tool: event?.toolName,
            category: "reload_safety",
            pattern: scan.ok ? pattern : "reload_scan_failed",
            excerpt: scan.ok ? nonSettledExcerpt(scan.nonSettled) : excerpt,
            ...(scan.ok ? {} : { error: scan.error }),
            toolCallId: event?.toolCallId,
          },
          logPath,
        );
        return undefined;
      }

      // Per-category enforcement (see header): edit_write and the two spawn-tag rules
      // deny in enforce mode; mutating_bash is log-only in EVERY mode; reload_safety
      // never reaches this line (observe-only branch above returns early).
      const deny =
        mode === "enforce" &&
        (category === "edit_write" ||
          category === "dispatch_missing_project_tag" ||
          category === "dispatch_unknown_project");

      appendGuardLog(
        {
          ts: new Date().toISOString(),
          mode,
          decision: deny ? "denied" : "would_deny",
          tool: event?.toolName,
          category,
          pattern,
          excerpt,
          toolCallId: event?.toolCallId,
        },
        logPath,
      );

      if (deny) {
        if (category === "edit_write") {
          return { block: true, reason: editWriteDenyReason(event?.toolName, excerpt, allowlist, logPath) };
        }
        if (category === "dispatch_unknown_project") {
          return { block: true, reason: unknownProjectDenyReason(unknownTag, registeredIds, logPath) };
        }
        return { block: true, reason: spawnDenyReason(logPath) };
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
