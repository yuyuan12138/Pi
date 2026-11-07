/**
 * Acceptance 4: credential-pattern fixture strings never reach the DB.
 * Covers session observations and KB sections.
 */
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { openIndex } from "../src/db.js";
import { backfillSessions } from "../src/parse-sessions.js";
import { refreshKnowledgeBase } from "../src/parse-kb.js";
import { writeSessionFile } from "./helpers.js";
import { matchCredentialPattern } from "../src/credentials.js";

const AWS_KEY = "AKIA" + "IOSFODNN7EXAMPLE";
const OPENAI_STYLE = "sk-" + "proj-" + "abc123def456ghi789jklmno";
const PASSWORD_LINE = "password: " + "hunter2secretvalue";
const GITHUB_PAT = "ghp_" + "AbCdEfGhIjKlMnOpQrStUvWx1234567890ab";

let ctx: any;
let root: string;
let firstScan: Array<{ credentialsSkipped: number; inserted: number }> = [];

beforeAll(async () => {
	root = mkdtempSync(path.join(tmpdir(), "memidx-cred-"));
	const sessionsDir = path.join(root, "sessions");
	writeSessionFile(sessionsDir, "2026-11-06T09-00-00-000Z_bbbbbbbb-1111-2222-3333-444444444444.jsonl", [
		{
			id: "dead0001",
			timestamp: "2026-11-06T10:00:00.000Z",
			observations: [
				{
					id: "cd0000000001",
					content: `Deployed the service using the key ${AWS_KEY} with fallback ${OPENAI_STYLE}.`,
					timestamp: "2026-11-06 09:50",
				},
				{
					id: "cd0000000002",
					content: "The benign observation about database migrations is safe to index.",
					timestamp: "2026-11-06 09:55",
				},
			],
		},
	]);
	ctx = await openIndex(path.join(root, "index.db"));
	firstScan = await backfillSessions(ctx.db, ctx.tokenizer, sessionsDir, "/tmp/proj-cred");

	const kb = path.join(root, "knowledge-base");
	mkdirSync(path.join(kb, "daily"), { recursive: true });
	mkdirSync(path.join(kb, "knowledge", "concepts"), { recursive: true });
	writeFileSync(
		path.join(kb, "daily", "2026-11-06.md"),
		[
			"# 2026-11-06",
			"",
			"## Deploy credentials rotation",
			`- Rotated the leaked ${GITHUB_PAT} and ${PASSWORD_LINE} on staging.`,
			"",
			"## Safe migration notes",
			"- Added an index on obs(project, kind, ts) without downtime.",
			"",
		].join("\n"),
	);
	writeFileSync(
		path.join(kb, "knowledge", "concepts", "credential-hygiene.md"),
		[
			"---",
			"title: Credential hygiene",
			"updated: 2026-11-06",
			"scope: pending",
			"approval: unreviewed",
			"---",
			"",
			"# Credential hygiene",
			"",
			`Never commit secrets like ${AWS_KEY} into any repository or memory store.`,
			"",
		].join("\n"),
	);
	await refreshKnowledgeBase(ctx.db, ctx.tokenizer, kb, "/tmp/proj-cred");
});

afterAll(() => {
	try {
		ctx.db.close();
	} catch {
		/* ignore */
	}
});

describe("acceptance 4: credential patterns absent from DB", () => {
	it("screens every fixture credential string out of the index", () => {
		const secrets = [AWS_KEY, OPENAI_STYLE, PASSWORD_LINE, GITHUB_PAT];
		for (const secret of secrets) {
			const escaped = secret.replaceAll(/[%_]/g, "!");
			const rows = ctx.db
				.prepare("SELECT obs_id FROM obs WHERE content LIKE ? ESCAPE '!'")
				.all(`%${escaped}%`);
			expect(rows, `secret leaked into obs: ${secret}`).toEqual([]);
			const fts = ctx.db
				.prepare("SELECT obs_id FROM obs_fts WHERE tokens LIKE ? ESCAPE '!'")
				.all(`%${escaped}%`);
			expect(fts, `secret leaked into obs_fts: ${secret}`).toEqual([]);
		}
	});

	it("still indexes benign observations and sections", () => {
		const benign = ctx.db
			.prepare("SELECT obs_id FROM obs WHERE content LIKE '%database migrations%'")
			.all();
		expect(benign.length).toBe(1);
		const sections = ctx.db
			.prepare("SELECT obs_id FROM obs WHERE content LIKE '%Safe migration notes%'")
			.all();
		expect(sections.length).toBe(1);
	});

	it("reports skipped counts honestly", () => {
		// firstScan is the original backfill run from beforeAll; re-running
		// backfill is a watermark no-op by design (idempotency).
		expect(firstScan[0]?.credentialsSkipped).toBe(1);
		expect(firstScan[0]?.inserted).toBe(1); // only the benign observation
	});

	it("unit-covers the individual patterns", () => {
		expect(matchCredentialPattern(`key ${AWS_KEY} end`)).toBe("aws-access-key");
		expect(matchCredentialPattern(OPENAI_STYLE)).toBe("openai-style-key");
		expect(matchCredentialPattern(GITHUB_PAT)).toBe("github-pat");
		expect(matchCredentialPattern(PASSWORD_LINE)).toBe("generic-secret-assignment");
		expect(matchCredentialPattern("eyJ" + "hbGciOiJIUzI1NiJ9.eyJzdWIiOiIxIn0.SflKxwRJSMeKKF2QT4fwpMeJf36POk6yJVadQssw5c")).toBe("jwt");
		expect(matchCredentialPattern("-----BEGIN " + "RSA PRIVATE KEY-----")).toBe("private-key-block");
		expect(matchCredentialPattern("mongodb://admin:s3cret@cluster0.abc.mongodb.net/db")).toBe("connection-string-credentials");
		expect(matchCredentialPattern("totally harmless text about ducks")).toBeNull();
	});
});
