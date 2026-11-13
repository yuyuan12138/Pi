# pi-memory-distiller

Memory-distiller extension for [pi](https://github.com/earendil-works/pi).
P1a of the memory-index design (`.pi/subagents/sa52/result.md` §3, executed as
**Theme B1** of `work/2026-11-13/architecture-expansion/PLAN.md`): on session
boundaries it distills the session's NEW verified text into typed **memory
atoms** and appends them to the knowledge base, with provenance on every atom.

Companion package: `extensions-src/memory-index/` (Theme B2) indexes these
atoms so `memory_search` finds them with `kind: "atom"`.

## What gets distilled (and what never does)

| Source (session JSONL) | Candidate source tag | Notes |
|---|---|---|
| `compaction` entries → `details.observations[]` | `compaction-observation` | pi-observational-memory's distilled observations |
| `custom` entries `om.observations.recorded` → `data.observations[]` | `om-observation` | observations recorded without a compaction |
| `custom_message` entries `subagent-report` | `subagent-report` | verified worker reports |

Never read or distilled: raw tool output, assistant/user message bodies,
compaction summaries. The distiller reads **only complete JSONL lines from
per-file byte-offset deltas** — each line is read exactly once across restarts.

## Atom record (schema 1, one JSON object per line)

```json
{
  "schema": 1,
  "id": "3f9c2a1b0d4e",
  "kind": "decision",
  "claim": "The distiller writes atoms only after dedup and credential screening pass.",
  "evidence": "after dedup",
  "source_entry_ids": ["aa0000000001", "adff437e"],
  "project": "piagents",
  "ts": "2026-11-13T12:00:00.000Z",
  "source_session": "<session uuid>",
  "origin": "llm",
  "hash": "<sha256 of normalized claim>"
}
```

- `kind` ∈ closed set: `preference | decision | constraint | work_fact |
  work_task | work_method | work_artifact`.
- `source_entry_ids` are pi session entry ids / observation ids — the same
  ids `recall(obs_id)` resolves (provenance is mandatory: an extracted atom
  without resolvable provenance is dropped, never guessed).
- `id` is derived from project + content hash, so a re-read after a crash
  reproduces the same id — dedup is idempotent by construction.
- `origin` states honestly whether an LLM or the rule fallback produced it.

## Write path

APPEND-ONLY: `knowledge-base/atoms/<project-slug>/<YYYY-MM-DD>.jsonl`
(one `appendFile` call per run per file; files are never edited in place —
corrections happen by appending new atoms). The KB root defaults to
`<cwd>/knowledge-base`, overridable with `PI_MEMORY_KB_ROOT` (same env var
as memory-index). There are **no concept writes and no in-place state in
B1**: a kill mid-run can leave at worst a torn trailing JSONL line (tolerated
by every reader) and a stale watermark (one re-read, collapsed by dedup).

Dedup: `hash` = sha256 of the normalized claim (case/whitespace-insensitive),
checked against the project's existing atoms AND within the batch. Watermark
state: `~/.pi/agent/memory/distiller/state.json` (`PI_DISTILLER_STATE`),
written atomically (temp file + rename) and only **after** a successful run;
`/distill --dry-run` writes neither atoms nor watermarks.

## Extraction: LLM first, rules as honest degrade

- **LLM path** — one provider-neutral nested call through the host model
  registry (`ctx.modelRegistry.streamSimple(ctx.model, …)`, the same composed
  runtime the session uses, so custom providers keep working). The prompt
  encodes the sa52/Tencent discipline: better-none-than-junk, self-contained
  claims, merge related observations, only-from-provided-text, closed kind
  set. Output is validated: unknown kinds, empty/oversized claims, missing
  or out-of-range provenance → dropped. Bounded by abort signal + hard race
  timer (45s idle runs, 12s shutdown flush).
- **Rule path** (no model, missing auth, LLM error/timeout/unparseable) —
  conservative keyword gating over the SAME candidate text; every claim is a
  **verbatim sentence from the source** (selection, never fabrication). The
  degrade reason is recorded in the run stats and stderr log.

Credential screening (`credentials.ts`, same pattern set as memory-index)
runs on every atom's claim+evidence **before any write**; flagged atoms are
skipped and counted.

## Triggers

- `agent_settled` → idle-debounce (default 60s, `PI_DISTILLER_IDLE_MS`,
  min 5s); a new turn (`agent_start`) cancels the pending run; fires only
  when the context is still idle; single-flight (concurrent triggers join
  the in-flight run).
- `session_shutdown` (quit/reload/new/resume/fork) → flush pass; LLM bounded
  to 12s with rule fallback so quit stays fast.
- `/distill` → manual run; `/distill --dry-run` reports the planned atoms
  (candidates, kinds, dedup/credential counts) and **writes nothing**.
- `agent_settled` runs stay quiet unless atoms were written (one stderr line
  + a `memory-distiller.run` custom session entry with the run stats).

## Storage & env vars

| Surface | Default | Override |
|---|---|---|
| Watermark state | `~/.pi/agent/memory/distiller/state.json` | `PI_DISTILLER_STATE` |
| Idle debounce | 60000 ms | `PI_DISTILLER_IDLE_MS` (≥5000) |
| KB root | `<cwd>/knowledge-base` | `PI_MEMORY_KB_ROOT` |

All three are re-read per run/event (nothing is latched at load); any code
change still requires a full pi restart (`docs/activation-contract.md`
universal rule). The extension registers zero tools — only the `/distill`
command and the three lifecycle handlers above. No writes happen at load.

## Install (main-session step, after verification)

```bash
cp -R extensions-src/memory-distiller ~/.pi/agent/extensions/memory-distiller
```

`@earendil-works/*` imports resolve through pi's extension loader (virtual
modules); devDependencies are needed only for typecheck/tests.

