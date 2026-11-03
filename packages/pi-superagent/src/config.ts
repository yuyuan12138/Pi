import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { parse } from "yaml";
import type { SuperagentConfig } from "./types.ts";

export const CONFIG_FILE = join(".pi", "superagent.yml");

export function normalizeConfig(raw: unknown): SuperagentConfig {
  const r = (raw ?? {}) as Record<string, any>;
  if (typeof r.repo !== "string" || !/^[\w.-]+\/[\w.-]+$/.test(r.repo)) throw new Error("superagent.yml: `repo` must be owner/name");
  if (typeof r.mention !== "string" || !r.mention.startsWith("@")) throw new Error("superagent.yml: `mention` must start with @");
  const allow = Array.isArray(r.allow) ? r.allow.map(String) : [];
  if (allow.length === 0) throw new Error("superagent.yml: `allow` must list at least one GitHub login");
  const rules = Array.isArray(r.rules) ? r.rules.map((x: any) => {
    if (typeof x?.label !== "string" || !["work", "ignore"].includes(x?.action)) throw new Error("superagent.yml: each rule needs label + action (work|ignore)");
    return { label: x.label, action: x.action };
  }) : [];
  return {
    repo: r.repo,
    mention: r.mention,
    allow: allow.map((s: string) => s.toLowerCase()),
    baseBranch: typeof r.baseBranch === "string" ? r.baseBranch : "main",
    pollIntervalSec: Math.max(15, Number(r.pollIntervalSec ?? 60)),
    maxConcurrent: Math.max(1, Number(r.maxConcurrent ?? 1)),
    rules,
    piCommand: typeof r.piCommand === "string" ? r.piCommand : "pi",
    piArgs: Array.isArray(r.piArgs) ? r.piArgs.map(String) : [],
    dryRun: Boolean(r.dryRun ?? false),
  };
}

export async function loadConfig(cwd: string): Promise<SuperagentConfig> {
  const text = await readFile(join(cwd, CONFIG_FILE), "utf8");
  return normalizeConfig(parse(text));
}
