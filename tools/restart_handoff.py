#!/usr/bin/env python3
"""Restart handoff ledger for the PiAgents coordinator (expansion plan A1).

Before a coordinator restart, `snapshot` dumps in-flight state to disk so no
dispatch is silently lost:
  - subagent snapshot parsed from the pi-superagent events dirs
    (.pi/subagents/<id>/events.jsonl mtime + running/done inference), and
  - the background process list (pi sessions, bridge keepalive, tunnels,
    model server) matched via pgrep-style regex patterns.
It writes .pi/restart-handoff-<ts>.json plus a markdown summary next to it.

After the restart, `resume` reads the newest handoff file and prints the
reconciliation list: which dispatches need re-launch (and which resolved on
their own before the process died).

Stdlib only; the only subprocess is a local read-only `ps`. No network calls.

Usage:
    python3 tools/restart_handoff.py snapshot [--root DIR] [--pattern REGEX]...
    python3 tools/restart_handoff.py resume   [--root DIR] [--file PATH]
"""
from __future__ import annotations

import argparse
import json
import re
import subprocess
import sys
import time
from datetime import datetime
from pathlib import Path

SCHEMA = "restart-handoff/1"
TERMINAL_EVENTS = ("agent_settled", "agent_end")
STALE_SECONDS = 1800  # no terminal marker and no event activity for 30 min
RESULT_FILE = "result.md"
HANDOFF_GLOB = "restart-handoff-*.json"

DEFAULT_PATTERNS = (
    r"(^|[\s/])pi( |$)",  # pi agent sessions (tmux panes)
    r"pi-web-bridge",     # web bridge node process
    r"keepalive\.sh",     # bridge tunnel keepalive driver
    r"ssh -fN -R",        # reverse tunnels
    r"vllm",              # local model server
    r"tmux",              # tmux server / watchers
)


def _iso(epoch: float) -> str:
    return datetime.fromtimestamp(epoch).astimezone().isoformat(timespec="seconds")


def _events_tail(events: Path, nbytes: int = 65536) -> str:
    """Read the tail of an events.jsonl (terminal markers live at the end)."""
    size = events.stat().st_size
    with open(events, "rb") as handle:
        if size > nbytes:
            handle.seek(size - nbytes)
        return handle.read().decode("utf-8", "replace")


def is_done(agent_dir: Path) -> bool:
    """Done = result.md written, or a terminal event in the events tail."""
    if (agent_dir / RESULT_FILE).is_file():
        return True
    events = agent_dir / "events.jsonl"
    if not events.is_file():
        return False
    tail = _events_tail(events)
    return any(f'"{marker}"' in tail for marker in TERMINAL_EVENTS)


def scan_subagents(subagents_dir: Path, now: float | None = None,
                   stale_seconds: int = STALE_SECONDS) -> list[dict]:
    """Snapshot .pi/subagents/*: id, status, events mtime, pointer."""
    now = time.time() if now is None else now
    entries: list[dict] = []
    if not subagents_dir.is_dir():
        return entries
    for child in sorted(subagents_dir.iterdir()):
        events = child / "events.jsonl"
        if not child.is_dir() or not events.is_file():
            continue  # 'sessions', 'worktrees', stray files, ...
        done = is_done(child)
        age = int(now - events.stat().st_mtime)
        if done:
            status = "done"
        elif age <= stale_seconds:
            status = "running"
        else:
            status = "stale"  # no completion marker, no recent activity
        entries.append({
            "id": child.name,
            "status": status,
            "result": (child / RESULT_FILE).is_file(),
            "events_mtime": _iso(events.stat().st_mtime),
            "age_seconds": age,
            "dir": str(child),
        })
    return entries


def _ps_lines() -> list[str]:
    out = subprocess.run(["ps", "ax", "-o", "pid=", "-o", "command="],
                         capture_output=True, text=True, check=False)
    return out.stdout.splitlines()


def scan_processes(patterns, lines: list[str] | None = None) -> list[dict]:
    """Match pgrep-style regex patterns against the process table."""
    lines = _ps_lines() if lines is None else lines
    regexes = [re.compile(pattern) for pattern in patterns]
    matched: list[dict] = []
    for line in lines:
        line = line.strip()
        if not line:
            continue
        pid, _, command = line.partition(" ")
        if any(rx.search(command) for rx in regexes):
            matched.append({"pid": pid, "command": command.strip()})
    return matched


def markdown_summary(payload: dict) -> str:
    lines = [
        f"# Restart handoff — {payload['ts']}",
        "",
        f"Root: `{payload['root']}`",
        "Taken before a coordinator restart. Reconcile afterwards:",
        "",
        "    python3 tools/restart_handoff.py resume",
        "",
        f"## Subagents ({len(payload['subagents'])})",
        "",
        "| id | status | events mtime | age (s) | pointer |",
        "| --- | --- | --- | --- | --- |",
    ]
    for entry in payload["subagents"]:
        pointer = entry["dir"] + (" (result.md)" if entry["result"] else "")
        lines.append(f"| {entry['id']} | {entry['status']} | "
                     f"{entry['events_mtime']} | {entry['age_seconds']} | {pointer} |")
    lines += ["", f"## Background processes ({len(payload['processes'])})",
              "", "Pre-restart PIDs — all stale after a restart:", "",
              "| pid | command |", "| --- | --- |"]
    for proc in payload["processes"]:
        lines.append(f"| {proc['pid']} | `{proc['command']}` |")
    candidates = [e for e in payload["subagents"] if e["status"] != "done"]
    lines += ["", "## Re-launch candidates", ""]
    if candidates:
        lines += [f"- {e['id']} ({e['status']}) — {e['dir']}" for e in candidates]
    else:
        lines.append("None — every subagent was done at snapshot time.")
    return "\n".join(lines) + "\n"


