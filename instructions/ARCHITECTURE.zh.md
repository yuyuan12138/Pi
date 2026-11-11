# ARCHITECTURE — 当前 agent 架构总览（中文版）

> 中文版，快照 2026-11-11。读者：系统所有者。**英文原版 `ARCHITECTURE.md`（当前 HEAD）是权威版本**，
> 本文件是其当前状态的中文改写——适配表达，而非逐句翻译。这只是概览投影，不是权威来源；活源拥有真相：
> `AGENT-ORG.md` v1.4（宪法）、`ROSTER.md`、`GRAPH-SCHEMA.md` v1.1、`PROJECT-SPACE-STANDARD.md`、
> `packages/pi-superagent`、`packages/pi-web-bridge`、`knowledge-base/AGENTS.md`、
> `packages/pi-delegation-reminder`。凡无法在磁盘上验证的陈述，均标注**仅观测**（observed-only）
> 或**推迟**（deferred）。

## 1. 核心论题

只存在**一种 agent 类型**。每个节点——coordinator 入口与每个被 spawn 的 worker 无一例外——运行同一条
第一性规则（AGENT-ORG §2）：先复述目标，然后 **decompose-or-execute**。十三个 expertise profile
（skills + 标准 + 工具 allowlist——只是能力，从来不是权限）与带编号的 individual（携带记忆的"人"）
可附着在任意节点；组织图不是一种结构，而是某一次需求递归恰好呈现出的形状。深度由各节点自行判定，
唯一的硬边界是每 agent 的 spawn 预算。能力**通过记忆产生复利**：可续会话、append-only 的经验账本、
scope 门控的知识库，让每一次验证过的 dispatch 都使下一次更便宜。

## 2. 层次

```
用户（USER）—— 需求 · 最终验收 · hiring gate · 预算所有者
   ▼
coordinator（固定入口）—— 复述 · 分解 · 定预算 · 对照文件系统验证 · UP-CHECK 退回 · 升级上报
   ├─ 本项目内：subagent_spawn → instance
   │            role-<ind>[.<spec>]@<project>（可续会话，可继续 spawn 子节点）
   └─ 项目流水线：pi-project-coordinator → project primary
        （同一套节点规则，项目 CWD；交付物落入项目空间——仅限已注册根目录）
              ▼ 两者按同一规则继续向下 spawn（深度逐节点判定，受预算约束）
worker 节点 —— 一次性新会话或可续子会话；任何节点都可 spawn，直至其
PI_SPAWN_BUDGET（默认 3；fanout 计 N）耗尽。worker engagement 的关闭必须包含记忆收割（§6）。
```

跨项目调用形态：**project → agent → project → agent → …**——在项目 A 工作的 agent 可以 spawn 一个
CWD 为项目 B 的子节点（取 repo 事实、调用同级工具），子节点向上汇报，链条回到 A 继续。让链条跨跳
成立的有两样东西：(1) **lineage 记录**——manager 传递 `PI_SPAWN_DEPTH` 与 spawned-by 链；id 与深度
落在 `.pi/subagents/<id>/`、work RECORD 和 bridge 的调用树里；(2) **收割的记忆**——验证过的教训
进入 profile/individual 账本，下一次 engagement 自动继承。

## 3. 身份

| 层 | id 约定 | 是什么 | 复用语义 |
|---|---|---|---|
| profile | 13 个名字（`coder`、`scout`、`reviewer`、…） | 岗位说明书：role card + `skills/<spec>.md` 存根 + dispatch 权限节 | 只定义 skills 与标准，从不授予权限；每次 dispatch 都被引用 |
| individual | `<profile>-<n>`（已播种：`coder-1`、`operator-1`、`reviewer-1`） | 一个"人"：spec 组合 + 级别 + 个人记忆文件（`records/<id>.md`） | 持久存在；记忆复利；只能经 hiring gate 创建 |
| instance | `role-<ind>[.<spec>]@<project>[.<sub>…]` | 某 individual 在某项目上的一次 engagement——一个可续会话（`subagent_spawn` 的 `session` 参数） | 按需 spawn，汇报后即空闲，从不常驻；同一 id 同时只承载一个活动任务；同角色不同项目 = 不同 instance；同项目并发 = `-2`、`-3` 后缀 |
| worker | 全新会话，无 session id | 任何节点 spawn 的一次性子节点；从不续用、不复活 | 其价值在验证完成后收割进账本（§6） |

