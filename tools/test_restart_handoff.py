"""Run with python3 -m unittest discover -s tools -p test_restart_handoff.py."""
import json
import os
import subprocess
import sys
import tempfile
import time
import unittest
from pathlib import Path

import restart_handoff as rh


def _events(*entries):
    return "\n".join(json.dumps(e) for e in entries) + "\n"


class SubagentScanTests(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        self.addCleanup(self.tmp.cleanup)
        self.subs = Path(self.tmp.name) / ".pi" / "subagents"
        self.subs.mkdir(parents=True)
        now = time.time()

        # done: terminal event + result.md
        done = self.subs / "done-x"
        done.mkdir()
        (done / "events.jsonl").write_text(_events({"type": "turn_end"},
                                                   {"type": "agent_settled"}))
        (done / "result.md").write_text("result\n")

        # done via agent_end only, no result.md
        done2 = self.subs / "done-y"
        done2.mkdir()
        (done2 / "events.jsonl").write_text(_events({"type": "agent_end"}))

        # running: no terminal marker, fresh mtime
        running = self.subs / "running-x"
        running.mkdir()
        (running / "events.jsonl").write_text(_events({"type": "tool_execution_start"}))

        # stale: no terminal marker, no activity for 2x STALE_SECONDS
        stale = self.subs / "stale-x"
        stale.mkdir()
        events = stale / "events.jsonl"
        events.write_text(_events({"type": "tool_execution_start"}))
        os.utime(events, (now - 2 * rh.STALE_SECONDS, now - 2 * rh.STALE_SECONDS))

        # skipped: dir without events.jsonl, and a stray file
        (self.subs / "sessions").mkdir()
        (self.subs / "stray.txt").write_text("not a dispatch\n")

        self.entries = {e["id"]: e for e in rh.scan_subagents(self.subs, now=now)}

    def test_skips_non_task_entries(self):
        self.assertNotIn("sessions", self.entries)
        self.assertNotIn("stray.txt", self.entries)

    def test_done_inference(self):
        self.assertEqual(self.entries["done-x"]["status"], "done")
        self.assertEqual(self.entries["done-y"]["status"], "done")
        self.assertTrue(self.entries["done-x"]["result"])
        self.assertFalse(self.entries["done-y"]["result"])

    def test_running_and_stale_inference(self):
        self.assertEqual(self.entries["running-x"]["status"], "running")
        self.assertEqual(self.entries["stale-x"]["status"], "stale")

    def test_entry_fields(self):
        entry = self.entries["done-x"]
        self.assertEqual(entry["dir"], str(self.subs / "done-x"))
        self.assertIn("events_mtime", entry)
        self.assertIn("age_seconds", entry)

    def test_is_done_current_state(self):
        self.assertTrue(rh.is_done(self.subs / "done-x"))
        self.assertFalse(rh.is_done(self.subs / "running-x"))


class ProcessScanTests(unittest.TestCase):
    LINES = [
        "  1234 pi",
        " 1235 bash /Users/yuyuan/.pi/agent/scripts/pi-web-bridge-tunnel-keepalive.sh",
        " 1236 ssh -fN -R /root/x/bridge.sock:127.0.0.1:7788 root@47.114.61.92",
        " 1237 /bin/zsh",
        " 1238 python3 tools/restart_handoff.py snapshot",
    ]

    def test_default_patterns_match_drivers_only(self):
        pids = {p["pid"] for p in rh.scan_processes(rh.DEFAULT_PATTERNS,
                                                    lines=self.LINES)}
        self.assertEqual(pids, {"1234", "1235", "1236"})

    def test_custom_pattern(self):
        pids = {p["pid"] for p in rh.scan_processes(["zsh"], lines=self.LINES)}
        self.assertEqual(pids, {"1237"})

    def test_match_fields(self):
        match = rh.scan_processes(["keepalive"], lines=self.LINES)[0]
        self.assertIn("keepalive.sh", match["command"])
        self.assertEqual(match["pid"], "1235")

    def test_live_ps_is_read_only(self):
        # runs the real `ps`; must return a list of pid/command dicts
        procs = rh.scan_processes([r"ps ax"])
        self.assertIsInstance(procs, list)


class SnapshotTests(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        self.addCleanup(self.tmp.cleanup)
        self.root = Path(self.tmp.name)
        subs = self.root / ".pi" / "subagents"
        subs.mkdir(parents=True)
        done = subs / "done-x"
        done.mkdir()
        (done / "events.jsonl").write_text(_events({"type": "agent_settled"}))
        (done / "result.md").write_text("ok\n")
        running = subs / "running-x"
        running.mkdir()
        (running / "events.jsonl").write_text(_events({"type": "turn_start"}))

    def test_snapshot_writes_json_and_md(self):
        _, json_path, md_path = rh.make_snapshot(
            self.root, patterns=["no-match-xyz"])
        self.assertRegex(json_path.name, r"restart-handoff-\d{8}-\d{6}\.json")
        self.assertEqual(md_path.with_suffix(".json"), json_path)
        payload = json.loads(json_path.read_text())
        self.assertEqual(payload["schema"], rh.SCHEMA)
        self.assertEqual(payload["root"], str(self.root.resolve()))
        ids = {e["id"] for e in payload["subagents"]}
        self.assertEqual(ids, {"done-x", "running-x"})
        self.assertEqual(payload["processes"], [])
        summary = md_path.read_text()
        self.assertIn("running-x", summary)
        self.assertIn("python3 tools/restart_handoff.py resume", summary)

    def test_snapshot_is_idempotent_and_sorted(self):
        first, j1, _ = rh.make_snapshot(self.root, patterns=["x"])
        second, j2, _ = rh.make_snapshot(self.root, patterns=["x"])
        self.assertEqual([e["id"] for e in first["subagents"]],
                         [e["id"] for e in second["subagents"]])
        self.assertEqual(min(j1.name, j2.name), j1.name)

    def test_no_subagents_dir(self):
        empty = Path(self.tmp.name) / "empty"
        empty.mkdir()
        payload, _, _ = rh.make_snapshot(empty, patterns=["x"])
        self.assertEqual(payload["subagents"], [])


class ResumeTests(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        self.addCleanup(self.tmp.cleanup)
        self.root = Path(self.tmp.name)
        subs = self.root / ".pi" / "subagents"
        subs.mkdir(parents=True)
        done = subs / "done-x"
        done.mkdir()
        (done / "events.jsonl").write_text(_events({"type": "agent_settled"}))
        running = subs / "running-x"
        running.mkdir()
        (running / "events.jsonl").write_text(_events({"type": "turn_start"}))
        _, self.json_path, _ = rh.make_snapshot(self.root, patterns=["x"])

    def test_resume_relaunch_list(self):
        results = rh.reconcile(json.loads(self.json_path.read_text()), self.root)
        by_id = {r["id"]: r["action"] for r in results}
        self.assertEqual(by_id, {"running-x": "needs-relaunch"})

    def test_resume_resolved_after_finish(self):
        (self.root / ".pi" / "subagents" / "running-x" / "result.md").write_text("late\n")
        results = rh.reconcile(json.loads(self.json_path.read_text()), self.root)
        self.assertEqual(results[0]["action"], "resolved")

    def test_resume_skips_done_entries(self):
        results = rh.reconcile(json.loads(self.json_path.read_text()), self.root)
        self.assertNotIn("done-x", {r["id"] for r in results})

    def test_newest_handoff_selection(self):
        time.sleep(1.1)  # distinct filename timestamp
        _, newer, _ = rh.make_snapshot(self.root, patterns=["x"])
        self.assertEqual(rh.newest_handoff(self.root), newer)


class CliTests(unittest.TestCase):
    SCRIPT = Path(__file__).with_name("restart_handoff.py")

    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        self.addCleanup(self.tmp.cleanup)
        self.root = Path(self.tmp.name)
        subs = self.root / ".pi" / "subagents"
        subs.mkdir(parents=True)
        running = subs / "running-x"
        running.mkdir()
        (running / "events.jsonl").write_text(_events({"type": "turn_start"}))

    def run_cli(self, *args):
        return subprocess.run([sys.executable, str(self.SCRIPT), *args],
                              capture_output=True, text=True, check=False)

    def test_snapshot_cli(self):
        result = self.run_cli("snapshot", "--root", str(self.root),
                              "--pattern", "never-matches-xyz")
        self.assertEqual(result.returncode, 0)
        self.assertIn("restart-handoff-", result.stdout)
        self.assertIn("1 not done", result.stdout)

    def test_resume_cli_lists_relaunch(self):
        self.run_cli("snapshot", "--root", str(self.root),
                     "--pattern", "never-matches-xyz")
        result = self.run_cli("resume", "--root", str(self.root))
        self.assertEqual(result.returncode, 0)
        self.assertIn("NEEDS-RELAUNCH  running-x", result.stdout)

    def test_resume_explicit_file(self):
        _, json_path, _ = rh.make_snapshot(self.root, patterns=["x"])
        result = self.run_cli("resume", "--file", str(json_path))
        self.assertEqual(result.returncode, 0)
        self.assertIn(str(json_path), result.stdout)

    def test_resume_without_handoff_fails(self):
        result = self.run_cli("resume", "--root", str(self.root))
        self.assertEqual(result.returncode, 1)
        self.assertIn("no restart handoff file", result.stderr)

    def test_resume_rejects_foreign_file(self):
        bogus = self.root / "bogus.json"
        bogus.write_text(json.dumps({"schema": "other/9"}))
        result = self.run_cli("resume", "--file", str(bogus))
        self.assertEqual(result.returncode, 1)
        self.assertIn("not a restart-handoff/1 file", result.stderr)


if __name__ == "__main__":
    unittest.main()


class JournalReconcileHintTests(unittest.TestCase):
    """A4 wiring: resume suggests journal reconciliation when the coordinator
    journal holds non-terminal task rows (env-overridable db for tests)."""

    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        self.addCleanup(self.tmp.cleanup)
        self.root = Path(self.tmp.name)
        subs = self.root / ".pi" / "subagents"
        running = subs / "running-x"
        running.mkdir(parents=True)
        (running / "events.jsonl").write_text(_events({"type": "turn_start"}))
        rh.make_snapshot(self.root, patterns=["x"])

    def run_cli(self, *args, env_extra=None):
        env = dict(os.environ)
        env.update(env_extra or {})
        return subprocess.run([sys.executable, str(Path(__file__).with_name("restart_handoff.py")), *args],
                              capture_output=True, text=True, check=False, env=env)

    def make_journal_with_candidate(self, db_path):
        import sqlite3
        con = sqlite3.connect(db_path)
        con.executescript(
            "CREATE TABLE journal(id INTEGER PRIMARY KEY AUTOINCREMENT, at TEXT NOT NULL,"
            " task_id TEXT NOT NULL, phase TEXT NOT NULL, detail TEXT, stage TEXT, dedupe_sha TEXT);"
            "CREATE TABLE registry(id INTEGER PRIMARY KEY CHECK(id = 1), json TEXT NOT NULL);"
        )
        con.execute("INSERT INTO registry(id, json) VALUES(1, ?)", (json.dumps({"projects": []}),))
        con.execute("INSERT INTO journal(at, task_id, phase, detail) VALUES(?,?,?,?)",
                    ("2026-11-13T10:00:00.000Z", "task-hint", "received",
                     json.dumps({"taskId": "task-hint", "dedupeKey": "dk", "goal": "g",
                                 "mutating": True, "createdAt": "2026-11-13T10:00:00.000Z"})))
        con.execute("INSERT INTO journal(at, task_id, phase) VALUES(?,?,?)",
                    ("2026-11-13T10:00:01.000Z", "task-hint", "queued"))
        con.commit()
        con.close()

    def test_hint_function_silent_without_rows(self):
        import journal_reconcile as jr
        orig = jr.count_nonterminal
        jr.count_nonterminal = lambda db_path=None: 0
        try:
            self.assertIsNone(rh._journal_hint())
        finally:
            jr.count_nonterminal = orig

    def test_hint_function_mentions_command(self):
        import journal_reconcile as jr
        orig = jr.count_nonterminal
        jr.count_nonterminal = lambda db_path=None: 3
        try:
            hint = rh._journal_hint()
        finally:
            jr.count_nonterminal = orig
        self.assertIn("3 non-terminal", hint)
        self.assertIn("tools/journal_reconcile.py", hint)

    def test_hint_function_survives_import_failure(self):
        import sys as _sys
        saved = _sys.path.pop(0) if _sys.path and _sys.path[0] == "" else None
        import journal_reconcile as jr  # already imported; force failure via sys.modules
        saved_modules = _sys.modules.pop("journal_reconcile", None)
        # simulate the import failing inside _journal_hint only
        real_import = __import__

        def fake_import(name, *a, **k):
            if name == "journal_reconcile":
                raise ImportError("blocked for test")
            return real_import(name, *a, **k)

        import builtins
        orig_import = builtins.__import__
        builtins.__import__ = fake_import
        try:
            self.assertIsNone(rh._journal_hint())
        finally:
            builtins.__import__ = orig_import
            if saved_modules is not None:
                _sys.modules["journal_reconcile"] = saved_modules
            if saved is not None:
                _sys.path.insert(0, saved)

    def test_resume_cli_suggests_reconcile_when_nonterminal_rows_exist(self):
        tmp = tempfile.mkdtemp()
        self.addCleanup(__import__("shutil").rmtree, tmp, ignore_errors=True)
        db_path = os.path.join(tmp, "coordinator.db")
        self.make_journal_with_candidate(db_path)
        result = self.run_cli("resume", "--root", str(self.root),
                              env_extra={"JOURNAL_RECONCILE_DB": db_path})
        self.assertEqual(result.returncode, 0)
        self.assertIn("1 non-terminal coordinator task row(s)", result.stdout)
        self.assertIn("tools/journal_reconcile.py", result.stdout)

    def test_resume_cli_no_hint_when_journal_clean_or_missing(self):
        result = self.run_cli("resume", "--root", str(self.root),
                              env_extra={"JOURNAL_RECONCILE_DB": "/nonexistent/journal.db"})
        self.assertEqual(result.returncode, 0)
        self.assertNotIn("journal_reconcile", result.stdout)
