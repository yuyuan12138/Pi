import { describe, expect, it } from "vitest";
import { spawn } from "node:child_process";
import { existsSync, readdirSync } from "node:fs";
import { mkdtemp, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { SubagentManager } from "../src/subagent/manager.ts";
import type { SpawnFn } from "../src/subagent/types.ts";

// Real end-to-end recursion check: the test's SubagentManager (root) spawns a real child pi
// agent (depth 1) whose task is to spawn a grandchild (depth 2) that writes a marker file.
// Requires a working `pi` binary and a reachable model. The model is overridable via
// PI_SUBAGENT_MODEL; the fallback below is the model available on this host (the manager's
// built-in default currently 404s here, so the test would fail for infrastructure reasons).
const EXTENSION_PATH = fileURLToPath(new URL("../src/index.ts", import.meta.url));
const MODEL = process.env.PI_SUBAGENT_MODEL || "GLM-5.3-Flash";

describe("subagent recursion (real pi, depth-2 chain)", () => {
  it("root spawns child spawns grandchild; grandchild writes the marker file", { timeout: 420_000 }, async () => {
    const dir = await mkdtemp(join(tmpdir(), "sa-chain-"));
    const marker = join(dir, "grandchild-marker.txt");
    const grandchildTask = `Use the write tool to create the file ${marker} with exactly this content: GRANDCHILD_OK. Then reply with exactly: GRANDCHILD_OK`;
    const childTask = `Call the subagent_spawn tool exactly once with wait=true and this exact task for the subagent: "${grandchildTask}". When the subagent has finished, your final message must include the subagent's final result text verbatim.`;
    const msgs: string[] = [];
    // Children inherit PI_SUBAGENT_MODEL so the grandchild (spawned by the child's own
    // manager, with no explicit model) resolves to the same working model.
    const prevModel = process.env.PI_SUBAGENT_MODEL;
    process.env.PI_SUBAGENT_MODEL = MODEL;
    // Hermetic: this host session runs inside a subagent itself; leaked spawn-tree env
    // (PI_SUBAGENT_ID/PI_SPAWN_DEPTH/…) would re-root the whole chain. Restore afterwards.
    const heredity = ["PI_SUBAGENT_ID", "PI_SPAWN_DEPTH", "PI_SPAWN_CHAIN", "PI_SPAWN_BUDGET"] as const;
    const savedEnv = heredity.map((k) => [k, process.env[k]] as const);
    for (const k of heredity) delete process.env[k];
    const m = new SubagentManager({
      spawn: ((cmd, args, o) => spawn(cmd, args, { cwd: o.cwd, env: o.env, stdio: ["pipe", "pipe", "pipe"] })) as SpawnFn,
      extensionPath: EXTENSION_PATH,
      baseDir: join(dir, ".pi", "subagents"),
      progressThrottleMs: 60_000,
    }, { deliver: (t) => { msgs.push(t); } });
    try {
      const child = await m.spawn({ task: childTask, label: "chain-child", model: MODEL, cwd: dir });
      expect(child.depth).toBe(1);
      expect(child.spawnedBy).toEqual([]);
      const fin = await m.waitFor(child.id);
      if (fin.state !== "done") throw new Error(`child ${fin.state}: ${fin.error ?? ""}\n${fin.result ?? ""}`);
      // The child's final text carries the grandchild's result (via the sync tool result or
      // the delivered combined/final report — both contain the marker token).
      expect(fin.result).toContain("GRANDCHILD_OK");
      // The grandchild really ran and wrote the marker file.
      expect(await readFile(marker, "utf8")).toContain("GRANDCHILD_OK");
      // The grandchild is tracked by the child's own manager under the shared base dir with a
      // tree-unique id (sa1-sa1) and a per-dispatch unique events dir (sa1-sa1-<token>), and its
      // result was logged. The child's own dir is likewise sa1-<token>.
      const gdDirName = readdirSync(join(dir, ".pi", "subagents")).find((n) => n.startsWith("sa1-sa1-"));
      expect(gdDirName).toBeTruthy();
      expect(existsSync(join(dir, ".pi", "subagents", gdDirName!, "result.md"))).toBe(true);
      // The child's transcript proves true recursion: it called subagent_spawn itself.
      const transcript = await readFile(join(child.logDir, "transcript.log"), "utf8");
      expect(transcript).toContain("[tool] subagent_spawn");
    } finally {
      process.env.PI_SUBAGENT_MODEL = prevModel;
      for (const [k, v] of savedEnv) { if (v === undefined) delete process.env[k]; else process.env[k] = v; }
      m.stopAll();
    }
  });
});
