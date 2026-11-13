#!/usr/bin/env python3
"""Harvest checker for the PiAgents coordinator (expansion plan B5, Theme B).

Flags dispatched work whose memory was never harvested: a DONE subagent whose
result was substantial, but where NEITHER the worker-role's
instructions/agents/<role>/records/experience.md gained an entry after the
worker finished, NOR the project's work/ tree gained a RECORD.md after the
worker finished (or one references the subagent id directly).

"Harvest" here is the AGENTS.md obligation: after verifying a child's result,
the parent appends transferable lessons to the role's records/experience.md
and/or the dispatch lands a work/ RECORD in the project space. The checker is
REPORT-ONLY: it writes nothing, blocks nothing, exits 0 unless --strict.

Reuse-over-drift (same pattern as the A3 reload-safety guard): done/stale
inference comes from importing tools/restart_handoff.py's scan_subagents() as
a library — the status semantics are defined in exactly one place.

Usage:
    python3 tools/harvest_check.py [--root DIR] [--days N] [--min-result-chars N]
                                   [--subagents-dir DIR] [--work-dir DIR] [--strict]
Exit codes: 0 = clean or advisory findings; 1 (--strict only) = flagged work.
"""
from __future__ import annotations

import argparse
import json
import re
import subprocess
import sys
import time
from pathlib import Path

# Library import of the A1 tool (no copied status logic).
sys.path.insert(0, str(Path(__file__).resolve().parent))
import restart_handoff as rh  # noqa: E402

EXPERIENCE_GLOB = "instructions/agents/*/records/experience.md"
RECORD_GLOB_PATTERNS = ("work/**/RECORD*.md", "work/**/RECORD*.mdx")
DEFAULT_MIN_RESULT_CHARS = 1000
DEFAULT_DAYS = 1


def first_user_brief(events_path: Path, max_bytes: int = 262_144) -> str:
    """Extract the task brief: the first user message text in events.jsonl.

    Reads only the head of the file (the brief is the first dispatch payload);
    tolerates content as str or [{type:'text',text},...] blocks.
    """
    try:
        with open(events_path, "rb") as handle:
            head = handle.read(max_bytes)
    except OSError:
        return ""
    for line in head.decode("utf-8", "replace").splitlines():
        line = line.strip()
        if not line:
            continue
        try:
            rec = json.loads(line)
        except json.JSONDecodeError:
            continue
        if rec.get("type") != "message_end":
            continue
        message = rec.get("message") or {}
        if message.get("role") != "user":
            continue
        content = message.get("content", "")
        if isinstance(content, str):
            text = content
        elif isinstance(content, list):
            text = "\n".join(
                block.get("text", "") for block in content
                if isinstance(block, dict) and block.get("type") == "text"
            )
        else:
            text = ""
        return text.strip()
    return ""


def detect_role(brief: str, role_dirs: list[str]) -> str | None:
    """Role named in the brief (instructions/agents/<role>/ naming); else None."""
    for role in sorted(role_dirs, key=len, reverse=True):
        if role in ("readme", "agents"):
            continue
        if re.search(rf"\b{re.escape(role)}\b", brief):
            return role
    return None


def experience_harvested(root: Path, role: str | None, finish_ts: float) -> list[Path]:
    """Experience files modified after the worker finished.

    Always scans ALL roles' records/experience.md: the parent may harvest to a
    different role file than the brief suggests, and a wrong role guess must
    not create a false flag. `role` is report metadata only.
    """
    hits: list[Path] = []
    for path in root.glob(EXPERIENCE_GLOB):
        try:
            if path.stat().st_mtime > finish_ts:
                hits.append(path)
        except OSError:
            continue
    return hits


def record_harvested(root: Path, subagent_id: str, finish_ts: float) -> list[Path]:
    """work/ RECORDs newer than the finish, or referencing the subagent id."""
    hits: list[Path] = []
    seen: set[Path] = set()
    for pattern in RECORD_GLOB_PATTERNS:
        for path in root.glob(pattern):
            if path in seen:
                continue
            seen.add(path)
            try:
                newer = path.stat().st_mtime > finish_ts
            except OSError:
                continue
            if newer:
                hits.append(path)
                continue
            try:
                if subagent_id in path.read_text(encoding="utf-8", errors="replace"):
                    hits.append(path)
            except OSError:
                continue
    return hits


def git_harvest_evidence(root: Path, since_ts: float) -> dict[str, float]:
    """One bounded `git log` call: harvest-path -> latest commit touching it at/after since_ts.

    Catches the worker-authored-RECORD case: the worker writes its own work/ RECORD
during the run (mtime pre-finish) and the parent commits it after verification —
the commit time is the reliable 'parent accepted' signal. Fail-open: any git
failure (not a repo, git missing) yields an empty map; mtime evidence still applies.
    """
    if not (root / ".git").exists():
        return {}
    since_iso = time.strftime("%Y-%m-%dT%H:%M:%S%z", time.localtime(since_ts))
    try:
        proc = subprocess.run(
            ["git", "-C", str(root), "log", f"--since={since_iso}", "--name-only", "--pretty=format:%ct"],
            capture_output=True, text=True, timeout=15,
        )
        if proc.returncode != 0:
            return {}
    except (OSError, subprocess.TimeoutExpired):
        return {}
    latest: dict[str, float] = {}
    current_ts: float | None = None
    for line in proc.stdout.splitlines():
        line = line.strip()
        if not line:
            continue
        if line.isdigit():
            current_ts = float(line)
            continue
        if current_ts is not None:
            latest[line] = max(latest.get(line, 0.0), current_ts)
    return latest


