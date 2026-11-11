---
name: detached-process
description: How to launch long-running processes that survive the tool call on macOS — nohup + background + disown, setsid unavailable, survival verified before reporting. Use before any launch/daemon step in a runbook.
---

# Skill: detached process discipline (operator)

## Why
A process launched in the foreground — or with its output attached to the
tool call's tty — dies when the tool call aborts or the session ends: the
launch command "succeeded" and the service is gone. Even `nohup` children
can die with an aborted tool call when they stay in the call's process
group; only verified detachment counts.

## Procedure (macOS)
1. Launch detached in ONE command: `nohup <cmd> > <logfile> 2>&1 &` —
   nohup AND background together. `setsid` is unavailable on macOS; do not
   reach for it.
2. For full detachment from the tool call's process group, double-fork via
   a subshell: `( <cmd> > <logfile> 2>&1 & )` — the intermediate shell
   exits immediately, the child is reparented and survives the call.
3. Capture the pid (`$!` from the launching shell) and register it where
   the runbook says, together with the completion/progress marker.
4. Verify survival BEFORE reporting: sleep a few seconds, then `kill -0
   <pid>`, confirm the process is still alive, and check the log for the
   expected startup lines. A launch without a survival check is an
   unknown outcome, not a success.
5. After a verified launch: STOP — no inline monitoring; hand the marker
   path and pid to the sentinel (see `monitoring.md`).
6. On relaunch: find and terminate (per the runbook) any stale previous
   instance first; two live instances is a corruption risk, not
   redundancy.
