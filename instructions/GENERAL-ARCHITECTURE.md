# Pi Agent 通用架构（General Architecture）

> 设计日期 2026-11-02。状态：设计文档；其中标注 [live] 的组件已建成并在用，
> [proposed] 为演进方向，需逐步验证。

## 总览

```
用户 (Telegram / TUI)
   │
   ▼
┌─────────────────────────────────────────────┐
│  主对话 = 薄协调入口 (thin coordinator)      │  [live]
│  只做: 理解需求 / 拆任务写brief / 决策       │
│        / 验收 / 跨项目集成                  │
│  不做: 重实现、长调试循环、大段探索          │
│  卫生线: 上下文 >75% → 状态写文件再派发      │
└───────────────┬─────────────────────────────┘
        ┌───────┼──────────────┐
        ▼       ▼              ▼
┌────────────┐ ┌────────────┐ ┌─────────────────────┐
│ 项目primary │ │ 角色subagent│ │  fork (例外通道)     │
│ (pi --mode  │ │ (干净上下文) │ │  仅当任务确需活会话   │
│  rpc 子会话)│ │ scout/     │ │  上下文;须声明依赖     │
│ 每个重项目  │ │ planner/   │ │  成本:整条会话拷贝    │
│ 一个常驻    │ │ coder/     │ └─────────────────────┘
│ medical[live]│ operator/  │
│ minecraft[  │ reviewer/   │
│  proposed]  │ researcher  │
└─────┬──────┘ └─────┬──────┘
      │              │ 写brief+skill文件,收三态报告
      ▼              ▼
┌─────────────────────────────────────────────┐
│  共享基础设施 (无模型, 本地)                  │
│  coordinator.db   会话/租约/任务队列 [live]   │
│  knowledge-base   验证过的知识 [live]         │
│  skills 库        角色/项目技能 [live]        │
│  usage-log        用量审计 [live]             │
│  task-sentinel    异步完成监听 [live]         │
│  git_guard        提交防线 [live]             │
└─────────────────────────────────────────────┘
```

## 五层职责

| 层 | 谁 | 职责 | token 经济 |
|---|---|---|---|
| L1 入口 | 主对话 | 需求理解、brief、决策、验收 | 保持薄；新鲜 token 每天目标 <1M |
| L2 执行 | 项目 primary | 一个项目的持续迭代（调试战役、日常开发） | 每项目独立上下文，互不污染 |
| L3 专业 | 角色 subagent | 干净上下文 + 角色 brief + skill，一次性交付 | 最便宜/任务；默认通道 |
| L3' | fork | 需要活会话上下文的实现任务 | 显式声明依赖才用（拷贝成本） |
| L4 记忆 | 文件+DB | skill/经验记录/知识库/usage | 模型无关、Git 审计、防投毒 |

## 核心机制

1. **状态外置**：任何要跨任务存活的状态都写文件（skill、runbook、
   experience.md、knowledge-base），不靠会话记忆。会话可随时重建。
2. **干净上下文优先**：任务能用书面 brief 说清 → subagent；说不清才 fork；
   多天循环 → 项目 primary。路由由 delegation_gate 校验（advisory）。
3. **三态验收**：implemented / tested / verified 分级报告；prompt 被接受
   ≠ 工作完成；settled ≠ 成功。
4. **失败即证据**：验证过的教训回填 experience.md 与知识库（跨项目改进
   回路）；未知结果不重试、不推断。
5. **审计与防线**：usage-log 记每轮 token；git_guard 拦截密钥/大文件；
   knowledge-base Git 历史防记忆投毒。
6. **授权不随委派扩大**：subagent/fork/项目 primary 的权限 ≤ 主对话
   已获授权；未知授权一律上报不做。

## 生命周期

- **会话**: 主对话定期开新会话（借助 observational memory 恢复事实）；
  项目 primary 由 coordinator.db 管理 generation/lease，崩溃不重放变更。
- **任务**: brief → 派发 → 三态报告 → 主对话验收 → 教训回填 → 关闭。
- **技能**: 验证过的教训 → experience.md → 反复出现 → 提升为独立 skill 文件
  （渐进披露：description 驱动选择，正文 <500 行按需读）。

## 演进方向 [proposed]

1. Minecraft 注册为第二个项目 primary（需授权开启子会话模型调用）。
2. delegation_gate 从 advisory 升级为 Pi 工具钩子（真正拦截而非提示）。
3. 角色 skill 按 Anthropic 渐进披露规范补全 frontmatter 与 description。
4. knowledge-base FTS 精确归因缺陷修复后作为 subagent 的公共检索层。
