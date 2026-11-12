/**
 * Register the english project (English-practice program) as a project primary
 * in the multi-project coordinator. Follows tools/register-blog-project.ts.
 * Read-only registration: no session spawn, no task dispatch.
 *
 * Usage: node --experimental-strip-types tools/register-english-project.ts
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

const ENGLISH = {
  id: "english",
  displayName: "English — practice program (agent chat + Notion vault translation)",
  aliases: ["english", "en"],
  root: "/Users/yuyuan/projects/english",
  sessionId: "english-primary",
};

mkdirSync(stateDir, { recursive: true });
const store = new CoordinatorStore(path.join(stateDir, "coordinator.db"));
let reg = loadRegistryFromStore(store);
if (reg.projects.some((p) => p.id === ENGLISH.id)) {
  console.log("already registered:", ENGLISH.id);
} else {
  reg = proposeRegistration(reg, ENGLISH);
  validateRegistry(reg);
  saveRegistryToStore(store, reg);
  console.log("registered project", ENGLISH.id, "->", ENGLISH.root);
}
for (const p of reg.projects) console.log("project:", p.id, p.root);
