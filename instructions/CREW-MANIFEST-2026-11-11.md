# CREW MANIFEST — 2026-11-11 (retrospective)

Per user request ("the sa's have no names — organize them into profiles"). Evidence:
`.pi/subagents/sa*/events.jsonl` user messages timestamped 2026-11-11 (~29 task
assignments across 26 sessions; ids were REUSED across the day for different tasks —
disambiguated by task tokens, not id). Taxonomy: 13 profiles (`instructions/agents/`)
→ numbered individuals (`ROSTER.md`: coder-1, operator-1, reviewer-1) → instances
`role-<name>[.<spec>]@<project>[.<subproject>]` (AGENT-ORG §5.1).

## The day's crew

| dispatch(es) | task one-liner | profile.spec | individual-or-new | project |
|---|---|---|---|---|
| sa13, sa14 02:30 | closed-loop RSI driver defect fixes + A/B arm runner fix (wave_loop.py) | coder.infra | **coder-1** (seeded) | minecraft.rsi |
| sa15 11:09 | read-only monitor, closed-loop RSI run c046+ (PID 77588) | operator.monitoring | **operator-1** (seeded) | minecraft.rsi |
| sa2 15:36 | FIRST SAMPLE project space (minecraft ops dir) | writer | new → seed writer-1 | minecraft |
| sa4–sa9 15:43 | project spaces ×6 (medical, info-router, vpn-ops, blog, notion-ops, nvim) | writer | new → seed writer-1 | 6 projects |
| sa10 15:43 | retrofit minecraft sample space to standard compliance | writer | new → seed writer-1 | minecraft |
| sa11 15:47 | blog docs gap-fills (/piagents/ page into index+archives) | writer | generic | blog |
| sa3 15:41 | canonical PROJECT-SPACE-STANDARD.md | writer | generic | PiAgents-org |
| sa19 16:11 | "Dispatch Authority" sections on the 9 original role cards | writer | generic | PiAgents-org |
| sa3 16:40 | this crew manifest | writer | generic | PiAgents-org |
| sa12 15:50 | design AGENT-ORG.md v1.0 (org structure + diagram) | designer.org | new → seed designer-1 | PiAgents-org |
| sa14 15:52 | AGENT-ORG rev: decomposition protocol + up-check loop | designer.org | new → seed designer-1 | PiAgents-org |
| sa15 15:55 | AGENT-ORG rev: three-tier layered memory | designer.org | new → seed designer-1 | PiAgents-org |
| sa17 15:58 | AGENT-ORG rev: layers not predefined + async/concurrent same-role | designer.org | new → seed designer-1 | PiAgents-org |
| sa18 16:04 | roster 9→13 profiles + spec/seniority system | designer.org | new → seed designer-1 | PiAgents-org |
| sa20 16:12 | subprojects design + machine-readable graph as source of truth | designer.org | new → seed designer-1 | PiAgents-org |
| sa21 16:19 | numbered individuals → ROSTER.md | designer.org | new → seed designer-1 | PiAgents-org |
| sa16 15:08 | Projects panel in mission-control UI (coordinator.db, read-only) | coder.frontend | new → seed coder-2 | PiAgents.bridge |
| sa16 15:56 | live #/org graph page (+3 feedback rounds to 16:10) | coder.frontend | new → seed coder-2 | PiAgents.bridge |
| sa1 16:25 | #/org whole-tree visibility + project hierarchy nodes | coder.frontend | new → seed coder-2 | PiAgents.bridge |
| sa2 16:34 | #/org round 4: vertical layout + collapse | coder.frontend | new → seed coder-2 | PiAgents.bridge |
| sa13-a/b/c 15:50 | BoN ×3: remove pi-superagent recursive-spawn depth cap | coder (BoN candidates) | generic ×3 | PiAgents.harness |
| sa1 15:27 | Notion vault icons + pages (dashboards scope-cut 15:33) | operator | generic | notion-ops |

## Naming gaps — what compliant instance ids WOULD have been

- sa13/sa14 → `role-coder-1.infra@minecraft.rsi`; sa15 monitor → `role-operator-1.episodes@minecraft.rsi` (seeded individuals, spec-composed).
- Scaffolding wave → today generic `role-writer@<project>`; after writer-1 seed: `role-writer-1@minecraft`, `role-writer-1@blog`, … (one individual, per-project instances).
- Org wave (sa12/14b/15b/17/18/20/21) → `role-designer@PiAgents-org` (dot-form `role-designer@PiAgents.org` equally valid); after designer-1 seed: `role-designer-1@PiAgents-org`.
- sa16's two graph tasks → per routing intent `role-designer@PiAgents-org` with persistent session **bridge-org-x1** (feedback rounds accumulate in one place); as-implemented they were coder briefs → `role-coder-2.frontend@PiAgents.bridge`.
- sa13-a/b/c BoN trio → `role-coder@PiAgents.harness` ×3, or deliberately `role-coder-1` + `role-coder-2` + generic (ROSTER BoN diversity rule).
- sa1's Notion work → `role-operator@notion-ops` (not operator-1 — different domain, single dispatch).

**Adoption note:** from the next dispatch, pass `session: "role-<individual>@<project>[.<subproject>]"`
(spec segment when the brief names one) so subagent dirs, work records and the #/org
graph show real names natively. The router derives the full id mechanically (ROSTER.md);
the session itself becomes the individual's tier-1a memory carrier (AGENT-ORG §6).

## Proposed new individual seeds (Task B — propose only, ROSTER.md untouched)

All three clear the ≥3-dispatch hiring rule from today alone:

```
writer-1   {spec: project-spaces, level: mid,
            notes: 8 dispatches today — 7 PROJECT-SPACE-STANDARD builds + 1 retrofit,
            identical brief shape; candidate memory: templates, per-project deviations;
            memory: agents/writer/records/writer-1.md}
designer-1 {spec: org-architecture, level: senior,
            notes: 7 dispatches today iterating AGENT-ORG.md/ROSTER/profile roster —
            org design, memory tiers, subprojects, graph normalization;
            memory: agents/designer/records/designer-1.md}
coder-2    {spec: frontend, level: mid,
            notes: 4 dispatches today on pi-web-bridge #/org + Projects panel
            (precedent 2026-11-09); complements coder-1 (infra);
            memory: agents/coder/records/coder-2.md}
```