## Tests

`npm install && npx vitest run` — 40 tests across 5 files:

1. **Scan** — candidate extraction from all three source types; second scan
   is a no-op; watermarks survive a restart (only the new delta is read);
   torn trailing lines wait; shrunk files rescan from zero; atomic state
   saves leave no temp files; corrupt state starts fresh.
2. **Extract** — LLM output validation (closed kinds, mandatory provenance,
   fence tolerance, no-sources-dropped); fake-stream LLM call (good output,
   garbage → throw, error stopReason → throw, hung stream → timeout);
   rule extraction keeps claims verbatim (substring assertion) and yields
   nothing without triggers; content-hash dedup keys collapse identical
   claims case/whitespace-insensitively.
3. **Write path** — `/distill --dry-run` writes nothing at all (and does not
   advance watermarks); real runs append with provenance; a kill simulation
   (state deleted) re-reads and collapses everything via dedup (written=0);
   credential fixture skipped before any write; LLM path via injected
   registry; LLM failure degrades with honest stats; zero-candidate runs
   still advance watermarks.
4. **Resolvability** — every atom's `source_entry_ids` exists in the fixture
   session file (top-level entry ids + nested observation ids, the
   recall-compatible set).
5. **Loader** — loads via the real pi 1.5.0 extension loader with **zero
   errors and zero warnings**, `/distill` registered, lifecycle handlers
   registered, and the command handler performs a real dry-run (nothing
   written) then a real run (atoms file + state) through the loaded
   definition.

`node scripts/manual-load-check.mjs` additionally (a) loads the entry through
the **actually installed** pi release loader and (b) boots the real
`pi --no-extensions --extension <entry> --mode rpc` CLI headlessly (temp cwd +
temp state/KB) and asserts clean stderr.

## Limitations (B1)

- Atoms are never deleted or updated in place; contradictions accumulate
  until consolidation or human review resolves them.
- The quit-time flush races process exit: if the LLM exceeds the 12s budget
  the run degrades to rules; idle-debounce is the primary LLM path.
- One LLM call handles at most 40 blocks per run; longer deltas are covered
  by subsequent runs (watermarks only advance over processed lines).
- Rule extraction is English/Chinese keyword-gated and conservative by
  design; low yield is expected and preferred over junk.

## B3 — L2 consolidation (`/distill-consolidate`, Theme B3 / sa52 P1b)

Reads the project's accumulated `atoms/<project>/*.jsonl` pool, clusters it
by topic (one LLM call proposing topic clusters; on any LLM failure a
deterministic rule fallback: greedy Jaccard clustering over significant
ASCII tokens + CJK bigrams), and writes DRAFT concept candidates to:

```
kB/knowledge/concepts/pending-<YYYY-MM-DD>/<slug>-<hash8>.md   + REPORT.md
```

Guarantees (each pinned by a test):

- **The approved concepts tree is NEVER written.** All writes land inside
  `concepts/pending-<date>/`; `compile_kb.py` scans only
  `concepts/*.md` (non-recursive glob), so the scope gate and the human
  approval gate are untouched. Promotion = a human moves a reviewed file
  into `concepts/`, after which the normal lint applies.
