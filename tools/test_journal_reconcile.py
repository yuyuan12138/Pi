"""Tests for tools/journal_reconcile.py (Theme A A4).

Run with: python3 -m unittest discover -s tools -p test_journal_reconcile.py

Fixtures mirror the production layout: a SQLite coordinator db (both the
current and the pre-D2 schema without budget columns) plus .pi/subagents/<id>/
dirs whose state follows tools/restart_handoff.py inference (done = result.md
or terminal event; stale = no terminal marker and no activity for
2x STALE_SECONDS; running = fresh mtime, no terminal marker).
"""
import hashlib
import json
import os
import sqlite3
import subprocess
import sys
import tempfile
import time
import unittest
from pathlib import Path

import journal_reconcile as jr
import restart_handoff as rh


def _events(*entries):
    return "\n".join(json.dumps(e) for e in entries) + "\n"


def make_db(root: Path, post_d2: bool = True) -> Path:
    db = root / "coordinator.db"
    con = sqlite3.connect(db)
    budget = ", budget_planned REAL, budget_spent REAL" if post_d2 else ""
    con.executescript(f"""
      CREATE TABLE meta(key TEXT PRIMARY KEY, value TEXT NOT NULL);
      CREATE TABLE journal(id INTEGER PRIMARY KEY AUTOINCREMENT, at TEXT NOT NULL,
        task_id TEXT NOT NULL, phase TEXT NOT NULL, detail TEXT, stage TEXT,
        dedupe_sha TEXT{budget});
      CREATE TABLE registry(id INTEGER PRIMARY KEY CHECK(id = 1), json TEXT NOT NULL);
      CREATE TABLE pause(id INTEGER PRIMARY KEY CHECK(id = 1), paused INTEGER NOT NULL,
        reason TEXT, at TEXT NOT NULL);
      CREATE TABLE mandates(task_id TEXT PRIMARY KEY, basis TEXT NOT NULL, at TEXT NOT NULL,
        scope TEXT NOT NULL);
    """)
    con.execute("INSERT INTO registry(id, json) VALUES(1, ?)", (json.dumps({"projects": [
        {"id": "proj", "root": str(root), "sessionId": "proj-primary", "status": "registered"}
    ]}),))
    con.commit()
    con.close()
    return db


def add_task(db: Path, task_id: str, *, goal="deploy the reporting service to staging",
             mutating=True, phases=("received", "queued", "started"),
             budget_planned=None, budget_spent=None, subagent_id=None,
             subagent_dir=None, post_d2=True, queued_detail=None,
             settled_detail=None):
    """Insert envelope + lifecycle rows the way the engine writes them."""
    con = sqlite3.connect(db)
    cols = "at, task_id, phase, detail, stage"
    if post_d2:
        cols += ", budget_planned, budget_spent"
    envelope = {
        "taskId": task_id, "dedupeKey": "dk-" + task_id, "sourceMessageId": "msg-" + task_id,
        "splitIndex": 0, "projectId": "proj", "goal": goal, "deliverable": "evidence",
        "mutating": mutating, "createdAt": "2026-11-13T10:00:00.000Z",
    }
    if budget_planned is not None:
        envelope["budgetPlanned"] = budget_planned
    if budget_spent is not None:
        envelope["budgetSpent"] = budget_spent
    if subagent_id is not None:
        envelope["subagentId"] = subagent_id
    if subagent_dir is not None:
        envelope["subagentDir"] = subagent_dir
    rows = [("2026-11-13T10:00:00.000Z", task_id, "received", json.dumps(envelope), None)]
    for i, phase in enumerate(phases[1:], start=1):
        detail = queued_detail if phase == "queued" else (
            settled_detail if phase == "settled" else None)
        stage = {"queued": "queued", "started": "working", "settled": "person/review"}.get(phase)
        rows.append((f"2026-11-13T10:00:0{i}.000Z", task_id, phase, detail, stage))
    for at, tid, phase, detail, stage in rows:
        if post_d2:
            spent = budget_spent if phase in ("received", "settled") else None
            planned = budget_planned if phase == "received" else None
            con.execute(f"INSERT INTO journal({cols}) VALUES(?,?,?,?,?,?,?)",
                        (at, tid, phase, detail, stage, planned, spent))
        else:
            con.execute(f"INSERT INTO journal({cols}) VALUES(?,?,?,?,?)",
                        (at, tid, phase, detail, stage))
    con.commit()
    con.close()


