# 多项目协调器 pi-project-coordinator

> **复现要点**：源码与测试都在 `packages/pi-project-coordinator/`，零外部依赖（SQLite 用 Node 内置 `node:sqlite`）。离线测试：`node --test tools/test_project_coordinator.ts`（18 个用例，其中真实 CLI 冒烟为 opt-in，不设 `PI_COORDINATOR_SMOKE=1` 时跳过）。这是**可选组件**——单项目复现不需要它，只有当你想让一个协调者对话路由多个项目时才装。文中列的安全门（模型调用默认关、接受 prompt ≠ 完成、变更类崩溃不重放）是包内代码实现的行为，不是配置开关。

## 定位

让一个长期协调者对话把用户请求路由给「每个项目一个主对话」的体系。核心原则：**什么都不会自动激活**——不改全局配置、不自动建会话、不自动注册项目。注册只是「提案」，项目根目录必须经用户明确确认后才生效。

## 五个模块，各管一层

- **registry**：项目持久身份——id、别名、realpath 强制的规范根目录、稳定 sessionId，原子保存。
- **router**：只做确定性路由（精确 id / 别名 / 规范根目录），结果只有 `ok` / `ambiguous` / `unknown`——歧义时宁可问用户，绝不模糊猜测，绝不扫盘去「发现」项目。
- **store**：SQLite 持久层（单 WAL 库，Node 内置 `node:sqlite`，零外部依赖）。`journal` 追加只写、按 `sha256(sourceMessageId:splitIndex)` 去重；旧的 JSON 文件一次性幂等导入后改名保留，不删除。
- **engine**：每项目 FIFO 队列 + 单写者租约 + 全局并发上限（默认 2），状态跨重启持久。
- **rpc-runtime**：以 RPC 模式拉起项目自己的 Pi 会话——按 id 精确恢复会话（绝不「continue 最近一个」）、cwd 钉在项目根、不带 `--model` 标志（保持当前模型），也不挂 Telegram 传输。

## 内置安全门

1. **模型调用默认关闭**：`allowModelCalls: false` 时仅用 `get_state` 探测身份（无模型往返），自动测试不可能烧 token 或改动项目。
2. **接受 prompt ≠ 完成**：运行时区分 prompt 应答（disposition）与 `agent_settled`，结果一律标 `completed-unverified`——验收是主对话/用户的独立步骤。
3. **崩溃规则**：变更类任务（mutating）崩溃一律记 `unknown-outcome`，引擎与 journal 重放都**不会**再执行它，只能显式 `reconciled` / `verified` / `cancelled` 收口。

## 现状

离线测试套件共 18 个用例（其中真实 CLI 冒烟用例不设 `PI_COORDINATOR_SMOKE=1` 时跳过）；真实 Pi CLI 冒烟验证过 spawn / 协议 / 会话身份（未跑真实 prompt）。尚未实现：接入活的协调者对话、注册真实项目、Telegram 分线程桥接、已运行会话的接管规则。
