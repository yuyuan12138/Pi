import { mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import type { Trigger, WorkItem, WorkStatus } from "./types.ts";

export interface State { cursor: string; items: WorkItem[] }

export class WorkStore {
  state: State = { cursor: new Date().toISOString(), items: [] };
  constructor(private file: string) {}
  static forCwd(cwd: string) { return new WorkStore(join(cwd, ".pi", "superagent", "state.json")); }

  async load() {
    try { this.state = JSON.parse(await readFile(this.file, "utf8")); } catch { /* fresh */ }
    return this;
  }
  async save() {
    await mkdir(dirname(this.file), { recursive: true });
    await writeFile(this.file, JSON.stringify(this.state, null, 2));
  }
  has(commentId: number) { return this.state.items.some((i) => i.commentId === commentId); }
  open(t: Trigger, request: string): WorkItem {
    const now = new Date().toISOString();
    const item: WorkItem = { id: `${t.issue}-${t.commentId}`, issue: t.issue, commentId: t.commentId, author: t.author, request, title: t.title, status: "queued", createdAt: now, updatedAt: now };
    this.state.items.push(item);
    return item;
  }
  update(id: string, patch: Partial<WorkItem> & { status?: WorkStatus }) {
    const it = this.state.items.find((i) => i.id === id);
    if (!it) throw new Error(`no work item ${id}`);
    Object.assign(it, patch, { updatedAt: new Date().toISOString() });
    return it;
  }
  byStatus(...s: WorkStatus[]) { return this.state.items.filter((i) => s.includes(i.status)); }
}
