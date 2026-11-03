# 迁移文档：在另一台 Mac 上复刻本 Pi agent 环境

> 生成日期：2026-11-03 · 依据本机的**实际配置**撰写（非假设）。
> 本机的真实值已逐条核对：`~/.pi/agent/settings.json`、`~/.pi/agent/models.json`、
> `~/.pi/agent/bin/pi` + `~/.pi/agent/install/`、`/Users/yuyuan/PiAgents/packages/`（6 个 vendored
> 扩展 + 各自 `UPSTREAM.json`）、`~/.pi/agent/AGENTS.md`、`/Users/yuyuan/PiAgents/instructions/`、
> `/tmp/tunnel-watchdog.sh`（含实际运行的 `ps` 快照）、`~/.ssh/config` 与 `known_hosts` 指纹。
>
> **安全约定**：本文不复现任何 API key / SSH 私钥内容——只引用路径；训练机 host key 只引用指纹。
> 从旧机复制含密钥的文件（`models.json`、`~/.ssh/id_ed25519`）时走加密通道，落地后确认权限 600。

---

## 0. 复刻清单（先读我）

| 组件 | 必须 / 可选 | 说明 |
|---|---|---|
| Pi 1.3.0（managed install） | 必须 | `~/.pi/agent/` 布局，Node ≥ 22.19 |
| `packages/` 下 6 个扩展中的 **pi-superagent + pi-minimal-subagent + pi-fork** | 必须（分发层核心） | `subagent_spawn`/`report_to_parent`、`subagent` 工具、`fork` 工具 |
| **pi-delegation-gate** | 必须（策略配套） | fork 前置校验 `[fork-context: …]`，AGENTS.md 工作流引用 `tools/delegation_gate.py` |
| **pi-usage-log** | 可选 | 每轮 token/cost JSONL + `/usage`；不影响功能 |
| **pi-observational-memory** | 可选 | 观察/反思/分层压缩；需要时才启用（settings.json 里已带阈值配置） |
| `npm:@llblab/pi-telegram` | 可选 | Telegram 桥；不装 Telegram 可跳过 |
| `models.json` 的 `training-coder/Qwen3-5` 条目 | 必须（用训练机时） | 指向本地隧道 127.0.0.1:18002 |
| SSH 隧道（watchdog） | 必须（用训练机时） | 见 §7 专节 |
| 全局 `~/.pi/agent/AGENTS.md` | 必须 | 整套委派/路由/注意力纪律策略 |
| `PiAgents/instructions/` + `tools/delegation_gate.py` | 必须 | AGENTS.md 直接按路径引用它们 |

**保持路径不变最省事**：本机布局是 `~/.pi/agent/`（Pi 本体）+ `/Users/<你>/PiAgents/`（工作区）。
settings.json 里的本地扩展路径是**相对路径** `../../PiAgents/packages/<ext>`（相对 `~/.pi/agent/`）。
新 Mac 上只要 PiAgents 目录叫 `PiAgents` 且放在用户主目录下，原样照抄即可；否则改相对路径。

---

## 1. 安装 Pi 1.3.0

本机是 **managed install**（不是全局 npm）：

```
~/.pi/agent/bin/pi                     # 启动器（shell 脚本）
~/.pi/agent/install/current-version    # 内容：1.3.0
~/.pi/agent/install/releases/1.3.0/node_modules/.bin/pi   # 真正的 pi
~/.local/share/pi-node/current/bin/node  # 安装器自带的 Node（启动器会自动加进 PATH）
```

新 Mac 上执行安装器（会装 Node 并创建上述布局）：

```bash
curl -fsSL https://pi.dev/install.sh | sh
```

