// config.js — live config resolution for pi-coordinator-guard.
//
// The guard reads ~/.pi/agent/coordinator-guard.json on EVERY tool call, but a
// stat + mtime cache means the file is re-read and re-parsed only when it
// actually changed: mode/allowlist edits apply LIVE, without /reload.
//
// Schema (v1):
//   { "version": 1, "mode": "observe" | "enforce", "allow": ["/abs/path", ...] }
//
// Failure posture: any problem (missing file, unreadable, corrupt JSON, wrong
// schema/version) falls back SAFE to { mode: "observe", allow: [] }. Parse and
// read errors are reported ONCE per file change via onError (wired to the JSONL
// sink by index.js) so they are visible without spamming the log on every call.
// A missing file is the quiet normal case (pre-config status quo) and is not
// logged.

import { statSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

/** Active config file path. */
export const DEFAULT_CONFIG_PATH = join(homedir(), ".pi", "agent", "coordinator-guard.json");

/** Only config version 1 is understood; anything else is treated as corrupt. */
export const CONFIG_VERSION = 1;

/** The safe default served whenever the config is missing or unusable. */
export function safeDefaultConfig() {
  return { mode: "observe", allow: [] };
}

/**
 * Parse config text. Throws on invalid JSON, non-object documents, unsupported
 * "version", or a "mode" that is neither "observe" nor "enforce" — the loader
 * turns any throw into the safe default plus one logged error. "allow" must be
 * an array when present; entries are filtered to non-empty trimmed strings.
 * Returns { mode, allow }; a missing "mode" means "observe".
 */
export function parseConfigText(text) {
  let doc;
  try {
    doc = JSON.parse(text);
  } catch (err) {
    throw new Error(`invalid JSON: ${err.message}`);
  }
  if (typeof doc !== "object" || doc === null || Array.isArray(doc)) {
    throw new Error("config must be a JSON object");
  }
  if (doc.version !== CONFIG_VERSION) {
    throw new Error(`unsupported "version" (expected ${CONFIG_VERSION}, got ${JSON.stringify(doc.version)})`);
  }
  if (doc.mode !== undefined && doc.mode !== "observe" && doc.mode !== "enforce") {
    throw new Error(`"mode" must be "observe" or "enforce", got ${JSON.stringify(doc.mode)}`);
  }
  let allow = [];
  if (doc.allow !== undefined) {
    if (!Array.isArray(doc.allow)) throw new Error(`"allow" must be an array of path strings`);
    allow = doc.allow.map((s) => (typeof s === "string" ? s.trim() : "")).filter(Boolean);
  }
  return { mode: doc.mode ?? "observe", allow };
}

/**
 * Build the config loader. Returns loadConfig() -> { mode, allow }, cached by
 * stat mtimeMs: every call stats the file (cheap), re-reads only on change.
 * Never throws. onError(message) fires at most once per file change.
 */
export function createConfigLoader({ configPath = DEFAULT_CONFIG_PATH, onError = () => {} } = {}) {
  // state "absent": no usable config cached (file missing, unreadable, or corrupt)
  let cache = { state: "absent", mtimeMs: null, config: safeDefaultConfig() };

  return function loadConfig() {
    let st;
    try {
      st = statSync(configPath);
    } catch {
      // Missing (or stat-unreadable): safe default, and a previously served
      // config is dropped immediately — deleting the file applies live too.
      if (cache.state !== "absent") cache = { state: "absent", mtimeMs: null, config: safeDefaultConfig() };
      return cache.config;
    }
    if (cache.state === "present" && st.mtimeMs === cache.mtimeMs) return cache.config; // hot path
    // New or changed file: re-read + re-parse.
    try {
      const config = parseConfigText(readFileSync(configPath, "utf8"));
      cache = { state: "present", mtimeMs: st.mtimeMs, config };
      return config;
    } catch (err) {
      cache = { state: "absent", mtimeMs: null, config: safeDefaultConfig() };
      try {
        onError(`coordinator-guard.json unusable, serving observe default: ${err.message}`);
      } catch {
        // onError must never break the guard.
      }
      return cache.config;
    }
  };
}