def make_snapshot(root: Path = Path("."), patterns=None):
    """Write .pi/restart-handoff-<ts>.json + .md; return (payload, json, md)."""
    root = Path(root).resolve()
    now = time.time()
    payload = {
        "schema": SCHEMA,
        "ts": _iso(now),
        "root": str(root),
        "subagents": scan_subagents(root / ".pi" / "subagents", now=now),
        "processes": scan_processes(DEFAULT_PATTERNS if patterns is None
                                    else list(patterns)),
    }
    out_dir = root / ".pi"
    out_dir.mkdir(parents=True, exist_ok=True)
    stamp = datetime.fromtimestamp(now).strftime("%Y%m%d-%H%M%S")
    json_path = out_dir / f"restart-handoff-{stamp}.json"
    md_path = out_dir / f"restart-handoff-{stamp}.md"
    json_path.write_text(json.dumps(payload, indent=2, ensure_ascii=False) + "\n",
                         encoding="utf-8")
    md_path.write_text(markdown_summary(payload), encoding="utf-8")
    return payload, json_path, md_path


def newest_handoff(root: Path) -> Path | None:
    root = Path(root).resolve()
    files = sorted((root / ".pi").glob(HANDOFF_GLOB)) if (root / ".pi").is_dir() else []
    return files[-1] if files else None


def reconcile(payload: dict, root: Path) -> list[dict]:
    """Classify each not-done snapshot entry against the CURRENT events dirs."""
    root = Path(root).resolve()
    results = []
    for entry in payload.get("subagents", []):
        if entry.get("status") == "done":
            continue
        agent_dir = root / ".pi" / "subagents" / entry["id"]
        resolved = agent_dir.is_dir() and is_done(agent_dir)
        results.append({
            "id": entry["id"],
            "snapshot_status": entry.get("status"),
            "action": "resolved" if resolved else "needs-relaunch",
            "dir": str(agent_dir),
        })
    return results


def cmd_snapshot(args) -> int:
    payload, json_path, md_path = make_snapshot(args.root, args.pattern)
    running = [e for e in payload["subagents"] if e["status"] != "done"]
    print(f"Handoff snapshot: {json_path}")
    print(f"Summary:          {md_path}")
    print(f"Subagents: {len(payload['subagents'])} total, "
          f"{len(running)} not done (re-launch candidates if the restart kills them)")
    print(f"Processes matched: {len(payload['processes'])}")
    return 0


def cmd_resume(args) -> int:
    root = Path(args.root).resolve()
    path = Path(args.file).resolve() if args.file else newest_handoff(root)
    if path is None or not path.is_file():
        print(f"error: no restart handoff file found under {root / '.pi'}",
              file=sys.stderr)
        return 1
    payload = json.loads(path.read_text(encoding="utf-8"))
    if payload.get("schema") != SCHEMA:
        print(f"error: {path} is not a {SCHEMA} file", file=sys.stderr)
        return 1
    results = reconcile(payload, root)
    print(f"Handoff: {path} (taken {payload.get('ts', '?')})")
    print("Reconciliation (which dispatches need re-launch):")
    for row in results:
        if row["action"] == "resolved":
            print(f"  RESOLVED        {row['id']} — finished since snapshot "
                  f"(verify {row['dir']}/{RESULT_FILE})")
        else:
            print(f"  NEEDS-RELAUNCH  {row['id']} — was {row['snapshot_status']} "
                  f"at snapshot; brief/pointer: {row['dir']}")
    if not results:
        print("  (none — every subagent was done at snapshot time)")
    done_count = sum(1 for e in payload.get("subagents", [])
                     if e.get("status") == "done")
    print(f"Done at snapshot: {done_count}; "
          f"re-launch now: {sum(1 for r in results if r['action'] == 'needs-relaunch')}")
    print("Note: pre-restart PIDs in the handoff are stale after a restart; "
          "do not kill or reuse them.")
    return 0


def main(argv=None) -> int:
    parser = argparse.ArgumentParser(description=__doc__.splitlines()[0])
    sub = parser.add_subparsers(dest="command", required=True)

    snap = sub.add_parser("snapshot", help="dump in-flight state before a restart")
    snap.add_argument("--root", default=".", help="project root (default: cwd)")
    snap.add_argument("--pattern", action="append", dest="pattern",
                      help="extra pgrep-style regex (repeatable; adds to defaults)")

    res = sub.add_parser("resume", help="reconcile after the restart")
    res.add_argument("--root", default=".", help="project root (default: cwd)")
    res.add_argument("--file", default=None,
                     help="explicit handoff file (default: newest under .pi/)")

    args = parser.parse_args(argv)
    if getattr(args, "pattern", None):
        args.pattern = DEFAULT_PATTERNS + tuple(args.pattern)
    return cmd_snapshot(args) if args.command == "snapshot" else cmd_resume(args)


if __name__ == "__main__":
    sys.exit(main())