def check(root: Path, days: int = DEFAULT_DAYS, min_result_chars: int = DEFAULT_MIN_RESULT_CHARS,
          subagents_dir: Path | None = None, work_dir: Path | None = None,
          now: float | None = None) -> dict:
    """Scan done subagents in the window; return the report dict (no writes)."""
    now = time.time() if now is None else now
    root = root.resolve()
    subs_dir = subagents_dir if subagents_dir is not None else root / ".pi" / "subagents"
    work_root = work_dir if work_dir is not None else root
    window_seconds = days * 86400

    roles = sorted(p.name for p in (root / "instructions" / "agents").glob("*") if p.is_dir())
    entries = rh.scan_subagents(subs_dir, now=now)

    report: dict = {
        "window_days": days,
        "done_total": 0,
        "in_window": 0,
        "skipped_small": 0,
        "harvested": [],
        "flagged": [],
        "checked_at": now,
    }
    window_start = now - window_seconds
    git_evidence: dict[str, float] | None = None
    for entry in entries:
        if entry["status"] != "done":
            continue
        report["done_total"] += 1
        if entry["age_seconds"] > window_seconds:
            continue  # older than the checked window
        report["in_window"] += 1
        agent_dir = Path(entry["dir"])
        subagent_id = entry["id"]

        result_path = agent_dir / rh.RESULT_FILE
        try:
            result_size = result_path.stat().st_size if result_path.is_file() else 0
        except OSError:
            result_size = 0
        if result_size < min_result_chars:
            report["skipped_small"] += 1  # bounded check / trivial consult: no harvest obligation
            continue

        brief = first_user_brief(agent_dir / "events.jsonl")
        finish_ts = (agent_dir / "events.jsonl").stat().st_mtime
        role = detect_role(brief, roles)
        exp_hits = experience_harvested(root, role, finish_ts)
        rec_hits = record_harvested(work_root, subagent_id, finish_ts)
        # Git evidence (one shared log call): a harvest path committed at/after the
        # finish (60s grace for mtime/commit skew) counts even when the file's
        # mtime predates the finish (worker-authored RECORDs, committed by the parent).
        if git_evidence is None:
            git_evidence = git_harvest_evidence(root, window_start)
        grace = finish_ts - 60
        for rel_path, commit_ts in git_evidence.items():
            if commit_ts < grace:
                continue
            if "experience.md" not in rel_path and "RECORD" not in Path(rel_path).name:
                continue
            p = root / rel_path
            if not p.is_file():
                continue
            if "experience.md" in rel_path:
                if p not in exp_hits:
                    exp_hits.append(p)
            elif p not in rec_hits:
                rec_hits.append(p)
        row = {
            "id": subagent_id,
            "age_seconds": entry["age_seconds"],
            "role": role,
            "result_chars": result_size,
            "brief_excerpt": brief[:140].replace("\n", " "),
            "experience_hits": [str(p.relative_to(root)) if p.is_relative_to(root) else str(p) for p in exp_hits],
            "record_hits": [str(p.relative_to(work_root)) if p.is_relative_to(work_root) else str(p) for p in rec_hits],
        }
        if exp_hits or rec_hits:
            report["harvested"].append(row)
        else:
            report["flagged"].append(row)
    return report


def format_report(report: dict) -> str:
    lines: list[str] = []
    lines.append(
        f"harvest_check: {report['in_window']} done dispatch(es) in the last {report['window_days']}d "
        f"({report['skipped_small']} skipped as bounded checks), "
        f"{len(report['harvested'])} harvested, {len(report['flagged'])} UNHARVESTED"
    )
    if report["flagged"]:
        lines.append("")
        lines.append("Flagged (worker finished, no harvest entry found):")
        lines.append("| id | role | result B | brief (excerpt) |")
        lines.append("|---|---|---|---|")
        for row in report["flagged"]:
            lines.append(
                f"| {row['id']} | {row['role'] or '-'} | {row['result_chars']} | {row['brief_excerpt']} |"
            )
        lines.append("")
        lines.append(
            "Harvest = append transferable lessons to instructions/agents/<role>/records/experience.md "
            "and/or land a work/ RECORD in the project space (AGENT-ORG §5.1 harvest obligation). "
            "This checker is advisory: it writes nothing and blocks nothing."
        )
    return "\n".join(lines)


def main(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser(description="Report dispatched work whose memory was never harvested.")
    parser.add_argument("--root", default=".", help="coordinator repo root (default: cwd)")
    parser.add_argument("--days", type=int, default=DEFAULT_DAYS, help="window size in days (default 1)")
    parser.add_argument("--min-result-chars", type=int, default=DEFAULT_MIN_RESULT_CHARS,
                        help="results below this size are treated as bounded checks (default 1000)")
    parser.add_argument("--subagents-dir", default=None, help="override .pi/subagents location (tests)")
    parser.add_argument("--work-dir", default=None, help="override work/ root for RECORD search (tests)")
    parser.add_argument("--json", action="store_true", help="emit the raw report dict")
    parser.add_argument("--strict", action="store_true",
                        help="exit 1 when flagged work exists (default: advisory exit 0)")
    args = parser.parse_args(argv)

    root = Path(args.root)
    subagents_dir = Path(args.subagents_dir) if args.subagents_dir else None
    work_dir = Path(args.work_dir) if args.work_dir else None
    report = check(
        root,
        days=max(args.days, 0),
        min_result_chars=args.min_result_chars,
        subagents_dir=subagents_dir,
        work_dir=work_dir,
    )
    if args.json:
        print(json.dumps(report, indent=2))
    else:
        print(format_report(report))
    if args.strict and report["flagged"]:
        print("harvest_check: --strict: unharvested dispatches present", file=sys.stderr)
        return 1
    return 0


if __name__ == "__main__":
    sys.exit(main())
