# pi-memory-index

Cross-session SQLite FTS5 memory index for [pi](https://github.com/earendil-works/pi).
P0 of the memory-index design (`.pi/subagents/sa52/result.md`): a `memory_search`
tool over **distilled** memory only — compaction observations and knowledge-base
entries — with project scoping, time windows, and drill-back through the
existing `recall(obs_id)` tool.

## What gets indexed (and what never does)

| Source | Kind | Unit |
|---|---|---|
| Compaction entries (`details.observations[]`, e.g. `om.folded`) | `observation` | one row per observation (its own 12-hex obs id + `sourceEntryIds`) |
| `knowledge-base/daily/YYYY-MM-DD.md` | `daily` | one row per `## ` section |
| `knowledge-base/knowledge/concepts/*.md` | `concept` | one row per file (frontmatter stripped) |

Never indexed: raw tool output, compaction summaries, `details.reflections[]`,
anything outside the two triggers below. Every row passes a credential-regex
screen before insert; matches are skipped and counted. Observations are
screened per observation, daily files per section, concepts per file.

## Triggers

Event names verified against pi 1.3.0 `dist/core/extensions/types.d.ts`:

- `session_start` — incremental backfill of the current project's session
  directory (per-file **byte-offset watermarks**, so re-runs are no-ops) plus
  a KB refresh (delete-by-source + reinsert per file, so in-place edits are
  reflected and re-runs are idempotent).
- `session_compact` — the fresh compaction entry's observations are indexed
  immediately; `obs_id` uniqueness makes this idempotent with backfill.
- `session_shutdown` — DB close (idempotent).

The design's optional `agent_before_settle` catch-up pass is deliberately not
implemented in P0; the two triggers above already make duplicate rows
impossible.

## Tool

`memory_search({ query, project?, from?, to?, kind?, limit? })`

- `project` defaults to the current session cwd; no cross-project global
  search exists by design.
- `from`/`to` accept `YYYY-MM-DD` or full ISO-8601 (inclusive bounds).
- `kind` ∈ `observation | concept | daily | atom` (`atom` is reserved for P1
  distillation and currently matches nothing).
- `limit` 1–50, default 10. Results ranked by `bm25()` with a recency
  tiebreak; a multi-term AND query that misses retries with OR.
- Returns `obs_id, entry_id, session_id, ts, snippet` plus
  `source_entry_ids` and (KB rows) `source_path`.
- Drill-back: `recall(<obs_id>)` (pi-observational-memory) recovers exact
  source context for observation hits; for KB rows read the listed
  `source_path`. This extension does not reimplement recovery.

## Storage

`~/.pi/agent/memory/index.db` (SQLite, WAL mode, outside every repository).
Canonical `obs` table (dedupe + drill-back data + original content) + FTS5
`obs_fts` with all metadata as UNINDEXED columns. Per-file watermarks live in
a `watermarks` table. Overridable via `PI_MEMORY_INDEX_DB` (full path) and
`PI_MEMORY_KB_ROOT`; `~/.pi/agent/extensions/memory-index/` is the install
location.

## CJK tokenization

Write side and query side share one segmentation (TencentDB-Agent-Memory's
approach):

- `jieba` — `@node-rs/jieba` `cutForSearch`, lazy-loaded; used when the
  native module is present (it is listed under `optionalDependencies`; run
  `npm install --omit=dev` in the extension dir to enable it).
- `bigram` — dependency-free fallback: overlapping CJK bigrams, ASCII words
  kept whole. **Disclosed degradation:** CJK queries whose word does not
  share a bigram with the document text will not match (jieba recall is
  strictly better for Chinese).

The active mode is recorded in the DB `meta` table; if availability changes
between sessions the whole FTS table is re-tokenized from stored content, so
write-side and query-side can never drift.

No embeddings, no LLM calls.

## Install

```bash
cp -R extensions-src/memory-index ~/.pi/agent/extensions/memory-index
cd ~/.pi/agent/extensions/memory-index && npm install --omit=dev   # optional: enables jieba
```

`@earendil-works/*` imports resolve through pi's extension loader
(virtual modules) — no dependency install is required for the core
functionality.

## Tests

`npm install && npx vitest run` (29 tests across 6 files):

1. **Search fixtures** — 3 synthetic session JSONLs with compaction entries;
   `memory_search` returns the right observation with id + ts in <50 ms
   (asserted); time windows exclude out-of-range hits; project filter works.
2. **Idempotency** — second backfill is a no-op; immediate
   `session_compact` insert + backfill dedupe; partially written trailing
   lines index exactly once.
3. **Credentials** — AWS/OpenAI-style/GitHub-PAT/password fixture strings
   absent from `obs` and `obs_fts`; benign content still indexed; unit
   coverage per pattern.
4. **Tokenizer** — bigram segmentation, jieba/bigram consistency, mode-drift
   re-tokenization.
5. **KB** — daily section splitting, frontmatter timestamps, refresh
   idempotency, in-place edits.
6. **Loader (acceptance 5)** — loads via the real pi 1.3.0 extension loader
   (`loadExtensions` from the same `dist/core/extensions/loader.js` the CLI
   runs, imported directly because the package's exports map hides dist
   subpaths) with **zero errors and zero warnings**, `memory_search`
   registered with the documented parameters, lifecycle handlers registered,
   and a live `execute()` wiring check through a mock session context.

`node scripts/manual-load-check.mjs` additionally (a) loads the entry through
the **actually installed** pi release loader and (b) boots the real
`pi --no-extensions --extension <entry> --mode rpc` CLI headlessly and
asserts clean stderr. Honest statement: the in-vitest test exercises the real
loader code but not the full CLI runtime; the script covers the CLI boot path
without a model call.

## Limitations (P0)

- Compaction summaries and `reflections[]` are not indexed (deliverable
  scope: observations + KB only). Reflection ids are recallable today but
  not searchable here.
- `atom` kind is reserved; P1 distillation will populate it.
- Session backfill covers the current project's session directory only
  (design: no cross-project global index).
- Observations whose compaction entry lacks `details.observations` (plain
  pi-core compactions) contribute nothing.
- KB rows use derived ids (not `recall`-able); their drill-back is the
  `source_path` field.
- The DB is machine-local and unencrypted by design; treat
  `~/.pi/agent/memory/` as private data.
