/**
 * Deterministic project routing over explicit identifiers only.
 *
 * No fuzzy matching, no guessing from directory listings. A request resolves
 * to exactly one project, to an explicit ambiguity result, or to unknown.
 * The caller (primary conversation) turns ambiguity/unknown into a user
 * question; it must never fall back to "most recent project".
 */
import type { Registry, RegistryProject } from "./registry.ts";
import { normalizeAlias } from "./registry.ts";

export type RoutingResult =
  | { status: "ok"; project: RegistryProject; matched: string }
  | { status: "ambiguous"; candidates: Array<{ projectId: string; matched: string }> }
  | { status: "unknown"; detail: string };

/**
 * Resolve an explicit identifier: project id, alias, or canonical root path.
 * Matching precedence: exact id, exact alias, exact canonical root. If several
 * aliases from different projects match (only possible transiently before
 * registry validation rejects it), we still return ambiguous rather than guess.
 */
export function route(registry: Registry, identifier: string): RoutingResult {
  const needle = String(identifier ?? "").trim();
  if (!needle) return { status: "unknown", detail: "empty identifier" };
  const active = registry.projects.filter((p) => p.status === "registered");
  const lower = normalizeAlias(needle);

  const byId = active.filter((p) => p.id === lower);
  if (byId.length === 1) return { status: "ok", project: byId[0], matched: `id:${byId[0].id}` };

  const aliasHits: Array<{ projectId: string; matched: string }> = [];
  for (const p of active) {
    if (p.aliases.includes(lower)) aliasHits.push({ projectId: p.id, matched: `alias:${lower}` });
  }
  if (aliasHits.length === 1) {
    const project = active.find((p) => p.id === aliasHits[0].projectId)!;
    return { status: "ok", project, matched: aliasHits[0].matched };
  }
  if (aliasHits.length > 1) return { status: "ambiguous", candidates: aliasHits };

  const byRoot = active.filter((p) => p.root === needle);
  if (byRoot.length === 1) return { status: "ok", project: byRoot[0], matched: `root:${needle}` };

  return { status: "unknown", detail: `no registered project matches "${identifier}"` };
}

/**
 * Split one user message into per-project task envelopes. The caller supplies
 * the routing identifier for each split; this function performs no language
 * understanding. Splits preserve order and get stable indices used by the
 * dedupe key, so a re-delivered Telegram message cannot enqueue duplicates.
 */
export function splitMessage(
  sourceMessageId: string,
  splits: Array<{ routingIdentifier: string; goal: string }>,
): Array<{ sourceMessageId: string; splitIndex: number; routingIdentifier: string; goal: string }> {
  if (!sourceMessageId) throw new Error("sourceMessageId required");
  return splits.map((s, splitIndex) => ({ sourceMessageId, splitIndex, ...s }));
}
