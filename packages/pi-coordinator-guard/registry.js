// registry.js — coordinator-registry validation for pi-coordinator-guard.
//
// Dispatch-chain guarantee (user directive 2026-11-13): a [project:<name>] spawn
// tag must name a project the coordinator can actually route — a misspelled or
// nonexistent name must not pass on format alone. The registry is the single-row
// JSON table at
//   ~/.pi/agent/project-coordinator/coordinator.db  (sqlite)
// owned by packages/pi-project-coordinator. Load pattern reused from
// packages/pi-web-bridge/src/projects.ts: node:sqlite via createRequire, loaded
// lazily so a runtime without it degrades instead of failing the import chain
// (zero dependencies added).
//
// Membership semantics mirror the coordinator's own router EXACTLY
// (packages/pi-project-coordinator/src/router.ts, route()): exact project id,
// exact alias (case-insensitive, normalizeAlias = trim+lowercase), or exact
// canonical root path — over projects with status "registered" only. The guard
// must agree with the router: denying an identifier the router would accept
// would break valid dispatches; accepting one the router would reject would
// leave the routing gap open.
//
// Failure posture (fail-open on READ errors only, never on format): ANY read
// problem — missing file, unreadable, corrupt file, missing table,
// node:sqlite unavailable — yields projects === null; the caller falls back to
// the format-only check and logs a warning to the JSONL sink. Rationale: the
// format check is the primary gate; the registry is secondary hardening, so a
// db hiccup must never brick dispatching.
//
// Cost: one read per REGISTRY_TTL_MS per db path (60s TTL cache, failures
// cached with the same TTL), so the hook stays cheap on hot spawn paths and a
// broken db warns once per window, not once per tool call.

import { createRequire } from "node:module";
import { homedir } from "node:os";
import { join } from "node:path";

/** Default coordinator DB location (read-only here; the coordinator owns writes). */
export const DEFAULT_REGISTRY_DB = join(homedir(), ".pi", "agent", "project-coordinator", "coordinator.db");

/** Registry cache TTL (ms): the hook re-reads the db at most once per minute per path. */
export const REGISTRY_TTL_MS = 60_000;

// node:sqlite is loaded lazily via createRequire (pattern from
// pi-web-bridge/src/projects.ts): a runtime without it must degrade the registry
// check, not fail the whole extension import. Cached: undefined = not yet
// attempted, null = unavailable in this runtime.
let sqlite;
function sqliteModule() {
  if (sqlite === undefined) {
    try { sqlite = createRequire(import.meta.url)("node:sqlite"); } catch { sqlite = null; }
  }
  return sqlite;
}

/**
 * Tolerant registry parse (subset of web-bridge's parseRegistry: the guard only
 * needs id/aliases/root/status). Returns the valid projects, skipping malformed
 * entries, and [] for any garbage input (missing row, corrupt JSON, wrong
 * shape). `id` is the only required field; everything else coerces.
 */
export function parseRegistryProjects(raw) {
  if (typeof raw !== "string") return [];
  let parsed;
  try { parsed = JSON.parse(raw); } catch { return []; }
  const list = parsed?.projects;
  if (!Array.isArray(list)) return [];
  const out = [];
  for (const entry of list) {
    const e = entry ?? {};
    if (typeof e.id !== "string" || !e.id.trim()) continue;
    out.push({
      id: e.id,
      aliases: Array.isArray(e.aliases) ? e.aliases.filter((a) => typeof a === "string" && !!a.trim()) : [],
      root: typeof e.root === "string" ? e.root : "",
      status: typeof e.status === "string" ? e.status : null,
    });
  }
  return out;
}

/** normalizeAlias, identical to packages/pi-project-coordinator/src/registry.ts. */
function normalizeAlias(alias) {
  return String(alias ?? "").trim().toLowerCase();
}

/**
 * Router-identical membership check (router.ts route()): exact id, exact alias
 * (case-insensitive), or exact canonical root path — registered projects only.
 * Returns the matched project's canonical id, or null when the tag names no
 * exactly-one project (unknown, or a transient ambiguous alias — the registry
 * validator rejects duplicates, so ambiguity is practically unreachable; either
 * way the tag does not name one routable project).
 */
export function registryProjectId(projects, tag) {
  const needle = String(tag ?? "").trim();
  if (!needle || !Array.isArray(projects)) return null;
  const active = projects.filter((p) => p.status === "registered");
  const lower = normalizeAlias(needle);
  const byId = active.filter((p) => p.id === lower);
  if (byId.length === 1) return byId[0].id;
  if (byId.length > 1) return null;
  const aliasHits = active.filter((p) => p.aliases.includes(lower));
  if (aliasHits.length === 1) return aliasHits[0].id;
  if (aliasHits.length > 1) return null;
  const byRoot = active.filter((p) => p.root === needle);
  return byRoot.length === 1 ? byRoot[0].id : null;
}

// Per-path TTL cache. Values are the result objects themselves, so callers can
// compare identity to detect a fresh read (used to warn once per read, not once
// per call, on registry failures).
const cache = new Map(); // dbPath -> { expiresAt, result }

function readOnce(dbPath) {
  try {
    const DatabaseSync = sqliteModule()?.DatabaseSync;
    if (!DatabaseSync) throw new Error("node:sqlite is unavailable in this runtime");
    const db = new DatabaseSync(dbPath, { readOnly: true });
    try {
      const row = db.prepare("SELECT json FROM registry WHERE id = 1").get();
      return { projects: parseRegistryProjects(row?.json) };
    } finally {
      try { db.close(); } catch { /* ignore */ }
    }
  } catch (e) {
    // Fail-open contract: a read problem is reported, never thrown.
    return { projects: null, error: String(e?.message ?? e ?? "registry read failed") };
  }
}

/**
 * Read the registry projects for dbPath, cached for REGISTRY_TTL_MS.
 * Success: { projects: [{ id, aliases, root, status }, ...] }.
 * Read failure: { projects: null, error } — the caller fails open to the
 * format-only check and logs a warning.
 * opts.ttlMs / opts.now are injection points for tests (default 60s / Date.now).
 */
export function readRegistryProjects(dbPath = DEFAULT_REGISTRY_DB, { ttlMs = REGISTRY_TTL_MS, now = Date.now } = {}) {
  const hit = cache.get(dbPath);
  if (hit && hit.expiresAt > now()) return hit.result;
  const result = readOnce(dbPath);
  cache.set(dbPath, { expiresAt: now() + ttlMs, result });
  return result;
}

/** Drop all cached registry reads (test isolation / forced re-read). */
export function resetRegistryCache() {
  cache.clear();
}
