"""Run with python3 -m unittest discover -s tools -p test_harvest_check.py."""
import json
import os
import sys
import tempfile
import time
import unittest
from pathlib import Path

import harvest_check as hc


def _events(*entries):
    return "\n".join(json.dumps(e) for e in entries) + "\n"


class HarvestCheckTests(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        self.addCleanup(self.tmp.cleanup)
        self.root = Path(self.tmp.name)
        self.subs = self.root / ".pi" / "subagents"
        self.subs.mkdir(parents=True)
        (self.root / "instructions" / "agents" / "coder" / "records").mkdir(parents=True)
        (self.root / "instructions" / "agents" / "coder" / "records" / "experience.md").write_text(
            "# coder experience log\n- 2026-11-11 Created; no engagements yet.\n"
        )
        # Backdate the log: fixtures' workers finish AFTER this file's last edit.
        stale = time.time() - 30 * 86400
        os.utime(self.root / "instructions" / "agents" / "coder" / "records" / "experience.md", (stale, stale))
        (self.root / "work").mkdir()

    def make_done_subagent(self, subagent_id: str, brief: str, result_chars: int = 1500,
                           age_seconds: int = 3600) -> Path:
        agent_dir = self.subs / subagent_id
        agent_dir.mkdir()
        (agent_dir / "events.jsonl").write_text(
            _events(
                {"type": "message_end", "message": {"role": "user", "content": [{"type": "text", "text": brief}]}},
                {"type": "agent_end"},
                {"type": "agent_settled"},
            )
        )
        (agent_dir / "result.md").write_text("r" * result_chars)
        old = time.time() - age_seconds
        os.utime(agent_dir / "events.jsonl", (old, old))
        os.utime(agent_dir / "result.md", (old, old))
        return agent_dir

    def test_flags_missing_harvest_fixture(self):
        """PLAN.md B5 acceptance: catches a seeded missing-harvest fixture."""
        self.make_done_subagent("theme-b-x1", "[project:PiAgents] Execute Theme B3 as dispatched coder.")
        report = hc.check(self.root, days=1, now=time.time())
        self.assertEqual(len(report["flagged"]), 1)
        self.assertEqual(report["flagged"][0]["id"], "theme-b-x1")
        self.assertEqual(report["flagged"][0]["role"], "coder")

    def test_experience_appended_after_finish_counts_as_harvested(self):
        agent_dir = self.make_done_subagent("theme-b-x1", "[project:PiAgents] work as dispatched coder.")
        finish = (agent_dir / "events.jsonl").stat().st_mtime
        exp = self.root / "instructions" / "agents" / "coder" / "records" / "experience.md"
        os.utime(exp, (finish + 60, finish + 60))  # harvested after finish
        report = hc.check(self.root, days=1, now=time.time())
        self.assertEqual(report["flagged"], [])
        self.assertEqual(len(report["harvested"]), 1)

    def test_work_record_after_finish_counts_as_harvested(self):
        self.make_done_subagent("theme-b-x1", "[project:PiAgents] work.")
        record = self.root / "work" / "2026-11-13" / "theme-b" / "RECORD-theme-b.md"
        record.parent.mkdir(parents=True)
        record.write_text("# Theme B record\n")
        report = hc.check(self.root, days=1, now=time.time())
        self.assertEqual(report["flagged"], [])
        self.assertTrue(any("RECORD-theme-b" in p for p in report["harvested"][0]["record_hits"]))

    def test_record_referencing_subagent_id_counts_even_when_older(self):
        self.make_done_subagent("theme-b-x1", "[project:PiAgents] work.")
        record = self.root / "work" / "theme-b" / "RECORD.md"
        record.parent.mkdir(parents=True)
        record.write_text("# Record\nWorker transcript: .pi/subagents/theme-b-x1\n")
        old = time.time() - 7200  # older than the finish: only the id match saves it
        os.utime(record, (old, old))
        report = hc.check(self.root, days=1, now=time.time())
        self.assertEqual(report["flagged"], [])

    def test_small_results_are_skipped_as_bounded_checks(self):
        self.make_done_subagent("quick-x1", "[project:PiAgents] quick bounded check.", result_chars=200)
        report = hc.check(self.root, days=1, now=time.time())
        self.assertEqual(report["flagged"], [])
        self.assertEqual(report["skipped_small"], 1)

    def test_running_and_out_of_window_dispatches_are_ignored(self):
        running = self.subs / "running-x1"
        running.mkdir()
        (running / "events.jsonl").write_text(_events({"type": "turn_end"}))  # fresh mtime, no terminal
        self.make_done_subagent("old-x1", "[project:PiAgents] old work.", age_seconds=3 * 86400)
        report = hc.check(self.root, days=1, now=time.time())
        self.assertEqual(report["done_total"], 1)
        self.assertEqual(report["in_window"], 0)
        self.assertEqual(report["flagged"], [])

    def test_first_user_brief_extracts_text_blocks(self):
        agent_dir = self.make_done_subagent("brief-x1", "[project:PiAgents] the brief text itself.")
        brief = hc.first_user_brief(agent_dir / "events.jsonl")
        self.assertIn("[project:PiAgents] the brief text itself.", brief)
        self.assertEqual(hc.first_user_brief(agent_dir / "missing.jsonl"), "")

    def test_strict_mode_exits_1_on_findings_only(self):
        self.make_done_subagent("theme-b-x1", "[project:PiAgents] work as coder.")
        self.assertEqual(hc.main(["--root", str(self.root), "--days", "1"]), 0)
        self.assertEqual(hc.main(["--root", str(self.root), "--days", "1", "--strict"]), 1)

    def test_cli_report_only_writes_nothing(self):
        self.make_done_subagent("theme-b-x1", "[project:PiAgents] work as coder.")
        before = sorted(str(p.relative_to(self.root)) for p in self.root.rglob("*"))
        self.assertEqual(hc.main(["--root", str(self.root), "--days", "1"]), 0)
        after = sorted(str(p.relative_to(self.root)) for p in self.root.rglob("*"))
        self.assertEqual(before, after)  # report-only: zero writes anywhere

    def test_git_commit_after_finish_counts_as_harvested(self):
        """Worker-authored RECORD (mtime pre-finish) committed by the parent post-finish."""
        self.make_done_subagent("theme-d-x1", "[project:PiAgents] work as coder.")
        record = self.root / "work" / "theme-d" / "RECORD.md"
        record.parent.mkdir(parents=True)
        record.write_text("# Theme D record\n")
        old = time.time() - 7200
        os.utime(record, (old, old))  # written DURING the run
        # Local git repo; commit AFTER the worker finished (parent verification).
        env = dict(os.environ, GIT_AUTHOR_NAME="t", GIT_AUTHOR_EMAIL="t@t", GIT_COMMITTER_NAME="t", GIT_COMMITTER_EMAIL="t@t")
        import subprocess
        def git(*args):
            subprocess.run(["git", "-C", str(self.root), *args], check=True, capture_output=True, env=env)
        git("init", "-q")
        git("add", str(record.relative_to(self.root)))
        git("commit", "-qm", "record")
        report = hc.check(self.root, days=1, now=time.time())
        self.assertEqual(report["flagged"], [])

    def test_no_git_repo_still_uses_mtime_evidence(self):
        self.make_done_subagent("theme-b-x1", "[project:PiAgents] work as coder.")
        # No .git anywhere in the fixture: git evidence fail-opens to empty.
        report = hc.check(self.root, days=1, now=time.time())
        self.assertEqual(len(report["flagged"]), 1)

    def test_role_detection_prefers_longest_role_name(self):
        self.assertEqual(hc.detect_role("dispatch a reviewer role now", ["code", "reviewer"]), "reviewer")
        self.assertIsNone(hc.detect_role("no role here", ["coder"]))


if __name__ == "__main__":
    unittest.main()
