# pi-web-bridge

A local "mission control" web chat for pi: talk to the running coordinator
session and read/reply to per-subagent threads from the browser. Dark, quiet,
single-file UI in a precision-instrument design language (signal-green
live-state accent, hairline/glass depth) — no framework, no external
resources, no npm runtime deps (Node stdlib only).

The v2 layout is a **hero conversation + right LIVE WORK panel** (no left rail):

- **Hero conversation (left/center)** — the coordinator window: chat log (user
  bubbles, assistant replies that stream in live with markdown rendering and
  cumulative in-flight tool lines, tool/report events), a collapsible usage
  instrument panel, and the "Message the coordinator" composer.
- **LIVE WORK panel (right)** — one card per subagent: a status dot that pulses
  while `running`, the agent id, an unread badge counting new lines since you
  last opened it, elapsed/last-activity time, a `status · tokens · model` line,
  and a mono ticker showing the latest event (tool call, assistant text, or
  milestone report). Finished agents fold behind a "Show done" toggle.
- **Slide-over transcript** — clicking a card slides a full transcript over the
  page: status header, its own usage panel, the event log, and a reply composer
  (POSTs to `/message` with the subagent target; delivered two-hop via the
  coordinator).
- **Mobile** — the panel collapses into a live-bar at the top (status dot +
  `N running · M blocked` text + total unread badge); tapping it opens the
  panel as a drawer. Safe-area layout, device-tested at 360/390px; polling
  resumes immediately when the tab becomes visible or the network returns.

```
┌────────────────────────────────────────┬─────────────────────┐
│ Coordinator (hero conversation)        │ LIVE WORK           │
│                                        │ ● sa42        (2)   │
│   [user bubble]                        │   fix-auth  3m ·    │
│   [assistant reply]                    │   running · 45k tok │
│                                        │   › bash pytest -q  │
│ [ Message the coordinator        Send ]│ ● sa43  pulse…      │
│                                        │   › report: progress│
└────────────────────────────────────────┴─────────────────────┘
       card click → slide-over transcript + reply composer
       (mobile: live-bar "2 running · 1 blocked" opens the drawer)
```

## How it works

A pi extension (`src/extension.ts`) starts an HTTP server **inside the running
pi session** on `127.0.0.1:7788` (override with `PI_WEB_BRIDGE_PORT`). The UI is
served at `GET /`; settled state is read from disk (session JSONL +
`.pi/subagents/` log dirs written by pi-superagent) and polled by the browser,
while in-flight assistant output streams from pi's
`message_start`/`message_update`/`message_end` hooks (`GET /stream` — the
session JSONL only persists complete messages).

### Injection mechanism (the exact pi API)

Web messages wake the coordinator through the same delivery path pi-superagent
uses for subagent reports, with one refinement: a main-target message steers
into an in-flight turn instead of waiting for the whole run to end.

```ts
pi.sendMessage(
  { customType: "web-chat", content: text, display: true },
  injectionOptions(kind, streaming), // { triggerTurn: true, deliverAs: ... }
);
```

`triggerTurn: true` starts a turn when the agent is idle. Delivery while the
agent is busy (tracked via `agent_start`/`agent_settled`; pi re-checks the real
state inside `sendCustomMessage`, so a stale flag only lands on the other safe
native path):

