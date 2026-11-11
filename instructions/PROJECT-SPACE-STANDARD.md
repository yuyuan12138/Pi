# Project-Space Documentation Standard

Version 1.0 (2026-11-11). Owner: coordinator conversation. Applies to every
project space in the agent workspace. Adapted from industry canon — OSS
READMEs, Google design docs, MADR-style ADRs, SRE runbooks and blameless
postmortems — sized for a solo user + AI-agent workflow: a doc earns its keep
only if it is read, written, or verified during real dispatches.

## Principles

1. **Docs describe; live files own.** The docs layer never edits engine or
   runtime state; it explains it, with citations (sample README "Conventions").
2. **No invented facts.** Every number/claim cites a source file or commit id;
   claims that cannot be verified are marked "unverified", never guessed.
3. **Write at decision time.** Docs are updated in the same dispatch that
   changes the system — not retrospectively.
4. **Short or it rots.** Length budgets in §8 are hard. A doc nobody rereads
   is a liability.
5. **Retrofit = index-in-place.** Existing projects adopt this layout add-only:
   INDEX files reference pre-existing files by relative path; nothing is moved
   or rewritten (pattern: sample `docs/runbooks/INDEX.md`).

## Layout (target)

```
<project-root>/
├── README.md                  # §1  charter + status + directory map
├── docs/
│   ├── architecture.md        # §2  design doc
│   ├── decisions.md           # §3  ADR log
│   ├── runbooks/              # §4  runbooks + INDEX.md
│   └── postmortems/           # §5  incident autopsies
└── work/                      # §6  one record dir per dispatched task
```

## 1. README.md — charter, status, directory map

**Model**: a good OSS README. **Purpose**: a new worker (human or agent)
becomes useful after one read.
**When**: written at project registration; the status section is refreshed at
every accepted milestone (§7); the map is updated when top-level structure
changes.
**Required sections**: What this is (2–4 lines) · Current status (table, §7) ·
How it works (2–3 lines + link to architecture) · Map of this directory (one
line per top-level path) · Conventions (5–8 bullets: git rules, record paths,
verification rule, docs/live boundary).
**Length**: ≤150 lines.
**Mini-example** (sample README, status table — State is verifiable against the
cited Source):

| Furnace goal | ACHIEVED. First fully collector-green success in wave-17, run `20261105T213411Z-35d359bd` (73 requests, ~17.5 min) | `OPERATOR-RECORD-wave17-round8-20261105T213411Z-35d359bd.md` |

Map row pattern (sample README):

| `closed_loop.py` | Closed-loop RSI engine: SENSE→PROPOSE→FILTER→EXPERIMENT→GATE→APPLY→CURRICULUM→LOOP |

Template: `templates/README.template.md`.

## 2. docs/architecture.md — the design doc

**Model**: Google design docs / RFCs.
**Purpose**: how the system works and why this design; the doc coder briefs
link to instead of re-explaining.
**When**: drafted before the first building dispatch of a new subsystem;
updated in the same dispatch that changes the design. Superseded sections are
edited in place with a date; if the old "why" matters, it moves to an ADR.
**Required sections**: 1 Context · 2 Goals / Non-goals (non-goals explicit) ·
3 Design overview (one layered table or diagram) · 4 Detailed design (per
component; `file:line` citations for load-bearing claims) · 5 Alternatives
considered (≥1 per major choice, with why rejected) · 6 Cross-cutting concerns
(safety, evidence/trust, failure modes) · 7 Open limitations (from records,
not speculation).
**Length**: ≤250 lines; link to ADRs instead of re-arguing decisions.
**Mini-example** (sample architecture.md §2 — every row cites its source):

| `prepare_artifact.py` | Stages ~33 source files into `artifact-<run_id>/`, hashes each, derives `source_sha256` | `prepare_artifact.py:28-47` |

Open-limitation pattern (sample §7): "JVM umask 002 world files during
episodes — neutralized post-stop by the wave-12b chmod-portability fix; earlier
runs show the failure mode (`OPERATOR-RECORD-wave12` root-cause part)."
Template: `templates/architecture.template.md`.

## 3. docs/decisions.md — ADR log

