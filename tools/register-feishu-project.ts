/**
 * Register the feishu project (Feishu/Lark integration) as a project primary
 * in the multi-project coordinator. Follows tools/register-english-project.ts.
 * Read-only registration: no session spawn, no task dispatch.
 *
 * Usage: node --experimental-strip-types tools/register-feishu-project.ts
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

const FEISHU = {
  id: "feishu",
  displayName: "Feishu — Feishu/Lark integrations (MCP plugin ops, bot/plugin ops, credential lifecycle)",
  aliases: ["feishu", "fs"],
  root: "/Users/yuyuan/projects/feishu",
  sessionId: "feishu-primary",
};

mkdirSync(stateDir, { recursive: true });
const store = new CoordinatorStore(path.join(stateDir, "coordinator.db"));
let reg = loadRegistryFromStore(store);
if (reg.projects.some((p) => p.id === FEISHU.id)) {
  console.log("already registered:", FEISHU.id);
} else {
  reg = proposeRegistration(reg, FEISHU);
  validateRegistry(reg);
  saveRegistryToStore(store, reg);
  console.log("registered project", FEISHU.id, "->", FEISHU.root);
}
for (const p of reg.projects) console.log("project:", p.id, p.root);
