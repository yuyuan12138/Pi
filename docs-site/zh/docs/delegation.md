# 委派体系：派工、路由与验收

> **复现要点**：本篇规则文本在 `instructions/PROJECT-AGENTS.md`（零内联执行、best-of-N、验收门、Mandatory routing decision）和 `instructions/DELEGATION-ROUTING.md`（默认归属表 + 三类显式例外：unavailable-tools / integration-only / trivial-fix）。归属校验工具是 `tools/delegation_gate.py`（`--category --owner` 两个参数，exit 0 允许 / 1 违反策略 / 2 参数错误）。注意它是建议性检查，不是运行时拦截器——复现它拷文件即可，但「执行归执行、校验归校验」的性质要记住。全局规则文件（`~/.pi/agent/AGENTS.md`，源自 `instructions/PROJECT-AGENTS.md`）还固化了「Agent 间通信一律英文」：发往子代理的 prompt、任务书与角色消息一律用英文，面向人的交付物跟随人的语言。

## 路由决策流程

任何非琐碎工作动手之前，主对话先声明四件事：任务类别、有界交付物、执行者、验收证据。默认归属：公开调研 → researcher 子代理（只读）；实现与测试 → coder / operator 子代理（书面任务书），`fork` 只在有明确上下文依赖时使用并说明依赖什么；评审 → reviewer（只读，只提建议不动手）；部署 → operator（仅限已授权的目标与操作）；多日迭代战役 → 经协调器交给项目自己的主对话；需求理解、决策、任务书与集成验收 → 主对话自己。可选用 `tools/delegation_gate.py` 做归属校验。

## zero inline execution

2026-11-05 起用户明确废止了「琐碎任务主对话顺手自己做」的例外：主对话能做的，子代理也能做。主对话的职责收敛为沟通、拆解、决策、验收与跨模块集成，不再吸收执行工作。

## fork 还是 subagent

`fork` 会复制主对话的全部上下文，代价高：上下文越大，每次 fork 都要重读一遍。只有真正依赖活对话状态（如正在进行的调试现场）才用 `fork`，并说明依赖。

## spawn 优先派工：subagent_spawn

2026-11-06 起默认派工方式是**后台 `subagent_spawn`**（由 `packages/pi-superagent/src/subagent/` 提供）：长任务或多步 operator/coder 链一律作为后台任务运行，主对话不再阻塞等待；同步 `subagent` 工具（或 `subagent_spawn` 的 `wait=true`）只留给短小的 advisor/reviewer 意见或快速有界检查。默认情况下 `subagent_spawn` 立即返回 `spawned <id>`，子代理的里程碑报告和最终结果之后以消息形式送达——派发、释放注意力、不要轮询。

三个可选参数（commit `0d80c87`）：

- **`tools`** —— 子代理工具白名单，按内置子工具（`read`、`grep`、`find`、`ls`、`bash`、`edit`、`write`）校验；`report_to_parent` 会被强制追加，后台汇报在任何白名单下都可用；`[]` 禁用全部内置工具（汇报工具仍在）。这是工作流约束，不是沙箱。
- **`session`** —— 命名持久子会话，存放在 gitignore 的 `.pi/subagents/sessions/` 下：首次 spawn 创建，之后用同一 id 的 spawn 续用（并行任务用不同 id）。
- **`wait`** —— `wait=true` 阻塞到子代理到达终态并返回最终结果文本（同步语义，仅用于短小有界任务）。

```
subagent_spawn(task="fix the flaky auth test; verify with pytest -q", tools=["read","bash","edit"], session="fix-auth")
# → "Spawned sa7 …" — 继续派工；报告和最终结果以消息送达。
subagent_spawn(task="one-line check: does settings.json still pin the model?", wait=true)
# → 阻塞并立即返回最终文本。
```

**存活校验**：后台 spawn 之后、采信之前先确认派发真的存活——查看该子代理的 `events.jsonl` mtime 是否在移动、日志目录（`.pi/subagents/<id>/`）里是否出现任务专属 token——因为 spawn 出的 id 可能与磁盘上的陈旧目录撞号。测试：`packages/pi-superagent/tests/subagent.test.ts`。

## best-of-N 并行候选

有界且可本地验证的任务，默认并行派 N 个子代理（默认 N=3，难任务可加到 5）：各自在隔离的工作副本上、用同一套固定验收测试工作，互不共享写入。全部完成后主对话逐一验收——跑测试、看 diff、核对交付物——择优采纳，N 个结果全部如实上报（哪些过、哪些挂、挂在哪）。验收标准对所有候选一致，绝不为了通过而删测试或放宽测试。

## 验收门

子代理报 PASS 不等于验收完成：主对话要亲自检查实际 diff 和关键证据。API 通不等于浏览器可用，幂等重试的成功响应不等于流程真的重跑了一遍。`delegation_gate.py` 只是建议性检查（exit 0 允许 / 1 违反策略 / 2 参数错误），不是运行时拦截器，也不能证明子代理真的跑过——它校验的是「声明的归属」，不是事实本身。
