# 预定义 agent 库（跨项目复用）

每个预定义 agent 是一个独立目录，沿用与原 agent 工作区同构的 folder 架构：

```text
instructions/agents/
├─ scout/
│  ├─ AGENTS.md     角色定义（任务书模板：身份/工具/技能/流程/输出契约/边界/示例）
│  ├─ README.md     简要章程
│  ├─ skills/       专属技能（子代理派发前先读）
│  └─ records/      经验记录与任务留档（跨项目累积）
├─ planner/         同构
├─ coder/           同构
├─ reviewer/        同构
└─ researcher/      同构
```

| agent | 工具 | 专属技能 | 用途 |
|---|---|---|---|
| scout | 只读 | structure-map | 摸清结构、定位代码 |
| planner | 只读 | tradeoff | 方案与取舍分析 |
| coder | 读写+执行 | minimal-change | 划定范围内的实现 |
| reviewer | 只读 | severity-review | 分级审查+深度声明 |
| researcher | 只读+执行 | source-verification | 调研+来源核实 |

## 派发方式

主对话派 `subagent` 时：
1. 读 `agents/<name>/AGENTS.md` 作为任务书基底；
2. 填写其「任务书补充」区块（cwd、目标、授权、验收标准）；
3. 按其「工具」区块设置 `tools` 参数；
4. 子代理在目标项目 cwd 内先读自己的专属技能再干活。

## 进步机制

- 经验 → `records/experience.md`（验收后追加，注明日期与来源项目）。
- 专属技能可增删：发现新方法论就加一个 skill 文件，不好用就改。
- 角色定义、技能、白名单的任何修改都进 Git，可审计可回滚。
- 只记可泛化内容，不写项目私密数据。

## 边界

- 这些是任务书模板+技能文件，不是常驻进程。
- 子代理子进程不加载扩展，技能以"先读文件"方式注入。
- 观察记忆是会话内的；跨项目进步由本目录承载。