**Model**: MADR (context → decision → consequences), compressed.
**Purpose**: the permanent record of WHY; stops re-litigating settled
questions.
**When**: appended at every accepted decision — user ruling, design choice, or
rejected experiment. Append-only; entries are never edited after being
written; newest at the bottom.
**Required per entry**: `ADR-NNN — title`; Date; Sources (file/commit
pointers); Context (2–3 lines); Decision (2–4 lines); Consequence (1–3 lines).
Rejected experiments include their outcome (sample ADR-007: Turn-BoN
"prediction falsified as run"; never deleted — supersede with a new entry).
**Length**: ≤10 lines per entry; one log file per project.
**Mini-example** (sample ADR-004, compressed):

> **ADR-004 — Water removed from the hazard system (user ruling)** · 2026-11-08
> Sources: commit `08b6e07`; `OPERATOR-RECORD-wave31` (the `hazard_support(water)` self-quit that motivated it); `OPERATOR-RECORD-wave32` (validation).
> Context: wave-31 died when the safety monitor read a water block under the bot's feet — a fatal false-positive class.
> Decision: water is ordinary terrain; removed from safety_monitor HAZARDS.
> Consequence: wave-32 ran end-to-end with zero safety trips.

Template: `templates/decisions.template.md`.

## 4. docs/runbooks/ — operational runbooks + INDEX

