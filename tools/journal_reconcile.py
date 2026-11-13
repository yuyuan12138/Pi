#!/usr/bin/env python3
"""Journal reconciliation for interrupted coordinator dispatches (Theme A A4).

When the coordinator pi process restarts mid-dispatch (or a worker dies
silently), rows in the coordinator journal
(~/.pi/agent/project-coordinator/coordinator.db, SQLite, append-only — see
packages/pi-project-coordinator/src/journal.ts) can stay in non-terminal
states forever: the process that would have appended the settled row is gone.
The dispatch's true outcome lives on disk: .pi/subagents/<dir>/events.jsonl
+ result.md. This tool reconciles the journal to that evidence — append-only,
conservative, never fabricating an outcome.

Reconciliation rules (fixed; identical for dry-run and --apply)
---------------------------------------------------------------
Candidates: tasks whose LATEST journal row is non-terminal and actionable:
  - unsettled:         phase in {received, queued, started}
  - reconcile-required: phase == settled AND latest settled outcome ==
    unknown-outcome AND envelope.mutating (the engine's crash rule; never
    auto-replayed — this tool supplies the evidence inspection, not a replay)
Skipped by design: phase == question (person/answer gate — a person decides),
terminal phases (settled with completed-unverified/failed, verified,
cancelled, reconciled), rows re-queued via coordinator.retry() (detail
"requeued via explicit retry" — a live engine owns them), and anomalies
(settled unknown-outcome whose envelope is missing or read-only: reported,
never written).

For each candidate the referenced subagent dir is resolved:
  1. explicit ref — envelope JSON keys `subagentDir` (path; relative resolves
     against the coordinator root) or `subagentId` (dir name under a
     subagent root), when present;
  2. unique content match — else every dir under the subagent roots
     (<coordinator-root>/.pi/subagents plus each registry project root's
     .pi/subagents) is matched against the envelope: STRONG when the exact
     taskId appears in the events head, WEAK when the normalized goal text
     (>= 24 chars) appears in the parsed event strings. 0 or >=2 matches
     => unresolved, never guessed.

Dir state uses tools/restart_handoff.py inference (imported, not copied):
  done    = result.md OR a terminal event (agent_settled/agent_end) in tail
  stale   = no terminal marker and no event activity for STALE_SECONDS
  running = no terminal marker, recent activity (a worker may still be alive)

Per-candidate actions (all writes are append-only INSERTs; the original row
fields ride along inside the new row's detail as an audit={} JSON blob):

  latest phase       | evidence            | mutating           | read-only
  -------------------|---------------------|--------------------|----------------
  unsettled          | unique dir, done    | append settled: completed-unverified
                     |                     | (+ budget_spent from usage sidecar)
  unsettled + started| unique dir, stale   | settled:           | settled: failed
                     | or no dir found     | unknown-outcome    |
                     |                     | (stays reconcile-required)
  unsettled + received/queued | no dir     | no write — stranded-queued;
                     |                     | re-submit (engine never replays queues)
  any unsettled      | dir still running   | no write — flagged, re-run later
  any                | >=2 matching dirs   | no write — flagged ambiguous
  reconcile-required | unique dir, done    | settled: completed-unverified
                     |                     | + reconciled row (clears the flag)
  reconcile-required | stale/missing       | no write — stays reconcile-required

"completed-unverified" is deliberately never "verified": acceptance is a
separate human/primary step (journal.ts contract). A mutating task without
positive evidence settles to unknown-outcome and STAYS flagged for a person —
the tool records honest ignorance, it does not guess.

Usage sidecar (budget_spent), first match wins:
  1. <dir>/usage.json — numeric costUsd / totalCost / spent / cost.total
  2. events.jsonl — sum of message_end records' message.usage.cost.total
     (USD as reported by the provider; capped at USAGE_CAP_BYTES).

Exit codes (machine-readable):
  0  nothing to do (no candidates/anomalies), or --apply closed every
     candidate with positive evidence (completed-unverified / failed)
  1  attention needed: dry-run found candidates/anomalies, or --apply left
     candidates flagged / stranded / unknown-outcome (human decides next)
  2  error (db missing/unreadable, bad arguments, write failure; writes are
     transactional and rolled back on failure)

Default is --dry-run: prints the plan, writes nothing. Stdlib only; no
network calls; the journal is opened read-only unless --apply.
"""
from __future__ import annotations

