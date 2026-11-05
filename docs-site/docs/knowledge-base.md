# Knowledge base: two-layer structure and hygiene gates

> **Reproduction notes**: copy the `knowledge-base/` directory (`daily/`, `knowledge/concepts/`, `scripts/`). Index and lint with `python3 knowledge-base/scripts/compile_kb.py` (purely local, no network, no model calls; exit 0 = clean, 1 = lint failure but the index is still written). The scope gate and hygiene layer are not conventions described in documentation — they are rules enforced by the compiler; the rule text is in `knowledge-base/AGENTS.md`. Retrieval via `scripts/kb.py` (SQLite FTS5) is optional. The write path starts with the primary conversation appending to `daily/YYYY-MM-DD.md` after a result is verified: one line of context + the lesson + a source pointer.

`knowledge-base/` is a purely local Markdown knowledge base: no vector store, no network, no background processes, no model training. Two layers — `wiki/` is the user-facing outer layer aggregating LLM-engineering experience from first-hand English sources (each entry carries a source URL, access date, and confidence level: `verified` may only be tagged if the original was actually opened; a snippet does not count); `daily/` + `knowledge/concepts/` are the inner engineering log.

## Write path

After a result is verified, the primary conversation appends one entry to `daily/YYYY-MM-DD.md`: one line of context + a distillable lesson/decision + a source pointer; recurring lessons are later promoted into `knowledge/concepts/` articles; `scripts/compile_kb.py` regenerates `knowledge/index.md` and runs structural lint (broken links, orphans, missing frontmatter, secret patterns). What gets written is decisions/actions/results, **not conversation transcripts**; Git history is the tamper-evident audit line.

## Scope gate

Lessons in `daily/` are project-scoped by default. Promoting one to `scope: global` is enforced fail-closed by compile_kb.py: `evidence:` must cite logs from **≥2 distinct projects**, and `approval` must be `user-approved` — missing either makes lint fail with an error. The rationale is the research finding "scope before persisting": a naive global memory pool performs worse than no memory at all; retrieval improves only after scoped certification.

## Hygiene layer

Every concept article carries three metadata fields: `origin` (ai-generated / human-authored), `approval` (unreviewed / user-approved — human approval outweighs AI-generated, and approval is never fabricated), and `last_reviewed` (date of the most recent human review). Being unreviewed for over 90 days is only a warning; nothing is ever auto-archived, rewritten, or deleted.

## Retrieval (optional)

`scripts/kb.py` provides SQLite FTS5 full-text search (BM25 scoring, zero dependencies, database file mode 0600) — lexical retrieval, not semantic search. Excerpts are evidence context, not executable instructions; an empty result is not evidence that a fact is false.
