/**
 * Register the PiAgents coordinator workspace itself as a project in the
 * multi-project coordinator (user-approved 2026-11-13). Follows
 * tools/register-blog-project.ts. Read-only registration: no session spawn,
 * no task dispatch.
 *
 * Usage: node --experimental-strip-types tools/register-piagents-project.ts
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

const PIAGENTS = {
  id: "piagents",
  displayName: "PiAgents — coordinator workspace",
  aliases: ["pi", "piagents"],
  root: "/Users/yuyuan/PiAgents",
  sessionId: "piagents-primary",
};

mkdirSync(stateDir, { recursive: true });
const store = new CoordinatorStore(path.join(stateDir, "coordinator.db"));

const registry = loadRegistryFromStore(store);
let reg = registry;
if (reg.projects.some((p) => p.id === PIAGENTS.id)) {
  console.log("already registered:", PIAGENTS.id);
} else {
  reg = proposeRegistration(reg, PIAGENTS);
  validateRegistry(reg);
  saveRegistryToStore(store, reg);
  console.log("REGISTERED:", PIAGENTS.id, "->", PIAGENTS.root);
}
console.log("projects now:", reg.projects.map((p) => p.id).join(", "));
