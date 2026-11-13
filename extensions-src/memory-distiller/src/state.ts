/**
 * Distiller watermarks: per-file byte offsets over append-only session
 * JSONL, so each delta is read exactly once (no re-reads). State is one
 * small JSON file written atomically (temp file + rename in the same
 * directory): a kill mid-save leaves the previous state intact, and a kill
 * between write and save only causes a re-read that content-hash dedup
 * makes harmless. Override the path with PI_DISTILLER_STATE.
 */
import { mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";

export interface Watermark {
	byte_offset: number;
	size: number;
	mtime_ms: number;
}

interface StateFile {
	version: 1;
	watermarks: Record<string, Watermark>;
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
				this.data = { version: 1, watermarks: parsed.watermarks };
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

	/** Atomic save: temp file + rename in the same directory (kill-safe). */
	save(): void {
		const dir = path.dirname(this.statePath);
		mkdirSync(dir, { recursive: true });
		const tmp = `${this.statePath}.tmp-${process.pid}`;
		writeFileSync(tmp, JSON.stringify(this.data, null, "\t") + "\n", "utf8");
		renameSync(tmp, this.statePath);
	}
}
