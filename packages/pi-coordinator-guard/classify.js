// classify.js — pure tool-call classifier for pi-coordinator-guard.
//
// Input: a tool call (toolName + input). Output: { category, pattern, excerpt }:
//   category "mutating_bash" — the bash command matches a mutating pattern (a):
//     git commit/push/reset/clean, rm -rf, mv or `>` overwrite outside obvious
//     temp, brew/npm/pip installs, kill/pkill/killall, curl|wget piped into a shell;
//   category "edit_write"    — an edit/write tool call targeting a path OUTSIDE the
//     effective allowlist (b): code-default roots (DEFAULT_ALLOWLIST below) extended
//     by config-file "allow" entries and PI_COORDINATOR_GUARD_ALLOW. Prefix match on
//     lexically normalized absolute paths (no symlink resolution — documented limit);
//   category "dispatch_missing_project_tag" — a subagent_spawn call whose task/
//     arguments do NOT contain the literal token [project:<name>] (d). This is the
//     project-space routing rule: every dispatch must name its attributed project.
//   category "passthrough"   — everything else (c).
//
// Precision over recall: patterns are deliberately narrow. A false positive costs
// one log line; a false negative in enforce mode is contained by the narrow scope
// (mutating bash is log-only by design).

import { resolve as pathResolve } from "node:path";

const EXCERPT_MAX = 200;

/**
 * Code-default allowlist roots for edit/write targets (absolute POSIX paths).
 * The config file "allow" array and PI_COORDINATOR_GUARD_ALLOW only EXTEND this
 * list (union); there is no way to shrink it via config — that is deliberate:
 * these are the roots the coordinator session is ever expected to touch.
 * "My Knowledge Vault" is a read-only source vault; it is allowlisted for the
 * rare sanctioned sync tasks, not for casual edits.
 */
export const DEFAULT_ALLOWLIST = [
  "/Users/yuyuan/PiAgents",
  "/Users/yuyuan/projects",
  "/tmp",
  "/private/tmp",
  "/Users/yuyuan/.pi",
  "/Users/yuyuan/.config",
  "/Users/yuyuan/My Knowledge Vault", // read-only source vault; sanctioned sync only
  "/Users/yuyuan/.feishu-user-plugin",
];

/** Obvious temp prefixes: overwrite/move targets under these are not flagged. */
const TEMP_PREFIXES = [
  "/tmp", "/var/tmp", "/private/tmp", "/private/var/tmp",
  "/var/folders", "/dev/null", "$TMPDIR", "${TMPDIR}",
];

/** Split a shell command into simple segments (approximate; best-effort by design). */
function bashSegments(command) {
  return String(command).split(/&&|\|\||[;|\n]/);
}

function tokens(segment) {
  let t = segment.trim().split(/\s+/).filter(Boolean);
  if (t[0] === "sudo") t = t.slice(1);
  return t;
}

