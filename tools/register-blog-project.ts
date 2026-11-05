/**
 * Register the blog project (yuyuan12138.github.io) as a project primary in
 * the multi-project coordinator. Follows tools/register-minecraft-project.ts.
 * Read-only registration: no session spawn, no task dispatch.
 *
 * Usage: node --experimental-strip-types tools/register-blog-project.ts
 */
import { mkdirSync } from "node:fs";
import { homedir } from "node:os";
import path from "node:path";
import { CoordinatorStore } from "../packages/pi-project-coordinator/src/store.ts";
import {
  loadRegistryFromStore,
  saveRegistryToStore,
  proposeRegistration,
  validateRegistry,
} from "../packages/pi-project-coordinator/src/registry.ts";

const stateDir = path.join(homedir(), ".pi/agent/project-coordinator");

const BLOG = {
  id: "blog",
  displayName: "Blog — yuyuan12138.github.io",
  aliases: ["blog", "博客"],
  root: "/Users/yuyuan/projects/blog",
  sessionId: "blog-primary",
};

mkdirSync(stateDir, { recursive: true });
const store = new CoordinatorStore(path.join(stateDir, "coordinator.db"));
let reg = loadRegistryFromStore(store);
if (reg.projects.some((p) => p.id === BLOG.id)) {
  console.log("already registered:", BLOG.id);
} else {
  reg = proposeRegistration(reg, BLOG);
  validateRegistry(reg);
  saveRegistryToStore(store, reg);
  console.log("registered project", BLOG.id, "->", BLOG.root);
}
for (const p of reg.projects) console.log("project:", p.id, p.root);