import argparse
import json
import os
import sqlite3
import sys
import time
from datetime import datetime, timezone
from pathlib import Path

import restart_handoff as rh  # shared inference: is_done, scan_subagents, STALE_SECONDS

SCHEMA = "journal-reconcile/1"
RESULT_FILE = rh.RESULT_FILE  # "result.md"
TERMINAL_OUTCOMES = ("completed-unverified", "failed", "unknown-outcome")
UNSETTLED_PHASES = ("received", "queued", "started")
RETRY_DETAIL_MARKER = "requeued via explicit retry"
TERMINAL_PHASES = {"verified", "cancelled", "reconciled"}
# Bounded reads: events head for linkage matching, whole-file cap for usage.
MATCH_HEAD_BYTES = 2_000_000
USAGE_CAP_BYTES = 16_000_000
# Below this length a goal is too generic for weak matching (strong taskId
# matching stays enabled); prevents one-word goals matching every dir.
WEAK_MATCH_MIN_CHARS = 24

DEFAULT_DB = Path.home() / ".pi" / "agent" / "project-coordinator" / "coordinator.db"


def default_db() -> Path:
    """Journal db location; JOURNAL_RECONCILE_DB overrides (tests, mirrors)."""
    env = os.environ.get("JOURNAL_RECONCILE_DB")
    return Path(env).expanduser() if env else DEFAULT_DB


def iso_now(ts: float | None = None) -> str:
    """Journal timestamps use the engine's shape (new Date().toISOString())."""
    dt = datetime.fromtimestamp(ts if ts is not None else time.time(), tz=timezone.utc)
    return dt.isoformat(timespec="milliseconds").replace("+00:00", "Z")


# --------------------------------------------------------------- journal read

def connect_ro(db: Path) -> sqlite3.Connection:
    uri = db.resolve().as_uri() + "?mode=ro"
    con = sqlite3.connect(uri, uri=True, timeout=5.0)
    con.row_factory = sqlite3.Row
    return con


def connect_rw(db: Path) -> sqlite3.Connection:
    con = sqlite3.connect(str(db), timeout=5.0)
    con.row_factory = sqlite3.Row
    con.execute("PRAGMA busy_timeout = 5000")
    return con


def load_rows(db: Path) -> tuple[list[dict], bool, list[dict]]:
    """Read all journal rows (asc), budget-column presence, registry projects.

    Tolerates the pre-D2 schema (no budget columns — the real db as of
    2026-11-13) and a missing/unreadable registry table.
    """
    con = connect_ro(db)
    try:
        cols = {r["name"] for r in con.execute("PRAGMA table_info(journal)")}
        has_budget = "budget_planned" in cols and "budget_spent" in cols
        select = (
            "SELECT id, at, task_id, phase, detail, stage, budget_planned, budget_spent"
            " FROM journal ORDER BY id"
            if has_budget
            else "SELECT id, at, task_id, phase, detail, stage,"
                 " NULL AS budget_planned, NULL AS budget_spent FROM journal ORDER BY id"
        )
        rows = [dict(r) for r in con.execute(select)]
        projects: list[dict] = []
        try:
            reg = con.execute("SELECT json FROM registry WHERE id = 1").fetchone()
            if reg and reg["json"]:
                parsed = json.loads(reg["json"])
                if isinstance(parsed, dict) and isinstance(parsed.get("projects"), list):
                    projects = [p for p in parsed["projects"] if isinstance(p, dict)]
        except (sqlite3.Error, json.JSONDecodeError, TypeError):
            projects = []
        return rows, has_budget, projects
    finally:
        con.close()


def parse_outcome(detail: str | None) -> str | None:
    """journal.ts: settled rows encode the outcome as the first detail token."""
    if not detail:
        return None
    head = detail.split(":", 1)[0].strip()
    return head if head in TERMINAL_OUTCOMES else None


def parse_envelope(detail: str | None) -> dict | None:
    if not detail:
        return None
    try:
        env = json.loads(detail)
    except (json.JSONDecodeError, TypeError):
        return None
    return env if isinstance(env, dict) and env.get("taskId") else None


