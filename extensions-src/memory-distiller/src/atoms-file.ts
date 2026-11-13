/**
 * Append-only atoms storage: knowledge-base/atoms/<project-slug>/<YYYY-MM-DD>.jsonl
 *
 * One JSON object per line (schema 1). Files are never edited in place —
 * corrections happen by appending new atoms; consumers dedupe by id/hash.
 * A run performs at most ONE appendFile call per target file, so a kill
 * mid-run either persisted a whole batch or nothing; a torn trailing line is
 * tolerated by every reader (parse-tolerant JSONL + content-hash dedup).
 * Credential screening happens BEFORE any bytes are written.
 */
import { existsSync } from "node:fs";
import { appendFile, mkdir, readFile, readdir } from "node:fs/promises";
import path from "node:path";
import { atomIdFor, claimHash } from "./extract.js";
import { matchCredentialPattern } from "./credentials.js";
import type { Atom, AtomDraft } from "./types.js";

export function projectSlugFor(cwd: string): string {
	const slug = path
		.basename(cwd)
		.toLowerCase()
		.replaceAll(/[^a-z0-9_-]+/g, "-")
		.replace(/^-+|-+$/g, "");
	return slug || "default";
}

export function atomsDirFor(kbRoot: string, projectSlug: string): string {
	return path.join(kbRoot, "atoms", projectSlug);
}

export function utcDateStamp(d: Date): string {
	return d.toISOString().slice(0, 10);
}

export function atomsFileFor(kbRoot: string, projectSlug: string, dateStamp: string): string {
	return path.join(atomsDirFor(kbRoot, projectSlug), `${dateStamp}.jsonl`);
}

/**
 * Load the dedup keys (claim hashes + atom ids) already present in one
 * project's atoms dir. Missing dir → empty sets. Torn/unparseable lines are
 * skipped; legacy records without `hash` are hashed from their claim.
 */
export async function loadKnownKeys(atomsDir: string): Promise<{ hashes: Set<string>; ids: Set<string> }> {
	const hashes = new Set<string>();
	const ids = new Set<string>();
	if (!existsSync(atomsDir)) return { hashes, ids };
	let files: string[] = [];
	try {
		files = (await readdir(atomsDir)).filter((f) => f.endsWith(".jsonl")).sort();
	} catch {
		return { hashes, ids };
	}
	for (const f of files) {
		let raw: string;
		try {
			raw = await readFile(path.join(atomsDir, f), "utf8");
		} catch {
			continue;
		}
		for (const line of raw.split("\n")) {
			const t = line.trim();
			if (!t) continue;
			try {
				const rec = JSON.parse(t) as { id?: unknown; hash?: unknown; claim?: unknown };
				if (typeof rec.id === "string" && rec.id) ids.add(rec.id);
				if (typeof rec.hash === "string" && rec.hash) hashes.add(rec.hash);
				else if (typeof rec.claim === "string" && rec.claim) hashes.add(claimHash(rec.claim));
			} catch {
				// torn tail line: tolerated, never fatal
			}
		}
	}
	return { hashes, ids };
}

/** Materialize a draft into the append-only record shape. */
export function materializeAtom(draft: AtomDraft, project: string, now: Date): Atom {
	const hash = claimHash(draft.claim);
	return {
		schema: 1,
		id: atomIdFor(project, hash),
		kind: draft.kind,
		claim: draft.claim.trim(),
		evidence: draft.evidence,
		source_entry_ids: [...draft.sourceEntryIds],
		project,
		ts: now.toISOString(),
		source_session: draft.sessionUuid,
		origin: draft.origin,
		hash,
	};
}

/** Credential screen on the atom's user-visible text (claim + evidence). */
export function atomFlagged(atom: { claim: string; evidence: string }): string | null {
	return matchCredentialPattern(`${atom.claim}\n${atom.evidence}`);
}

/** Append atom lines to the daily file. ONE appendFile call per invocation. */
export async function appendAtomsToFile(filePath: string, atoms: Atom[]): Promise<void> {
	if (atoms.length === 0) return;
	await mkdir(path.dirname(filePath), { recursive: true });
	const payload = atoms.map((a) => JSON.stringify(a)).join("\n") + "\n";
	await appendFile(filePath, payload, "utf8");
}