然后确认版本（本机为 1.3.0；若安装器给了更新版本，用 `pi update` 或按
[quickstart 的 pin 方法](file:///Users/yuyuan/.pi/agent/install/releases/1.3.0/node_modules/@earendil-works/pi-coding-agent/docs/quickstart.md) 固定到 1.3.0）：

```bash
~/.pi/agent/bin/pi --version   # 期望 1.3.0
```

> 备选：`npm install -g --ignore-scripts @earendil-works/pi-coding-agent`（不固定传递依赖，
> 且不是 `~/.pi/agent` 布局——settings.json 的相对扩展路径会失效，不推荐）。

---

## 2. 部署 PiAgents 工作区（扩展 + 指令 + 工具）

从旧机把整个 PiAgents 目录拷到新机的 `/Users/<你>/PiAgents/`（用 `rsync` 或 git bundle，
注意排除各仓库的 `.git` 之外的私有数据；`knowledge-base/`、`packages/pi-project-coordinator/`
是独立仓库，按需一并拷贝）。必须包含：

```
PiAgents/
├── AGENTS.md                 # 项目级指令（工作区协调者）
├── instructions/             # 注意：没有 roles/ 目录，实际是 agents/
│   ├── DELEGATION-ROUTING.md
│   ├── GENERAL-ARCHITECTURE.md
│   ├── PROJECT-AGENTS.md
│   ├── PI-项目对话与子代理运行说明.md
│   └── agents/               # 全局角色模板：scout/planner/coder/operator/reviewer/researcher（各含 AGENTS.md + skills/ + records/）
├── packages/                 # 6 个 vendored 扩展 + pi-project-coordinator（协调引擎，独立 npm 包）
│   ├── pi-fork/
│   ├── pi-minimal-subagent/
│   ├── pi-observational-memory/
│   ├── pi-usage-log/
│   ├── pi-delegation-gate/
│   └── pi-superagent/        # 带 node_modules（依赖 yaml），整目录拷
└── tools/
    └── delegation_gate.py    # 委派门禁校验脚本（全局 AGENTS.md 按绝对路径调用）
```

**扩展溯源（`UPSTREAM.json`，迁移后应原样保留在包内）**：

| 扩展 | 上游 | 本地改造 |
|---|---|---|
| pi-fork | github.com/elpapi42/pi-fork @ `e69725c` | 见 PROJECT-ARCHITECTURE.md，非上游原样 |
| pi-minimal-subagent | npm pi-minimal-subagent@0.1.0 | 增加了深度预算嵌套（`PI_SUBAGENT_DEPTH`，上限 2），替代原来的硬禁止递归 |
| pi-observational-memory | npm pi-observational-memory@3.1.4 | 见 PROJECT-ARCHITECTURE.md |
| pi-superagent | github.com/aicodewith-team/pi-superagent @ `fd93937`（MIT） | 安全本地化：worker 只加载本扩展启动（`--mode rpc --no-session --no-extensions --no-mcp --no-approve --offline -e`）；guard 的凭据 DENY 规则扩展到 `~/.pi`/`auth.json`/`models.json`；`subagent_spawn` 的 cwd 被 realpath 限制在当前项目内。**上游面向 pi-coding-agent ^1.4.0，本机跑 1.3.0**——升级 Pi 前先验证 loader 兼容性 |
| pi-usage-log / pi-delegation-gate | 本地自研，无 UPSTREAM.json | — |

---

## 3. 写 `~/.pi/agent/settings.json`（包注册 + 各扩展配置）

本机实际内容（密钥不涉及，可直接照抄；`deviceId` 会由 Pi 自动生成，可留空删掉）：

```json
{
  "lastChangelogVersion": "1.3.0",
  "packages": [
    "npm:@llblab/pi-telegram",
    "../../PiAgents/packages/pi-fork",
    "../../PiAgents/packages/pi-minimal-subagent",
    "../../PiAgents/packages/pi-observational-memory",
    "../../PiAgents/packages/pi-usage-log",
    "../../PiAgents/packages/pi-delegation-gate",
    "../../PiAgents/packages/pi-superagent"
  ],
  "pi-fork": {
    "extensions": [],
    "offline": true,
    "costFooter": true
  },
  "observational-memory": {
    "observeAfterTokens": 10000,
    "reflectAfterTokens": 20000,
    "observerChunkMaxTokens": 12000,
    "compactAfterTokens": 81000,
    "compactAfterTokensMode": "calibrated",
    "agentMaxTokens": 8192,
    "showWorkerNotifications": true,
    "passive": false,
    "debugLog": false
  }
}
```

要点：
- `packages` 数组就是扩展加载清单：1 个 npm 包（Telegram，可删）+ 6 个本地目录（相对
  `~/.pi/agent/`，所以 `../../PiAgents/...` = `/Users/<你>/PiAgents/...`）。
- `pi-fork` 配置块：`offline: true`（fork 子进程离线跑，成本显示在页脚）。
- `observational-memory` 配置块：各 token 阈值。**不装该扩展就把这段一起删**。
- 用 `pi install <本地路径>` 也可以注册，但本机现状就是 settings.json 直列路径，照抄最稳。

---

## 4. 配 `~/.pi/agent/models.json`（训练机模型走本地隧道）

本机实际内容中的关键条目（`apiKey` 是占位符，vLLM 不收真 key）：

```json
{
  "providers": {
    "training-coder": {
      "baseUrl": "http://127.0.0.1:18002/v1",
      "api": "openai-completions",
      "apiKey": "local-vllm",
      "models": [
        {
          "id": "Qwen3-5",
          "name": "Qwen3-Coder-Next (training server)",
          "input": ["text"],
          "contextWindow": 262144,
          "maxTokens": 8192
        }
      ]
    }
  }
}
```

- `baseUrl` 指向**本机隧道端口 18002**（隧道把训练机 `localhost:8002` 的 vLLM 映射进来，见 §7）。
- 本机该文件里还有一条 `glm-5.2` provider，内含**真实 API key**——迁移时从旧机文件里取出、
  加密传输、落到新机的 models.json，**不要把 key 写进任何文档/git**。
- 配好后 `/model` 里应能看到 `training-coder/Qwen3-5`。

---

## 5. 全局指令与工作区指令

- **全局**：把旧机 `~/.pi/agent/AGENTS.md` 原样拷到新机同路径。它定义：自动委派、best-of-N
  并行候选、角色边界（fork=实现者/subagent=顾问与执行者）、注意力纪律、多项目协调、
  知识库约定、`tools/delegation_gate.py` 校验的绝对路径调用。
- **项目级**：`PiAgents/AGENTS.md` 随目录一起过来。
- **instructions/**：整目录拷（见 §2）。全局 AGENTS.md 直接按路径引用
  `instructions/DELEGATION-ROUTING.md` 和 `instructions/agents/<角色>/`，**路径变了引用就断**。

---

## 6. 激活分发层（subagent_spawn / subagent / fork）

分发层由 3 个扩展组成：**pi-superagent**（`subagent_spawn`、`subagent_list/status/message/stop/result`、
`report_to_parent`、bash 工具调用 guard）、**pi-minimal-subagent**（`subagent` 工具 + 状态面板 +
深度预算嵌套）、**pi-fork**（`fork` 工具）。pi-delegation-gate 给 fork 加前置门禁。

步骤：
1. settings.json 的 `packages` 已列好（§3）→ 启动 `pi`；扩展在会话启动时加载。
2. 若改动过 settings.json / 扩展代码：在 TUI 里敲 **`/reload`** 重新加载扩展。
3. 验证：`/help` 或工具列表里出现 `subagent_spawn`、`subagent`、`fork`；pi-superagent 的 guard
   激活标志是——bash 里碰 `~/.pi`、`models.json`、凭据路径会被 guard 拦下并回
   `pi-superagent guard: credential access`（本机会话里已实测命中）。
4. 可选环境变量：`PI_SUBAGENT_MAX`（并发子代理上限，默认 3）、`PI_SUBAGENT_DEPTH`（嵌套上限 2）。
   子代理日志落在项目内 `.pi/subagents/<id>/`。
5. 注意（上游 UPSTREAM.json 已声明）：pi-superagent 上游面向 pi-coding-agent ^1.4.0，本机 1.3.0
   实测可用；若 `pi update` 升级，先跑它的 `npm run check` 和一次真实 `subagent_spawn` 冒烟。

---

## 7. SSH 转发说明（单独专节）：127.0.0.1:18002 → 训练机 localhost:8002

### 7.1 目标拓扑

- 训练机：`106.54.195.163`，端口 **22**，用户 **chenzhuang**（`~/.ssh/config` 里有同名 Host 条目）。
- 远端 vLLM 监听 `127.0.0.1:8002`（仅本机可达）→ 隧道映射到本机 `127.0.0.1:18002`。
- 本机 SSH 私钥：**`~/.ssh/id_ed25519`**（脚本未写 `-i`，走默认身份文件；只引用路径，密钥内容不进文档）。
- Host key 指纹（从 `~/.ssh/known_hosts` 读出，脚本用 `HostKeyAlgorithms=ssh-ed25519` 只认 ED25519 这条）：
  **`SHA256:WOBXHiYZ+wxq5QTfcflNMIKgWgNAYJRXrZMi+UKwH6E`**（ED25519，106.54.195.163）。
  known_hosts 里另有 RSA `SHA256:Na2FzXZXhinpXlzcN5uBcuU5hCBqj92hvOfYJdMyGJ8` 与
  ECDSA `SHA256:8RRV+nHlRPgjjsRfY2ZJNkcNFU7ZfMVOEG4q08kn1ng`，但隧道脚本不接受它们。

### 7.2 一次性手动转发（验证用）

```bash
/usr/bin/ssh -N \
  -L 127.0.0.1:18002:127.0.0.1:8002 \
  -o ExitOnForwardFailure=yes \
  -o ServerAliveInterval=15 -o ServerAliveCountMax=2 \
  -o TCPKeepAlive=yes \
  -o ConnectTimeout=10 -o ConnectionAttempts=1 \
  -o BatchMode=yes -o StrictHostKeyChecking=yes \
  -o UserKnownHostsFile=$HOME/.ssh/known_hosts -o GlobalKnownHostsFile=/dev/null \
  -o UpdateHostKeys=no -o PreferredAuthentications=publickey -o PasswordAuthentication=no \
  -o KbdInteractiveAuthentication=no -o HostKeyAlgorithms=ssh-ed25519 \
  -o ForwardAgent=no -o ForwardX11=no -o RequestTTY=no -o ControlMaster=no -o ControlPath=none \
  -p 22 -l chenzhuang 106.54.195.163
```

各选项意图：`ServerAliveInterval=15/CountMax=2` → 掉线约 30s 内被本机主动发现；`TCPKeepAlive`
双保险；`BatchMode=yes` 永不弹交互（保证 watchdog 能无人值守重连）；`StrictHostKeyChecking=yes` +
固定 known_hosts + 只认 ED25519 → 防 host key 被换（新 key 会直接失败而不是静默接受）；
`ExitOnForwardFailure=yes` → 端口占不住立即退出，交给外层循环重试。

### 7.3 watchdog 自启模式（本机现行方案，脚本位于 `/tmp/tunnel-watchdog.sh`）

一个 `while true` bash 循环包住上面的 ssh 命令：ssh 退出 → 写日志 → `sleep 5` → 重连。
本机脚本全文（无密钥，可整段复制）：

```bash
#!/bin/bash
# Auto-reconnecting SSH tunnel: 127.0.0.1:18002 -> training-deploy-01:8002 (Qwen3-5 vLLM)
LOG=/tmp/tunnel-watchdog.log
while true; do
  echo "$(date -u +%FT%TZ) tunnel up" >> "$LOG"
  /usr/bin/ssh -N \
    -L 127.0.0.1:18002:127.0.0.1:8002 \
    -o ExitOnForwardFailure=yes \
    -o ServerAliveInterval=15 -o ServerAliveCountMax=2 \
    -o TCPKeepAlive=yes \
    -o ConnectTimeout=10 -o ConnectionAttempts=1 \
    -o BatchMode=yes -o StrictHostKeyChecking=yes \
    -o UserKnownHostsFile=$HOME/.ssh/known_hosts -o GlobalKnownHostsFile=/dev/null \
    -o UpdateHostKeys=no -o PreferredAuthentications=publickey -o PasswordAuthentication=no \
    -o KbdInteractiveAuthentication=no -o HostKeyAlgorithms=ssh-ed25519 \
    -o ForwardAgent=no -o ForwardX11=no -o RequestTTY=no -o ControlMaster=no -o ControlPath=none \
    -p 22 -l chenzhuang 106.54.195.163
  echo "$(date -u +%FT%TZ) tunnel died (exit $?), reconnect in 5s" >> "$LOG"
  sleep 5
done
```

启动方式（本机现状：终端里作为普通后台进程跑的，**没有** launchd/cron 条目——`crontab -l`、
`launchctl list`、`~/Library/LaunchAgents` 均无隧道条目，`ps` 实测为
`bash /tmp/tunnel-watchdog.sh` + 子 ssh 进程）：

```bash
nohup bash /tmp/tunnel-watchdog.sh >/dev/null 2>&1 &
```

### 7.4 新 Mac 上的落地要点（照做即可复刻，并修掉两个坑）

1. **把脚本从 `/tmp` 挪到持久位置**：macOS 重启会清空 `/tmp`，旧机重启后 watchdog 就没了
   （这也是旧机日志只有一行"tunnel up"的原因——重启后是手动重跑的）。建议放
   `~/bin/tunnel-watchdog.sh` 或 `PiAgents/tools/` 内。
2. **known_hosts 预置**：把 `106.54.195.163` 的 ED25519 条目（指纹
   `SHA256:WOBXHiYZ+wxq5QTfcflNMIKgWgNAYJRXrZMi+UKwH6E`）拷进新机 `~/.ssh/known_hosts`，
   或首次用 `ssh-keyscan -t ed25519 106.54.195.163` 核对指纹一致后再写入。
   指纹对不上 = 中间人，停。
3. **私钥**：`~/.ssh/id_ed25519` 从旧机加密传输到新机同路径，`chmod 600`。
4. **可选持久化（旧机目前没有，按需自建）**：写一个 LaunchAgent
   （`~/Library/LaunchAgents/com.yuyuan.vllm-tunnel.plist`，`KeepAlive=true` 跑 7.3 的脚本）
   即可开机自启 + 崩溃自拉起；要不要做由操作者决定，本机现状就是手动 nohup。
5. **验证**：
   ```bash
   curl -s http://127.0.0.1:18002/v1/models   # 应列出 Qwen3-5 等模型
   tail /tmp/tunnel-watchdog.log              # 断线重连记录（UTC 时间戳）
   ```
   然后在 pi 里 `/model` 切到 `training-coder/Qwen3-5` 发一条消息，端到端确认。

---

## 8. 迁移后验收清单

- [ ] `pi --version` = 1.3.0
- [ ] `pi` 启动后工具列表含 `fork`、`subagent`、`subagent_spawn`、`report_to_parent`（及 `/usage`，若装了 usage-log）
- [ ] bash 触碰 `~/.pi`/凭据被 guard 拦（`pi-superagent guard: credential access`）
- [ ] `curl 127.0.0.1:18002/v1/models` 出模型；pi 里切 `training-coder/Qwen3-5` 可用
- [ ] 委派冒烟：让主代理 `subagent_spawn` 一个只读小任务，确认后台跑 + `report_to_parent` 回报 + 最终结果回注
- [ ] `python3 PiAgents/tools/delegation_gate.py --category implementation --owner subagent` 能跑（路径若变需同步改全局 AGENTS.md）
- [ ] models.json 里其他 provider（如 glm-5.2）的 key 已从旧机安全转移且未进任何文档/git