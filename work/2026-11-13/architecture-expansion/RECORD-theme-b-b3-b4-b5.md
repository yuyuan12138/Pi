# Theme B completion: B3 (L2 consolidation) + B4 (L3 profile) + B5 (harvest checker)

Task: Theme B remaining P1 items — B3 consolidation with contradiction surfacing, B4 ≤2KB profile layer with section injection, B5 report-only harvest checker · Dispatched-by: PiAgents coordinator primary (PLAN.md Theme B brief, 2026-11-13) · Worker: dispatched coder (clean-context background subagent) · Status: delivered · Brief header: [project:PiAgents]

Date 2026-11-13 · Worker: dispatched coder (clean-context background subagent, Theme B brief) · Status: delivered.

## Task brief

work/2026-11-13/architecture-expansion/PLAN.md Theme B items B3/B4/B5, executed per the sa52
spec (.pi/subagents/sa52/result.md §3 P1b/c) and knowledge-base/AGENTS.md conventions: B3 =
`/distill-consolidate` + disabled-by-default idle hook clustering accumulated atoms by
topic/contradiction (contradictions surfaced, never auto-resolved) into
`knowledge/concepts/pending-<date>/` drafts (scope:pending + approval:unreviewed + atom evidence
chains), NEVER writing the approved concepts tree (compile_kb scope gate untouched); B4 = ≤2KB
`~/.pi/agent/memory/profile.md` preference layer from ACCEPTED/user-approved records only,
injected via before_agent_start as a bounded section (pi 1.5.0 API); B5 = `tools/harvest_check.py`
report-only lint over done subagent dirs flagging missing harvest entries; tests for all three;
activation-contract checker must pass; explicit-path commits, no install, no push.

## Delivered

### 1. B3 — L2 consolidation (extensions-src/memory-distiller: src/cluster.ts 249 LOC, src/consolidate.ts 492 LOC, wiring in src/index.ts)
- `/distill-consolidate [--dry-run]` + idle hook DISABLED by default
  (`PI_DISTILLER_CONSOLIDATE_IDLE=1` opts in; fires only at ≥40 new atoms since last run AND ≥12h
  since last run — sa52 pipeline-manager thresholds).
- Reads `knowledge-base/atoms/<project>/*.jsonl` (deduped, oldest first, credential screen
  re-applied at read), clusters by topic: LLM path (one provider-neutral `streamSimple` call, 45s
  race timer, clusters+contradictions JSON validated) degrading honestly to a deterministic rule
  path (greedy Jaccard over ASCII tokens + CJK bigrams; titles from token frequency).
- **Contradictions surfaced, never resolved**: dedicated "Contradictions (surfaced, never
  auto-resolved)" section per candidate + all listed in REPORT.md; cross-cluster contradictions
  counted separately; renderer never merges conflicting claims. Rule heuristic: shared significant
  subject + opposing negation polarity.
- **Approved tree never written**: candidates land ONLY in
  `knowledge/concepts/pending-<date>/<slug>-<hash8>.md` (+REPORT.md). compile_kb.py's
  non-recursive `concepts.glob("*.md")` never sees subdirectories — human gate + scope gate
  untouched (compile_kb diff = zero, runs clean). Frontmatter uses ONLY existing KNOWN_FIELDS
  vocabulary with `scope: pending` + `approval: unreviewed` + atom evidence citations
  (`source_entry_ids` chains) — promotion-ready when a human moves a file out.
- Idempotent/crash-safe: candidate file names = sha256 of the sorted atom-id set (re-runs overwrite
  the same paths), temp+rename atomic writes, dry-run writes nothing, state
  (`consolidate-state.json`, `PI_DISTILLER_STATE`-relative) records lastRunTs only after success.
- Deliberate deviation from sa52 §P1b (per the stricter brief): UPDATE-default / cap-15 / heat
  counters operate on the approved tree, which must not be touched — not implemented as writes;
  documented in README.

### 2. B4 — L3 profile (src/profile.ts 469 LOC, wiring in src/index.ts)
- `/distill-profile [--dry-run]` maintains `~/.pi/agent/memory/profile.md` (`PI_PROFILE_PATH`
  override), ≤2KB hard cap enforced at generation AND defensively at injection (line-boundary
  truncation with an honest marker).
- **Source discipline**: generator reads ONLY accepted records — `daily/*.md` + concepts with
  `approval: user-approved`; unreviewed/pending concepts excluded before the generator sees them
  (negative test pins: seeded unreviewed content must not leak). Atoms are NEVER source content
  (unverified-worker-claim risk) — only the refresh TRIGGER (≥15 new preference-kind atoms since
  last refresh, or missing/>30-day-stale profile, checked at session shutdown; sa52 PersonaTrigger
  P4 port; P1/P2/P2.5/P3 collapsed to manual+threshold+stale at personal scale).
