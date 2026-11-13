/**
 * B4 (sa52 P1c / L3 profile) tests: the accepted-records-only source policy
 * (unreviewed concepts NEVER reach the generator), budget enforcement,
 * regenerate-and-replace idempotency, dry-run, and the before_agent_start
 * section injection through the REAL pi 1.5.0 loader (with a temp-dir
 * PI_PROFILE_PATH override — never the real ~/.pi/agent/memory/profile.md).
 */
import { existsSync, mkdirSync, mkdtempSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import {
	collectProfileSources,
	conceptIsUserApproved,
	defaultProfilePath,
	enforceProfileBudget,
	formatProfileStats,
	parseFrontmatter,
	parseProfileMarkdown,
	readProfileCached,
	renderProfileSection,
	ruleGenerateProfile,
	shouldRefreshProfile,
	runProfileRefresh,
	MAX_PROFILE_BYTES,
	PROFILE_SECTION_NAME,
} from "../src/profile.js";
import { fakeProfileStreamFactory } from "./llm-fixtures.js";

const envKeys = ["PI_PROFILE_PATH", "PI_PROFILE_INJECT", "PI_MEMORY_KB_ROOT", "PI_DISTILLER_STATE"] as const;
afterEach(() => {
	for (const k of envKeys) delete process.env[k];
});

// ---------------------------------------------------------------------------
// Frontmatter / source gate.
// ---------------------------------------------------------------------------

const APPROVED_CONCEPT = `---
title: Approved concept
updated: 2026-11-12
scope: global
origin: ai-generated
approval: user-approved
last_reviewed: 2026-11-12
sources:
  - docs/example.md
---

# Approved concept
The user decided deliverables are always written in English.`;

const UNREVIEWED_CONCEPT = `---
title: Pending candidate
updated: 2026-11-13
scope: pending
origin: ai-generated
approval: unreviewed
sources:
  - atoms/proj/2026-11-13.jsonl
---

# Pending candidate
The user always wants speculative AI proposals auto-applied without review.`;

describe("parseFrontmatter + conceptIsUserApproved (the source gate)", () => {
	it("parses simple frontmatter maps", () => {
		const meta = parseFrontmatter(APPROVED_CONCEPT)!;
		expect(meta.get("approval")).toBe("user-approved");
		expect(meta.get("scope")).toBe("global");
		expect(meta.get("sources")).toEqual(["docs/example.md"]);
	});

	it("accepts ONLY approval: user-approved", () => {
		expect(conceptIsUserApproved(APPROVED_CONCEPT)).toBe(true);
		expect(conceptIsUserApproved(UNREVIEWED_CONCEPT)).toBe(false);
		expect(conceptIsUserApproved("no frontmatter at all")).toBe(false);
		expect(conceptIsUserApproved("---\ntitle: x\napproval: unreviewed\n---\nbody")).toBe(false);
	});
});

describe("collectProfileSources (accepted corpus only)", () => {
	it("includes daily entries + user-approved concepts; excludes unreviewed ones", async () => {
		const dir = mkdtempSync(path.join(tmpdir(), "distiller-profile-"));
		const kbRoot = path.join(dir, "kb");
		mkdirSync(path.join(kbRoot, "daily"), { recursive: true });
		mkdirSync(path.join(kbRoot, "knowledge", "concepts"), { recursive: true });
		writeFileSync(
			path.join(kbRoot, "daily", "2026-11-12.md"),
			"## 2026-11-12 — Chat language\n- Durable lesson: the user requires English deliverables; chat may be Chinese.\n- Source: commit e8e1759.\n",
		);
		writeFileSync(path.join(kbRoot, "knowledge", "concepts", "approved.md"), APPROVED_CONCEPT);
		writeFileSync(path.join(kbRoot, "knowledge", "concepts", "pending-candidate.md"), UNREVIEWED_CONCEPT);

		const blocks = await collectProfileSources(kbRoot);
		const sources = blocks.map((b) => b.source);
		expect(sources.some((s) => s.startsWith("daily/2026-11-12"))).toBe(true);
		expect(sources.some((s) => s.includes("approved.md"))).toBe(true);
		// THE gate: the unreviewed concept never reaches the generator.
		expect(sources.some((s) => s.includes("pending-candidate"))).toBe(false);
		expect(blocks.map((b) => b.text).join("\n")).not.toContain("auto-applied without review");
	});
});

// ---------------------------------------------------------------------------
// Generation: rule fallback, budget, parsing.
// ---------------------------------------------------------------------------

describe("ruleGenerateProfile (verbatim selection, never fabrication)", () => {
	it("picks verbatim preference sentences from the accepted corpus", () => {
		const body = ruleGenerateProfile([
			{ text: "The user prefers concise reports. The build failed on Tuesday for unrelated reasons.", source: "daily/x.md" },
		]);
		expect(body).toContain("The user prefers concise reports.");
		expect(body).not.toContain("build failed on Tuesday");
		expect(body).toContain("daily/x.md");
	});
});

describe("enforceProfileBudget (≤2KB hard cap)", () => {
	it("passes through small bodies untouched", () => {
		const small = "# User profile\n- Language: English";
		expect(enforceProfileBudget(small)).toBe(small);
	});

	it("truncates oversized bodies at a line boundary under the byte cap", () => {
		const lines = Array.from({ length: 200 }, (_, i) => `- Line ${i}: ${"x".repeat(40)}`).join("\n");
		const out = enforceProfileBudget(lines);
		expect(Buffer.byteLength(out, "utf8")).toBeLessThanOrEqual(MAX_PROFILE_BYTES);
		expect(out).toContain("truncated to");
	});
});

describe("parseProfileMarkdown", () => {
	it("tolerates code fences and missing headers", () => {
		expect(parseProfileMarkdown("```markdown\n# User profile\n- A: b\n```")).toContain("- A: b");
		const noHeader = parseProfileMarkdown("- Language: English");
		expect(noHeader).toMatch(/^#\s+User profile/);
	});
});

// ---------------------------------------------------------------------------
// Orchestration: writes, idempotency, dry-run, threshold trigger.
// ---------------------------------------------------------------------------

describe("runProfileRefresh", () => {
	function profileFixture() {
		const dir = mkdtempSync(path.join(tmpdir(), "distiller-profile-run-"));
		const kbRoot = path.join(dir, "kb");
		mkdirSync(path.join(kbRoot, "daily"), { recursive: true });
		writeFileSync(path.join(kbRoot, "daily", "2026-11-12.md"), "The user prefers working with a single primary conversation per project.\n");
		return {
			dir,
			kbRoot,
			profilePath: path.join(dir, "memory", "profile.md"),
			statePath: path.join(dir, "profile-state.json"),
		};
	}

	it("writes the profile atomically and records state (rule path, no model)", async () => {
		const f = profileFixture();
		const stats = await runProfileRefresh(
			{ kbRoot: f.kbRoot, profilePath: f.profilePath, statePath: f.statePath, log: () => {} },
			{ dryRun: false, trigger: "test" },
		);
		expect(stats.wrote).toBe(true);
		expect(stats.llmUsed).toBe(false);
		expect(stats.degradedReason).toBe("no-model");
		expect(existsSync(f.profilePath)).toBe(true);
		expect(Buffer.byteLength(readFileSync(f.profilePath, "utf8"), "utf8")).toBeLessThanOrEqual(MAX_PROFILE_BYTES);
		expect(existsSync(f.statePath)).toBe(true);
		expect(readFileSync(f.profilePath, "utf8")).not.toContain("tmp-"); // no temp leftovers
	});

	it("is regenerate-and-replace: re-running replaces content and never appends", async () => {
		const f = profileFixture();
		const deps = { kbRoot: f.kbRoot, profilePath: f.profilePath, statePath: f.statePath, log: () => {} };
		await runProfileRefresh(deps, { dryRun: false, trigger: "first" });
		const first = readFileSync(f.profilePath, "utf8");
		await runProfileRefresh(deps, { dryRun: false, trigger: "second" });
		const second = readFileSync(f.profilePath, "utf8");
		expect(second).toBe(first); // same corpus → same rule output; replace, not append
		expect(second.split("# User profile").length).toBe(2); // exactly one header
	});

	it("dry-run writes nothing", async () => {
		const f = profileFixture();
		const stats = await runProfileRefresh(
			{ kbRoot: f.kbRoot, profilePath: f.profilePath, statePath: f.statePath, log: () => {} },
			{ dryRun: true, trigger: "test" },
		);
		expect(stats.wrote).toBe(false);
		expect(existsSync(f.profilePath)).toBe(false);
		expect(existsSync(f.statePath)).toBe(false);
	});

	it("uses the LLM path when available and stays within budget", async () => {
		const f = profileFixture();
		const registry = { streamSimple: fakeProfileStreamFactory({ mode: "good" }), hasConfiguredAuth: () => true };
		const stats = await runProfileRefresh(
			{ kbRoot: f.kbRoot, profilePath: f.profilePath, statePath: f.statePath, log: () => {} },
			{ dryRun: false, trigger: "test", model: { id: "test" }, modelRegistry: registry },
		);
		expect(stats.llmUsed).toBe(true);
		const text = readFileSync(f.profilePath, "utf8");
		expect(text).toContain("deliverables in English");
		expect(Buffer.byteLength(text, "utf8")).toBeLessThanOrEqual(MAX_PROFILE_BYTES);
	});

	it("uses the temp-dir env override for the default path (never the real profile)", () => {
		const tmpProfile = path.join(mkdtempSync(path.join(tmpdir(), "distiller-profile-env-")), "profile.md");
		process.env.PI_PROFILE_PATH = tmpProfile;
		expect(defaultProfilePath()).toBe(tmpProfile);
		expect(defaultProfilePath()).not.toContain(path.join(".pi", "agent", "memory", "profile.md"));
	});
});

describe("shouldRefreshProfile (threshold trigger)", () => {
	const profilePath = "/nonexistent/profile.md"; // missing → refresh

	it("refreshes when the profile is missing", () => {
		expect(shouldRefreshProfile(profilePath, { version: 1, lastRefreshTs: null }, [], new Date())).toBe(true);
	});

	it("fires only at the preference-atom threshold when a fresh profile exists", () => {
		const dir = mkdtempSync(path.join(tmpdir(), "distiller-profile-thr-"));
		const p = path.join(dir, "profile.md");
		writeFileSync(p, "# User profile\n- x");
		const now = new Date("2026-11-13T12:00:00.000Z");
		const state = { version: 1 as const, lastRefreshTs: "2026-11-12T00:00:00.000Z" };
		const prefs = (n: number) => Array.from({ length: n }, (_, i) => ({ ts: `2026-11-13T0${i}:00:00.000Z` }));
		expect(shouldRefreshProfile(p, state, prefs(14), now)).toBe(false);
		expect(shouldRefreshProfile(p, state, prefs(15), now)).toBe(true);
	});

	it("refreshes stale profiles (>30 days)", () => {
		const dir = mkdtempSync(path.join(tmpdir(), "distiller-profile-stale-"));
		const p = path.join(dir, "profile.md");
		writeFileSync(p, "# User profile\n- x");
		const state = { version: 1 as const, lastRefreshTs: "2026-09-01T00:00:00.000Z" };
		expect(shouldRefreshProfile(p, state, [], new Date("2026-11-13T12:00:00.000Z"))).toBe(true);
	});
});

// ---------------------------------------------------------------------------
// Injection through the REAL pi 1.5.0 loader.
// ---------------------------------------------------------------------------

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ENTRY = path.resolve(HERE, "../src/index.ts");
const pkgRoot = path.resolve(HERE, "..", "node_modules", "@earendil-works", "pi-coding-agent");
const loaderJs = path.join(pkgRoot, "dist", "core", "extensions", "loader.js");
const { loadExtensions } = (await import(pathToFileURL(loaderJs).href)) as any;

describe("before_agent_start injection (real loader, temp-dir profile)", () => {
	const dir = mkdtempSync(path.join(tmpdir(), "distiller-profile-inject-"));
	const profilePath = path.join(dir, "memory", "profile.md");
	let handler: Function | undefined;

	beforeAll(async () => {
		mkdirSync(path.dirname(profilePath), { recursive: true });
		writeFileSync(profilePath, "# User profile\n- Language: English deliverables\n- Style: concise\n");
		process.env.PI_PROFILE_PATH = profilePath;
		process.env.PI_MEMORY_KB_ROOT = path.join(dir, "kb");
		process.env.PI_DISTILLER_STATE = path.join(dir, "state.json");
		const result = await loadExtensions([ENTRY], dir);
		expect(result.errors).toEqual([]);
		handler = result.extensions[0].handlers.get("before_agent_start")?.[0];
	});

	afterAll(() => {
		delete process.env.PI_PROFILE_PATH;
		delete process.env.PI_MEMORY_KB_ROOT;
		delete process.env.PI_DISTILLER_STATE;
	});

	function fakeEvent() {
		return {
			type: "before_agent_start",
			messageType: "user",
			prompt: "hi",
			systemPrompt: "BASE",
			systemPromptOptions: { sections: {} as Record<string, string> },
		};
	}

	it("injects the profile as a bounded system-prompt SECTION (not forceSystemPrompt)", () => {
		expect(handler).toBeTruthy();
		const event = fakeEvent();
		handler!(event, {});
		const section = event.systemPromptOptions.sections[PROFILE_SECTION_NAME]!;
		expect(section).toBeTruthy();
		expect(section).toContain("<user_profile>");
		expect(section).toContain("Language: English deliverables");
		expect(Buffer.byteLength(section, "utf8")).toBeLessThanOrEqual(MAX_PROFILE_BYTES + 400);
		// The base prompt was NOT replaced (no forceSystemPrompt semantics).
		expect(event.systemPrompt).toBe("BASE");
	});

	it("applies the kill switch (PI_PROFILE_INJECT=0 → no section)", () => {
		process.env.PI_PROFILE_INJECT = "0";
		const event = fakeEvent();
		handler!(event, {});
		expect(event.systemPromptOptions.sections[PROFILE_SECTION_NAME]).toBeUndefined();
		delete process.env.PI_PROFILE_INJECT;
	});

	it("no-ops cleanly when the profile file is absent", () => {
		const event = fakeEvent();
		const before = { ...event.systemPromptOptions.sections };
		process.env.PI_PROFILE_PATH = path.join(dir, "memory", "absent.md");
		handler!(event, {});
		expect(event.systemPromptOptions.sections).toEqual(before);
		delete process.env.PI_PROFILE_PATH;
	});
});

describe("readProfileCached (mtime cache + defensive re-cap)", () => {
	it("caches by mtime and re-reads after edits", () => {
		const dir = mkdtempSync(path.join(tmpdir(), "distiller-profile-cache-"));
		const p = path.join(dir, "profile.md");
		writeFileSync(p, "# User profile\n- v1");
		const first = readProfileCached(undefined, p);
		expect(first.text).toContain("v1");
		const second = readProfileCached(first.cache, p);
		expect(second.text).toContain("v1");
		writeFileSync(p, "# User profile\n- v2");
		// Force a different mtime (same-second writes can collide on coarse mtimes).
		const st = statSync(p);
		const third = readProfileCached({ ...first.cache, mtimeMs: Math.floor(st.mtimeMs) - 1000 }, p);
		expect(third.text).toContain("v2");
	});
});

describe("renderProfileSection + formatProfileStats", () => {
	it("wraps the profile and states its fallibility", () => {
		const s = renderProfileSection("# User profile\n- A: b");
		expect(s).toContain("<user_profile>");
		expect(s).toContain("fallible");
	});

	it("formats one-line stats honestly including degrade reason", () => {
		const line = formatProfileStats({
			trigger: "test", dryRun: true, llmUsed: false, degradedReason: "no-model",
			sourcesUsed: 3, bytes: 128, wrote: false, profilePath: "/tmp/p.md",
		});
		expect(line).toContain("dry-run");
		expect(line).toContain("rule (no-model)");
		expect(line).toContain("Nothing written");
	});
});
