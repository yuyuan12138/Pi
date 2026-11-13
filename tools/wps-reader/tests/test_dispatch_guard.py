#!/usr/bin/env python3
"""Tests for tools/wps-reader/dispatch_guard.py and its wiring in the writers.

Plain unittest (no pytest dependency):
    python3 tools/wps-reader/tests/test_dispatch_guard.py
"""
import io
import os
import subprocess
import sys
import unittest
from contextlib import redirect_stderr
from pathlib import Path

READER_DIR = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(READER_DIR))

import dispatch_guard  # noqa: E402


class EnvMixin:
    """Run a test body with DISPATCHED_BY / PI_SESSION_ID fully under control."""

    def set_env(self, dispatched_by=None, session_id=None):
        for key, value in (("DISPATCHED_BY", dispatched_by), ("PI_SESSION_ID", session_id)):
            if value is None:
                os.environ.pop(key, None)
            else:
                os.environ[key] = value

    def tearDown(self):
        os.environ.pop("DISPATCHED_BY", None)
        os.environ.pop("PI_SESSION_ID", None)


class GuardWriteTests(EnvMixin, unittest.TestCase):
    def test_unset_env_blocks_with_nonzero_exit_and_message(self):
        self.set_env()
        buf = io.StringIO()
        with redirect_stderr(buf):
            with self.assertRaises(SystemExit) as ctx:
                dispatch_guard.guard_write("add_entry.py")
        self.assertNotEqual(ctx.exception.code, 0)
        err = buf.getvalue()
        self.assertIn("write blocked: DISPATCHED_BY unset", err)
        self.assertIn("dispatched subagent", err)
        self.assertEqual(len([ln for ln in err.splitlines() if ln.strip()]), 1, err)

    def test_empty_and_whitespace_env_blocks(self):
        for value in ("", "   ", "\t\n"):
            self.set_env(dispatched_by=value)
            buf = io.StringIO()
            with redirect_stderr(buf):
                with self.assertRaises(SystemExit) as ctx:
                    dispatch_guard.guard_write("batch_add.py")
            self.assertNotEqual(ctx.exception.code, 0)
            self.assertIn("DISPATCHED_BY unset", buf.getvalue())

    def test_set_env_proceeds_without_raising(self):
        self.set_env(dispatched_by="sa30", session_id="sess-1")
        prov = dispatch_guard.guard_write("add_entry.py")
        self.assertEqual(prov["dispatched_by"], "sa30")
        self.assertEqual(prov["session_id"], "sess-1")
        self.assertEqual(prov["tool"], "add_entry.py")

    def test_check_writable_probe(self):
        self.set_env()
        self.assertFalse(dispatch_guard.check_writable())
        self.set_env(dispatched_by="sa30")
        self.assertTrue(dispatch_guard.check_writable())


class WriterWiringTests(unittest.TestCase):
    """The guard must be the first action of each writer's main()."""

    WRITERS = ("add_entry.py", "batch_add.py")

    def test_writers_call_guard_before_any_write(self):
        for name in self.WRITERS:
            src = (READER_DIR / name).read_text(encoding="utf-8")
            self.assertIn("from dispatch_guard import", src, name)
            main_body = src.split("def main():", 1)[1]
            guard_at = main_body.index("guard_write(")
            for later in ("http_json(", "CDP(", "c.evaluate("):
                self.assertLess(guard_at, main_body.index(later), f"{name}: {later} before guard")
            first_stmt = main_body.splitlines()[1].strip()
            self.assertIn("guard_write(", first_stmt, f"{name}: guard is not the first action")

    def test_read_only_reader_is_not_gated(self):
        src = (READER_DIR / "wps_read.py").read_text(encoding="utf-8")
        self.assertNotIn("dispatch_guard", src)


class EndToEndRefusalTests(EnvMixin, unittest.TestCase):
    """Real process: refusal happens before any CDP connection is attempted."""

    def run_writer(self, name, args):
        env = {k: v for k, v in os.environ.items() if k != "DISPATCHED_BY"}
        return subprocess.run(
            [sys.executable, str(READER_DIR / name), *args],
            capture_output=True, text=True, timeout=60, env=env, cwd=str(READER_DIR),
        )

    def test_add_entry_refuses_without_dispatch(self):
        p = self.run_writer("add_entry.py", ["--amount", "25", "--category", "餐饮"])
        self.assertNotEqual(p.returncode, 0)
        self.assertIn("write blocked: DISPATCHED_BY unset", p.stderr)
        self.assertNotIn("Connection refused", p.stderr)  # no CDP attempt
        self.assertEqual(p.stdout.strip(), "")

    def test_batch_add_refuses_without_dispatch(self):
        p = self.run_writer("batch_add.py", ["/nonexistent-entries.json"])
        self.assertNotEqual(p.returncode, 0)
        self.assertIn("write blocked: DISPATCHED_BY unset", p.stderr)
        self.assertNotIn("Traceback", p.stderr)


if __name__ == "__main__":
    unittest.main(verbosity=2)
