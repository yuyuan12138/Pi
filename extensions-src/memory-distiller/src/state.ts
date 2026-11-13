/**
 * Distiller watermarks: per-file byte offsets over append-only session
 * JSONL, so each delta is read exactly once (no re-reads). State is one
 * small JSON file written atomically (temp file + rename in the same
 * directory): a kill mid-save leaves the previous state intact, and a kill
 * between write and save only causes a re-read that content-hash dedup
 * makes harmless. Override the path with PI_DISTILLER_STATE.
 *
 * The file also carries an additive, bounded `lastRun` diagnostics summary
 * of the most recent real (non-dry) run (degraded runs were previously
 * console-only and unrecoverable). It is diagnostics-only: old state files
 * without it load unchanged, and a malformed one is dropped, not fatal.
 */
import { mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";

export interface Watermark {
	byte_offset: number;
	size: number;
	mtime_ms: number;
}

/** Bounded summary of the most recent real (non-dry) distillation run. */
export interface LastRunSummary {
	/** ISO-8601 UTC time the run finished. */
	at: string;
	trigger: string;
	/** Files scanned (ScanStats.filesScanned at run time). */
	scanned: number;
	written: number;
	llmUsed: boolean;
	degradedReason: string | null;
	atomsFile: string | null;
}

/** Diagnostics-only shape check: anything off → drop the field, keep state loadable. */
function isLastRunSummary(v: unknown): v is LastRunSummary {
	if (!v || typeof v !== "object") return false;
	const r = v as Record<string, unknown>;
	return (
		typeof r.at === "string" &&
		typeof r.trigger === "string" &&
		typeof r.scanned === "number" &&
		typeof r.written === "number" &&
		typeof r.llmUsed === "boolean" &&
		(r.degradedReason === null || typeof r.degradedReason === "string") &&
		(r.atomsFile === null || typeof r.atomsFile === "string")
	);
}

interface StateFile {
	version: 1;
	watermarks: Record<string, Watermark>;
	/** Additive, optional: absent in state files written before this key existed. */
	lastRun?: LastRunSummary;
}

export function defaultStatePath(): string {
	if (process.env.PI_DISTILLER_STATE) return process.env.PI_DISTILLER_STATE;
	return path.join(os.homedir(), ".pi", "agent", "memory", "distiller", "state.json");
}

export class DistillerState {
	private data: StateFile = { version: 1, watermarks: {} };

	constructor(readonly statePath: string = defaultStatePath()) {}

	/** Load from disk; missing or corrupt files yield a fresh state (logged). */
	load(): void {
		let raw: string;
		try {
			raw = readFileSync(this.statePath, "utf8");
		} catch {
			return; // first run (or removed state): start fresh
		}
		try {
			const parsed = JSON.parse(raw) as StateFile;
			if (parsed && parsed.version === 1 && parsed.watermarks && typeof parsed.watermarks === "object") {
				this.data = {
					version: 1,
					watermarks: parsed.watermarks,
					// Additive diagnostics only: keep a well-shaped lastRun, drop a
					// malformed one (never fail to load over a diagnostics field).
					...(isLastRunSummary(parsed.lastRun) ? { lastRun: parsed.lastRun } : {}),
				};
			} else {
				console.error(`[memory-distiller] unexpected state format in ${this.statePath}; starting fresh`);
			}
		} catch (err) {
			console.error(`[memory-distiller] corrupt state file ${this.statePath}; starting fresh:`, err);
			this.data = { version: 1, watermarks: {} };
		}
	}

	getWatermark(filePath: string): Watermark | undefined {
		return this.data.watermarks[filePath];
	}

	setWatermark(filePath: string, wm: Watermark): void {
		this.data.watermarks[filePath] = wm;
	}

	/** Last-run diagnostics (undefined until the first persisted real run). */
	getLastRun(): LastRunSummary | undefined {
		return this.data.lastRun;
	}

	setLastRun(summary: LastRunSummary): void {
		this.data.lastRun = summary;
	}

	/** Atomic save: temp file + rename in the same directory (kill-safe). */
	save(): void {
		const dir = path.dirname(this.statePath);
		mkdirSync(dir, { recursive: true });
		const tmp = `${this.statePath}.tmp-${process.pid}`;
		writeFileSync(tmp, JSON.stringify(this.data, null, "\t") + "\n", "utf8");
		renameSync(tmp, this.statePath);
	}
}