def derive_stage(phase: str | None, outcome: str | None) -> str:
    """Port of journal.ts deriveStage (first-match order)."""
    if outcome == "failed":
        return "person/blocked-failed"
    if outcome == "completed-unverified" and phase != "verified":
        return "person/review"
    if phase == "question":
        return "person/answer"
    if phase == "started":
        return "working"
    if phase in ("queued", "received"):
        return "queued"
    return "idle"


class Candidate:
    """One task whose latest journal row is non-terminal and actionable."""

    def __init__(self, task_id: str, rows: list[dict], envelope: dict | None):
        self.task_id = task_id
        self.rows = rows  # ascending by id
        self.envelope = envelope
        latest = rows[-1]
        self.phase: str = latest["phase"]
        self.latest_at: str = latest["at"]
        self.latest_detail: str | None = latest["detail"]
        self.latest_id: int = latest["id"]
        settled = [r for r in rows if r["phase"] == "settled"]
        self.latest_outcome: str | None = (
            parse_outcome(settled[-1]["detail"]) if settled else None
        )
        # Latest known budget_spent across the task's rows (the envelope row
        # may carry it; a settled row may refresh it — journal.ts absorb()).
        self.prev_budget_spent: float | None = None
        for r in rows:
            if r["budget_spent"] is not None:
                self.prev_budget_spent = r["budget_spent"]
        if envelope and envelope.get("budgetSpent") is not None and self.prev_budget_spent is None:
            self.prev_budget_spent = envelope["budgetSpent"]
        # Conservative default: a missing/unreadable envelope is treated as
        # mutating (never guess "safe").
        self.mutating: bool = bool(envelope["mutating"]) if envelope else True
        self.envelope_missing = envelope is None
        self.is_reconcile_required = (
            self.phase == "settled"
            and self.latest_outcome == "unknown-outcome"
            and self.mutating
        )
        if envelope and isinstance(envelope.get("createdAt"), str):
            self.created_at = envelope["createdAt"]
        else:
            self.created_at = rows[0]["at"]


def classify(rows: list[dict]) -> tuple[list[Candidate], int, list[Candidate]]:
    """Split journal rows into (candidates, question_count, anomalies)."""
    by_task: dict[str, list[dict]] = {}
    envelopes: dict[str, dict] = {}
    question = 0
    for r in rows:
        by_task.setdefault(r["task_id"], []).append(r)
        if r["phase"] == "received":
            env = parse_envelope(r["detail"])
            if env and r["task_id"] not in envelopes:
                envelopes[r["task_id"]] = env
    candidates: list[Candidate] = []
    anomalies: list[Candidate] = []
    for task_id, task_rows in sorted(by_task.items()):
        latest = task_rows[-1]
        if latest["phase"] == "question":
            question += 1
            continue
        if latest["phase"] in TERMINAL_PHASES:
            continue
        if latest["phase"] == "settled":
            cand = Candidate(task_id, task_rows, envelopes.get(task_id))
            if cand.latest_outcome == "unknown-outcome":
                # unknown-outcome on a read-only or envelope-less task cannot
                # happen via the engine; report it, never write to it.
                if cand.envelope_missing or not cand.mutating:
                    anomalies.append(cand)
                else:
                    candidates.append(cand)  # reconcile-required
            # settled completed-unverified / failed are terminal: skip
            continue
        if latest["phase"] in UNSETTLED_PHASES:
            candidates.append(Candidate(task_id, task_rows, envelopes.get(task_id)))
    candidates.sort(key=lambda c: c.latest_id)
    return candidates, question, anomalies


# ----------------------------------------------------------- subagent evidence

def _read_head(path: Path, cap: int) -> str:
    try:
        with open(path, "rb") as handle:
            return handle.read(cap).decode("utf-8", "replace")
    except OSError:
        return ""


def _collect_strings(obj, out: list[str]) -> None:
    if isinstance(obj, str):
        out.append(obj)
    elif isinstance(obj, list):
        for v in obj:
            _collect_strings(v, out)
    elif isinstance(obj, dict):
        for v in obj.values():
            _collect_strings(v, out)


def _norm(text: str) -> str:
    return " ".join(text.split())


