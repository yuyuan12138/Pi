/**
 * Project registry: durable project identity only.
 *
 * Never store credentials, raw conversations, inventories or server settings
 * here. Runtime state (leases, PIDs, active tasks) lives in the journal, not
 * in the registry. A registry entry is identity, not liveness.
 */
import fs from "node:fs";
import path from "node:path";

export const REGISTRY_SCHEMA_VERSION = 1;

export const PROJECT_STATUSES = ["registered", "disabled"] as const;
export type ProjectStatus = (typeof PROJECT_STATUSES)[number];

export interface RegistryProject {
  id: string;
  displayName: string;
  /** Lowercased routing aliases. Must be unique across the registry. */
  aliases: string[];
  /** Canonical absolute path (realpath) of the project root. */
  root: string;
  /** Stable Pi session id for the project-primary conversation. */
  sessionId: string;
  status: ProjectStatus;
  /** ISO timestamp of registration and last confirmation by the user. */
  registeredAt: string;
  confirmedAt?: string;
}

export interface Registry {
  schemaVersion: number;
  projects: RegistryProject[];
}

export class RegistryError extends Error {}

const ID_RE = /^[a-z0-9][a-z0-9._-]*$/;

export function emptyRegistry(): Registry {
  return { schemaVersion: REGISTRY_SCHEMA_VERSION, projects: [] };
}

export function validateRegistry(registry: Registry): void {
  if (!registry || registry.schemaVersion !== REGISTRY_SCHEMA_VERSION) {
    throw new RegistryError(`unsupported schemaVersion: ${registry?.schemaVersion}`);
  }
  if (!Array.isArray(registry.projects)) throw new RegistryError("projects must be an array");
  const aliasOwners = new Map<string, string>();
  const roots = new Map<string, string>();
  const ids = new Set<string>();
  for (const p of registry.projects) {
    if (!p.id || !ID_RE.test(p.id)) throw new RegistryError(`invalid project id: ${p.id}`);
    if (ids.has(p.id)) throw new RegistryError(`duplicate id: ${p.id}`);
    ids.add(p.id);
    if (!p.displayName) throw new RegistryError(`project ${p.id}: displayName required`);
    if (!path.isAbsolute(p.root)) throw new RegistryError(`project ${p.id}: root must be absolute`);
    const canon = fs.realpathSync.native(p.root);
    if (canon !== p.root) {
      throw new RegistryError(`project ${p.id}: root must be canonical (${p.root} -> ${canon})`);
    }
    if (roots.has(canon)) throw new RegistryError(`duplicate root ${canon} (${roots.get(canon)}, ${p.id})`);
    roots.set(canon, p.id);
    if (!p.sessionId || !ID_RE.test(p.sessionId)) {
      throw new RegistryError(`project ${p.id}: sessionId required`);
    }
    if (!PROJECT_STATUSES.includes(p.status)) {
      throw new RegistryError(`project ${p.id}: invalid status ${p.status}`);
    }
    const aliases = (p.aliases ?? []).map((a) => normalizeAlias(a));
    if (aliases.length === 0) throw new RegistryError(`project ${p.id}: at least one alias required`);
    for (const a of aliases) {
      if (aliasOwners.has(a)) {
        throw new RegistryError(`alias "${a}" owned by ${aliasOwners.get(a)} and ${p.id}`);
      }
      aliasOwners.set(a, p.id);
    }
    p.aliases = aliases;
  }
}

export function normalizeAlias(alias: string): string {
  return String(alias).trim().toLowerCase();
}

/** Load and validate a registry file. Missing file yields an empty registry. */
export function loadRegistry(file: string): Registry {
  if (!fs.existsSync(file)) return emptyRegistry();
  const registry = JSON.parse(fs.readFileSync(file, "utf8")) as Registry;
  validateRegistry(registry);
  return registry;
}

/** Atomic save (tmp + rename) so a crash never truncates the registry. */
export function saveRegistry(file: string, registry: Registry): void {
  validateRegistry(registry);
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const tmp = file + ".tmp";
  fs.writeFileSync(tmp, JSON.stringify(registry, null, 2) + "\n", "utf8");
  fs.renameSync(tmp, file);
}

/**
 * Create a registration proposal. The caller (the primary conversation) must
 * confirm the canonical root with the user before saving; this function never
 * creates directories, scans disks or adopts sessions on its own.
 */
export function proposeRegistration(
  registry: Registry,
  input: { id: string; displayName: string; aliases: string[]; root: string; sessionId: string },
): Registry {
  const project: RegistryProject = {
    ...input,
    aliases: input.aliases.map(normalizeAlias),
    status: "registered",
    registeredAt: new Date().toISOString(),
  };
  const next: Registry = { ...registry, projects: [...registry.projects, project] };
  validateRegistry(next);
  return next;
}
