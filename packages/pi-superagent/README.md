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

LLM tools: `subagent_spawn` (task, label, cwd, `isolate` = fresh git worktree + branch, `model`, `tools` = child tool allowlist (workflow limit, not a sandbox), `session` = named persistent child session, `wait` = block and return the final result, `fanout` = N (1-3) identical copies of the task in parallel — best-of-N), `subagent_list`, `subagent_status`, `subagent_message` (steer a running one), `subagent_stop`, `subagent_result` (final result, or `log=true` for the truncated on-disk transcript). Humans: `/subagent list | status <id> | log <id> | stop <id|all> | spawn <task>`. The footer shows `subagents ● 2 running · 1 queued`.

**Fanout (best-of-N) and recursion:** `fanout: N` (1-3) runs N identical copies of the task; with `isolate` each member gets its own worktree. All N are tracked to a terminal state, each reports independently, and one combined result — an array of `{id, status, resultText, worktree, spawned_by, depth}` — arrives when all are terminal (with `wait=true` it is the tool result). Selecting the best member is the parent agent's job, never automatic. Subagents can spawn their own sub-subagents: the manager launches workers with this extension loaded and passes `PI_SPAWN_DEPTH` (root spawn = depth 1) plus the lineage chain. Nesting depth is uncapped — `PI_SPAWN_DEPTH` is observability/lineage only; the per-agent spawn budget (`PI_SPAWN_BUDGET`, default 3 — a fanout of N counts as N) is the only runaway bound, and exhausting it is refused with a clear error.

**Spawn-tag gate (project-space routing, 2026-11-13):** every spawned task — root and nested alike — must carry the literal `[project:<name>]` token attributing the dispatch to a project; a tagless task is refused at the spawner chokepoint with an actionable error. This is deliberate **format-only** enforcement: workers run `--no-extensions`, so the coordinator-side guard (pi-coordinator-guard) never sees sub-spawns — the spawner keeps every dispatch labeled, while **registry validation (does `<name>` exist?) stays with the coordinator guard**, next to the registry db and the router. Kill switch: `PI_SPAWN_REQUIRE_PROJECT_TAG=0` (or `false`) restores untagged spawning for degraded-mode ops.

**Declarative model routing (Theme D4):** an OPTIONAL routing table at `~/.pi/agent/model-routing.json` maps selectors to a model id for spawned subagents. **The file is absent by default and absent means exactly the previous behavior** — nothing activates until you create it. Shape:

```json
{
  "projects": { "PiAgents": "training-coder/GLM-5.3-Flash", "medical": "deepseek/deepseek-chat" },
  "roles":    { "coder": "training-coder/GLM-5.3-Flash", "reviewer": "anthropic/claude-sonnet-4" },
  "default":  "training-coder/GLM-5.3-Flash"
}
```

Resolution precedence (highest first; the winner is what the worker's `--model` arg gets):

| # | Source | Notes |
|---|---|---|
| 1 | explicit `model` arg on `subagent_spawn` | **always wins — the table never overrides a user-specified model** |
| 2 | table `projects[<tag>]` | exact match on the `[project:<name>]` token the task must carry |
| 3 | table `roles[<role>]` | exact match on the optional spawn `role` argument |
| 4 | table `default` | fills the default slot when no selector matched |
| 5 | `PI_SUBAGENT_MODEL` env | unchanged semantics |
| 6 | built-in fallback `training-coder/GLM-5.3-Flash` | unchanged |

Posture: the table only fills the DEFAULT slot (rows 2–4 replace nothing an explicit arg set); any table hit beats the env slot. The table is **latched at SubagentManager construction** — a change requires a restart or a new session (see `docs/activation-contract.md`). A malformed file is ignored with a one-line stderr warning; spawning never breaks. Every dispatch records its decision: `subagent_list`/`subagent_status` show `model (via <source>)`, and the subagent's events dir gets a `routing.log` JSON line (`requested` / `project` / `role` / `resolved` / `source`). No silent provider switches: routing picks among models pi already supports, and the choice is auditable per dispatch.

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

模型可调用的工具：`subagent_spawn`（任务、标签、cwd、`isolate` 独立 git worktree + 分支、`model`、`tools` 子代理工具白名单（工作流限制而非沙箱）、`session` 命名持久子会话、`wait` 阻塞等待并返回最终结果、`fanout` = N（1-3）并行运行 N 份相同任务——best-of-N）、`subagent_list`、`subagent_status`、`subagent_message`（给运行中的子代理追加指令）、`subagent_stop`、`subagent_result`（最终结果，或 `log=true` 读截断后的磁盘日志）。人工命令：`/subagent list | status <id> | log <id> | stop <id|all> | spawn <任务>`。底栏显示 `subagents ● 2 running · 1 queued`。

**Fanout（best-of-N）与递归：** `fanout: N`（1-3）并行运行 N 份相同任务；配合 `isolate` 时每个成员拥有独立 worktree。全部 N 个成员都被跟踪到终态，各自独立汇报，并在全部结束时汇总为一条组合结果——每个成员一项的 `{id, status, resultText, worktree, spawned_by, depth}` 数组（`wait=true` 时直接作为工具结果返回）。挑选最优成员是父 Agent 的职责，绝不自动代劳。子代理还可以继续派生自己的子子代理：管理器启动 worker 时加载本扩展并传入 `PI_SPAWN_DEPTH`（根派生 = 深度 1）和谱系链。嵌套深度不设上限——`PI_SPAWN_DEPTH` 仅用于观测与谱系；每代理派生预算（`PI_SPAWN_BUDGET`，默认 3——fanout N 计为 N）是唯一的失控防护，超出时以明确错误拒绝。

**派生项目标签门（project-space routing，2026-11-13）：** 每个被派发的任务——根派生与嵌套派生一视同仁——都必须携带字面量 `[project:<name>]` 标记以归属项目；缺标签的任务在派生器咽喉点被拒绝，并给出可操作的错误说明。这是刻意的**仅格式**校验：worker 以 `--no-extensions` 运行，协调器侧守卫（pi-coordinator-guard）看不到子派生——派生器负责让每次派发都带上项目标签，而**注册表校验（`<name>` 是否存在？）仍归协调器守卫所有**（它紧邻注册表数据库与路由器）。降级开关：`PI_SPAWN_REQUIRE_PROJECT_TAG=0`（或 `false`）可恢复无标签派生。

**声明式模型路由（Theme D4）：** 可选的路由表 `~/.pi/agent/model-routing.json` 把选择器映射为子代理的模型 id。**默认没有这个文件，没有就等于一切照旧**——创建之前没有任何行为变化。表结构：`projects`（任务中 `[project:<name>]` 标记的精确匹配）、`roles`（派生时可选 `role` 参数的精确匹配）、`default`（无匹配时填充默认槽位）。解析优先级：① 显式 `model` 参数（**永远最高，路由表绝不覆盖用户指定的模型**）→ ② 表 `projects` → ③ 表 `roles` → ④ 表 `default` → ⑤ `PI_SUBAGENT_MODEL` 环境变量 → ⑥ 内置回退 `training-coder/GLM-5.3-Flash`。路由表在 SubagentManager 构造时**一次性读入**（改动需重启或新会话，见 `docs/activation-contract.md`）；文件缺失 = 静默跳过；文件损坏则忽略并告警一行，派生永不中断。每次派发都记录决策：`subagent_list`/`subagent_status` 显示 `model (via <来源>)`，子代理事件目录里写入 `routing.log` JSON 行（`requested` / `project` / `role` / `resolved` / `source`）——绝不静默切换供应商。

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