def _events_text_blob(head: str) -> str:
    parts: list[str] = []
    for line in head.splitlines():
        line = line.strip()
        if not line:
            continue
        try:
            rec = json.loads(line)
        except json.JSONDecodeError:
            parts.append(line)  # raw fallback still allows plain-text needles
            continue
        strs: list[str] = []
        _collect_strings(rec, strs)
        parts.extend(strs)
    return _norm("\n".join(parts))


def numeric_cost(data) -> float | None:
    """Accept the sidecar shapes a dispatcher might write; nothing else."""
    if isinstance(data, (int, float)) and not isinstance(data, bool):
        return float(data)
    if isinstance(data, dict):
        for key in ("costUsd", "totalCost", "spent"):
            v = data.get(key)
            if isinstance(v, (int, float)) and not isinstance(v, bool):
                return float(v)
        cost = data.get("cost")
        if isinstance(cost, dict) and isinstance(cost.get("total"), (int, float)):
            return float(cost["total"])
    return None


def usage_from_dir(directory: Path) -> tuple[float | None, str | None]:
    """Budget spend for a finished dispatch; (None, None) when no sidecar."""
    sidecar = directory / "usage.json"
    if sidecar.is_file():
        try:
            value = numeric_cost(json.loads(sidecar.read_text(encoding="utf-8", errors="replace")))
            if value is not None:
                return value, "usage.json"
        except (json.JSONDecodeError, OSError):
            pass
    events = directory / "events.jsonl"
    if not events.is_file():
        return None, None
    total, seen, remaining = 0.0, False, USAGE_CAP_BYTES
    try:
        with open(events, "rb") as handle:
            for line in handle:
                remaining -= len(line)
                if remaining < 0:
                    break  # capped: usage beyond the cap is not summed
                if b'"message_end"' not in line:
                    continue
                try:
                    rec = json.loads(line)
                except json.JSONDecodeError:
                    continue
                if rec.get("type") != "message_end":
                    continue
                usage = (rec.get("message") or {}).get("usage") or {}
                cost = (usage.get("cost") or {}).get("total")
                if isinstance(cost, (int, float)) and not isinstance(cost, bool):
                    total += float(cost)
                    seen = True
    except OSError:
        return None, None
    return (total, "events.jsonl") if seen else (None, None)


def subagent_roots(root: Path, projects: list[dict], extra: list[Path]) -> list[Path]:
    """Coordinator root first, then each registered project root, then extras."""
    roots = [root / ".pi" / "subagents"]
    for p in projects:
        project_root = p.get("root")
        if isinstance(project_root, str) and project_root:
            roots.append(Path(project_root) / ".pi" / "subagents")
    roots.extend(extra)
    out, seen = [], set()
    for r in roots:
        key = str(r.resolve())
        if key not in seen:
            seen.add(key)
            out.append(r)
    return out


def scan_all_roots(roots: list[Path], now: float, stale_seconds: int) -> list[dict]:
    entries: list[dict] = []
    for subroot in roots:
        if subroot.is_dir():
            entries.extend(rh.scan_subagents(subroot, now=now, stale_seconds=stale_seconds))
    return entries


def _entry_for(path: Path, now: float, stale_seconds: int, matched_by: str) -> dict:
    events = path / "events.jsonl"
    try:
        age = int(now - events.stat().st_mtime)
    except OSError:
        age = -1
    if rh.is_done(path):
        status = "done"
    elif 0 <= age <= stale_seconds:
        status = "running"
    else:
        status = "stale"
    return {
        "status": status,
        "dir": str(path),
        "id": path.name,
        "result": (path / RESULT_FILE).is_file(),
        "age_seconds": age,
        "matched_by": matched_by,
    }


