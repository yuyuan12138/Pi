import { decide, stripMention } from "./auth.ts";
import { GitHub } from "./github.ts";
import { runWorkItem, cleanupWorktree } from "./executor.ts";
import type { Exec, SuperagentConfig } from "./types.ts";
import { WorkStore } from "./workitems.ts";

export interface AgentEvents { onChange?: () => void; log?: (msg: string) => void }

/** One poll cycle: read new comments, open work items, run queued items. */
export class Superagent {
  running = 0;
  timer?: ReturnType<typeof setTimeout>;
  lastError?: string;
  lastPoll?: string;
  gh: GitHub;

  constructor(public cfg: SuperagentConfig, public store: WorkStore, private exec: Exec, private cwd: string, private ev: AgentEvents = {}, gh?: GitHub) {
    this.gh = gh ?? new GitHub(exec, cfg.repo);
  }

  async poll(): Promise<void> {
    const triggers = await this.gh.triggersSince(this.store.state.cursor);
    for (const t of triggers) {
      if (t.createdAt > this.store.state.cursor) this.store.state.cursor = t.createdAt;
      if (this.store.has(t.commentId)) continue;
      const d = decide(t, this.cfg);
      if (!d.act) { this.ev.log?.(`skip #${t.issue} ${t.commentId}: ${d.reason}`); continue; }
      const item = this.store.open(t, stripMention(t.body, this.cfg.mention) || t.title);
      this.ev.log?.(`opened ${item.id} (${d.reason})`);
      if (!this.cfg.dryRun) await this.gh.comment(t.issue, `👀 On it — work item \`${item.id}\`. I'll reply here with a PR or a question.`);
    }
    this.lastPoll = new Date().toISOString();
    await this.store.save();
    this.ev.onChange?.();
    if (!this.cfg.dryRun) await this.drain();
  }

  async drain(): Promise<void> {
    const queued = this.store.byStatus("queued");
    const jobs: Promise<void>[] = [];
    for (const item of queued) {
      if (this.running >= this.cfg.maxConcurrent) break;
      this.running++;
      this.store.update(item.id, { status: "running" });
      this.ev.onChange?.();
      jobs.push((async () => {
        try {
          const r = await runWorkItem(item, this.cfg, { exec: this.exec, gh: this.gh, cwd: this.cwd });
          this.store.update(item.id, { status: r.status, prUrl: r.prUrl, branch: r.branch, worktree: r.worktree, error: r.status === "failed" ? r.summary : undefined });
          const msg = r.status === "done" ? `✅ PR: ${r.prUrl}` : r.status === "needs-human" ? `❓ I need your input:\n\n${r.summary}` : `⚠️ Work item \`${item.id}\` failed:\n\n\`\`\`\n${r.summary}\n\`\`\``;
          await this.gh.comment(item.issue, msg);
          if (r.status !== "failed") await cleanupWorktree(this.exec, this.cwd, r.worktree);
        } catch (e) {
          this.store.update(item.id, { status: "failed", error: String((e as Error).message ?? e) });
        } finally {
          this.running--;
          await this.store.save();
          this.ev.onChange?.();
        }
      })());
    }
    await Promise.all(jobs);
  }

  start() {
    const tick = async () => {
      try { await this.poll(); this.lastError = undefined; } catch (e) { this.lastError = String((e as Error).message ?? e); this.ev.onChange?.(); }
      this.timer = setTimeout(tick, this.cfg.pollIntervalSec * 1000);
    };
    void tick();
  }
  stop() { if (this.timer) clearTimeout(this.timer); this.timer = undefined; }
  get active() { return this.timer !== undefined; }
}
