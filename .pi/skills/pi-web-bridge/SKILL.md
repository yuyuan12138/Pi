---
name: pi-web-bridge
description: Operate, deploy, and debug the pi-web-bridge Mission Control (browser UI for messaging the pi coordinator and watching subagents live). Use when the UI shows "bridge offline" or "not delivered", when deploying/activating the bridge, when messages from the web UI never arrive, or when touching the nginx/tunnel chain on 47.114.61.92.
---

# pi-web-bridge Mission Control

Single-file UI + HTTP server inside the pi process (`packages/pi-web-bridge`, extension
registered in `~/.pi/agent/settings.json` packages). Server binds `127.0.0.1:7788` in-session;
endpoints: `GET /state`, `/main-log?after=N`, `/sub-log?id=..&after=N`, `POST /message`
(`{target: "main"|"subagent:<id>", text}`).

## Access chain (public)

```
browser → http://47.114.61.92/pi-bridge/ (Basic auth pi)
        → nginx container (per-directory bind mounts) → unix socket
          /root/interview-practice-platform/pi-docs/bridge.sock
        → reverse SSH tunnel (ssh -fN -R ...bridge.sock:127.0.0.1:7788, keepalive loop
          ~/.pi/agent/scripts/pi-web-bridge-tunnel-keepalive.sh, log /tmp/pi-web-bridge-tunnel-keepalive.log)
        → in-session bridge server (index.html re-read from src/ on EVERY request —
          editing the file deploys with just a browser refresh, no reload/restart)
```

## Failure triage (ordered by what actually broke)

1. **"bridge offline" / "not delivered" from the browser while curl works** — if the page is
   served under a sub-path (nginx `location /pi-bridge/`), ALL `fetch()` paths in the UI must be
   RELATIVE (`state`, not `/state`); a leading slash resolves against the domain root and hits
   whatever else the server hosts (here: the jobcoder app). This was the real bug behind every
   "curl green / browser offline" split-brain: the two sides were literally fetching different
   URLs. Fix in `api()` (commit 010f5ae): `fetch(path.replace(/^\/+/, ""), opts)`.
   **Verify what the BROWSER requests, not what the server answers** — curl the exact browser URL
   (including the sub-path prefix), never the stripped internal path.
2. **POST returns ok but no turn arrives** — followUp queue semantics: `pi.sendMessage` with
   `deliverAs followUp` queues while the main session is streaming and flushes only at turn end.
   Latency = remaining duration of the in-flight turn. Not message loss.
3. **/state 200 but stale after a pi restart** — the listener owner changed. `lsof -iTCP:7788 -sTCP:LISTEN`
   and compare the PID to the current pi process; an orphaned standalone server (standalone-server.mjs)
   must be killed before the extension can bind. Restarting pi re-registers the extension automatically.
4. **Public 502/timeout** — check keepalive log for "server-side check FAILED; re-establishing";
   the tunnel re-establishes itself in ~4s. Do not restart anything manually within one keepalive cycle.
5. **UI never connects even at correct URL** — hard refresh (Cmd+Shift+R); browsers cache both the
   HTML and stale Basic-auth credentials from before a password change.

## Operational rules

- The bridge server is READ-ONLY about auth: `/message` write path exists only with the extension
  active in a live pi session (settings.json + /reload). A standalone server is preview-only and
  cannot inject turns.
- Reload/restart of pi kills in-flight background subagents — activate the extension only when the
  worker fleet is drained.
- The in-session server injects messages as `[web-chat · project:<name>]` custom messages with
  triggerTurn — enumerate `customType` entries in the session JSONL to verify arrival; grepping raw
  strings false-positives on the agent's own bash commands.
