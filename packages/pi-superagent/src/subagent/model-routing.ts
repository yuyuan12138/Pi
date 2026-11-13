/**
 * Declarative model routing (Theme D4, work/2026-11-13/architecture-expansion/PLAN.md):
 * an OPTIONAL routing table at ~/.pi/agent/model-routing.json maps selectors to a
 * model id for spawned subagents. Posture:
 *
 *   - ABSENT (the default on every host) = exactly the pre-D4 behavior: explicit
 *     model arg > PI_SUBAGENT_MODEL env > built-in fallback. Nothing else changes.
 *   - When present, the table only fills the DEFAULT slot — an explicit per-spawn
 *     `model` argument ALWAYS wins. No user-specified model is ever silently overridden.
 *   - Selector priority inside the table: `projects[<tag>]` (from the task's
 *     [project:<name>] token, exact match) > `roles[<role>]` (spawn `role` option,
 *     exact match) > `default`. Any table hit beats the env slot.
 *   - Latched at SubagentManager construction — restart / new session to change.
 *   - Malformed table: ignored with a one-line stderr warning; spawning never breaks.
 *
 * Full precedence (mirrored in the package README):
 *   1. explicit `model` arg          (user-specified — always wins)
 *   2. routing table projects[...]   (table present + project tag hit)
 *   3. routing table roles[...]      (table present + role hit)
 *   4. routing table default         (table present, no selector matched)
 *   5. PI_SUBAGENT_MODEL env
 *   6. built-in fallback (FALLBACK_MODEL)
 */
import { readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

/** Built-in last-resort model (unchanged from the pre-D4 hardcoded default). */
export const FALLBACK_MODEL = "training-coder/GLM-5.3-Flash";

/** Default routing table location. Absent file = exactly current behavior. */
export const MODEL_ROUTING_PATH = join(homedir(), ".pi", "agent", "model-routing.json");

export interface ModelRoutingConfig {
  /** project id (the [project:<name>] token in the task, matched exactly) -> model id */
  projects?: Record<string, string>;
  /** spawn `role` option (matched exactly) -> model id */
  roles?: Record<string, string>;
  /** fills the default slot when no selector matches (beats env, loses to explicit args) */
  default?: string;
}

export type ModelSource = "explicit" | "route:project" | "route:role" | "route:default" | "env" | "fallback";

export interface ModelResolution {
  model: string;
  source: ModelSource;
}

/** Non-empty, trimmed string; anything else -> undefined. */
function clean(s: unknown): string | undefined {
  return typeof s === "string" && s.trim() ? s.trim() : undefined;
}

/**
 * Tolerant table parse: absent/garbage -> undefined; structurally valid document ->
 * sanitized config with individual bad entries dropped. A section typed as anything
 * but an object marks the whole document malformed (caller warns).
 */
export function parseModelRouting(raw: string | undefined): ModelRoutingConfig | undefined {
  if (raw === undefined || raw.trim() === "") return undefined;
  let doc: unknown;
  try { doc = JSON.parse(raw); } catch { return undefined; }
  if (typeof doc !== "object" || doc === null || Array.isArray(doc)) return undefined;
  const d = doc as Record<string, unknown>;
  const out: ModelRoutingConfig = {};
  let malformed = false;
  for (const key of ["projects", "roles"] as const) {
    const v = d[key];
    if (v === undefined) continue;
    if (typeof v !== "object" || v === null || Array.isArray(v)) { malformed = true; continue; }
    const entries: Record<string, string> = {};
    for (const [k, mv] of Object.entries(v as Record<string, unknown>)) {
      const m = clean(mv);
      if (k.trim() && m) entries[k] = m;
    }
    if (Object.keys(entries).length > 0) out[key] = entries;
  }
  const def = clean(d["default"]);
  if (def) out.default = def;
  return malformed ? undefined : out;
}

/**
 * Read the routing table ONCE (latched at manager construction). Absent or unreadable
 * file -> undefined with no noise: that is the default posture, exactly current behavior.
 * A malformed file warns once to stderr and behaves as absent — spawning never breaks.
 */
export function loadModelRouting(
  path: string = MODEL_ROUTING_PATH,
  warn: (msg: string) => void = (m) => process.stderr.write(m + "\n"),
): ModelRoutingConfig | undefined {
  let raw: string | undefined;
  try { raw = readFileSync(path, "utf8"); } catch { return undefined; }
  const parsed = parseModelRouting(raw);
  if (!parsed) {
    warn(
      `pi-superagent: ${path} exists but is not a valid model-routing table — ignoring it ` +
      `(explicit model args, PI_SUBAGENT_MODEL and the built-in fallback still apply; ` +
      `see the package README for the schema).`,
    );
    return undefined;
  }
  return parsed;
}

/**
 * The [project:<name>] token every spawn task must carry (spawn-tag gate); returns the
 * tag name or undefined. Same token shape as the gate's PROJECT_TAG_RE in manager.ts.
 */
export function projectTagOf(task: string | undefined | null): string | undefined {
  const m = /\[project:([^\]\s]+)\]/.exec(String(task ?? ""));
  return m ? m[1] : undefined;
}

/**
 * Pure model resolution at the spawner's model-resolution point. See the module doc
 * comment for the precedence contract; `source` is recorded per dispatch for audit.
 */
export function resolveModel(opts: {
  explicit?: string;
  project?: string;
  role?: string;
  routing?: ModelRoutingConfig;
  env?: string;
}): ModelResolution {
  const explicit = clean(opts.explicit);
  if (explicit) return { model: explicit, source: "explicit" };
  const r = opts.routing;
  if (r) {
    const projectHit = opts.project ? clean(r.projects?.[opts.project]) : undefined;
    if (projectHit) return { model: projectHit, source: "route:project" };
    const roleHit = opts.role ? clean(r.roles?.[opts.role]) : undefined;
    if (roleHit) return { model: roleHit, source: "route:role" };
    const def = clean(r.default);
    if (def) return { model: def, source: "route:default" };
  }
  const env = clean(opts.env);
  if (env) return { model: env, source: "env" };
  return { model: FALLBACK_MODEL, source: "fallback" };
}