def resolve_evidence(cand: Candidate, roots: list[Path], now: float,
                     stale_seconds: int) -> dict:
    """Link a candidate to at most one subagent dir; never guess on 0 or >=2."""
    env = cand.envelope or {}
    explicit_dir = env.get("subagentDir")
    explicit_id = env.get("subagentId")
    if isinstance(explicit_dir, str) and explicit_dir:
        path = Path(explicit_dir)
        if not path.is_absolute() and roots:
            path = roots[0].parent / path  # relative refs resolve against <root>
        if path.is_dir() and (path / "events.jsonl").is_file():
            return _entry_for(path, now, stale_seconds, "explicit:subagentDir")
        return {"status": "missing", "dir": str(path), "matched_by": "explicit:subagentDir"}
    if isinstance(explicit_id, str) and explicit_id:
        hits = [r / explicit_id for r in roots if (r / explicit_id / "events.jsonl").is_file()]
        if len(hits) == 1:
            return _entry_for(hits[0], now, stale_seconds, "explicit:subagentId")
        if len(hits) > 1:
            return {"status": "ambiguous", "candidates": [str(h) for h in hits],
                    "matched_by": "explicit:subagentId"}
        return {"status": "missing", "dir": explicit_id, "matched_by": "explicit:subagentId"}

    goal = _norm(str(env.get("goal") or ""))
    weak_ok = len(goal) >= WEAK_MATCH_MIN_CHARS
    strong, weak = [], []
    for subroot in roots:
        if not subroot.is_dir():
            continue
        for entry in rh.scan_subagents(subroot, now=now, stale_seconds=stale_seconds):
            head = _read_head(Path(entry["dir"]) / "events.jsonl", MATCH_HEAD_BYTES)
            if not head:
                continue
            if cand.task_id in head:
                strong.append(entry)
                continue
            if weak_ok and goal in _events_text_blob(head):
                weak.append(entry)
    matches = strong if strong else weak
    matched_by = "task-id" if strong else ("goal-text" if weak else None)
    if len(matches) == 1:
        entry = dict(matches[0])
        entry["matched_by"] = matched_by
        return entry
    if len(matches) > 1:
        return {"status": "ambiguous", "candidates": [m["dir"] for m in matches],
                "matched_by": matched_by}
    return {"status": "missing", "matched_by": None}


# ------------------------------------------------------------------- planning

def audit_blob(cand: Candidate, evidence: dict, settled_at: str,
               spent: float | None = None, spent_source: str | None = None,
               extra: dict | None = None) -> str:
    """Original row fields preserved inside the reconcile row's detail."""
    audit = {
        "tool": SCHEMA,
        "task_id": cand.task_id,
        "prev_phase": cand.phase,
        "prev_at": cand.latest_at,
        "prev_detail": cand.latest_detail,
        "prev_budget_spent": cand.prev_budget_spent,
        "envelope_missing": cand.envelope_missing,
        "evidence_status": evidence.get("status"),
        "evidence_dir": evidence.get("dir"),
        "matched_by": evidence.get("matched_by"),
        "settled_at": settled_at,
        "reconciled_at": settled_at,
    }
    if spent is not None:
        audit["budget_spent"] = spent
        audit["budget_spent_source"] = spent_source
    if extra:
        audit.update(extra)
    return json.dumps(audit, ensure_ascii=False, sort_keys=True, separators=(",", ":"))


def _dead_dispatch_rows(cand: Candidate, evidence: dict, now: float,
                        reason: str) -> list[dict]:
    """The engine's crash semantics, written by the reconciler: a mutating
    task settles unknown-outcome (never auto-replayed), a read-only task failed."""
    settled_at = iso_now(now)
    if cand.mutating:
        outcome = "unknown-outcome"
        human = f"no terminal evidence ({reason}); left flagged for a person; never auto-replayed"
    else:
        outcome = "failed"
        human = f"dispatch died without terminal evidence ({reason})"
    return [{
        "at": settled_at,
        "task_id": cand.task_id,
        "phase": "settled",
        "detail": f"{outcome}: journal_reconcile: {human}; audit="
                  + audit_blob(cand, evidence, settled_at, extra={"reason": reason}),
        "stage": derive_stage("settled", outcome),
        "budget_spent": None,
    }]