**Model**: SRE workbooks.
**Purpose**: a repeatable operation any operator subagent can execute from the
file alone, surviving worker turnover.
**When**: an operation has run successfully twice manually → promote the third
run's notes into a runbook. Update on every failure the runbook did not cover.
**Required sections**: What this automates + authorization basis ·
Preconditions (budgets, permissions, fresh run_id) · Procedure (numbered,
copy-pasteable; success criterion per step; revert point recorded BEFORE risky
steps) · Verification (what success looks like + evidence to keep) · Failure
paths (symptom → diagnosis → remediation table) · Escalation (what must be
handed back to a human: unknown outcomes, replay decisions).
**Length**: ≤120 lines each. `docs/runbooks/INDEX.md` is a one-line-per-file
finding aid and may reference files anywhere in the project (nothing moves).
**Mini-examples** (both real, indexed in the sample's INDEX.md):
`COLD-PIPELINE-RUNBOOK.md` — numbered automatic steps, explicit PASS/FAIL gate,
one-command revert (`git revert <exact commit>` recorded before the A/B);
failure-path example: `OPERATOR-RECORD-furnace-reset-20261105.md` — world
perms (umask 002) + empty-stats baseline diagnosis → fixes.
Template: `templates/runbook.template.md`.

## 5. docs/postmortems/ — blameless incident autopsies

**Model**: blameless postmortems (Google SRE).
**Purpose**: an incident's evidence, mechanism, and permanent fixes in one
file, so the same failure class is never rediscovered.
**When**: every incident that cost a run, corrupted evidence, or tripped a
safety/breaker mechanism. Written by the incident's operator/closer; linked
from the work record.
**Required sections**: Header (incident id, date, run ids, analyst, evidence
paths) · Impact (numbers) · Timeline (UTC, from logs — not memory) · Root
cause (mechanism, proven with evidence; isolate/reproduce if possible) · What
went well / poorly (mechanisms only) · Action items (each lands in an ADR,
runbook, code commit, or KB daily) · Cross-project lessons.
**Length**: ≤150 lines. Blameless means mechanisms, never workers ("the
receipt reported ok while server stats credited nothing" — not "the model
lied").
**Mini-example** (sample `AUTOPSY-wave30-ea211db1.md`): root cause proven by
region-file diff + isolated repro on a throwaway server — the wooden pickaxe
broke between req ~105 and 130; from req 130 all stone digging was bare-hand;
vanilla 1.21.6 removes the block but awards no stat and no drop — 335 requests
(72% of the run) for zero yield, while digMany receipts reported `status:"ok"`.
Action-item pattern: `AUTOPSY-h7-infra-two-strikes-20261109T090128Z.md` →
two-strikes infra breaker (two identical death signatures → STOP, human
handoff). Transferable lessons go to `knowledge-base/daily/` (2026-11-08
container triage; 2026-11-09 physics-stall infra class).
Template: `templates/postmortem.template.md`.

## 6. work/ — dispatch records

**Model**: the sample's existing RECORD.md template, formalized.
**Purpose**: one append-only record per dispatched task: what was asked, what
was delivered, what verifies it, what is open.
**When**: every dispatch (docs, code, ops). Written by the worker; linked from
the README status table when the task changes status.
**Required header fields**: Date · Task · Dispatched-by · Worker · Status
(`delivered | delivered-unverified | blocked | failed`).
**Required body sections**: Task brief (2–6 lines) · Delivered (exact file
list) · Verification evidence (commands run, checks passed, sources
cross-checked; "unverified" is an acceptable per-item value) · Open items.
**Rules**: append-only history — never edit a delivered record's body;
follow-ups are new records or new Open items. Every number must be verifiable
against a cited source.
**Mini-example**: `work/2026-11-11-project-space-sample/RECORD.md` — its
verification section records a correction ("the task brief's upper bound '~57'
was NOT matched to a source; docs say 24–51 (verified range)") — that honesty
bar is the minimum for all records.
Template: `templates/work-record.template.md`.

## 7. Status convention — README section (chosen over STATUS.md)

**Decision**: project status lives in a README table section, refreshed at
every accepted milestone. No separate STATUS.md.

Why: (a) the sample README already established the format and it survived
verification; (b) one entry file, zero duplicate state — a separate STATUS.md
forks from the README within weeks (the project's point-in-time snapshots
`CURRENT.md` / `VISION-STATUS.md` rotted exactly this way and are now frozen
history per the sample's open items); (c) OSS READMEs carry status badges for
the same reason.

Format: `## Current status (as of <YYYY-MM-DD UTC>)` — a ≤10-row table
`| Item | State | Source |`, one row per load-bearing fact; every State cell
verifiable against its cited Source. Deep point-in-time snapshots, if ever
needed, are frozen into `work/` records — never into README.

## 8. Length discipline

| Doc | Budget | Update trigger |
|---|---|---|
| README | ≤150 lines | status: each accepted milestone; map: structural change |
| architecture.md | ≤250 lines | same dispatch that changes the design |
| decisions.md | ≤10 lines/entry | every accepted decision (append-only) |
| runbook | ≤120 lines | every operation failure it didn't cover |
| postmortem | ≤150 lines | every qualifying incident |
| work RECORD | ≤80 lines | every dispatch |

## Deliberately dropped from the industry canon

- RFC comment periods, RFC numbers, assigned reviewers — a solo user decides
  in one turn; the ADR log + git history carry the traceability instead.
- RACI matrices and sign-off approvals — no org; `Dispatched-by`/`Worker`
  fields in work records cover accountability.
- OKRs and quarterly planning docs — goals live in the charter and the
  project's own goal mechanism; ceremony without verification.
- CONTRIBUTING.md / CODE_OF_CONDUCT.md / LICENSE — private single-user workspace.
- Meeting minutes — no meetings; decisions are captured as ADRs at decision time.
- Formal SLO/error-budget machinery — kept as a metrics trend row in the status
  table; SRE ceremony without a pager is overhead.

## 9. ROUTING RULE (how the coordinator applies this)

1. **Instruction arrives** → identify the project via the coordinator registry
   (canonical root; never guess between plausible projects).
2. **Ensure the skeleton exists** (once per project): create `README.md`,
   `docs/{architecture.md,decisions.md,runbooks/INDEX.md,postmortems/}`,
   `work/` from `templates/`, stubs marked "draft: retrofit". For existing
   project dirs, retrofit add-only (Principle 5).
3. **Dispatch**: every implementation/ops brief names its deliverables as
   **code commits + doc updates** (which doc, which section). Workers read the
   project README and relevant runbook before touching anything; docs work
   never edits live files (Principle 1).
4. **Acceptance**: a dispatch is accepted only when the diff contains both the
   working change AND its doc updates — status row refresh, ADR if a decision
   was made, runbook/postmortem if an operation or incident occurred, work
   record always.
5. **Periodic status**: at each accepted milestone the primary (or closing
   worker) refreshes the README status table (§7). No separate status ceremony.

Reference implementation: `remote-agent/operations/20261029-minimal-sword-episode/`
(see `work/2026-11-11-project-space-sample/RECORD.md`).
