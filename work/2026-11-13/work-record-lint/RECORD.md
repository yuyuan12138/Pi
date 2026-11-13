# Work record — Work-record compliance linter (Theme D D3b)

- **Date**: 2026-11-13
- **Task**: Build `tools/work_record_lint.py` — mechanical §6 compliance checking for work RECORDs (PLAN.md D3b, gap G5 "work-record compliance never mechanically checked")
- **Dispatched-by**: coordinator primary conversation (background subagent brief, 2026-11-13)
- **Worker**: work-record-lint coder subagent (clean context, this record's author)
- **Brief header**: [project:PiAgents]
- **Status**: delivered

## Task brief
Build the work-record compliance linter from PLAN.md D3b: validate §6 required header
fields, status vocabulary, required body sections, `[project:...]` tag presence/consistency
with the record's directory (path-prefix map), and append-only discipline via read-only
git history (flag removed/modified content after the first commit; pure appends allowed).
Per-record pass/warn/fail with actionable reasons; exit 1 only on fail; run on the real
tree and report honest compliance; never edit historical records; unittest suites per tools/ conventions.

## Delivered
- `tools/work_record_lint.py` (new, ~450 lines) — scanner for `<root>/work/**/RECORD.md` plus `remote-agent/operations/*/work/` and `operations/*/work/` when present; modes `--all` (default), `--since YYYY-MM-DD`, `--record PATH`; knobs `--root`, `--project-tag PREFIX=TAG` (repeatable), `--no-default-tags`. Severity model: FAIL = missing required field/section, out-of-vocabulary or conflicting status, tag/directory mismatch, malformed tag, append-only violation; WARN = missing tag (incl. honest "Brief header: none" backfills), extra status prose, brief length outside 2-6 lines, >80-line budget (§8, comment blocks excluded), date/dirname mismatch, uncommitted changes. All git access read-only (`log`, `diff`, `status`, `rev-parse`).
- `tools/test_work_record_lint.py` (new, 35 tests) — fixtures: clean record, missing field(s), bad/conflicting status, `delivered-unverified`, missing tag, explicit "none" tag, tag-in-brief-section, tag mismatch, subproject tag, unmapped dir, append-only violation vs pure append vs uncommitted vs untracked, date/dirname mismatch, section prefix match, template-comment stripping, prose/`·`-separator header parsing, length budget, `--since`, scan-root coverage, CLI exit codes (0/1/2).
- `work/2026-11-13/work-record-lint/RECORD.md` (new, this file).

## Verification evidence
- Unit tests: `python3 -m unittest discover -s tools -p test_work_record_lint.py` — 35/35 pass. Full tools suite (`-p "test_*.py"`) — 65/65 pass (delegation_gate, git_guard, restart_handoff included; no regressions).
- Acceptance criterion from PLAN.md D3b ("linter flags a nonconforming fixture RECORD") met by `HeaderFieldTests.test_missing_required_field_fails`, `StatusVocabularyTests.test_bad_status_fails`, `TagTests.test_tag_directory_mismatch_fails`, `GitAppendOnlyTests.test_append_only_violation_fails`.
- Real-tree run (`python3 tools/work_record_lint.py`, exit 1): 5 records — 0 pass, 4 warn, 1 fail. FAIL: `work/2026-11-13/dispatch-chain-project-tag/RECORD.md` (missing Task + Dispatched-by header fields; missing all four required body sections — uses `## Changes`/`## Evidence` headings instead; extra status prose "delivered, all suites green"; no brief-header tag). WARNs: three 2026-11-11 sword-episode records lack a `[project:...]` tag (expected `minecraft`); graph-schema-backfill brief 9 lines + 82 content lines over budget; postmortems-index-retrofit brief 7 lines; closedloop backfill honestly declares "Brief header: none". Full compliance rate: 0/5 fully clean; 4/5 fail-free.
- This record itself was linted: pre-commit run correctly WARNed "uncommitted changes"; post-commit run (final verification) PASSES with zero findings, exercising the linter against its own deliverable.
- Append-only check verified live against real git history (sword-episode records in the nested remote-agent repo, single-commit files → no violation; dispatch-chain RECORD single commit → no violation).

## Open items
- The dispatch-chain RECORD (2026-11-13) fails lint: per append-only discipline it must NOT be edited; remediation is a follow-up record or an ADR-level decision on whether pre-standard header styles are grandfathered (user/primary decision).
- 0/5 fully-clean compliance reflects missing `[project:...]` tags in 4 records; future records should cite the tag per §6; linter's built-in tag map currently covers only `work/`→PiAgents and the sword-episode→minecraft; extend `DEFAULT_PROJECT_TAG_MAP` (or pass `--project-tag`) as new project spaces adopt work/ dirs.
- D3b larger enforcement (e.g. wiring the linter into git_guard pre-commit or coordinator guard) is future work outside this dispatch's scope.
