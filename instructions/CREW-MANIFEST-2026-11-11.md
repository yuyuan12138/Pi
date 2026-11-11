# CREW MANIFEST — 2026-11-11 (retrospective)

> Same-day addendum: after this manifest was written, the user approved 5 more profiles
> (product-manager, evaluator, memory-curator, curriculum-designer, prompt-engineer) —
> the roster is now 18 (AGENT-ORG.md §4). Event rows below are history, not the current roster.

Per user request ("the sa's have no names — organize them into profiles"). Evidence:
`.pi/subagents/sa*/events.jsonl` user messages timestamped 2026-11-11 (~29 task
assignments across 26 sessions; ids were REUSED across the day for different tasks —
disambiguated by task tokens, not id). Taxonomy: expertise profiles (`instructions/agents/`)
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

## 2026-11-11 backfill attribution

Retroactive project/role/name mapping for the #/org page (commit e78ed24 follow-up).
Evidence sources: each session's first user task message (`.pi/subagents/<id>/events.jsonl`),
the coordinator journal (projectId envelopes only — no dispatch links), KB daily notes
(`knowledge-base/daily/`), and the registry aliases served by `GET /projects`. The page
embeds these rows (`ORG_CREW_DISPATCH_PROJECTS` / `ORG_CREW_NAME_SNAPSHOT` in
`packages/pi-web-bridge/src/index.html`) with token gates, so a reused id never inherits
yesterday's project. Rendered labels are English-only (`ORG_CJK_GLOSSARY`); token gates
stay bilingual for matching Chinese source text.

| dispatch(es) | project | crew name / role | evidence |
|---|---|---|---|
| sa9 | PiAgents.harness | feishu mcp | task: 给 Pi 接飞书 MCP server，配凭证测通 (events.jsonl) |
| sa12 | PiAgents.harness | feishu mcp | task: 飞书应用 scope 开通后各域 API 验证 |
| sa13 | PiAgents.harness | feishu mcp | task: 飞书通讯录找 open_id + 发测试消息 |
| sa14 | PiAgents.harness | feishu mcp | task: 事件日志/P2P 会话捞 open_id 并回复 |
| sa15 | PiAgents.harness | feishu mcp | task: 证明 Pi 能读王若钧的飞书文档 |
| sa17 | PiAgents.harness | feishu mcp | task: 文档共享，加可编辑协作者 |
| sa18 | PiAgents.harness | feishu mcp | task: 共享后打不开（页面不存在）排查 |
| sa10 | PiAgents.harness | — | task: 安装 cloudflare/security-audit-skill 到 Pi |
| sa8-a/b/c | PiAgents.bridge | — | task: org-graph standalone HTML mockup BoN（label 内嵌 fixture 数据点名各项目 → 仅 work-type token 可归因） |
| sa20 | PiAgents-org | — | task: 专门写文档的 subagent 角色，偏好固化进 skill（role-card wave） |
| sa84 | PiAgents-org | — | task: Rewrite PiAgents README（与 sa88 同一 docs wave, 11-09） |
| sa88 | PiAgents-org | — | task: README polish + docs-site，让 Pi agent setup 可被他人采用 |
| sa29, sa33, sa37 | PiAgents.harness | — | capability installs: whisper.cpp / yt-dlp / video-editing skill (11-06/07) |
| sa38, sa39, sa40, sa40-sa1, sa41 | PiAgents.harness | vlog toolchain bring-up | /tmp/vlog-edit-test workspace + vlog-auto-edit skill 首测 (11-07) |
| sa53, sa54, sa55 | PiAgents.harness | memory-index | task: "Implement P0 of the Pi memory-index design" BoN ×3 (11-07) |
| sa85 | PiAgents.harness | — | task: Terminal-Bench v2 feasibility recon vs 本地 agent stack (11-09) |
| crew sa23+sa24 | minecraft | rsi episode monitor | labels: 只读监控 MC RSI episode（11-09，manifest 的 operator.monitoring 同族） |
| crew sa9–sa18 wave | PiAgents.harness | feishu mcp ·×N | 11-11 harness day-crew 多数成员属 feishu MCP 能力接入 |
| crew sa16+sa19+sa21 | PiAgents-org (PRIMARY-DELIVERABLE rule) | weekly report docx | 产出物 = 组会汇报 docx（面向用户的组织例会文档）；文本提及的 MC/医疗平台只是内容素材。规则变更：对有明确产出物的 dispatch，按产出物归属，优先于 ≥2 提及的跨项目规则 |
| sa80, sa82 | blog (PRIMARY-DELIVERABLE rule) | — | 产出物 = Pi-agent 博客草稿（/tmp/pi-blog-draft/）；minecraft 只是博文中提到的素材 |
| sa56, sa90 | personal-ops (muted pseudo-project) | — | 产出物 = 个人 LoL 集锦视频 / 个人微信账单→WPS 台账核对；不属于任何已注册项目 → 渲染级命名桶 "personal-ops"（unregistered personal operations） |
| crew sa22+sa78 | minecraft (各自的 primary deliverable) | minecraft ops | sa22 = MC 随机世界重生成；sa78 = closed-loop RSI engine（remote-agent/operations/20261029-minimal-sword-episode/closed_loop.py）— 均为 minecraft ops 工作 |

Unattributed bucket: DISSOLVED (2026-11-11, primary-deliverable rule). Every former
member now has a documented home (rows above); the bucket mechanism remains in the
code for genuinely unknown future dispatches but renders nothing while empty.
- **sa80, sa82 → blog** — primary deliverable is the blog post; mentioned projects are content.
- **sa16, sa19, sa21 → PiAgents-org** — primary deliverable is the weekly-meeting report docx.
- **sa56, sa90 → personal-ops** — genuinely personal work, no registered project fits.
- **crew sa22+sa78 → minecraft** — each dispatch's own deliverable (world regen / closed-loop engine);
  the shared-day crew is named "minecraft ops" instead of the unnamed floor.

## 2026-11-11 dedupe pass (era split + duplicate merge — view-level, rows above unchanged)

Observation: numeric sa dirs were REUSED across conversations — one dir can hold
many unrelated task eras (sa1: 6 eras 11-03..11-11; sa2: 6; sa27: 2). The manifest
rows above describe ONE era per dispatch id; the #/org invocation tree now splits
reused dirs into per-era dispatch nodes (`sa27 · era 1/2`), each labeled/attributed
from its own first task message (eras = user-message clusters split at >6h gaps,
state.ts `extractEras`). Manifest rows therefore name the era they describe; where
a row's id has several eras, the row matches the era whose task text it quotes.

True re-dispatches (same session id, or same dominant task tokens within ±6h —
e.g. the BoN trios sa13-a/b/c, sa8-a/b/c, the 11-11 project-space scaffolding
wave) merge into one node with a `·×N` counter in the tree view; the per-dir rows
above stay the record of each physical dispatch.
