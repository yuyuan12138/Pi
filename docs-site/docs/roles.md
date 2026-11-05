# 九个预定义角色

> **复现要点**：把 `instructions/agents/` 整个目录拷走就是全部角色资产——9 个角色各一个目录（`AGENTS.md` 任务书模板 + `skills/` 方法论 + `records/experience.md`）。其中 `records/` 是原作者的个人经验，**复现者清空即可**，角色运转只依赖前两者。派工时照每份 `AGENTS.md` 顶部的说明做：填 Task Brief 五字段（Project root / Goal and scope / Relevant paths / Authorization and prohibitions / Expected evidence and acceptance criteria）、按 Tools 段设工具白名单、子代理先读自己的 skill 文件。完整走一遍的例子见仓库根 [README](../README.md) 第三步。

角色库位于 `instructions/agents/`，每个角色一个目录：`AGENTS.md`（任务书模板）+ `skills/`（方法论）+ `records/experience.md`（跨项目经验）。它们不是常驻进程，而是干净上下文子代理的任务书模板。派工流程：主对话读对应 `AGENTS.md` → 填「任务书补充」（cwd、目标、授权、验收）→ 按其 Tools 段设置工具白名单 → 子代理开工前先读自己的 skill 文件。

| 角色 | 工具白名单 | 职责 | 何时用 |
|---|---|---|---|
| scout | read / grep / find / ls | 摸清结构，定位代码到 `path:line`，不评价设计 | 「这是什么、在哪、怎么组织」 |
| planner | read / grep / find / ls | ≤6 步可验证计划 + 显式权衡（每个关键决策至少两个选项） | 动手前要方案与取舍 |
| coder | read / grep / find / ls / bash / edit / write | 指定文件范围内最小改动 + 自测，三态报告（已实现/已测试/未验证） | 实现、修 bug、写测试 |
| operator | bash / read / ls | 机械执行已验证的 runbook：启动、监控、清理、磁盘卫生；未知结局不重试 | 部署、巡检、按清单操作 |
| reviewer | read / grep / find / ls | 按正确性→安全→回归→测试缺口→UX 分级评审，附 path:line 证据 | 独立评审（只提发现，不修） |
| researcher | read / grep / find / ls / bash | 公开调研 + 一手来源核验，每条结论带链接与不确定度标注 | 需要外部事实与出处 |
| visualizer | read / write / bash / ls | 产出真实图表/架构图/HTML 文件，数据必须真实，标注「解释≠证明」 | 要看得见的可视化产物 |
| writer | read / write / bash / ls | 用用户风格写文档（人话、详细、不堆技术细节），从反馈中自更新 skill | 交付文档、报告 |
| designer | read / write / edit / bash / ls / grep | 只动观感不动数据流的重新设计，去 AI 腔（unslop），信息不丢 | 页面/邮件/文档美化 |

改进闭环：验证过的结果按日期追加到该角色的 `records/experience.md`（只记可迁移方法论，不记项目私有数据），由主对话提交 Git，跨项目沉淀。
