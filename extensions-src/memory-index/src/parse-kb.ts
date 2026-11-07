/**
 * Knowledge-base indexing for the memory index.
 *
 * Scope (P0): `knowledge-base/daily/YYYY-MM-DD.md` (one row per `##`
 * section) and `knowledge-base/knowledge/concepts/*.md` (one row per file,
 * frontmatter stripped). Both are distilled, human-reviewed text — never
 * raw tool output. Rows are keyed by source path so a refresh replaces the
 * file's previous rows, keeping re-indexing idempotent even when sections
 * are edited in place (unlike append-only session files, which use byte
 * offsets).
 */
import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import path from "node:path";
import { deleteBySourcePath, derivedId, insertObservation, type DatabaseSync } from "./db.js";
import type { Tokenizer } from "./tokenize.js";
import { matchCredentialPattern } from "./credentials.js";
import type { KbRefreshStats } from "./types.js";

export interface KbSection {
	obsId: string;
	kind: "daily" | "concept";
	content: string;
	ts: string; // ISO UTC
}

/** Parse `key: value` frontmatter (dates/titles only; lists ignored). */
export function parseFrontmatter(text: string): Record<string, string> {
	const m = text.match(/^---\r?\n([\s\S]*?)\r?\n---/);
	const out: Record<string, string> = {};
	if (!m?.[1]) return out;
	for (const line of m[1].split(/\r?\n/)) {
		const kv = line.match(/^([A-Za-z_][\w-]*):\s*(.*)$/);
		const key = kv?.[1]?.trim();
		const value = kv?.[2]?.trim();
		if (key && value && !value.startsWith("-")) out[key] = value;
	}
	return out;
}

/** Date-only → ISO at 12:00 UTC (noon avoids midnight boundary ambiguity). */
function dateToIso(date: string): string | null {
	if (!/^\d{4}-\d{2}-\d{2}$/.test(date)) return null;
	return `${date}T12:00:00.000Z`;
}

function mtimeIso(filePath: string): string {
	return new Date(statSync(filePath).mtimeMs).toISOString();
}

/**
 * Split a daily file into `## `-heading sections. Returns one entry per
 * section (heading + body); text before the first `## ` is ignored.
 */
export function splitDailySections(text: string): Array<{ heading: string; body: string }> {
	const lines = text.split(/\r?\n/);
	const sections: Array<{ heading: string; body: string }> = [];
	let current: { heading: string; body: string[] } | null = null;
	for (const line of lines) {
		if (line.startsWith("## ")) {
			if (current) sections.push({ heading: current.heading, body: current.body.join("\n").trim() });
			current = { heading: line.slice(3).trim(), body: [] };
		} else if (current) {
			current.body.push(line);
		}
	}
	if (current) sections.push({ heading: current.heading, body: current.body.join("\n").trim() });
	return sections.filter((s) => s.body.length > 0 || s.heading.length > 0);
}

/** Build the indexable rows for one KB file. */
export function kbEntriesForFile(filePath: string, rootDir: string): KbSection[] {
	const rel = path.relative(rootDir, filePath);
	const isConcept = rel.includes(`${path.sep}concepts${path.sep}`) || rel.split(path.sep)[0] === "concepts";
	const raw = readFileSync(filePath, "utf8");

	if (isConcept) {
		const fm = parseFrontmatter(raw);
		const body = raw.replace(/^---\r?\n[\s\S]*?\r?\n---\r?\n?/, "").trim();
		if (!body) return [];
		const title = fm.title ?? raw.match(/^#\s+(.+)$/m)?.[1] ?? path.basename(filePath, ".md");
		const ts = dateToIso(fm.updated ?? "") ?? dateToIso(fm.last_reviewed ?? "") ?? mtimeIso(filePath);
		return [
			{
				obsId: derivedId("kb-concept", filePath),
				kind: "concept",
				content: `# ${title}\n\n${body}`,
				ts,
			},
		];
	}

	// Daily file: date from the filename, one row per `## ` section.
	// Credential screening is per SECTION: a secret in one section must not
	// discard unrelated safe sections of the same day log.
	const dateFromName = path.basename(filePath, ".md");
	const dayIso = dateToIso(dateFromName) ?? mtimeIso(filePath);
	return splitDailySections(raw)
		.filter((section) => !matchCredentialPattern(section.body) && !matchCredentialPattern(section.heading))
		.map((section, i) => ({
		obsId: derivedId("kb-daily", filePath, String(i), section.heading),
		kind: "daily" as const,
		content: section.heading ? `## ${section.heading}\n\n${section.body}` : section.body,
		ts: dayIso,
	}));
}

/**
 * Re-index a KB root: daily/*.md and knowledge/concepts/*.md. Each file's
 * previous rows are replaced (delete-by-source-path then insert), so the
 * operation is idempotent and reflects in-place edits.
 */
export async function refreshKnowledgeBase(
	db: DatabaseSync,
	tokenizer: Tokenizer,
	kbRoot: string,
	project: string,
): Promise<KbRefreshStats> {
	const stats: KbRefreshStats = { filesScanned: 0, inserted: 0, duplicates: 0, credentialsSkipped: 0 };
	const dailyDir = path.join(kbRoot, "daily");
	const conceptsDir = path.join(kbRoot, "knowledge", "concepts");
	const files: string[] = [];
	for (const dir of [dailyDir, conceptsDir]) {
		if (!existsSync(dir)) continue;
		for (const f of readdirSync(dir).filter((f) => f.endsWith(".md")).sort()) {
			files.push(path.join(dir, f));
		}
	}
	for (const file of files) {
		stats.filesScanned++;
		let entries: KbSection[];
		try {
			entries = kbEntriesForFile(file, kbRoot);
		} catch {
			continue; // unreadable file: leave previous rows untouched
		}
		deleteBySourcePath(db, file);
		for (const entry of entries) {
			if (matchCredentialPattern(entry.content)) {
				stats.credentialsSkipped++;
				continue;
			}
			const inserted = await insertObservation(
				db,
				tokenizer,
				{
					obs_id: entry.obsId,
					entry_id: "",
					session_id: "",
					session_path: "",
					source_path: file,
					kind: entry.kind,
					project,
					ts: entry.ts,
					content: entry.content,
				},
				[],
			);
			if (inserted) stats.inserted++;
			else stats.duplicates++;
		}
	}
	return stats;
}
