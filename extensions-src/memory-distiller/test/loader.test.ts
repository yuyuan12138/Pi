/**
 * Acceptance 5 (same method as memory-index): the extension loads via the
 * REAL pi extension loader with zero diagnostics, registers the /distill
 * command + lifecycle handlers, and the command handler performs an honest
 * dry-run through the loaded definition (nothing written).
 */
import { existsSync, mkdtempSync, readdirSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { beforeAll, describe, expect, it } from "vitest";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ENTRY = path.resolve(HERE, "../src/index.ts");

// Import the real loader file directly (the package's exports map hides dist
// subpaths) — same 1.5.0 code the pi CLI runs.
const pkgRoot = path.resolve(HERE, "..", "node_modules", "@earendil-works", "pi-coding-agent");
const loaderJs = path.join(pkgRoot, "dist", "core", "extensions", "loader.js");
const { loadExtensions } = (await import(pathToFileURL(loaderJs).href)) as any;

const resultRef: any = {};
let tmpCwd: string;
let fixtureSessionDir: string;
let kbRoot: string;
let statePath: string;

beforeAll(async () => {
	tmpCwd = mkdtempSync(path.join(tmpdir(), "distiller-loader-"));
	fixtureSessionDir = path.join(tmpCwd, "sessions");
	kbRoot = path.join(tmpCwd, "kb");
	statePath = path.join(tmpCwd, "state.json");
	// The extension factory must be side-effect free (no state read, no writes at load).
	resultRef.result = await loadExtensions([ENTRY], tmpCwd);
});

describe("acceptance 5: real pi 1.5.0 loader", () => {
	it("loads with zero errors and zero warnings", () => {
		const { result } = resultRef;
		expect(result.errors).toEqual([]);
		expect(result.warnings ?? []).toEqual([]);
		expect(result.extensions).toHaveLength(1);
		expect(result.extensions[0].path).toBe(ENTRY);
	});

	it("registers the /distill command", () => {
		const { result } = resultRef;
		const command = result.extensions[0].commands.get("distill");
		expect(command).toBeTruthy();
		expect(command.description).toContain("--dry-run");
		expect(typeof command.handler).toBe("function");
	});

	it("registers the documented lifecycle handlers", () => {
		const { result } = resultRef;
		const handlers = result.extensions[0].handlers;
		for (const event of ["agent_settled", "agent_start", "session_shutdown"]) {
			expect(handlers.get(event)?.length ?? 0).toBeGreaterThan(0);
		}
	});
});

describe("command handler wiring through the loaded definition", () => {
	it("/distill --dry-run reports candidates and writes nothing", async () => {
		const { result } = resultRef;
		const command = result.extensions[0].commands.get("distill");

		// Fixture session with one distillable compaction observation.
		const { writeFileSync, mkdirSync } = await import("node:fs");
		mkdirSync(fixtureSessionDir, { recursive: true });
		writeFileSync(
			path.join(fixtureSessionDir, "s1.jsonl"),
			JSON.stringify({
				type: "compaction",
				id: "comp1",
				timestamp: "2026-11-13T09:02:00.000Z",
				details: {
					observations: [
						{
							id: "aa1",
							content: "Decision: the loader wiring check distills through the real command handler now.",
							timestamp: "2026-11-13 09:01",
							sourceEntryIds: ["adff437e"],
						},
					],
				},
			}) + "\n",
		);

		process.env.PI_DISTILLER_STATE = statePath;
		process.env.PI_MEMORY_KB_ROOT = kbRoot;

		const notified: string[] = [];
		const mockCtx: any = {
			sessionManager: {
				getCwd: () => path.join(tmpCwd, "Wiring_Project"),
				getSessionDir: () => fixtureSessionDir,
				getSessionId: () => "loader-test",
				getSessionFile: () => undefined,
			},
			model: undefined,
			modelRegistry: null,
			ui: { notify: (msg: string) => notified.push(msg) },
			isIdle: () => true,
		};
		await command.handler("--dry-run", mockCtx);
		expect(notified).toHaveLength(1);
		expect(notified[0]).toContain("dry-run");
		expect(notified[0]).toContain("1 candidate(s)");
		expect(notified[0]).toContain("Nothing written");
		expect(existsSync(kbRoot)).toBe(false); // dry-run wrote nothing anywhere
		expect(existsSync(statePath)).toBe(false);

		// A real (non-dry) invocation appends the atoms file and saves state.
		await command.handler("", mockCtx);
		expect(existsSync(statePath)).toBe(true);
		const atomsDir = path.join(kbRoot, "atoms", "wiring_project");
		expect(existsSync(atomsDir)).toBe(true);
		const files = readdirSync(atomsDir).filter((f) => f.endsWith(".jsonl"));
		expect(files).toHaveLength(1);
		const lines = (await import("node:fs")).readFileSync(path.join(atomsDir, files[0]!), "utf8").trim().split("\n");
		expect(lines.length).toBeGreaterThan(0);
		const atom = JSON.parse(lines[0]!) as { kind: string; source_entry_ids: string[] };
		expect(atom.kind).toBe("decision");
		expect(atom.source_entry_ids).toContain("adff437e");

		delete process.env.PI_DISTILLER_STATE;
		delete process.env.PI_MEMORY_KB_ROOT;
	});
});
