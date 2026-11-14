/**
 * Register the nvim config repo (~/.config/nvim) as a project primary in
 * the multi-project coordinator. Follows tools/register-blog-project.ts.
 * Read-only registration: no session spawn, no task dispatch.
 *
 * Usage: node --experimental-strip-types tools/register-nvim-config-project.ts
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

const NVIM = {
  id: "nvim-config",
  displayName: "Neovim config (~/.config/nvim)",
  aliases: ["nvim", "nvim-config", "编辑器"],
  root: path.join(homedir(), ".config/nvim"),
  sessionId: "nvim-config-primary",
};

mkdirSync(stateDir, { recursive: true });
const store = new CoordinatorStore(path.join(stateDir, "coordinator.db"));
let reg = loadRegistryFromStore(store);
if (reg.projects.some((p) => p.id === NVIM.id)) {
  console.log("already registered:", NVIM.id);
} else {
  reg = proposeRegistration(reg, NVIM);
  validateRegistry(reg);
  saveRegistryToStore(store, reg);
  console.log("registered project", NVIM.id, "->", NVIM.root);
}
for (const p of reg.projects) console.log("project:", p.id, p.root);