function isObviousTempPath(p) {
  if (!p) return false;
  const s = String(p).replace(/^["']|["']$/g, "");
  return TEMP_PREFIXES.some((pre) => s === pre || s.startsWith(pre + "/"));
}

function firstTokenIs(t, name) {
  return t[0] === name || t[0] === `/${name}` || t[0]?.endsWith(`/${name}`);
}

/** rm -rf (any flag grouping: -rf, -fr, -r -f, --recursive --force, ...). */
function isRmRecursiveForce(t) {
  if (!firstTokenIs(t, "rm")) return false;
  let recursive = false;
  let force = false;
  for (const tok of t.slice(1)) {
    if (tok === "--") break;
    if (tok === "-r" || tok === "-R" || tok === "--recursive") { recursive = true; continue; }
    if (tok === "-f" || tok === "--force") { force = true; continue; }
    if (/^-[a-zA-Z]*r/i.test(tok)) recursive = true;
    if (/^-[a-zA-Z]*f/i.test(tok)) force = true;
  }
  return recursive && force;
}

/** mv whose final target is not an obvious temp path. */
function isMvOutsideTemp(t) {
  if (!firstTokenIs(t, "mv")) return false;
  for (let i = t.length - 1; i >= 1; i--) {
    if (!t[i].startsWith("-")) return !isObviousTempPath(t[i]);
  }
  return true; // mv with no visible target: flag defensively
}

/** Named mutator checks over one segment's tokens: [patternName, predicate]. */
const SEGMENT_MUTATORS = [
  ["git_commit", (t) => firstTokenIs(t, "git") && t[1] === "commit"],
  ["git_push", (t) => firstTokenIs(t, "git") && t[1] === "push"],
  ["git_reset", (t) => firstTokenIs(t, "git") && t[1] === "reset"],
  ["git_clean", (t) => firstTokenIs(t, "git") && t[1] === "clean"],
  ["rm_rf", isRmRecursiveForce],
  ["mv_outside_temp", isMvOutsideTemp],
  ["package_install", (t) =>
    (firstTokenIs(t, "brew") && t[1] === "install") ||
    (firstTokenIs(t, "npm") && (t[1] === "install" || t[1] === "i" || t[1] === "add")) ||
    ((firstTokenIs(t, "pip") || firstTokenIs(t, "pip3")) && t[1] === "install") ||
    ((firstTokenIs(t, "python") || firstTokenIs(t, "python3")) && t[1] === "-m" && t[2] === "pip" && t[3] === "install") ||
    (firstTokenIs(t, "uv") && t[1] === "pip" && t[2] === "install")],
  ["process_kill", (t) =>
    firstTokenIs(t, "kill") || firstTokenIs(t, "pkill") || firstTokenIs(t, "killall")],
];

/** curl/wget piped into sh/bash/zsh/dash/fish (checked on the raw command). */
const PIPE_TO_SHELL = /(?:^|[\s;|(])(?:curl|wget)\b[^;&]*\|\s*(?:sudo\s+)?(?:ba|z|da|fi)?sh\b/;

/** `>` overwrite redirection to a non-obvious-temp target (append `>>` is not flagged). */
const OVERWRITE_REDIRECT = /(?:^|[\s;(])>(?!>)\s*("[^"]*"|'[^']*'|\S+)/;

/** Literal [project:<name>] token required in every subagent_spawn dispatch. */
const PROJECT_TAG = /\[project:[^\]\s]+\]/;
const PROJECT_TAG_GLOBAL = /\[project:[^\]\s]+\]/g;
const PROJECT_TAG_PREFIX = "[project:";

/**
 * Placeholder exemption (live false positive, 2026-11-13): a tag NAME containing
 * angle brackets is the DOCUMENTATION CONVENTION string ("[project:<name>]",
 * as printed in AGENTS.md/README prose), never a real project id. It must be
 * exempt from tag extraction: (a) prose mentions of the convention must not be
 * validated against the registry (the registry lookup would deny unknown
 * project "<name>"), and (b) a placeholder alone does NOT satisfy the
 * dispatch-tag rule — a real, non-placeholder tag is still required.
 */
export function isPlaceholderTagName(name) {
  return /[<>]/.test(String(name ?? ""));
}

/** All NON-placeholder [project:<name>] matches in a haystack (raw match objects). */
function realTagMatches(haystack) {
  return [...haystack.matchAll(PROJECT_TAG_GLOBAL)].filter(
    (m) => !isPlaceholderTagName(m[0].slice(PROJECT_TAG_PREFIX.length, -1)),
  );
}

/** Exact quoted '/reload' token: "/reload" or '/reload' (not paths like src/reload/x). */
const QUOTED_RELOAD = /(["'])\/reload\1/;

/**
 * /reload detection for the reload_safety category (expansion plan A3):
 * a tool-call-visible attempt to reload the coordinator TUI. Precision-first —
 * only the realistic dispatch vectors count:
 *   reload_send_keys — a bash segment invoking tmux send-keys whose keys mention /reload;
 *   reload_quoted    — an exactly-quoted "/reload" token anywhere in the command;
 *   reload_bare      — the whole command IS /reload.
 * A TUI-typed /reload never reaches the guard (no tool call happens) — out of
 * scope by construction. Paths like src/reload/index.ts do not match (no exact
 * quoted token, no send-keys). Returns the pattern name or null.
 */
export function classifyReloadBash(command) {
  if (typeof command !== "string" || command.length === 0) return null;
  if (command.trim() === "/reload") return "reload_bare";
  // send-keys first: the specific dispatch vector names the pattern even when
  // the keys are also a quoted "/reload" token.
  for (const segment of bashSegments(command)) {
    if (!segment.includes("/reload")) continue;
    const t = tokens(segment);
    if (t.length === 0) continue;
    if (t.some((tok) => tok === "send-keys" || tok.endsWith("/send-keys"))) {
      return "reload_send_keys";
    }
  }
  if (QUOTED_RELOAD.test(command)) return "reload_quoted";
  return null;
}

/** Classify a bash command. Returns the matched pattern name, or null. */
export function classifyBash(command) {
  if (typeof command !== "string" || command.length === 0) return null;
  if (PIPE_TO_SHELL.test(command)) return "pipe_to_shell";
  for (const segment of bashSegments(command)) {
    const t = tokens(segment);
    if (t.length === 0) continue;
    for (const [name, matches] of SEGMENT_MUTATORS) {
      if (matches(t)) return name;
    }
  }
  const redirect = command.match(OVERWRITE_REDIRECT);
  if (redirect && !redirect[1].startsWith("&") && !isObviousTempPath(redirect[1])) {
    return "overwrite_outside_temp";
  }
  return null;
}

/**
 * Is this edit/write target path covered by the allowlist (path prefixes)?
 * Paths are LEXICALLY normalized (node:path resolve) so ".." traversal cannot
 * escape a root, e.g. /root/allowed/../secret resolves to /secret and is then
 * matched against the prefixes. Symlinks are NOT resolved (would need fs I/O and
 * breaks for not-yet-existing write targets) — a symlink inside an allowlisted
 * root pointing outside is a documented, accepted limitation.
 */
export function isAllowlisted(p, allowlist, cwd = process.cwd()) {
  if (!Array.isArray(allowlist) || allowlist.length === 0 || typeof p !== "string" || p === "") return false;
  let target;
  try { target = resolveTarget(cwd, p); } catch { return false; }
  if (target === null) return false; // "~..." cannot be proven inside an absolute root
  return allowlist.some((prefix) => {
    let pre;
    try { pre = pathResolve(String(prefix)); } catch { return false; }
    return target === pre || target.startsWith(pre.endsWith("/") ? pre : pre + "/");
  });
}

/** Normalize to an absolute path; "~..." has no provable absolute root → null. */
function resolveTarget(cwd, p) {
  if (p.startsWith("~")) return null;
  return pathResolve(cwd, p); // normalizes "..", ".", duplicate slashes
}

function head(s) {
  return String(s).slice(0, EXCERPT_MAX);
}

/**
 * Classify a subagent_spawn call against the [project:<name>] tag rule.
 * The tag may sit anywhere in the task or the other arguments (label, cwd, ...).
 * Returns the category "dispatch_missing_project_tag" or null (tag present).
 */
export function classifySpawn(input) {
  try {
    const haystack = JSON.stringify(input ?? {});
    // Only a REAL (non-placeholder) tag satisfies the rule; the documentation
    // convention string "[project:<name>]" in prose does not count (see
    // isPlaceholderTagName).
    return realTagMatches(haystack).length > 0 ? null : "dispatch_missing_project_tag";
  } catch {
    return "dispatch_missing_project_tag"; // unserializable args: flag defensively
  }
}

/**
 * All [project:<name>] tag names found anywhere in the serialized spawn input
 * (same haystack as classifySpawn, so the registry check validates exactly what
 * the format check accepted). Returns [] when no tag is present, null when the
 * input is unserializable (classifySpawn flags that case defensively already).
 * Pure: no I/O, never throws.
 */
export function extractProjectTags(input) {
  try {
    const hay = JSON.stringify(input ?? {});
    return realTagMatches(hay).map((m) => m[0].slice(PROJECT_TAG_PREFIX.length, -1));
  } catch {
    return null;
  }
}

/**
 * Classify one tool call. Pure: no I/O, never throws on odd input.
 * Returns { category, pattern, excerpt }; excerpt is the command head (bash),
 * target path (edit/write), or task head (subagent_spawn), truncated to 200 chars.
 */
export function classifyToolCall(toolName, input, { allowlist = DEFAULT_ALLOWLIST, cwd = process.cwd() } = {}) {
  if (toolName === "subagent_spawn") {
    const violation = classifySpawn(input);
    if (violation) {
      const task = input && typeof input.task === "string" ? input.task : JSON.stringify(input ?? {});
      return { category: violation, pattern: violation, excerpt: head(task) };
    }
    return { category: "passthrough", pattern: null, excerpt: null };
  }
  if ((toolName === "bash" || toolName === "powershell") && input && typeof input.command === "string") {
    // reload_safety wins over mutating_bash when both match (e.g.
    // `tmux send-keys '/reload' Enter && git push`): the reload check is the
    // more specific rule and its observe verdict must not be masked.
    const reloadPattern = classifyReloadBash(input.command);
    if (reloadPattern) return { category: "reload_safety", pattern: reloadPattern, excerpt: head(input.command) };
    const pattern = classifyBash(input.command);
    if (pattern) return { category: "mutating_bash", pattern, excerpt: head(input.command) };
    return { category: "passthrough", pattern: null, excerpt: null };
  }
  if ((toolName === "edit" || toolName === "write") && input && typeof input.path === "string" && input.path !== "") {
    if (!isAllowlisted(input.path, allowlist, cwd)) {
      return { category: "edit_write", pattern: "edit_write", excerpt: head(input.path) };
    }
  }
  return { category: "passthrough", pattern: null, excerpt: null };
}
