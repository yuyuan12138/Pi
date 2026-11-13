/** lastRun diagnostics + backwards compatibility of the distiller state file. */
import { existsSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import os, { tmpdir } from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { DistillerState } from "../src/state.js";

function tmp(): string {
	return mkdtempSync(path.join(tmpdir(), "distiller-state-"));
}

const WM = { byte_offset: 10, size: 10, mtime_ms: 123 };

describe("DistillerState lastRun (additive, diagnostics-only)", () => {
	it("old-schema state file (version 1 + watermarks only) loads unchanged; no lastRun", () => {
		const p = path.join(tmp(), "state.json");
		writeFileSync(p, JSON.stringify({ version: 1, watermarks: { "/a.jsonl": WM } }, null, "\t") + "\n");
		const st = new DistillerState(p);
		st.load();
		expect(st.getWatermark("/a.jsonl")).toEqual(WM);
		expect(st.getLastRun()).toBeUndefined();
	});

	it("lastRun + watermarks survive the atomic save/load cycle", () => {
		const p = path.join(tmp(), "state.json");
		const st = new DistillerState(p);
		st.setWatermark("/a.jsonl", WM);
		st.setLastRun({
			at: "2026-11-13T13:05:00.000Z",
			trigger: "idle-debounce",
			scanned: 3,
			written: 23,
			llmUsed: false,
			degradedReason: "llm-error: boom",
			atomsFile: "/kb/atoms/piagents/2026-11-13.jsonl",
		});
		st.save();
		// on disk: still version 1, watermarks intact, lastRun additive
		const raw = JSON.parse(readFileSync(p, "utf8")) as Record<string, unknown>;
		expect(raw.version).toBe(1);
		expect(Object.keys(raw.watermarks as object)).toEqual(["/a.jsonl"]);
		expect(raw.lastRun).toMatchObject({ written: 23, llmUsed: false });
		// reload: both survive
		const st2 = new DistillerState(p);
		st2.load();
		expect(st2.getWatermark("/a.jsonl")).toEqual(WM);
		expect(st2.getLastRun()).toMatchObject({
			at: "2026-11-13T13:05:00.000Z",
			trigger: "idle-debounce",
			scanned: 3,
			written: 23,
			llmUsed: false,
			degradedReason: "llm-error: boom",
			atomsFile: "/kb/atoms/piagents/2026-11-13.jsonl",
		});
	});

	it("malformed lastRun is dropped on load; the state itself stays loadable", () => {
		const p = path.join(tmp(), "state.json");
		writeFileSync(
			p,
			JSON.stringify({ version: 1, watermarks: { "/a.jsonl": WM }, lastRun: { written: "many" } }) + "\n",
		);
		const st = new DistillerState(p);
		st.load();
		expect(st.getWatermark("/a.jsonl")).toEqual(WM);
		expect(st.getLastRun()).toBeUndefined();
	});

	it("live state file (read-only reference) loads: version 1 + watermarks; never written by tests", () => {
		const live = path.join(os.homedir(), ".pi", "agent", "memory", "distiller", "state.json");
		if (!existsSync(live)) return; // no live install on this machine
		const raw = readFileSync(live, "utf8");
		const parsed = JSON.parse(raw) as { version: number; watermarks: Record<string, object> };
		expect(parsed.version).toBe(1);
		expect(parsed.watermarks && typeof parsed.watermarks === "object").toBe(true);
		// load a temp COPY — the live file is never touched by tests
		const copy = path.join(tmp(), "state.json");
		writeFileSync(copy, raw);
		const st = new DistillerState(copy);
		st.load();
		const keys = Object.keys(parsed.watermarks);
		expect(keys.length).toBeGreaterThan(0);
		for (const k of keys) expect(st.getWatermark(k)).toEqual(parsed.watermarks[k]);
	});
});