两点澄清（与 AGENT-ORG §5.1、ROSTER.md 一致）：individual 是**编号身份**，不是 specialization 路径
（后者曾于 2026-11-11 短暂引入，同日被用户撤销）；instance id 中的 spec 段**可选**，仅当 brief 指名
specialization 时出现。router 按机械规则推导所有 id（profile × individual roster × project × 在飞
任务集合）——从不把它变成向用户的提问。

## 4. dispatch 协议

- **分解判定（§2）在每个节点执行**：子目标可独立验证、文件所有权两两不相交、且预算上划算 → 分解；
  否则自己执行。无法复述目标的节点必须升级（`blocked` + 一个具体问题）。
- **acceptance-first brief**：第一行是身份头 `[project:<name>[.<subproject>]]`，由子节点原样回显；
  边界与验收标准在 dispatch 前固定，对所有 best-of-N 候选完全相同，绝不放宽。
- **UP-CHECK 环绕每一条边**：子节点带证据自检 → 向上汇报 → 父节点对照真实证据复核（跑测试、查
  diff）→ 通过则向上一层合并；失败则**带书面诊断**退回；优先用 `subagent_message` 拨动在飞的
  子节点，而不是重新 spawn。
- **两击规则**：同一标准上连续 2 轮返工失败后停止，带着证据包升级到人。
- **默认异步**：每次 dispatch 都是后台执行；任何节点都不为等待链条占住自己的回合；负责合并的节点
  恰好返回一条 `ready` 报告——结论、交付物路径、证据表（子节点 → 结果 → 路径，transcript 只按
  路径引用）。

## 5. 治理

- **hiring gate**：新增 profile/individual 需用户批准；播种以证据为准（ROSTER：≥3 次重复 dispatch
  需要同一种 spec 组合；没有验证结果支撑的 individual 只是一个名字）。
- **权限永远向上回收**：各节点在验收、范围、预算、授权上只有建议权；coordinator 对照文件系统验证；
  用户最终拍板。
- **被否决 / 已回滚的先例**（留在磁盘上作为历史，从不删除）：
  - 固定分层组织设计——AGENT-ORG v1.0/v1.1 曾按层级分配 dispatch 权，后回滚为逐节点分解判定
    （§7 反模式 5）。
  - subproject 节点类别——GRAPH-SCHEMA v1.0 曾有独立的 `subproject` 节点；v1.1 废除：嵌套项目就是
    普通 project，递归通过 `child_of` 表达。
  - 时间点状态文件——`CURRENT.md`/`VISION-STATUS.md` 相对 README 腐化；状态现在只活在 README
    表格中（PROJECT-SPACE-STANDARD §7）。
- **任何东西都不得修改的不变量**：docs 层从不编辑引擎/运行时状态；work RECORD 与 ADR 日志
  append-only；验收标准绝不为了通过而放宽；记忆 scope 门 fail-closed；`graph.json` 只在记录时刻更新。

## 6. 记忆架构

三层，刻意分开（AGENT-ORG §6）：

| 层 | 范围 | 位置 | 写入者 |
|---|---|---|---|
| 1a — 会话 | 单个 instance | 可续的 `role-…` 会话 | agent 自己（易逝；随退休消亡） |
| 1b — role/individual 账本 | 单个 profile 或 individual | `instructions/agents/<role>/records/[<id>.]md`——按日期、append-only、只收验证结果、入 git | coordinator 入口在文件系统验证后追加；各节点只能提议 |
| 2 — 项目 | 单个项目根 | 项目空间本身（README、ADR、runbook、postmortem、`work/`）+ 私有的 coordinator registry/journal | 执行节点写 RECORD；project primary 维护 docs |
| 3 — 全局 | 所有项目 | `knowledge-base/`（`daily/`、`knowledge/concepts/`、`wiki/`） | primary 追加 `daily/`；概念提升受门控（见下） |

- **污染控制**：项目 A 的教训不会出现在项目 B，除非通过 KB scope 门——`scope: global` 需要
  **≥2 个不同项目**的证据 **且** `approval: user-approved`，由 `knowledge-base/scripts/compile_kb.py`
  强制 fail-closed（失败退出码 1；在 AGENTS.md 与脚本中均已核实）。
