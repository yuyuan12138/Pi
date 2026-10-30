/**
 * Stage-D live check: register a real project (explicit user confirmation
 * required before calling this) and run ONE read-only task through the
 * full Coordinator + RpcProjectRuntime pipeline against the installed Pi CLI.
 *
 * Usage:
 *   node --experimental-strip-types tools/live-coordinator-check.ts \
 *     --task "read-only goal"
 *
 * Private state lives in ~/.pi/agent/project-coordinator/ (outside Git).
 * The medical project registration is performed here because the user has
 * explicitly confirmed root /Users/yuyuan/projects/mobile-medical/medical-system.
 */
import { mkdirSync, writeFileSync, readFileSync, existsSync } from "node:fs";
import { homedir } from "node:os";
import path from "node:path";
import {
  loadRegistry,
  saveRegistry,
  proposeRegistration,
  validateRegistry,
} from "../packages/pi-project-coordinator/src/registry.ts";
import { TaskJournal } from "../packages/pi-project-coordinator/src/journal.ts";
import { Coordinator } from "../packages/pi-project-coordinator/src/engine.ts";
import { RpcProjectRuntime } from "../packages/pi-project-coordinator/src/rpc-runtime.ts";

const stateDir = path.join(homedir(), ".pi/agent/project-coordinator");
const registryFile = path.join(stateDir, "registry.json");
const journalFile = path.join(stateDir, "journal.jsonl");
const sessionDir = path.join(stateDir, "sessions");

const MEDICAL = {
  id: "medical",
  displayName: "Medical platform",
  aliases: ["medical", "medical-system", "医疗平台", "医疗系统"],
  root: "/Users/yuyuan/projects/mobile-medical/medical-system",
  sessionId: "medical-primary",
};

const cliPath =
  "/Users/yuyuan/.pi/agent/install/releases/1.3.0/node_modules/@earendil-works/pi-coding-agent/dist/cli.js";

function ensureState() {
  mkdirSync(stateDir, { recursive: true });
  mkdirSync(sessionDir, { recursive: true });
  if (!existsSync(registryFile)) saveRegistry(registryFile, loadRegistry(registryFile));
  let reg = loadRegistry(registryFile);
  if (!reg.projects.some((p) => p.id === MEDICAL.id)) {
    reg = proposeRegistration(reg, MEDICAL);
    validateRegistry(reg);
    saveRegistry(registryFile, reg);
    console.log(`registered project ${MEDICAL.id} -> ${MEDICAL.root}`);
  }
  return reg;
}

async function main() {
  const goal =
    process.argv.includes("--task") ? process.argv[process.argv.indexOf("--task") + 1] : undefined;
  if (!goal) {
    console.error("usage: live-coordinator-check.ts --task '<read-only goal>'");
    process.exit(2);
  }
  const registry = ensureState();
  const journal = new TaskJournal(journalFile);
  const runtime = new RpcProjectRuntime({
    cliPath,
    allowModelCalls: true, // explicit operator decision for this live check
    timeoutMs: 300000,
    // Preserve the coordinator conversation's current model/provider (never
    // silently route project work to a different provider).
    extraArgs: ["--session-dir", sessionDir, "--model", process.env.PI_MODEL ?? ""].filter(
      (a) => a !== "",
    ),
  });
  const coordinator = new Coordinator(registry, journal, runtime);

  const sourceMessageId = `live-check-${Date.now()}`;
  const result = coordinator.submit({
    sourceMessageId,
    splitIndex: 0,
    projectId: "medical",
    goal,
    deliverable: "short written summary with file paths; no file modifications",
    nonGoals: ["editing files", "git operations other than status/log", "network operations"],
    mutating: false,
  });
  console.log("submit:", result.status, result.taskId);

  // Wait for the queue to drain (single task).
  const deadline = Date.now() + 330000;
  while (Date.now() < deadline) {
    const phase = journal.phase(result.taskId);
    if (phase && ["settled", "failed"].includes(phase)) break;
    await new Promise((r) => setTimeout(r, 1000));
  }
  await runtime.stopAll();
  const lines = readFileSync(journalFile, "utf8").trim().split("\n").map((l) => JSON.parse(l));
  console.log("journal tail:", JSON.stringify(lines.slice(-3), null, 2));
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