- **main target, streaming** — `deliverAs: "steer"`: pi delivers the message
  after the current assistant turn's tool calls finish, before the next LLM
  call (the same boundary pi-telegram's steer packets target), so long-running
  turns no longer swallow replies. pi holds the message until that boundary —
  it never lands between a tool call and its result.
- **main target, idle** — `deliverAs: "followUp"`: the previous exact behavior
  (pi ignores `deliverAs` when idle; `triggerTurn` starts the run).
- **subagent target** — always `deliverAs: "followUp"` (two-hop fallback
  unchanged).

The injected entry lands in the session JSONL as
`{"type":"custom_message","customType":"web-chat",…}`, which is exactly what
the UI's main window parses back out.

**Subagent replies are a two-hop fallback:** pi-superagent's steer pathway
(`{type:"steer"}` on the child's stdin) lives inside its private
`SubagentManager` instance and is not reachable from another extension. So
`POST /message` with `target: "subagent:<id>"` injects into the main session
with the header `[web-chat · for-subagent:<id>] <text>` and the coordinator
forwards it via its own `subagent_message` tool. The user just types in the
subagent's window; routing metadata travels in the request, never in the text.

## API (all on 127.0.0.1, GET/POST only, 32KB body cap)

| Route | Purpose |
|---|---|
| `GET /` | the single-file UI |
| `GET /state` | `{project, now, mainSessionAlive, main:{sessionFile, sessionMtime, alive}, subagents:[{id,label,session,model,status,lastActivity,lastExcerpt,result}]}` — status is `running` / `blocked` (last `report_to_parent` status) / `done` (`result.md` present) |
| `GET /main-log?after=<byteCursor>[&file=<sessionPath>]` | incremental conversation items parsed from the session JSONL: `web-chat` custom messages (user) + assistant text entries + one compact line per `toolCall` block (terminal-like activity flow); `{file, cursor, reset, items:[{kind:"user"|"assistant"|"tool",name?,text,ts,id,offset}]}` — the additive `file` param lets the server deep-read the log straight from the client's cursor when it has fallen behind the item ring (no gap after a busy turn or a suspended tab) |
| `GET /stream` | live in-flight assistant view fed by the pi `message_start`/`message_update`/`message_end` hooks (the session JSONL only persists complete messages, so this is the only true streaming source): `{streaming, text, turnStartedAt, runStartedAt, tool:{name,summary}|null, tools:[{id,name,summary}]}` — `text` is bounded to the last 8000 chars of the growing reply; `tools` accumulates every tool call of the current run in order (bounded to the last 30, deduped by toolCall id) so earlier calls stay visible while the next one streams; the single-slot `tool` field is kept for backward compatibility |
| `GET /history?before=<byteOffset>[&limit=N]` | backwards-paged main-conversation history: up to `limit` items (default 200, max 500) strictly before the byte offset; `{items, oldest}` — `oldest` is the next page's `before`, `null` at file start |
| `GET /sub-history?id=<id>&before=<byteOffset>[&limit=N]` | the same backwards paging over a subagent's events.jsonl (default 300, max 1000) |
| `GET /sub-log?id=<id>&after=<byteCursor>` | compact events.jsonl tail (`tool` / `assistant` / `report` / `event` lines) + `result` (tail of result.md); `{id, cursor, reset, lines, result, done}` |
| `POST /message` | body `{target:"main"|"subagent:<id>", text}` → injects `[web-chat · project:<cwd-basename>] <text>` (or `[web-chat · for-subagent:<id>] <text>`); responds `{ok:true, routed:"main"|"main-for-subagent", id?}` |

Security: loopback binding only; Host and Origin header checks (DNS-rebinding /
CSRF guards); 32KB body cap; subagent ids validated against a strict pattern;
no eval, no dynamic code paths.

## Install

The bridge is additive; it changes nothing in settings or other packages.

1. Register the package for auto-load — **edit this yourself** (the package
   never touches settings.json): add to `~/.pi/agent/settings.json`:

   ```json
   "packages": [
     "...existing entries...",
     "../../PiAgents/packages/pi-web-bridge"
   ]
   ```

   Or try it one-off without registering: `pi -e packages/pi-web-bridge/src/extension.ts`

2. Restart pi. On session start the status bar shows the bridge URL. A second
   pi session on the same machine detects the busy port, logs
   `server error: EADDRINUSE (bridge inactive)` and keeps running — exactly one
   bridge is live at a time.

### Dev dependencies (only for `npm run check`)

No runtime deps. For typecheck/tests, `npm install` inside the package pulls
`typescript`, `@types/node` and `@earendil-works/pi-coding-agent`. (On this
host the repo already carries offline symlinks in `node_modules/` pointing at
the running 1.5.0 install, so `npm run check` works without network.)

## Launch

**Preferred:** the server lives inside pi — it starts and stops with the
session, nothing to run by hand.

**Read-only standalone preview** (no injection; watches logs only):

```sh
cd packages/pi-web-bridge
node scripts/standalone-server.mjs /path/to/project &   # foreground job in background
```

Do not wire it into launchd/cron — this is a dev/preview helper, the real
bridge belongs to the pi session.

**Remote/deployed access:** the server binds loopback only. All UI `fetch()`
paths are relative, so it can sit behind an nginx sub-path (e.g.
`location /pi-bridge/`) or be exposed through an SSH reverse tunnel to the
loopback port; put your own auth in front of it — the bridge itself has none
by design.

## Tests

```sh
cd packages/pi-web-bridge
npm run check        # tsc --noEmit && node --test tests/
```

83 tests, Node built-in test runner:

- **routing** — `/message` header building, subagent fallback, 404 on unknown
  ids, validation, 503 on refused injection, `/state` and `/sub-log` against a
  live server with a mocked `inject` emitter
- **inject** — delivery decisions: main-target steers into a busy turn /
  followUp when idle, subagent-target always followUp
- **history** — the backwards JSONL pager behind `/history`/`/sub-history`:
  byte-offset pages are true line starts, incomplete tails skipped,
  `oldest=null` at file start
- **stream** — `message_start`/`message_update`/`message_end` extraction and
  the cumulative per-run tool list (dedup by toolCall id, 8000-char text bound)
- **usage** — tools/subagents/skills/token counting over subagent event-stream
  lines feeding the append-only `subagents-usage.jsonl` ledger
- **shutdown** — `closeBridge` force-closes tracked keep-alive sockets so the
  port frees immediately on `/reload`; double-close is a no-op
- **state** — subagent status/label/model/excerpt derived from a **real
  redacted events.jsonl fixture** (`tests/fixtures/sa-fixture/`, copied from
  `.pi/subagents/sa1/`, credential-looking strings replaced), plus ordering and
  cache behavior
- **security** — loopback-only bind, Host spoof → 403, foreign Origin → 403,
  >32KB body → 413, bad method → 405, traversal-proof ids, zero external
  resources in the served HTML
- **loader** — the extension loads through the **real pi 1.5.0 loader**
  (`~/.pi/agent/install/releases/<current>/…/extensions/loader.js`) with zero
  errors/warnings

## Limitations

- Subagent replies cost a coordinator turn (two-hop delivery; no direct steer
  without pi-superagent cooperation).
- Subagent `label` is the first line of the child's task; `session` (named
  persistent sessions) is not recoverable from disk and always `null`.
- The main window backfills the last ~512KB of the session file (bounded ring
  of 300 items); older history loads on demand via backwards-paged `/history`.
  TUI-typed user messages are not rendered — only web-sent messages and
  assistant replies.
- `blocked` detection scans the last 64KB of events.jsonl; a blocked report
  buried deeper than that shows as `running`.
- One bridge per machine (port conflict → later sessions run without a bridge).
- Trust boundary is the loopback: any local process can read logs or inject
  messages. There is no token auth by design (localhost tool, not a service).
