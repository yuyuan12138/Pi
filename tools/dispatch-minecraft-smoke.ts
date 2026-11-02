/** One read-only smoke task to the minecraft project primary (validates the
 * full Coordinator -> RpcProjectRuntime chain for the newly registered project). */
import { homedir } from "node:os";
import path from "node:path";
import { CoordinatorStore } from "../packages/pi-project-coordinator/src/store.ts";
import { loadRegistryFromStore } from "../packages/pi-project-coordinator/src/registry.ts";
import { TaskJournal } from "../packages/pi-project-coordinator/src/journal.ts";
import { Coordinator } from "../packages/pi-project-coordinator/src/engine.ts";
import { RpcProjectRuntime } from "../packages/pi-project-coordinator/src/rpc-runtime.ts";

const stateDir = path.join(homedir(), ".pi/agent/project-coordinator");
const store = new CoordinatorStore(path.join(stateDir, "coordinator.db"));
const journal = new TaskJournal(path.join(stateDir, "coordinator.db"));
const runtime = new RpcProjectRuntime({
  cliPath: "/Users/yuyuan/.pi/agent/install/releases/1.3.0/node_modules/@earendil-works/pi-coding-agent/dist/cli.js",
  allowModelCalls: true,
  timeoutMs: 300000,
  extraArgs: ["--session-dir", path.join(stateDir, "sessions"), "--model", process.env.PI_MODEL ?? ""].filter(a => a !== ""),
});
const coordinator = new Coordinator(loadRegistryFromStore(store), journal, runtime);
const result = coordinator.submit({
  sourceMessageId: `mc-smoke-${Date.now()}`,
  splitIndex: 0,
  projectId: "minecraft",
  goal: "Read-only orientation: read CURRENT.md and skills/library.json in this directory and summarize in under 120 words what the current episode state and active skills are.",
  deliverable: "short written summary; no file modifications",
  nonGoals: ["editing files", "git operations", "network operations", "starting any episode or server"],
  mutating: false,
});
console.log("submit:", result.status, result.taskId);
const deadline = Date.now() + 330000;
while (Date.now() < deadline) {
  const phase = journal.phase(result.taskId);
  if (phase && ["settled", "failed"].includes(phase)) break;
  await new Promise(r => setTimeout(r, 1000));
}
await runtime.stopAll();
const tail = journal.allRecords().slice(-2);
console.log(JSON.stringify(tail, null, 2).slice(0, 3000));