def planned_rows(cand: Candidate, evidence: dict, now: float) -> tuple[list[dict], str]:
    """Rows to append for one candidate + the candidate's outcome status.

    Statuses: reconciled | failed-recorded | unknown-recorded | flagged-running
    | flagged-ambiguous | flagged-no-evidence | stranded-queued | skipped-requeued
    """
    if cand.phase == "queued" and cand.latest_detail and RETRY_DETAIL_MARKER in cand.latest_detail:
        return [], "skipped-requeued"
    status = evidence.get("status")
    if status == "ambiguous":
        return [], "flagged-ambiguous"
    if status == "missing":
        if cand.is_reconcile_required:
            return [], "flagged-no-evidence"  # stays reconcile-required for a person
        if cand.phase == "started":
            return _dead_dispatch_rows(cand, evidence, now, reason="no-evidence-dir"), (
                "unknown-recorded" if cand.mutating else "failed-recorded")
        return [], "stranded-queued"  # received/queued: never dispatched, re-submit
    if status == "running":
        return [], "flagged-running"  # a worker may still be alive; re-run later
    if status == "stale":
        if cand.is_reconcile_required:
            return [], "flagged-no-evidence"  # stays reconcile-required for a person
        return _dead_dispatch_rows(cand, evidence, now, reason="stale-dir"), (
            "unknown-recorded" if cand.mutating else "failed-recorded")
    # done: positive evidence
    directory = Path(evidence["dir"])
    spent, spent_source = usage_from_dir(directory)
    settled_at = iso_now(now)
    bits = [RESULT_FILE] if evidence.get("result") else ["terminal-event"]
    detail = (
        f"completed-unverified: journal_reconcile: subagent evidence dir={evidence.get('id', directory.name)}"
        f" ({'+'.join(bits)}); audit="
        + audit_blob(cand, evidence, settled_at, spent, spent_source,
                     {"evidence": "done", "evidence_age_seconds": evidence.get("age_seconds")})
    )
    rows = [{
        "at": settled_at,
        "task_id": cand.task_id,
        "phase": "settled",
        "detail": detail,
        "stage": derive_stage("settled", "completed-unverified"),
        "budget_spent": spent,
    }]
    if cand.is_reconcile_required:
        rows.append({
            "at": settled_at,
            "task_id": cand.task_id,
            "phase": "reconciled",
            "detail": "journal_reconcile: positive subagent evidence supersedes earlier"
                      " unknown-outcome; audit="
                      + audit_blob(cand, evidence, settled_at, spent, spent_source,
                                   {"superseded_outcome": "unknown-outcome"}),
            "stage": derive_stage("reconciled", "completed-unverified"),
            "budget_spent": None,
        })
    return rows, "reconciled"


# ---------------------------------------------------------------------- apply

def apply_rows(db: Path, rows: list[dict], has_budget: bool) -> int:
    """Append-only INSERTs, mirroring journal.ts append() column shape."""
    if not rows:
        return 0
    con = connect_rw(db)
    appended = 0
    try:
        con.execute("BEGIN IMMEDIATE")
        if has_budget:
            stmt = ("INSERT INTO journal(at, task_id, phase, detail, stage, dedupe_sha,"
                    " budget_planned, budget_spent) VALUES(?, ?, ?, ?, ?, NULL, NULL, ?)")
        else:
            stmt = ("INSERT INTO journal(at, task_id, phase, detail, stage, dedupe_sha)"
                    " VALUES(?, ?, ?, ?, ?, NULL)")
        for row in rows:
            if has_budget:
                con.execute(stmt, (row["at"], row["task_id"], row["phase"], row["detail"],
                                   row["stage"], row["budget_spent"]))
            else:
                con.execute(stmt, (row["at"], row["task_id"], row["phase"], row["detail"],
                                   row["stage"]))
            appended += 1
        con.execute("COMMIT")
        return appended
    except Exception:
        con.execute("ROLLBACK")
        raise
    finally:
        con.close()


# --------------------------------------------------------------------- report

RESOLVED_STATUSES = {"reconciled", "failed-recorded"}
OPEN_STATUSES = {
    "unknown-recorded", "flagged-running", "flagged-ambiguous",
    "flagged-no-evidence", "stranded-queued",
}
STATUS_LABEL = {
    "reconciled": "reconciled (completed-unverified recorded)",
    "failed-recorded": "failed recorded (read-only dispatch, no evidence)",
    "unknown-recorded": "unknown-outcome recorded (stays flagged for a person)",
    "flagged-running": "FLAGGED: worker may still be running — re-run later",
    "flagged-ambiguous": "FLAGGED: ambiguous evidence — human decision required",
    "flagged-no-evidence": "FLAGGED: no positive evidence — stays reconcile-required",
    "stranded-queued": "STRANDED: never dispatched — re-submit needed",
    "skipped-requeued": "skipped: requeued via explicit retry (engine owns it)",
}


