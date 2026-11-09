#!/usr/bin/env node
/**
 * Standalone (read-only) mission control server — boots the bridge WITHOUT a pi
 * session. Useful for previewing the UI or watching subagent logs; POST /message
 * will answer 503 because there is no live session to inject into.
 *
 * Usage:
 *   node scripts/standalone-server.mjs [projectDir] &
 *
 * Env:
 *   PI_WEB_BRIDGE_PORT   port to bind (default 7788)
 */
import { readdirSync, readFileSync, statSync } from "node:fs";
import { basename, join, resolve } from "node:path";
import { createBridgeServer } from "../src/server.ts";

const projectDir = resolve(process.argv[2] ?? process.cwd());

/** Newest session JSONL for this project dir, using pi's encoded-cwd layout. */
function newestSessionFile(dir) {
  try {
    const enc = `--${dir.replace(/^[/\\]/, "").replace(/[/\\:]/g, "-")}--`;
    const sessions = join(process.env.HOME ?? "", ".pi", "agent", "sessions", enc);
    const files = readdirSync(sessions).filter((f) => f.endsWith(".jsonl"));
    if (!files.length) return undefined;
    let newest; let newestM = 0;
    for (const f of files) {
      const m = statMtime(join(sessions, f));
      if (m > newestM) { newestM = m; newest = join(sessions, f); }
    }
    return newest;
  } catch {
    return undefined;
  }
}
function statMtime(p) { try { return statSync(p).mtimeMs; } catch { return 0; } }

const server = createBridgeServer({
  project: basename(projectDir),
  inject: () => false, // no live pi session to deliver into
  sessionFile: () => newestSessionFile(projectDir),
  subagentsDir: () => join(projectDir, ".pi", "subagents"),
  indexHtml: () => readFileSync(new URL("../src/index.html", import.meta.url), "utf8"),
  log: (m) => console.error(`[web-bridge] ${m}`),
});

server.listen(Number(process.env.PI_WEB_BRIDGE_PORT || 7788), "127.0.0.1", () => {
  const { port } = server.address();
  console.log(`[web-bridge] standalone mission control on http://127.0.0.1:${port} (project ${basename(projectDir)}, read-only)`);
});
