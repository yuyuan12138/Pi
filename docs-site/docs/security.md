# 安全边界

> **复现要点**：本篇的防线分两类，别混淆。技术防线可拷贝：`tools/git_guard.py` + `.githooks/pre-commit`（`git config core.hooksPath .githooks` 启用）。规则防线是给主对话执行的**文本**：权限条款在全局规则（`instructions/PROJECT-AGENTS.md`「Delegation does not expand authorization」段），子代理加固与「不弱化安全检查」写在每个角色的 Boundaries 段（如 `instructions/agents/coder/AGENTS.md`）。后者没有自动执行机制——复现它们就是拷规则并让主对话遵守。

## 权限不因委派扩大

委派不带来新授权：任务之外不装依赖、不碰远程机器、不发布、不做破坏性操作、不取凭证。并行候选的文件所有权必须互不相交，主对话与子代理不同时编辑同一文件。要认清工具白名单和 cwd 限制的本质：它们是工作流约束，不是 OS 沙箱——子代理运行在宿主用户权限之下，所以授权必须写进任务书并保持最小。

## 子代理加固

worker 子代理以 `--no-extensions --no-mcp --no-approve --offline` 启动，凭证拒绝列表封锁 `auth.json` / `models.json`，cwd 钉在派发项目内（含 realpath 校验），禁止 Telegram 子通道。fork 子进程禁用 MCP 与项目级启动配置，取消、报错、空输出、非零退出都不会被美化成成功。

## Git 与 secrets

只做本地提交：不加 remote、不 push、不发 PR，除非用户明确批准。暂存用显式路径，禁止盲目的 `git add .` / `git add -A`。每个仓库经共享的 `.githooks/` staged-content guard 扫描常见凭证模式与危险路径——它是尽力而为，不是 DLP：guard 拦下了不许为了让提交通过而关掉，正确做法是把敏感内容移出暂存区。还要记住两条容易忽略的事实：忽略（ignore）不等于取消跟踪，历史里的文件依然在；revert/删除提交也抹不掉历史中的秘密——一旦泄露，封存并通知用户。

## 其他防线

- **知识库**：索引配置只允许两个工作区根 + 文本扩展名白名单，排除凭证/私有/会话目录与可疑文件名；SQLite 0600 但未加密；检索结果进入云端模型上下文前要有授权意识。
- **多项目协调器**：模型调用默认关闭；变更类任务崩溃后记 `unknown-outcome`，永不自动重放。
- **所有角色共同的红线**：如实报告失败，永不制造完成的假象——测试没过、验证被阻塞就如实说，而不是赶在报告前伪造一个干净的检查点。
