/**
 * Acceptance 5: the extension loads via the REAL pi extension loader with
 * zero diagnostics.
 *
 * Method (stated honestly): this test imports `loadExtensions` from
 * @earendil-works/pi-coding-agent@1.3.0 — the same loader code the pi CLI
 * runs (dist/core/extensions/loader.js, jiti with the same virtual-module
 * aliases) — and loads this extension's entry point through it, asserting
 * an empty `errors` array, no warnings, and a registered `memory_search`
 * tool. It does NOT boot the full pi CLI runtime (session/agent wiring);
 * scripts/manual-load-check.mjs does that against the actually-installed
 * pi binary via `pi --no-extensions --extension <path>` and asserts clean
 * stderr.
 */
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { pathToFileURL } from "node:url";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ENTRY = path.resolve(HERE, "../src/index.ts");

// pi's package index does not re-export the loader and its exports map
// hides dist subpaths, so locate the physical package directory and import
// the real loader file directly (same 1.3.0 code the pi CLI runs).
const pkgRoot = path.resolve(HERE, "..", "node_modules", "@earendil-works", "pi-coding-agent");
const loaderJs = path.join(pkgRoot, "dist", "core", "extensions", "loader.js");
const { loadExtensions } = (await import(pathToFileURL(loaderJs).href)) as any;

const resultRef: any = {};
let tmpCwd: string;

beforeAll(async () => {
	tmpCwd = mkdtempSync(path.join(tmpdir(), "memidx-loader-"));
	// The extension factory must be side-effect free (no DB open at load).
	resultRef.result = await loadExtensions([ENTRY], tmpCwd);
});

afterAll(() => {
	/* loader holds no process-wide resources that need closing here */
});

describe("acceptance 5: real pi loader", () => {
	it("loads with zero errors and zero warnings", () => {
		const { result } = resultRef;
		expect(result.errors).toEqual([]);
		expect(result.warnings ?? []).toEqual([]);
		expect(result.extensions).toHaveLength(1);
		expect(result.extensions[0].path).toBe(ENTRY);
	});

	it("registers the memory_search tool with the documented parameters", () => {
		const { result } = resultRef;
		const tool = result.extensions[0].tools.get("memory_search");
		expect(tool).toBeTruthy();
		const props = (tool.definition ?? tool).parameters.properties ?? {};
		expect(Object.keys(props).sort()).toEqual(["from", "kind", "limit", "project", "query", "to"]);
		expect(props.query.type).toBe("string");
	});

	it("registers the documented lifecycle handlers", () => {
		const { result } = resultRef;
		const handlers = result.extensions[0].handlers;
		for (const event of ["session_start", "session_compact", "session_shutdown"]) {
			expect(handlers.get(event)?.length ?? 0).toBeGreaterThan(0);
		}
	});
});

describe("tool execute through the loaded definition (wiring check)", () => {
	it("returns formatted hits using ctx.sessionManager.getCwd() as default project", async () => {
		const { result } = resultRef;
		const tool = result.extensions[0].tools.get("memory_search");
		const def = tool.definition ?? tool;

		// Isolated DB for this test file (read before first open).
		process.env.PI_MEMORY_INDEX_DB = path.join(tmpCwd, "wiring.db");
		// Seed one row through the same public helper the triggers use.
		const { openIndex, insertObservation } = await import("../src/db.js");
		const opened = await openIndex(process.env.PI_MEMORY_INDEX_DB);
		await insertObservation(opened.db, opened.tokenizer, {
			obs_id: "fa0000000001",
			entry_id: "c1",
			session_id: "s1",
			session_path: "",
			source_path: "",
			kind: "observation",
			project: "/tmp/wiring-project",
			ts: "2026-11-06T10:00:00.000Z",
			content: "Wiring check: memory_search defaults the project scope from the session cwd.",
		});

		const mockCtx: any = {
			sessionManager: { getCwd: () => "/tmp/wiring-project" },
		};
		const res = await def.execute("test-call", { query: "wiring check defaults" }, undefined, undefined, mockCtx);
		expect(res.details.hits).toBe(1);
		expect(res.content[0].text).toContain("obs_id=fa0000000001");
		expect(res.content[0].text).toContain("project=/tmp/wiring-project");

		// A different default project sees nothing (scoping is real).
		const resOther = await def.execute("test-call-2", { query: "wiring check defaults" }, undefined, undefined, {
			sessionManager: { getCwd: () => "/tmp/other-project" },
		} as any);
		expect(resOther.details.hits).toBe(0);

		opened.db.close();
		delete process.env.PI_MEMORY_INDEX_DB;
	});
});
