/**
 * Register the Minecraft operations project as a project primary in the
 * multi-project coordinator (explicit user confirmation 2026-11-02
 * "全部落地", covering all general-architecture rollout items).
 * Read-only registration: no session spawn, no task dispatch.
 *
 * Usage: node --experimental-strip-types tools/register-minecraft-project.ts
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

const MINECRAFT = {
  id: "minecraft",
  displayName: "Minecraft model-driven sword episodes",
  aliases: ["minecraft", "mc", "sword", "我的世界"],
  root: "/Users/yuyuan/PiAgents/remote-agent/operations/20261029-minimal-sword-episode",
  sessionId: "minecraft-primary",
};

mkdirSync(stateDir, { recursive: true });
const store = new CoordinatorStore(path.join(stateDir, "coordinator.db"));
let reg = loadRegistryFromStore(store);
if (reg.projects.some((p) => p.id === MINECRAFT.id)) {
  console.log("already registered:", MINECRAFT.id);
} else {
  reg = proposeRegistration(reg, MINECRAFT);
  validateRegistry(reg);
  saveRegistryToStore(store, reg);
  console.log("registered project", MINECRAFT.id, "->", MINECRAFT.root);
}
for (const p of reg.projects) console.log("project:", p.id, p.root);
