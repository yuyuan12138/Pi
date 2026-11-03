# pi-superagent

> **A port of [DeepSeek's `dsh-superagent-prototype`](https://github.com/deepseek-ai/dsh-superagent-prototype) to the [pi coding agent](https://github.com/badlogic/pi-mono/tree/main/packages/coding-agent) as an extension.**
> All credit for the idea, philosophy and design goes to the DeepSeek Harness Team. This is an independent, unofficial community port — not affiliated with or endorsed by DeepSeek. Research-grade code: review before use.

[English](#english) · [中文](#中文)

---

## English

DeepSeek open-sourced `dsh-superagent-prototype`: a *proactive* coding agent for one GitHub repository, packaged for DeepSeek Harness. **pi-superagent brings the same way of working to pi**, plus a standalone **subagent mode** for everyday chats, with any model pi supports (DeepSeek, Claude, GPT, local llama.cpp…).

The principle (from DeepSeek's [000-philosophy](https://github.com/deepseek-ai/dsh-superagent-prototype/tree/main/docs)): *take as little human attention as possible, give as much value as possible.* The agent acts only when an allowed person asks or a team-written rule allows it, and speaks only when someone must act or can use a result.

### What it does

1. Polls your repo's issue + PR comments for `@your-agent-bot` mentions.
2. Checks the **allow list** and the rules in `.pi/superagent.yml` (label-based proactive work / ignore).
3. Opens a **work item**, replies "👀 On it".
4. Creates a dedicated **git worktree + branch** (`superagent/<issue>-<comment>`) and runs a **fresh pi session** (`pi -p`) in it.
5. If the worker committed changes: pushes the branch, opens a **pull request**, and replies in the original thread with the link. If it needs a human, it replies with its one question. Failures are reported too.
6. A **tool_call guard** blocks dangerous bash in worker sessions (sudo, `rm -rf /`, force-push, push to main, `curl | sh`, credential reads, `gh auth token`…).
7. `/superagent start | stop | status | poll` in the pi TUI, with a live footer status.

### 🧵 Subagent mode (Grok Bot / Claude-style) — no config needed

Inside a normal interactive `pi` chat, the main agent can **delegate tasks to background subagents and keep chatting with you**. Each subagent is a separate headless pi process (`pi --mode rpc`), run in parallel up to a cap (default 3, `PI_SUBAGENT_MAX`). When a subagent finishes, its result is injected back into your session and **the main agent wakes up** to act on it. Works without `superagent.yml`.

LLM tools: `subagent_spawn` (task, label, cwd, `isolate` = fresh git worktree + branch, `model`), `subagent_list`, `subagent_status`, `subagent_message` (steer a running one), `subagent_stop`, `subagent_result` (final result, or `log=true` for the truncated on-disk transcript). Humans: `/subagent list | status <id> | log <id> | stop <id|all> | spawn <task>`. The footer shows `subagents ● 2 running · 1 queued`.

**Clean main context (modelled on dsh-superagent's Executor → main Session Reports):** the subagent's transcript, tool calls and intermediate output **never** enter the main session. The main agent only sees (1) the task it wrote, (2) short milestone reports the subagent sends with its own `report_to_parent` tool — `progress` (throttled: at most one per minute per subagent, newest wins), `blocked` + one concrete question (immediate, wakes the main agent), `ready` / `failed` / `dropped` — and (3) the concise final result (truncated to 2000 chars). Like dsh-superagent, the main session does not wait or poll: reports arrive as messages. Full logs stay on disk in `.pi/subagents/<id>/` (`transcript.log`, `events.jsonl`, `result.md`) and are read on demand with `subagent_result log=true` (truncated, max 20k chars). Subagents run with the same tool_call guard; dialog prompts in subagents are auto-cancelled since nobody watches them.

Try: *"Spawn three subagents to review src/a.ts, src/b.ts and src/c.ts in parallel, then summarize."*

### Install

```bash
pi install git:github.com/aicodewith-team/pi-superagent
# or try it once:
git clone https://github.com/aicodewith-team/pi-superagent && cd pi-superagent && npm i
pi -e ./src/index.ts
```

Then in your target repo: copy [`examples/superagent.yml`](examples/superagent.yml) to `.pi/superagent.yml`, run `pi`, and type `/superagent start`. Full guide: [SETUP.md](SETUP.md) — or just ask pi: *"Read SETUP.md in pi-superagent and set it up with me."*

### Compared with the original

| | dsh-superagent-prototype | pi-superagent (v0.1) |
|---|---|---|
| Host | DeepSeek Harness bundle | pi extension |
| GitHub mentions → work item → PR | ✅ (webhooks) | ✅ (polling via `gh`) |
| Allow list + team rules | ✅ | ✅ (labels) |
| Isolated session + directory per item | ✅ | ✅ (worktree + `pi -p`) |
| Feishu | ✅ optional | ⏳ planned |
| Web panel | ✅ | TUI status only (⏳ web panel) |

### ⚠️ Safety

Workers run **without approval prompts** as your OS user. Use a dedicated machine/container and a **dedicated GitHub bot account** — never your own. The guard is a denylist safety net, not a sandbox. Start with `dryRun: true` and an allow list of just you.

### Develop

`npm run check` (typecheck against real pi `ExtensionAPI` types + vitest).

---

## 中文

DeepSeek 刚开源了 [`dsh-superagent-prototype`](https://github.com/deepseek-ai/dsh-superagent-prototype)：一个**主动式**编码 Agent，服务于单个 GitHub 仓库，原版打包给 DeepSeek Harness 使用。**pi-superagent 把同样的工作方式移植到了 [pi](https://github.com/badlogic/pi-mono) 上**，并附带一个可独立使用的 **Subagent 子代理模式**，可以搭配 pi 支持的任意模型（DeepSeek、Claude、GPT、本地模型等）。

> 创意、理念与设计均归功于 DeepSeek Harness 团队。本项目是社区独立移植，非 DeepSeek 官方，也未获其背书；研究级代码，请审阅后使用。

核心理念：**尽量少占人的注意力，尽量多给价值。** 只有白名单里的人点名、或团队写好的规则允许时才动手；只有需要人处理或有可用结果时才说话。

### 功能

1. 轮询仓库 issue / PR 评论中的 `@你的机器人`。
2. 校验 `.pi/superagent.yml` 的**白名单**和**规则**（按 label 主动干活 / 忽略）。
3. 开**工单**，在原帖回复「👀 On it」。
4. 为工单建独立 **git worktree + 分支**，在里面启动**全新 pi 会话**（`pi -p`）完成任务。
5. 有提交就推分支、**开 PR**，回到原帖贴链接；需要人决定就回一个问题；失败也会回报。
6. **tool_call 守卫**：在工作会话中拦截危险命令（sudo、`rm -rf /`、强推、推 main、`curl | sh`、读凭据等）。
7. pi 里用 `/superagent start | stop | status | poll` 控制，底栏实时状态。

### 🧵 Subagent 模式（类 Grok Bot / Claude 子代理）—— 无需配置

在普通的 `pi` 交互对话里，主 Agent 可以**把任务派给后台子代理，自己继续和你聊天**。每个子代理是一个独立的无头 pi 进程（`pi --mode rpc`），并行运行，有并发上限（默认 3，可用 `PI_SUBAGENT_MAX` 调）。子代理完成后，结果自动注入回当前会话，**主 Agent 被唤醒**继续处理。不依赖 `superagent.yml`。

模型可调用的工具：`subagent_spawn`（任务、标签、cwd、`isolate` 独立 git worktree + 分支、`model`）、`subagent_list`、`subagent_status`、`subagent_message`（给运行中的子代理追加指令）、`subagent_stop`、`subagent_result`（最终结果，或 `log=true` 读截断后的磁盘日志）。人工命令：`/subagent list | status <id> | log <id> | stop <id|all> | spawn <任务>`。底栏显示 `subagents ● 2 running · 1 queued`。

**主上下文保持干净（参照 dsh-superagent 中 Executor 向主 Session 汇报 Report 的做法）：** 子代理的对话记录、工具调用和中间输出**一律不进主会话**。主 Agent 只看到：① 它自己写的任务；② 子代理用 `report_to_parent` 工具主动发出的简短里程碑汇报——`progress`（节流：每个子代理每分钟最多一条，只保留最新）、`blocked` + 一个具体问题（立即送达并唤醒主 Agent）、`ready` / `failed` / `dropped`；③ 精简的最终结果（截断到 2000 字符）。和 dsh-superagent 一样，主会话不等待、不轮询，汇报以消息形式自动到达。完整日志保存在 `.pi/subagents/<id>/`（`transcript.log`、`events.jsonl`、`result.md`），需要时用 `subagent_result log=true` 按需读取（截断，最多 2 万字符）。子代理同样受 tool_call 守卫保护；子代理里的弹窗确认会被自动取消，因为没人看着。

试试：*「派三个子代理并行审查 src/a.ts、src/b.ts、src/c.ts，然后汇总。」*

### 安装

```bash
pi install git:github.com/aicodewith-team/pi-superagent
```

把 [`examples/superagent.yml`](examples/superagent.yml) 复制到目标仓库的 `.pi/superagent.yml`，在仓库里运行 `pi`，输入 `/superagent start`。详细步骤见 [SETUP.md](SETUP.md)，也可以直接让 pi 读 SETUP.md 带你配置。

### ⚠️ 安全

工作会话**不经审批**，以你的系统用户身份执行命令。请在独立机器/容器中运行，并使用**专用 GitHub 机器人账号**（不要用自己的）。守卫只是黑名单兜底，不是沙箱。建议先开 `dryRun: true`，白名单只放自己。

## License

MIT. Design and concepts adapted from [deepseek-ai/dsh-superagent-prototype](https://github.com/deepseek-ai/dsh-superagent-prototype) (MIT, © DeepSeek).