def build_plan(db: Path, root: Path, extra_roots: list[Path], now: float,
               stale_seconds: int) -> dict:
    rows, has_budget, projects = load_rows(db)
    candidates, question, anomalies = classify(rows)
    roots = subagent_roots(root, projects, extra_roots)
    entries = scan_all_roots(roots, now, stale_seconds) if candidates else []
    items, requeued = [], 0
    for cand in candidates:
        evidence = resolve_evidence(cand, roots, now, stale_seconds)
        pending, status = planned_rows(cand, evidence, now)
        if status == "skipped-requeued":
            requeued += 1  # a live engine owns retried rows; not actionable here
            continue
        items.append({"candidate": cand, "evidence": evidence, "rows": pending, "status": status})
    return {
        "db": str(db), "has_budget": has_budget, "roots": [str(r) for r in roots],
        "items": items, "question": question, "anomalies": anomalies,
        "requeued": requeued, "scanned_dirs": len(entries),
    }


def _counts(plan: dict) -> tuple[dict, int, int]:
    counts: dict[str, int] = {}
    for item in plan["items"]:
        counts[item["status"]] = counts.get(item["status"], 0) + 1
    flagged = sum(counts.get(s, 0) for s in OPEN_STATUSES)
    resolvable = sum(counts.get(s, 0) for s in RESOLVED_STATUSES)
    return counts, flagged, resolvable


def print_report(plan: dict, written: int | None) -> int:
    """Human report; returns the process exit code."""
    counts, flagged, resolvable = _counts(plan)
    items = plan["items"]
    print(f"Journal: {plan['db']} (budget columns: {'yes' if plan['has_budget'] else 'no — pre-D2 schema'})")
    print(f"Subagent roots: {', '.join(plan['roots'])}")
    print(f"Candidates: {len(items)} non-terminal task row(s); "
          f"question-phase skipped: {plan['question']}; "
          f"requeued rows left to the engine: {plan.get('requeued', 0)}; "
          f"anomalies (unknown-outcome, no envelope): {len(plan['anomalies'])}; "
          f"subagent dirs seen: {plan['scanned_dirs']}")
    for item in items:
        cand, ev = item["candidate"], item["evidence"]
        print(f"  {cand.task_id}  phase={cand.phase} mutating={cand.mutating}"
              f"{' (envelope missing)' if cand.envelope_missing else ''}")
        ev_desc = f"status={ev.get('status')}"
        if ev.get("dir"):
            ev_desc += f" dir={ev['dir']}"
        if ev.get("matched_by"):
            ev_desc += f" matched_by={ev['matched_by']}"
        if ev.get("candidates"):
            ev_desc += f" candidates={ev['candidates']}"
        print(f"    evidence: {ev_desc}")
        for row in item["rows"]:
            spent = f" budget_spent={row['budget_spent']}" if row["budget_spent"] is not None else ""
            print(f"    -> append {row['phase']} stage={row['stage']}{spent}")
            print(f"       detail: {row['detail'][:160]}{'…' if len(row['detail']) > 160 else ''}")
        print(f"    action: {STATUS_LABEL.get(item['status'], item['status'])}")
    for cand in plan["anomalies"]:
        print(f"  ANOMALY {cand.task_id}: settled unknown-outcome but envelope missing/unreadable — inspect manually")
    if written is not None:
        print(f"Applied: wrote {written} journal row(s); {resolvable} candidate(s) closed, "
              f"{flagged} left open (unknown-outcome stays flagged for a person; never auto-replayed)")
    else:
        print("DRY RUN — nothing written. Re-run with --apply to write the planned rows.")
    clean = (written is not None and not plan["anomalies"]
             and all(i["status"] in RESOLVED_STATUSES for i in items))
    clean_dry = written is None and not items and not plan["anomalies"]
    print(f"result: {'apply' if written is not None else 'dry_run'}"
          f" candidates={len(items)} resolvable={resolvable} flagged={flagged}"
          f" question_skipped={plan['question']} requeued_skipped={plan.get('requeued', 0)}"
          f" anomalies={len(plan['anomalies'])}"
          f" written={written if written is not None else 0}")
    return 0 if (clean or clean_dry) else 1