def done_dir(subs: Path, name: str, *, with_result=True, usage_cost=None,
             contains=None, goal_hint=None):
    d = subs / name
    d.mkdir(parents=True)
    lines = []
    if usage_cost is not None:
        lines.append(json.dumps({"type": "message_end",
                                 "message": {"usage": {"cost": {"total": usage_cost}}}}))
    if contains:
        lines.append(json.dumps({"type": "text", "text": contains}))
    if goal_hint:
        lines.append(json.dumps({"type": "text", "text": goal_hint}))
    lines.append(json.dumps({"type": "turn_end"}))
    lines.append(json.dumps({"type": "agent_settled"}))
    (d / "events.jsonl").write_text("\n".join(lines) + "\n")
    if with_result:
        (d / "result.md").write_text("result\n")
    return d


def stale_dir(subs: Path, name: str, *, contains=None, goal_hint=None, now=None):
    d = subs / name
    d.mkdir(parents=True)
    lines = []
    if contains:
        lines.append(json.dumps({"type": "text", "text": contains}))
    if goal_hint:
        lines.append(json.dumps({"type": "text", "text": goal_hint}))
    lines.append(json.dumps({"type": "tool_execution_start"}))
    events = d / "events.jsonl"
    events.write_text("\n".join(lines) + "\n")
    ts = (now or time.time()) - 2 * rh.STALE_SECONDS
    os.utime(events, (ts, ts))
    return d


def running_dir(subs: Path, name: str, *, contains=None):
    d = subs / name
    d.mkdir(parents=True)
    lines = []
    if contains:
        lines.append(json.dumps({"type": "text", "text": contains}))
    lines.append(json.dumps({"type": "tool_execution_start"}))
    (d / "events.jsonl").write_text("\n".join(lines) + "\n")  # fresh mtime
    return d


