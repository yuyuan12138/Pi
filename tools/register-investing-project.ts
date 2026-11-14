/**
 * Register the investing project (investment research & decision-support) as a
 * project primary in the multi-project coordinator. Follows
 * tools/register-blog-project.ts. Read-only registration: no session spawn,
 * no task dispatch.
 *
 * Usage: node --experimental-strip-types tools/register-investing-project.ts
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

const INVESTING = {
  id: "investing",
  displayName: "Investing — investment research & decision-support",
  aliases: ["invest", "tz"],
  root: "/Users/yuyuan/projects/investing",
  sessionId: "investing-primary",
};

mkdirSync(stateDir, { recursive: true });
const store = new CoordinatorStore(path.join(stateDir, "coordinator.db"));
let reg = loadRegistryFromStore(store);
if (reg.projects.some((p) => p.id === INVESTING.id)) {
  console.log("already registered:", INVESTING.id);
} else {
  reg = proposeRegistration(reg, INVESTING);
  validateRegistry(reg);
  saveRegistryToStore(store, reg);
  console.log("registered project", INVESTING.id, "->", INVESTING.root);
}
for (const p of reg.projects) console.log("project:", p.id, p.root);
