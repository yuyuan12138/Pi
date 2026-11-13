#!/usr/bin/env node
/**
 * Manual-load check for the memory-distiller extension (same method as
 * memory-index's check, adapted for a command-only extension).
 *
 * Two honest, real-loader checks that cannot run inside vitest:
 *
 *  1. Load through the ACTUALLY INSTALLED pi release loader (the exact
 *     dist/core/extensions/loader.js the user's pi binary runs) and assert
 *     zero errors/warnings + the /distill command registered.
 *  2. Boot the real pi CLI headlessly (RPC mode) with ONLY this extension
 *     (--no-extensions --extension <path>), let it initialize and shut down;
 *     assert stderr shows no extension load failure or memory-distiller
 *     runtime error. PI_DISTILLER_STATE / PI_MEMORY_KB_ROOT point at temp
 *     dirs so the boot cannot touch real state or a real KB.
 *
 * Usage: node scripts/manual-load-check.mjs [extensionDir]
 * Exits 0 on success, 1 on failure, with evidence printed.
 */
import { spawn } from "node:child_process";
import { existsSync, mkdtempSync, readdirSync } from "node:fs";
import { createRequire } from "node:module";
import os from "node:os";
import path from "node:path";

const EXT_DIR = path.resolve(process.argv[2] ?? path.join(path.dirname(new URL(import.meta.url).pathname), ".."));
const ENTRY_TS = path.join(EXT_DIR, "src", "index.ts");
if (!existsSync(ENTRY_TS)) {
	console.error(`manual-load-check: entry not found: ${ENTRY_TS}`);
	process.exit(1);
}

const RELEASES = path.join(os.homedir(), ".pi", "agent", "install", "releases");
let installedPi = null;
if (existsSync(RELEASES)) {
	for (const v of readdirSync(RELEASES).sort().reverse()) {
		const candidate = path.join(RELEASES, v, "node_modules", "@earendil-works", "pi-coding-agent", "dist", "index.js");
		if (existsSync(candidate)) {
			installedPi = candidate;
			break;
		}
	}
}

let failed = false;

// --- Check 1: installed-release loader -------------------------------------
if (installedPi) {
	const loaderUrl = installedPi.replace(/index\.js$/, "core/extensions/loader.js");
	try {
		const { loadExtensions } = await import(loaderUrl);
		const tmpCwd = mkdtempSync(path.join(os.tmpdir(), "distiller-live-"));
		const result = await loadExtensions([ENTRY_TS], tmpCwd);
		const errors = result.errors ?? [];
		const warnings = result.warnings ?? [];
		const command = result.extensions[0]?.commands?.get("distill");
		const handlers = result.extensions[0]?.handlers ?? new Map();
		const handlerEvents = ["agent_settled", "agent_start", "session_shutdown"].filter((e) => (handlers.get(e)?.length ?? 0) > 0);
		console.log(`[check1] installed pi loader: ${installedPi}`);
		console.log(
			`[check1] errors=${errors.length} warnings=${warnings.length} /distill=${command ? "registered" : "MISSING"} handlers=${handlerEvents.join(",")}`,
		);
		if (errors.length || warnings.length || !command || handlerEvents.length !== 3) {
			failed = true;
			console.error("[check1] diagnostics:", JSON.stringify({ errors, warnings }, null, 2));
		}
	} catch (err) {
		failed = true;
		console.error(`[check1] FAILED to run installed loader: ${err?.stack || err}`);
	}
} else {
	console.log("[check1] SKIPPED: no installed pi release found (npm devDependency copy is covered by vitest loader.test.ts)");
}

// --- Check 2: real CLI headless load ---------------------------------------
const piBin = path.join(os.homedir(), ".pi", "agent", "bin", "pi");
if (existsSync(piBin)) {
	const tmp = mkdtempSync(path.join(os.tmpdir(), "distiller-live-"));
	const args = ["--no-extensions", "--extension", ENTRY_TS, "--mode", "rpc"];
	console.log(`[check2] running: ${piBin} ${args.join(" ")}`);
	const child = spawn(piBin, args, {
		stdio: ["pipe", "pipe", "pipe"],
		cwd: tmp, // temp cwd: no real KB, no real sessions
		env: {
			...process.env,
			PI_DISTILLER_STATE: path.join(tmp, "state.json"),
			PI_MEMORY_KB_ROOT: path.join(tmp, "kb"),
		},
	});
	let stderr = "";
	child.stderr.on("data", (d) => (stderr += d.toString()));
	// Give the CLI time to boot and load extensions, then shut it down.
	await new Promise((r) => setTimeout(r, 4000));
	child.stdin.end();
	const exited = await new Promise((resolve) => {
		const t = setTimeout(() => {
			child.kill("SIGTERM");
			resolve("timeout-killed");
		}, 8000);
		child.on("exit", (code) => {
			clearTimeout(t);
			resolve(code === 0 || code === null ? "clean" : `exit-${code}`);
		});
	});
	const badPatterns = [/failed to load extension/i, /extension error/i, /memory-distiller.*(error|failed)/i];
	const bad = badPatterns.filter((re) => re.test(stderr));
	console.log(`[check2] exit=${exited} stderrBytes=${stderr.length} badDiagnosticLines=${bad.length}`);
	if (stderr.trim()) console.log("[check2] stderr:\n" + stderr.trim().split("\n").slice(-10).join("\n"));
	if (bad.length > 0) failed = true;
} else {
	console.log("[check2] SKIPPED: pi binary not found");
}

if (failed) {
	console.error("manual-load-check: FAILED");
	process.exit(1);
}
console.log("manual-load-check: OK");