- Candidate frontmatter uses ONLY compile_kb's existing field vocabulary
  (`title/updated/scope/evidence/origin/approval/last_reviewed/sources`)
  with `scope: pending` + `approval: unreviewed` — no concept ever
  auto-promotes, structurally (this code has no write path into the
  approved tree).
- **Contradictions (conflicting claims on the same subject) are surfaced,
  never resolved**: each candidate carries a dedicated "Contradictions
  (surfaced, never auto-resolved)" section, the run REPORT lists all of
  them, and the renderer never merges conflicting claims into one sentence.
- Evidence chains run candidate → atom → session entries: every cited atom
  shows its `source_entry_ids` (recall-compatible) and source session.
- Candidate file names are derived from the sorted atom-id set (sha256), so
  a re-run over the same atom pool overwrites the same files idempotently;
  all writes are atomic (temp+rename). `--dry-run` writes nothing.
- Bounded: ≤80 atoms per run (most recent), ≤12 clusters, ≤8 contradictions
  per cluster; 45s LLM race timer with abort.

Deliberate deviation from sa52 §P1b as designed: the UPDATE-default /
concept-cap-15 / heat-counter pressure rules operate on the approved tree,
which this stricter brief forbids touching — so they are NOT implemented as
writes. The per-project concept count is left to the human; candidates are
promotion-ready instead. The idle-time hook is DISABLED by default: opt in
with `PI_DISTILLER_CONSOLIDATE_IDLE=1` (fires only when ≥40 new atoms exist
since the last run AND ≥12h have passed; per-call env, no restart needed).

## B4 — L3 user profile (`/distill-profile`, Theme B4 / sa52 P1c)

A ≤2KB preference layer at `~/.pi/agent/memory/profile.md`
(`PI_PROFILE_PATH`), maintained by regenerate-and-replace (atomic
temp+rename — re-running can never append, duplicate, or grow it) and
injected into every run as a bounded `user-profile` system-prompt SECTION
via `before_agent_start` → `event.systemPromptOptions.sections` — never
`forceSystemPrompt`, so the base prompt, transcript-recorded sections, and
prompt cacheability are preserved (pi 1.5.0 API).

Source discipline (the load-bearing guarantee):

- The generator reads ONLY accepted/approved records: `daily/*.md` (the
  accepted-results log by KB convention) and `knowledge/concepts/*.md`
  whose frontmatter carries `approval: user-approved`. Pending/unreviewed
  concepts are excluded before the generator ever sees them (pinned by a
  negative test: seeded unreviewed content must not appear in the profile).
- Atoms are NEVER profile source content (AI-extracted, potentially
  unverified worker claims). They act only as the refresh TRIGGER: ≥15 new
  preference-kind atoms since the last refresh (or a missing/30-day-stale
  profile) fires a refresh at session shutdown; `/distill-profile` refreshes
  manually any time.
- The LLM prompt forbids deriving preferences from rejected approaches or
  worker-originated claims; the rule fallback emits only verbatim
  preference-pattern sentences from the accepted corpus.

Injection reads the file with an mtime cache (one stat per run, sub-ms) and
re-applies the 2KB budget defensively every turn. `PI_PROFILE_INJECT=0` is
the kill switch for injection AND threshold-triggered refresh (the manual
command still works). Tests exercise the injection through the REAL pi
1.5.0 loader with a temp-dir `PI_PROFILE_PATH` — the real profile file is
never touched by tests.

## Limitations (B3/B4, honest)

- **Consolidation false-positive risk**: rule-path clustering is lexical
  (token overlap), so it both over- and under-groups; the LLM path is
  better but nondeterministic. Everything is draft + human-gated, so a bad
  cluster costs review time, not correctness. Contradiction detection is a
  heuristic (shared subject + negation polarity on the rule path): expect
  false positives (harmless — human review) and misses on subtler conflicts
  (the report states that absence of a flag is not a guarantee).
- **Profile injection latency**: one file stat + cached read per
  `before_agent_start` (sub-millisecond; the 2KB section itself is
  cache-stable across turns). Profile *generation* is an LLM call but only
  at refresh boundaries (threshold/stale/manual), never per turn.
- LLM wording varies between profile regenerations; "idempotent" means the
  update operation is regenerate-and-replace (no growth/duplication), not
  byte-identical output across LLM runs. The rule fallback is deterministic.
- sa52's trigger conditions P1 (explicit L2 signal) and P2/P2.5/P3 (cold
  start/recovery/first-scene) are collapsed to: manual command + threshold
  + staleness — sufficient at personal scale.