- **情景 vs 程序**：`records/experience.md` 是情景账本（发生了什么，带证据链接，按日期）；
  `skills/<spec>.md` 是蒸馏出的程序（怎么做，面向未来），随验证教训的重复而积累。当前多数 profile
  仍是存根级 spec 文件；完整蒸馏是持续进行的实践。
- **收割义务**：关闭一个 worker engagement 而不把可迁移教训追加进账本，等于 UP-CHECK 没有闭合——
  记忆收割是强制的。
- 跨会话 FTS 检索（`memory_search`，"pi-memory-index"）：AGENT-ORG §6 有引用，但 **`packages/` 下
  并不存在**——仅观测；已验证的 FTS5 层是可选的 `knowledge-base/scripts/kb.py`，检索蒸馏后的记忆。

## 7. 项目空间

标准布局（PROJECT-SPACE-STANDARD）：`README.md`（章程 + 状态表 + 目录地图 + Crew）· `graph.json`
（规范结构）· `docs/`（architecture、ADR 日志、runbook、postmortem）· `work/`（每次 dispatch 一份
append-only RECORD）。原则：docs 描述，活文件拥有事实；不发明事实（每条陈述注明来源）；改变系统的
dispatch 必须在同一回合里更新 docs；硬性行数预算；retrofit 只增不删。dispatch 验收要求 diff 同时
携带工作变更**和**对应的 doc 更新。

**嵌套项目**：一个需要独立 ADR 或要跨越多个会话的分支可以"毕业"（每次毕业一个用户决定）——一份
≤30 行、带 Crew 节的章程；id 延伸为 `role-<ind>@<project>.<sub>`；归档时把教训向上合并并标记
`done`；什么都不删除（git 历史就是审计轨迹）。`child_of` 包含关系构成任意深度的树：单一父节点、无环。

## 8. 可观测性

- **组织图调用树**（`pi-web-bridge`）：project 节点与 agent 节点按**真实 spawn lineage** 交替——
  每条边都是一次调用；另有聚合的组织图视图可选。归因通过 registry 与 token 规则把 session 映射到
  项目；无法归因的进入显式的 `unattributed` 桶（从不悄悄猜）；`personal-ops` 是静音桶，收纳不属于
  任何已注册项目的真实交付物（在 `src/index.html` 中核实）。
- **coordinator journal / `/projects` 面板**（`pi-web-bridge/src/projects.ts`）：对 `coordinator.db`
  （registry + append-only journal）的只读视图；每个任务信封的 `projectId` 完成归因；单项目活动 =
  最新一行 journal；任何读取失败都降级为空列表 + 说明（UI 绝不能弄崩会话）。
- **每项目的 `graph.json`**：持久、git 版本化的结构（§3、§7），其证据指针可导航到章程、记录、
  transcript。图的 web 消费端**推迟到 v2**；今天 journal 是活层，graph 是持久层。各用一句话：
  调用树回答"现在实际是谁、在哪个项目下、跑了什么"；journal 回答"每个已注册项目当前什么状态"；
  `graph.json` 回答"持久结构是什么、证据在哪里"。

## 9. 有意的限制

- **唯一的失控边界是预算**：嵌套深度故意不设上限——`PI_SPAWN_DEPTH` 只承担 lineage/可观测性；
  `PI_SPAWN_BUDGET`（每 agent，默认 3，fanout 计 N）是唯一的失控边界，耗尽即以清晰错误失败
  （在 pi-superagent 中核实）。信任建立在 brief + UP-CHECK 上，而不是沙箱；tool_call 守卫是
  黑名单式安全网，明确不是沙箱。
- **新颖性/delegation 强制是 prompt 级的**：规则活在 AGENTS.md、role card 和每轮机械性重注入的
  router 提醒里（`pi-delegation-reminder`，含 DECOMPOSE FIRST 规则，commit c7df28a，已在 packages/
  核实）；`tools/delegation_gate.py` 是工作流校验器，不是运行时拦截器。更深的机械校验**推迟**。
- **归因残差是诚实的，不是强凑的**：不可归因或跨项目的工作进显式的 `personal-ops` /
  `unattributed` 桶，而不是被硬塞给一个貌似合理的项目。
- **推迟的工作**：把 `graph.json` 补设到既有项目、图的 web 消费端、coordinator registry 树——都是
  rollout/v2 步骤；v1/v1.1 只是约定，零引擎改动。