def json_report(plan: dict, written: int | None) -> int:
    """Machine-readable report; returns the process exit code."""
    _, flagged, resolvable = _counts(plan)
    items = []
    for item in plan["items"]:
        cand = item["candidate"]
        items.append({
            "taskId": cand.task_id,
            "phase": cand.phase,
            "mutating": cand.mutating,
            "envelopeMissing": cand.envelope_missing,
            "evidence": item["evidence"],
            "status": item["status"],
            "rows": item["rows"],
        })
    clean = (written is not None and not plan["anomalies"]
             and all(i["status"] in RESOLVED_STATUSES for i in items))
    clean_dry = written is None and not items and not plan["anomalies"]
    payload = {
        "schema": SCHEMA,
        "db": plan["db"],
        "mode": "apply" if written is not None else "dry-run",
        "subagentRoots": plan["roots"],
        "candidates": items,
        "anomalies": [{"taskId": c.task_id, "phase": c.phase} for c in plan["anomalies"]],
        "questionSkipped": plan["question"],
        "requeuedSkipped": plan.get("requeued", 0),
        "written": written or 0,
        "summary": {"candidates": len(items), "resolvable": resolvable, "flagged": flagged},
        "exitCode": 0 if (clean or clean_dry) else 1,
    }
    print(json.dumps(payload, ensure_ascii=False, indent=2))
    return payload["exitCode"]


# ------------------------------------------------------- restart_handoff hook

def count_nonterminal(db_path: str | Path | None = None) -> int | None:
    """Count actionable non-terminal journal rows; None when unavailable.

    Used by tools/restart_handoff.py `resume` to suggest this command. Silent
    and read-only; any problem (missing db, lock, corrupt row) -> None.
    """
    try:
        db = Path(db_path) if db_path else default_db()
        if not db.is_file():
            return None
        rows, _, _ = load_rows(db)
        candidates, _, _ = classify(rows)
        return len(candidates)
    except Exception:
        return None


# ------------------------------------------------------------------------ CLI

def main(argv=None) -> int:
    parser = argparse.ArgumentParser(description=__doc__.splitlines()[0])
    parser.add_argument("--db", default=None,
                        help="coordinator SQLite db (default: JOURNAL_RECONCILE_DB or ~/.pi/agent/project-coordinator/coordinator.db)")
    parser.add_argument("--root", default=".",
                        help="coordinator project root for .pi/subagents (default: cwd)")
    parser.add_argument("--subagent-root", action="append", dest="subagent_roots", default=[],
                        help="extra .pi/subagents root to scan (repeatable)")
    parser.add_argument("--stale-seconds", type=int, default=rh.STALE_SECONDS,
                        help="no-activity threshold for stale dirs (default %(default)s)")
    parser.add_argument("--apply", action="store_true",
                        help="write the planned reconcile rows (default: dry-run)")
    parser.add_argument("--json", action="store_true", help="machine-readable JSON report on stdout")
    args = parser.parse_args(argv)

    db = Path(args.db).expanduser() if args.db else default_db()
    if not db.is_file():
        print(f"error: journal db not found: {db}", file=sys.stderr)
        return 2
    root = Path(args.root).resolve()
    extra_roots = [Path(p).expanduser().resolve() for p in args.subagent_roots]
    try:
        plan = build_plan(db, root, extra_roots, now=time.time(), stale_seconds=args.stale_seconds)
    except sqlite3.Error as error:
        print(f"error: cannot read journal db {db}: {error}", file=sys.stderr)
        return 2

    written = None
    if args.apply:
        pending = [row for item in plan["items"] for row in item["rows"]]
        try:
            written = apply_rows(db, pending, plan["has_budget"])
        except sqlite3.Error as error:
            print(f"error: apply failed (rolled back): {error}", file=sys.stderr)
            return 2
    try:
        return json_report(plan, written) if args.json else print_report(plan, written)
    except BrokenPipeError:
        return 2


if __name__ == "__main__":
    sys.exit(main())
