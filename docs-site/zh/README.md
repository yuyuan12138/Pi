# PiAgents：一套可复现的「代理操作系统」

一句话定位：**这不是一个应用，而是一份用纯文本写成的代理操作系统**——主对话只派工、决策、验收，真正干活的是干净上下文的子代理；全部「内核」由 Markdown 规则、角色模板和三个小脚本组成，没有隐藏的二进制或云依赖。它在 [pi](https://github.com/earendil-works/pi) 上验证运行，但设计不绑定引擎：任何支持「主循环 + 子任务派生」的 agent 框架都能套用这套理念。

## 架构总览

```text
                      用户（需求 · 决策 · 最终验收）
                                  │
      ┌───────────────────────────▼────────────────────────────┐
      │         主对话 primary（每项目一个，cwd = 项目根）          │
      │    只做：需求理解 / 书面任务书 / 决策 / 验收 / 集成          │
      └────────┬─────────────────────────┬─────────────────────┘
               │ subagent_spawn          │ fork（例外）
               │ 干净上下文、后台（默认）  │ 继承当前对话分支
               ▼                         ▼
        9 类角色 worker                上下文密集型探索
  scout / planner / coder / operator /  （调试现场·多文件实现）
   reviewer / researcher / visualizer /
   writer / designer
               │                         │
               └────────────┬────────────┘
                            ▼
              验收：亲自跑测试 · 看 diff · 核对证据
                            │ 验证通过，沉淀教训
                            ▼
      ┌─────────────────────────────────────────────┐
      │ knowledge-base/（两层知识库）                 │
      │  daily/YYYY-MM-DD.md → knowledge/concepts/  │
      │  compile_kb.py 索引 + scope gate             │
      └─────────────────────────────────────────────┘

 ═══════════════ 跨项目协调层（可选） ═══════════════════════
   项目 A 主对话 ──┐
   项目 B 主对话 ──┼──▶ pi-project-coordinator
   项目 C 主对话 ──┘    registry · 确定性路由 · 每项目单写队列
```

这套循环外还包了一层可选的观测面：**pi-web-bridge**——本地网页任务控制台（127.0.0.1:7788），带实时子代理面板、协调者回复流式显示、转向注入、Markdown 渲染与移动端适配的能力（见 `packages/pi-web-bridge/`）。

## 三步复现

### 第一步：装引擎（约 2 分钟）

本仓库的运行引擎是 [pi](https://github.com/earendil-works/pi)（`@earendil-works/pi-coding-agent`，包名已核对 npm registry，bin 名为 `pi`）。按 pi 官方 README，首选安装方式（自动处理 Node 依赖，可用 `pi update` 升级）：

```bash
curl -fsSL https://pi.dev/install.sh | sh
```

或用 npm（注意官方命令带 `--ignore-scripts`；要求 Node.js ≥ 22.19）：

```bash
npm install -g --ignore-scripts @earendil-works/pi-coding-agent
```

**pi 本体不带子代理**——官方 README 原话："Pi ships with powerful defaults but skips features like sub-agents and plan mode"。本架构依赖的派工工具以 pi 包形式提供，本仓库内就带源码（已退役的同步 `subagent` 工具仅留作参考）：

| 工具 | 作用 | 仓库内源码 | 上游安装命令 |
|---|---|---|---|
| `fork` | 派生继承当前对话分支的子进程（上下文密集型探索） | `packages/pi-fork/` | `pi install git:github.com/elpapi42/pi-fork` |
| `subagent` | 同步派生干净上下文的独立子代理——**已于 2026-11-09 退役并从运行配置移除；改用 `subagent_spawn`** | `packages/pi-minimal-subagent/` | — |
| `subagent_spawn` | 派生后台干净上下文子代理（默认派工方式；`tools` 白名单 / 持久 `session` / `wait: true` 同步语义） | `packages/pi-superagent/` | `pi install git:github.com/aicodewith-team/pi-superagent` |
| `pi-web-bridge` | 本地网页任务控制台（127.0.0.1:7788）：实时子代理面板、流式回复、转向注入、Markdown 渲染、移动端适配（可选） | `packages/pi-web-bridge/` | 在 `settings.json` 注册仓库内路径（见其 README） |

两种装法任选：用上面的 `pi install` 命令装上游包，或把仓库内路径写进 `~/.pi/agent/settings.json` 的 `packages` 数组（本机即如此）。版本注记：本仓库当前运行在 pi 1.5.0，建议装最新版（早期验证环境为 1.3.0，fork/subagent 在 1.3.0 实测可用）。

**理念可移植声明**：如果你用其他框架（Claude Code、自研 harness 等），跳过本步即可——下面两类资产是纯文本，不依赖 pi 的任何 API，只要你的框架能「派生一个带独立上下文、可用工具受限的子任务」就能套用。

### 第二步：拷贝三类文本资产

这是「操作系统内核」的全部，每个路径都在本仓库真实存在：

| 资产 | 仓库内真实路径 | 装到哪 | 作用 |
|---|---|---|---|
| ① 全局规则（主对话宪法） | `instructions/PROJECT-AGENTS.md` | `~/.pi/agent/AGENTS.md`（pi 的全局规则位，对所有会话生效） | 零内联执行、best-of-N 并行候选、验收门、委派路由 |
| ② 9 角色模板 | `instructions/agents/`——scout / planner / coder / operator / reviewer / researcher / visualizer / writer / designer 各一个目录 | 任意目录，主对话按路径读取 | 每角色 = `AGENTS.md` 任务书模板 + `skills/` 方法论 + `records/experience.md` 经验 |
| ③ 三个脚本 | `tools/delegation_gate.py`、`tools/git_guard.py`（经 `.githooks/pre-commit` 接线）、`knowledge-base/scripts/compile_kb.py` | 仓库内任意位置 | 路由校验（建议性）/ 暂存区守卫 / 知识库编译 + lint |

诚实条款：

- 角色模板里的 `records/experience.md` 是原作者跨项目攒的**个人经验**，复现者**清空即可**，角色运转只依赖 `AGENTS.md` 和 `skills/`。
- `delegation_gate.py` 校验的是「声明的归属」是否合规，不是运行时拦截器，更不能证明子代理真的跑过（详见[委派体系](docs/delegation.md)）。
- 暂存区守卫用 `git config core.hooksPath .githooks` 启用；它是尽力而为的扫描，不是 DLP（详见[安全边界](docs/security.md)）。

可选资产：`packages/pi-project-coordinator/`（多项目协调器，单项目复现不需要）和 `knowledge-base/`（两层知识库，scope gate 规则文本在 `knowledge-base/AGENTS.md`）。

### 第三步：走一个真实例子（给 coder 派工）

场景：给你的项目修一个小 bug。完整流程四步。

**0. 路由声明**——动手前主对话先说清四件事（规则来自全局规则的「Mandatory routing decision」）：

```text
任务类别 = implementation；交付物 = 单文件修复 + 1 条回归测试；
执行者 = subagent(coder)；验收 = pytest 全绿 + 主对话亲自看 diff
```

**1. 建议性校验归属**（可选，用法来自 `instructions/DELEGATION-ROUTING.md`）：

```bash
python3 tools/delegation_gate.py --category implementation --owner subagent
# ALLOW: Declared ownership matches routing policy  (exit 0)
```

**2. 发任务书**。字段固定，来自 `instructions/agents/coder/AGENTS.md` 的 Task Brief 段。一份填好的真实形态：

```markdown
## Task Brief (filled by the primary conversation)
- Project root (cwd): /home/you/myapp
- Goal and scope: utils/date.py 的 parse_date() 要拒绝非法月份（如 "2026-13-01"），
  只改这一个文件；在 tests/test_date.py 补一条回归测试 test_rejects_invalid_month
- Relevant paths / background facts: utils/date.py 现用 datetime.strptime；
  tests/test_date.py 已有 12 个 pytest 函数式用例，新用例照此风格
- Authorization and prohibitions: 只许改 utils/date.py 和 tests/test_date.py；
  不装依赖、不联网；不得删除或放宽现有测试
- Expected evidence and acceptance criteria: pytest -q 输出 13 passed；
  报告按三态标注 implemented / tested / unverified，逐文件一句话说明改动
```

同时按 coder 模板的 Tools 段设工具白名单 `read, grep, find, ls, bash, edit, write`，把子代理 cwd 钉在项目根。coder 开工第一件事是读自己的 skill 文件（`instructions/agents/coder/skills/minimal-change.md`：最小改动 + 三态汇报）——方法论注入靠这一步，不靠微调模型。

**3. 验收**。子代理报 PASS 不算数：主对话亲自跑 `pytest -q`、看实际 diff、核对三态报告。有界且可本地验证的任务默认走 best-of-N（N=3）：三个候选各在隔离的工作副本上用**同一份任务书**工作，主对话逐一验收、择优采纳，N 个结果全部如实上报（哪些过、哪些挂、挂在哪）。

验证通过后，一条可迁移的教训按日期追加进 `knowledge-base/daily/YYYY-MM-DD.md`，反复出现再由 `compile_kb.py` 提升进 `knowledge/concepts/`。

## 设计原则（可移植内核，与 pi 解耦）

| # | 原则 | 内容 | 为什么 |
|---|---|---|---|
| 1 | 零内联执行 | 主对话不亲手干活——实现、测试、调研、评审全部派工；主对话只做沟通、拆解、决策、验收与集成 | 执行过程的海量读文件与试错噪音留在子进程里，主对话上下文留给决策 |
| 2 | 干净上下文子代理 | 每个子代理从空白上下文开始，靠书面任务书获得全部输入；`fork`（继承对话）只留给真正依赖活对话状态的任务 | 干净上下文便宜且可并行；继承全量上下文的代价随主对话大小线性增长 |
| 3 | 固定验收标准 | 验收标准写进任务书，派工后不可更改；绝不为了通过而删测试或放宽断言 | 让 best-of-N 候选可比较；杜绝「为了绿而绿」 |
| 4 | 书面任务书 | 每次派工都是结构化 brief（cwd / 目标 / 路径 / 授权 / 验收），字段固定 | 上下文隔离后唯一的信息通道；任务书写不出来，说明需求还没想清楚 |
| 5 | 证据驱动验收 | 子代理报 PASS ≠ 验收完成；主对话亲自跑测试、看 diff、核对证据；API 通 ≠ 浏览器可用 | 执行者与验收者必须分离，否则误报和美化无人纠正 |
| 6 | 可证伪的经验入库 | 经验入库要带来源与证据指针；「verified」只有真打开过一手来源才能标；不可证伪的内容不入库 | 不可证伪的知识会污染后续所有决策；snippet 不是证据 |
| 7 | 范围门控记忆 | `daily/` 教训默认只在本项目有效；升为全局需 ≥2 个不同项目的证据 + 用户显式批准（fail-closed） | 研究表明朴素的全局记忆池比没有记忆更差——先定范围，再持久化 |
| 8 | Agent 间通信一律英文 | 操作者与主对话可用任意语言交流，但所有发往代理的文本——prompt、任务书、角色消息、子代理派发——一律用英文；面向人的交付物（聊天回复、用户报告）跟随人的语言 | 角色模板、skill 文件与工具链本身锁定英文；混合语言任务书会降低小参数开源模型的指令遵循质量（已固化为全局规则） |

## 文档导览

| 文档 | 内容 |
|---|---|
| [委派体系](docs/delegation.md) | 路由决策流程、best-of-N、验收门、zero inline execution 规则 |
| [九个角色](docs/roles.md) | 每个角色的职责、工具白名单、何时用哪个（表格） |
| [多项目协调器](docs/coordinator.md) | registry / 确定性路由 / 单写队列 / RPC 运行时 |
| [知识库](docs/knowledge-base.md) | 两层结构、scope gate、卫生层、compile_kb |
| [安全边界](docs/security.md) | 权限不因委派扩大、子代理加固、Git 与 secrets 规则 |

## 关键数字

- **9 个预定义角色**：全部是任务书模板而非常驻进程，不加载扩展，靠「先读自己的 skill 文件」注入方法论——资产即 `instructions/agents/` 一个目录。
- **2 个在役派工工具**（`fork` + `subagent_spawn`）：pi 本体不带子代理，由 `packages/pi-fork` 与 `packages/pi-superagent` 提供；同步 `subagent` 工具已于 2026-11-09 退役（能力并入 `subagent_spawn`；`packages/pi-minimal-subagent` 仅留作仓库内参考）。
- **1 个可选网页任务控制台**：`pi-web-bridge`——本地 web UI（127.0.0.1:7788），实时子代理面板、协调者回复流式显示、转向注入与向后翻页历史。
- **3 个脚本**：`delegation_gate.py`（归属校验，建议性）、`git_guard.py`（暂存区守卫）、`compile_kb.py`（知识库编译 + lint）——纯本地、零依赖。
- **1 个多项目协调器**（可选）：SQLite 持久化、每项目单写队列、全局并发上限 2、变更类任务崩溃后永不盲目重放。
- **2 层知识库**：`wiki/`（外部一手经验，带置信度）+ `daily/` 与 `knowledge/concepts/`（内部工程日志），scope gate fail-closed。
