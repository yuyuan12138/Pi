/**
 * Register the notion-ops project as a project primary in the multi-project
 * coordinator. Follows tools/register-blog-project.ts.
 * Read-only registration: no session spawn, no task dispatch.
 *
 * Usage: node --experimental-strip-types tools/register-notion-ops-project.ts
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

const NOTION = {
  id: "notion-ops",
  displayName: "Notion Ops — workspace management (ex-Obsidian vault migration)",
  aliases: ["notion", "notion-ops", "笔记"],
  root: "/Users/yuyuan/projects/notion-ops",
  sessionId: "notion-ops-primary",
};

mkdirSync(stateDir, { recursive: true });
const store = new CoordinatorStore(path.join(stateDir, "coordinator.db"));
let reg = loadRegistryFromStore(store);
if (reg.projects.some((p) => p.id === NOTION.id)) {
  console.log("already registered:", NOTION.id);
} else {
  reg = proposeRegistration(reg, NOTION);
  validateRegistry(reg);
  saveRegistryToStore(store, reg);
  console.log("registered project", NOTION.id, "->", NOTION.root);
}
for (const p of reg.projects) console.log("project:", p.id, p.root);