class Base(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        self.addCleanup(self.tmp.cleanup)
        self.root = Path(self.tmp.name)
        self.subs = self.root / ".pi" / "subagents"
        self.subs.mkdir(parents=True)
        self.db = make_db(self.root)

    def plan(self, post_d2=True):
        return jr.build_plan(self.db, self.root, [], now=time.time(),
                             stale_seconds=rh.STALE_SECONDS)

    def dump_rows(self):
        con = sqlite3.connect(self.db)
        rows = con.execute("SELECT id, at, task_id, phase, detail, stage FROM journal ORDER BY id").fetchall()
        con.close()
        return rows

    def db_hash(self):
        return hashlib.sha256(self.db.read_bytes()).hexdigest()

    def latest_row(self, task_id):
        con = sqlite3.connect(self.db)
        cols = {r[1] for r in con.execute("PRAGMA table_info(journal)")}
        spent = ", budget_spent" if "budget_spent" in cols else ", NULL AS budget_spent"
        row = con.execute(
            f"SELECT at, task_id, phase, detail, stage{spent} FROM journal"
            " WHERE task_id = ? ORDER BY id DESC LIMIT 1", (task_id,)).fetchone()
        con.close()
        return row


class DeriveStageTests(unittest.TestCase):
    """Port parity with journal.ts deriveStage (first-match order)."""

    def test_branches(self):
        cases = [
            (("settled", "failed"), "person/blocked-failed"),
            (("started", "failed"), "person/blocked-failed"),
            (("settled", "completed-unverified"), "person/review"),
            (("queued", "completed-unverified"), "person/review"),
            (("verified", "completed-unverified"), "idle"),
            (("question", None), "person/answer"),
            (("question", "failed"), "person/blocked-failed"),
            (("started", None), "working"),
            (("queued", None), "queued"),
            (("received", None), "queued"),
            (("cancelled", None), "idle"),
            (("reconciled", None), "idle"),
            ((None, None), "idle"),
            (("settled", "unknown-outcome"), "idle"),
        ]
        for (phase, outcome), expected in cases:
            self.assertEqual(jr.derive_stage(phase, outcome), expected, (phase, outcome))


class LinkageTests(Base):
    def test_strong_task_id_match(self):
        stale_dir(self.subs, "dispatch-a", contains="dispatching task-x1 now")
        add_task(self.db, "task-x1")
        plan = self.plan()
        self.assertEqual(len(plan["items"]), 1)
        ev = plan["items"][0]["evidence"]
        self.assertEqual(ev["status"], "stale")
        self.assertEqual(ev["matched_by"], "task-id")
        self.assertTrue(ev["dir"].endswith("dispatch-a"))

    def test_weak_goal_match(self):
        goal = "reconcile the quarterly ledger entries across the finance database"
        stale_dir(self.subs, "dispatch-b", goal_hint=f"Please {goal} promptly")
        add_task(self.db, "task-y1", goal=goal)
        plan = self.plan()
        ev = plan["items"][0]["evidence"]
        self.assertEqual(ev["matched_by"], "goal-text")
        self.assertEqual(ev["status"], "stale")

    def test_weak_match_disabled_for_short_goals(self):
        stale_dir(self.subs, "dispatch-c", goal_hint="g g g")
        add_task(self.db, "task-z1", goal="g")
        plan = self.plan()
        self.assertEqual(plan["items"][0]["evidence"]["status"], "missing")

    def test_collided_dirs_are_ambiguous_never_guessed(self):
        stale_dir(self.subs, "dispatch-d1", contains="task-w1 brief")
        done_dir(self.subs, "dispatch-d2", contains="task-w1 brief")
        add_task(self.db, "task-w1")
        plan = self.plan()
        item = plan["items"][0]
        self.assertEqual(item["status"], "flagged-ambiguous")
        self.assertEqual(item["rows"], [])
        self.assertEqual(len(item["evidence"]["candidates"]), 2)

    def test_explicit_subagent_id(self):
        stale_dir(self.subs, "dispatch-e")
        add_task(self.db, "task-v1", subagent_id="dispatch-e")
        plan = self.plan()
        ev = plan["items"][0]["evidence"]
        self.assertEqual(ev["matched_by"], "explicit:subagentId")
        self.assertEqual(ev["status"], "stale")

    def test_explicit_subagent_id_missing(self):
        add_task(self.db, "task-v2", subagent_id="gone-dir")
        plan = self.plan()
        self.assertEqual(plan["items"][0]["evidence"]["status"], "missing")

    def test_explicit_subagent_dir_overrides_content_match(self):
        done_dir(self.subs, "dispatch-f", contains="task-u1")
        stale_dir(self.subs, "dispatch-f-lookalike", contains="task-u1")
        target = str(self.subs / "dispatch-f")
        add_task(self.db, "task-u1", subagent_dir=target)
        plan = self.plan()
        ev = plan["items"][0]["evidence"]
        self.assertEqual(ev["dir"], target)
        self.assertEqual(ev["status"], "done")
        self.assertEqual(ev["matched_by"], "explicit:subagentDir")


class RulesTests(Base):
    def test_done_evidence_reconciles_completed_unverified(self):
        done_dir(self.subs, "dispatch-1", contains="task-t1", usage_cost=1.25)
        add_task(self.db, "task-t1", budget_planned=5)
        plan = self.plan()
        self.assertEqual(len(plan["items"]), 1)
        item = plan["items"][0]
        self.assertEqual(item["status"], "reconciled")
        self.assertEqual(len(item["rows"]), 1)
        row = item["rows"][0]
        self.assertEqual(row["phase"], "settled")
        self.assertEqual(row["stage"], "person/review")
        self.assertEqual(row["budget_spent"], 1.25)
        self.assertTrue(row["detail"].startswith("completed-unverified: journal_reconcile:"))
        self.assertIn('"prev_phase": "started"'.replace(" ", ""), row["detail"])
        self.assertIn("prev_at", row["detail"])

    def test_done_without_result_md_still_reconciles(self):
        done_dir(self.subs, "dispatch-2", with_result=False, contains="task-t2")
        add_task(self.db, "task-t2", mutating=False)
        item = self.plan()["items"][0]
        self.assertEqual(item["status"], "reconciled")
        self.assertIn("terminal-event", item["rows"][0]["detail"])

    def test_dead_mid_run_mutating_sets_unknown_outcome(self):
        stale_dir(self.subs, "dispatch-3", contains="task-t3")
        add_task(self.db, "task-t3", mutating=True)
        item = self.plan()["items"][0]
        self.assertEqual(item["status"], "unknown-recorded")
        row = item["rows"][0]
        self.assertTrue(row["detail"].startswith("unknown-outcome: journal_reconcile:"))
        self.assertIn("never auto-replayed", row["detail"])
        self.assertEqual(row["stage"], "idle")

    def test_dead_mid_run_readonly_sets_failed(self):
        stale_dir(self.subs, "dispatch-4", contains="task-t4")
        add_task(self.db, "task-t4", mutating=False)
        item = self.plan()["items"][0]
        self.assertEqual(item["status"], "failed-recorded")
        self.assertTrue(item["rows"][0]["detail"].startswith("failed: journal_reconcile:"))
        self.assertEqual(item["rows"][0]["stage"], "person/blocked-failed")

    def test_started_without_any_dir(self):
        add_task(self.db, "task-t5", mutating=True)
        item = self.plan()["items"][0]
        self.assertEqual(item["status"], "unknown-recorded")
        add_task(self.db, "task-t6", mutating=False)
        items = {i["candidate"].task_id: i for i in self.plan()["items"]}
        self.assertEqual(items["task-t6"]["status"], "failed-recorded")

    def test_queued_without_dir_is_stranded_not_written(self):
        add_task(self.db, "task-t7", phases=("received", "queued"))
        plan = self.plan()
        item = plan["items"][0]
        self.assertEqual(item["status"], "stranded-queued")
        self.assertEqual(item["rows"], [])

    def test_running_dir_left_open(self):
        running_dir(self.subs, "dispatch-5", contains="task-t8")
        add_task(self.db, "task-t8")
        item = self.plan()["items"][0]
        self.assertEqual(item["status"], "flagged-running")
        self.assertEqual(item["rows"], [])

    def test_question_phase_skipped(self):
        add_task(self.db, "task-t9", phases=("received", "question"))
        plan = self.plan()
        self.assertEqual(plan["items"], [])
        self.assertEqual(plan["question"], 1)

    def test_requeued_rows_left_to_engine(self):
        add_task(self.db, "task-t10", phases=("received", "queued"),
                 queued_detail="requeued via explicit retry (mandate valid)")
        plan = self.plan()
        self.assertEqual(plan["items"], [])
        self.assertEqual(plan["requeued"], 1)

    def test_unknown_outcome_with_done_evidence_reconciles_two_rows(self):
        done_dir(self.subs, "dispatch-6", contains="task-t11", usage_cost=0.5)
        add_task(self.db, "task-t11", mutating=True,
                 phases=("received", "queued", "started", "settled"),
                 settled_detail="unknown-outcome: crash: rpc child exited")
        item = self.plan()["items"][0]
        self.assertEqual(item["status"], "reconciled")
        self.assertEqual(len(item["rows"]), 2)
        self.assertEqual(item["rows"][0]["phase"], "settled")
        self.assertEqual(item["rows"][1]["phase"], "reconciled")
        self.assertEqual(item["rows"][1]["stage"], "person/review")
        self.assertIn("supersedes earlier unknown-outcome", item["rows"][1]["detail"])

    def test_unknown_outcome_without_positive_evidence_stays_flagged(self):
        stale_dir(self.subs, "dispatch-7", contains="task-t12")
        add_task(self.db, "task-t12", mutating=True,
                 phases=("received", "queued", "started", "settled"),
                 settled_detail="unknown-outcome: crash: rpc child exited")
        item = self.plan()["items"][0]
        self.assertEqual(item["status"], "flagged-no-evidence")
        self.assertEqual(item["rows"], [])

    def test_unknown_outcome_readonly_is_anomaly_never_written(self):
        add_task(self.db, "task-t13", mutating=False,
                 phases=("received", "queued", "started", "settled"),
                 settled_detail="unknown-outcome: impossible row")
        plan = self.plan()
        self.assertEqual(plan["items"], [])
        self.assertEqual(len(plan["anomalies"]), 1)

    def test_budget_sidecar_usage_json_wins_over_events(self):
        d = done_dir(self.subs, "dispatch-8", contains="task-t14", usage_cost=3.0)
        (d / "usage.json").write_text(json.dumps({"costUsd": 1.75}))
        add_task(self.db, "task-t14")
        row = self.plan()["items"][0]["rows"][0]
        self.assertEqual(row["budget_spent"], 1.75)

    def test_no_sidecar_leaves_budget_spent_unset(self):
        done_dir(self.subs, "dispatch-9", contains="task-t15")
        add_task(self.db, "task-t15")
        row = self.plan()["items"][0]["rows"][0]
        self.assertIsNone(row["budget_spent"])

    def test_registry_project_root_is_scanned(self):
        # Dispatch subagent dirs may live under the PROJECT root, not the
        # coordinator root; the registry supplies that root.
        proj = self.root / "proj-tree"
        (proj / ".pi" / "subagents").mkdir(parents=True)
        stale_dir(proj / ".pi" / "subagents", "dispatch-10", contains="task-t16")
        add_task(self.db, "task-t16")
        con = sqlite3.connect(self.db)
        con.execute("UPDATE registry SET json = ?", (json.dumps({"projects": [
            {"id": "proj", "root": str(proj), "sessionId": "s", "status": "registered"}]}),))
        con.commit()
        con.close()
        plan = self.plan()
        self.assertEqual(len(plan["items"]), 1)
        self.assertTrue(plan["items"][0]["evidence"]["dir"].startswith(str(proj)))


class ApplyTests(Base):
    def test_apply_writes_and_preserves_budget_planned(self):
        done_dir(self.subs, "dispatch-11", contains="task-a1", usage_cost=2.0)
        add_task(self.db, "task-a1", budget_planned=5)
        before = len(self.dump_rows())
        code = jr.main(["--db", str(self.db), "--root", str(self.root), "--apply"])
        self.assertEqual(code, 0)
        rows = self.dump_rows()
        self.assertEqual(len(rows), before + 1)
        _, at, tid, phase, detail, stage = rows[-1]
        self.assertEqual(phase, "settled")
        self.assertEqual(stage, "person/review")
        self.assertTrue(detail.startswith("completed-unverified: journal_reconcile:"))
        con = sqlite3.connect(self.db)
        planned = con.execute(
            "SELECT budget_planned FROM journal WHERE task_id='task-a1' AND phase='received'"
        ).fetchone()[0]
        spent = con.execute(
            "SELECT budget_spent FROM journal WHERE task_id='task-a1' AND phase='settled'"
        ).fetchone()[0]
        con.close()
        self.assertEqual(planned, 5)   # untouched on the received row
        self.assertEqual(spent, 2.0)   # from the usage sidecar
        self.assertIn("budget_spent_source", detail.replace('"', '"'))

    def test_apply_is_idempotent(self):
        done_dir(self.subs, "dispatch-12", contains="task-a2")
        add_task(self.db, "task-a2")
        self.assertEqual(jr.main(["--db", str(self.db), "--root", str(self.root), "--apply"]), 0)
        after_first = len(self.dump_rows())
        self.assertEqual(jr.main(["--db", str(self.db), "--root", str(self.root), "--apply"]), 0)
        self.assertEqual(len(self.dump_rows()), after_first)

    def test_apply_unknown_outcome_exits_1_and_stays_flagged(self):
        stale_dir(self.subs, "dispatch-13", contains="task-a3")
        add_task(self.db, "task-a3", mutating=True)
        code = jr.main(["--db", str(self.db), "--root", str(self.root), "--apply"])
        self.assertEqual(code, 1)
        at, tid, phase, detail, stage, spent = self.latest_row("task-a3")
        self.assertEqual(phase, "settled")
        self.assertTrue(detail.startswith("unknown-outcome:"))
        self.assertIsNone(spent)
        # a fresh classification still flags it for a person (never hidden)
        rows, _, _ = jr.load_rows(self.db)
        candidates, _, _ = jr.classify(rows)
        self.assertEqual(len(candidates), 1)
        self.assertTrue(candidates[0].is_reconcile_required)

    def test_apply_readonly_failed_exits_0(self):
        stale_dir(self.subs, "dispatch-14", contains="task-a4")
        add_task(self.db, "task-a4", mutating=False)
        self.assertEqual(jr.main(["--db", str(self.db), "--root", str(self.root), "--apply"]), 0)

    def test_apply_stranded_queued_exits_1_writes_nothing(self):
        add_task(self.db, "task-a5", phases=("received", "queued"))
        before = self.db_hash()
        code = jr.main(["--db", str(self.db), "--root", str(self.root), "--apply"])
        self.assertEqual(code, 1)
        self.assertEqual(self.db_hash(), before)

    def test_apply_ambiguous_writes_nothing(self):
        stale_dir(self.subs, "dispatch-15a", contains="task-a6")
        done_dir(self.subs, "dispatch-15b", contains="task-a6")
        add_task(self.db, "task-a6")
        before = self.db_hash()
        self.assertEqual(jr.main(["--db", str(self.db), "--root", str(self.root), "--apply"]), 1)
        self.assertEqual(self.db_hash(), before)


class DryRunSafetyTests(Base):
    def test_dry_run_writes_nothing(self):
        done_dir(self.subs, "dispatch-16", contains="task-d1", usage_cost=1.0)
        stale_dir(self.subs, "dispatch-17", contains="task-d2")
        add_task(self.db, "task-d1", budget_planned=9)
        add_task(self.db, "task-d2", mutating=False)
        before_rows = self.dump_rows()
        before_hash = self.db_hash()
        before_dir_listing = sorted(p.name for p in self.root.rglob("*"))
        code = jr.main(["--db", str(self.db), "--root", str(self.root)])
        self.assertEqual(code, 1)  # candidates found -> attention needed
        self.assertEqual(self.dump_rows(), before_rows)
        self.assertEqual(self.db_hash(), before_hash)
        self.assertEqual(sorted(p.name for p in self.root.rglob("*")), before_dir_listing)

    def test_clean_journal_is_exit_0(self):
        code = jr.main(["--db", str(self.db), "--root", str(self.root)])
        self.assertEqual(code, 0)


class SchemaCompatTests(Base):
    def setUp(self):
        # These tests build their own db (schema variants); only the tmp tree.
        self.tmp = tempfile.TemporaryDirectory()
        self.addCleanup(self.tmp.cleanup)
        self.root = Path(self.tmp.name)
        self.subs = self.root / ".pi" / "subagents"
        self.subs.mkdir(parents=True)
        self.db = make_db(self.root)

    def test_pre_d2_db_without_budget_columns(self):
        self.db.unlink()  # replace the default db with the pre-D2 variant
        db = make_db(self.root, post_d2=False)
        self.db = db
        stale_dir(self.subs, "dispatch-18", contains="task-s1")
        add_task(db, "task-s1", post_d2=False)
        rows, has_budget, projects = jr.load_rows(db)
        self.assertFalse(has_budget)
        self.assertEqual(len(projects), 1)
        self.assertEqual(jr.main(["--db", str(db), "--root", str(self.root), "--apply"]), 1)
        at, tid, phase, detail, stage, _ = self.latest_row("task-s1")
        self.assertEqual(phase, "settled")
        self.assertTrue(detail.startswith("unknown-outcome:"))
        con = sqlite3.connect(db)
        cols = {r[1] for r in con.execute("PRAGMA table_info(journal)")}
        con.close()
        self.assertNotIn("budget_spent", cols)  # schema never altered by the tool

    def test_malformed_rows_are_tolerated(self):
        con = sqlite3.connect(self.db)
        con.execute("INSERT INTO journal(at, task_id, phase, detail) VALUES(?,?,?,?)",
                    ("2026-11-13T10:00:00.000Z", "task-m1", "received", "not-json{{{"))
        con.commit()
        con.close()
        plan = self.plan()
        # Unreadable envelope: the task stays an unsettled candidate with the
        # conservative mutating default, but received-without-dir = stranded
        # (never dispatched evidence) -> reported, no write.
        self.assertEqual(len(plan["items"]), 1)
        self.assertEqual(plan["items"][0]["status"], "stranded-queued")
        self.assertTrue(plan["items"][0]["candidate"].mutating)
        self.assertTrue(plan["items"][0]["candidate"].envelope_missing)

    def test_missing_db_is_exit_2(self):
        self.assertEqual(jr.main(["--db", str(self.root / "nope.db")]), 2)


class HookTests(Base):
    def test_count_nonterminal(self):
        self.assertEqual(jr.count_nonterminal(self.db), 0)
        add_task(self.db, "task-h1")
        self.assertEqual(jr.count_nonterminal(self.db), 1)
        self.assertIsNone(jr.count_nonterminal(self.root / "absent.db"))

    def test_count_nonterminal_survives_garbage(self):
        (self.root / "garbage.db").write_bytes(b"this is not sqlite at all")
        self.assertIsNone(jr.count_nonterminal(self.root / "garbage.db"))


class CliTests(Base):
    SCRIPT = Path(__file__).with_name("journal_reconcile.py")

    def run_cli(self, *args):
        return subprocess.run([sys.executable, str(self.SCRIPT), *args],
                              capture_output=True, text=True, check=False)

    def test_cli_dry_run_default_prints_plan(self):
        done_dir(self.subs, "dispatch-19", contains="task-c1")
        add_task(self.db, "task-c1")
        result = self.run_cli("--db", str(self.db), "--root", str(self.root))
        self.assertEqual(result.returncode, 1)
        self.assertIn("DRY RUN", result.stdout)
        self.assertIn("task-c1", result.stdout)
        self.assertRegex(result.stdout, r"result: dry_run candidates=1")

    def test_cli_json_report(self):
        done_dir(self.subs, "dispatch-20", contains="task-c2", usage_cost=0.25)
        add_task(self.db, "task-c2")
        result = self.run_cli("--db", str(self.db), "--root", str(self.root), "--json")
        self.assertEqual(result.returncode, 1)
        payload = json.loads(result.stdout)
        self.assertEqual(payload["schema"], "journal-reconcile/1")
        self.assertEqual(payload["mode"], "dry-run")
        self.assertEqual(payload["candidates"][0]["status"], "reconciled")
        self.assertEqual(payload["candidates"][0]["rows"][0]["budget_spent"], 0.25)
        self.assertEqual(payload["exitCode"], 1)

    def test_cli_apply(self):
        done_dir(self.subs, "dispatch-21", contains="task-c3")
        add_task(self.db, "task-c3")
        result = self.run_cli("--db", str(self.db), "--root", str(self.root), "--apply")
        self.assertEqual(result.returncode, 0)
        self.assertIn("wrote 1 journal row(s)", result.stdout)
        self.assertRegex(result.stdout, r"result: apply .*written=1")

    def test_cli_missing_db(self):
        result = self.run_cli("--db", str(self.root / "nope.db"))
        self.assertEqual(result.returncode, 2)
        self.assertIn("not found", result.stderr)

    def test_cli_clean_journal_exit_0(self):
        result = self.run_cli("--db", str(self.db), "--root", str(self.root))
        self.assertEqual(result.returncode, 0)
        self.assertIn("candidates=0", result.stdout)


if __name__ == "__main__":
    unittest.main()
