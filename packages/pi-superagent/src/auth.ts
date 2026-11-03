import type { SuperagentConfig, Trigger } from "./types.ts";

export type Decision = { act: true; reason: string } | { act: false; reason: string };

/** Act only when an allowed person asks, or when a team-written rule allows it. */
export function decide(t: Trigger, cfg: SuperagentConfig): Decision {
  const author = t.author.toLowerCase();
  if (author === cfg.mention.slice(1).toLowerCase()) return { act: false, reason: "own comment" };
  if (t.labels.some((l) => cfg.rules.some((r) => r.label === l && r.action === "ignore"))) return { act: false, reason: "ignored by rule" };
  if (!cfg.allow.includes(author)) return { act: false, reason: `author ${t.author} not in allow list` };
  if (mentions(t.body, cfg.mention)) return { act: true, reason: "mentioned by allowed user" };
  const rule = cfg.rules.find((r) => r.action === "work" && t.labels.includes(r.label));
  if (rule) return { act: true, reason: `rule: label ${rule.label}` };
  return { act: false, reason: "no mention" };
}

export function mentions(body: string, mention: string): boolean {
  const esc = mention.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  return new RegExp(`(^|[^\\w@])${esc}(?![\\w-])`, "i").test(body);
}

export function stripMention(body: string, mention: string): string {
  const esc = mention.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  return body.replace(new RegExp(esc, "gi"), "").trim();
}