- Injection via `before_agent_start` → `event.systemPromptOptions.sections["user-profile"]`
  (mutable-sections API, pi 1.5.0 types.d.ts:739-747) — NEVER `forceSystemPrompt`. mtime-cached
  read per turn (one stat, sub-ms). `PI_PROFILE_INJECT=0` kills injection + auto-refresh; manual
  command still works.
- Regenerate-and-replace (atomic temp+rename): re-running cannot append/duplicate/grow. LLM path
  with verbatim-sentence rule fallback (B1's honest-degrade pattern).

### 3. B5 — harvest checker (tools/harvest_check.py 309 LOC + tools/test_harvest_check.py 151 LOC)
- Report-only lint: scans `.pi/subagents/` done dirs in a window (`--days`, default 1) by importing
  `restart_handoff.scan_subagents()` as a library (A3 no-drift pattern), extracts each worker's
  brief (first user message), flags workers with result ≥1000 chars and NO harvest evidence: no
  `instructions/agents/*/records/experience.md` mtime after finish, no `work/**/RECORD*` newer
  than finish or referencing the subagent id.
- Git evidence closes a false-positive mode found live: worker-authored RECORDs have mtime
  pre-finish (written during the run) but are committed by the parent after verification — one
  shared `git log --since` call maps commit-time→paths; a harvest path committed at/after
  finish−60s counts. Live proof: `platform-obs-x1` (Theme D D4/D5) flagged by mtime-only, cleared
  by git evidence (commit 418cb02). Small results skipped as bounded checks. Advisory only: zero
  writes (test asserts tree unchanged), exit 0 unless `--strict`; `--json` for tooling.

### 4. Contract + docs
- `docs/activation-contract.md`: memory-distiller row extended with the 3 new env vars
  (`PI_DISTILLER_CONSOLIDATE_IDLE`, `PI_PROFILE_PATH`, `PI_PROFILE_INJECT` — all per-call,
  no restart) + B3/B4 state-file locations; the checker itself caught a `process.env.HOME` read,
  removed in favor of `os.homedir()`.
- `extensions-src/memory-distiller/README.md`: B3/B4 sections with honest limitations;
  `knowledge-base/AGENTS.md`: pending-<date>/ candidate-draft convention (promotion is manual;
  compile_kb untouched by design).

## Verification evidence

- Developer tests: distiller 85/85 (40 B1 existing + 23 consolidate + 21 profile + loader pins for
  the new commands and `before_agent_start`), including the fail-closed "no concept ever
  auto-promotes" assertions (approved tree empty, `scope: global` never emitted). tools 123/123
  (12 harvest tests incl. the seeded missing-harvest fixture = PLAN B5 acceptance). memory-index
  35/35 unchanged. `python3 knowledge-base/scripts/compile_kb.py` lint clean, gate untouched.
- Independent loader checks: `npm run manual-load-check` — installed pi 1.5.0 loader: 0 errors,
  0 warnings; /distill + /distill-consolidate + /distill-profile registered; 4 lifecycle handlers;
  real CLI headless boot clean (temp env; no real KB/state/profile touched).
- Live behavior smoke: real-tree harvest_check run — 92 done dispatches/2d, 24 skipped as bounded
  checks, 68 harvested, 0 flagged (after the git-evidence fix). Rule-path consolidation on a
  5-atom fixture (older "use SQLite" decision vs newer "never use SQLite") produced 4
  promotion-ready candidates + REPORT.md with the contradiction surfaced and full
  atom→source_entry_ids chains, all inside pending-2026-11-13/.
- NOT live-verified: LLM paths (fixture-driven only, same as B1 — needs a real model call);
  profile injection inside a real user session (needs restart + a turn).

## Limitations (honest)

- Consolidation false-positive risk: rule clustering is lexical (over/under-groups); LLM clustering
  is better but nondeterministic. All output is draft + human-gated, so cost is review time, not
  correctness. Contradiction detection misses subtler conflicts (stated in REPORT.md itself).
- Profile injection latency: ~1 stat + cached read per run start (sub-ms); generation is an LLM
  call only at refresh boundaries. LLM wording varies between regenerations — "idempotent" means
  replace semantics (no growth/duplication), not byte-identical output; the rule path is
  deterministic.
- Harvest heuristics: mtime+git evidence can miss non-git uncommitted harvests; `[project:]`-less
  briefs weaken role metadata (report-only; a human confirms).

## Open items

- Full pi restart required (universal rule, docs/runbooks/pi-restart.md) for the extension code
  change; the distiller is still NOT installed into `~/.pi/agent/extensions` (candidates never
  self-install) — activation is a separate user decision. After restart, `/distill-consolidate
  --dry-run` and `/distill-profile --dry-run` are safe first probes.
- First real consolidation/profile refresh runs will use the rule fallback unless the session
  model is configured; watch the degrade reason in the notify line.
- knowledge-base repo commit (AGENTS.md + daily entry) ships alongside this commit.
