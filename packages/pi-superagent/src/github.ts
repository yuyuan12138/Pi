import type { Exec, Trigger } from "./types.ts";

interface RawComment { id: number; body?: string; user?: { login?: string }; created_at: string; issue_url: string }
interface RawIssue { number: number; title: string; labels: Array<{ name: string } | string> }

export function issueNumberFromUrl(url: string): number {
  const m = /\/issues\/(\d+)$/.exec(url);
  if (!m) throw new Error(`bad issue_url ${url}`);
  return Number(m[1]);
}

export class GitHub {
  constructor(private exec: Exec, private repo: string) {}

  private async api<T>(path: string, args: string[] = []): Promise<T> {
    const r = await this.exec("gh", ["api", path, ...args], { timeout: 60_000 });
    if (r.code !== 0) throw new Error(`gh api ${path} failed: ${r.stderr.trim()}`);
    return JSON.parse(r.stdout || "null") as T;
  }

  /** Issue + PR comments created since `since` (ISO). */
  async triggersSince(since: string): Promise<Trigger[]> {
    const comments = await this.api<RawComment[]>(`repos/${this.repo}/issues/comments?since=${encodeURIComponent(since)}&sort=created&direction=asc&per_page=100`);
    const out: Trigger[] = [];
    const cache = new Map<number, RawIssue>();
    for (const c of comments) {
      if (c.created_at <= since) continue;
      const n = issueNumberFromUrl(c.issue_url);
      let issue = cache.get(n);
      if (!issue) { issue = await this.api<RawIssue>(`repos/${this.repo}/issues/${n}`); cache.set(n, issue); }
      out.push({
        issue: n, commentId: c.id, author: c.user?.login ?? "", body: c.body ?? "", title: issue.title,
        labels: issue.labels.map((l) => (typeof l === "string" ? l : l.name)), createdAt: c.created_at,
      });
    }
    return out;
  }

  async comment(issue: number, body: string): Promise<void> {
    const r = await this.exec("gh", ["issue", "comment", String(issue), "--repo", this.repo, "--body", body]);
    if (r.code !== 0) throw new Error(`gh issue comment failed: ${r.stderr.trim()}`);
  }

  async createPr(opts: { branch: string; base: string; title: string; body: string; cwd: string }): Promise<string> {
    const r = await this.exec("gh", ["pr", "create", "--repo", this.repo, "--head", opts.branch, "--base", opts.base, "--title", opts.title, "--body", opts.body], { cwd: opts.cwd });
    if (r.code !== 0) throw new Error(`gh pr create failed: ${r.stderr.trim()}`);
    return r.stdout.trim().split("\n").pop() ?? "";
  }
}
