"""Run with python3 -m unittest discover -s tools -p test_work_record_lint.py.

Fixtures cover: clean record, missing field, bad/conflicting status, missing
tag, tag-directory mismatch, append-only violation vs pure append, uncommitted
changes, date/dirname mismatch, length budget, --since/--record modes, CLI
exit codes.
"""
import subprocess
import sys
import tempfile
import unittest
from pathlib import Path

import work_record_lint as wrl

CLEAN = """\
# Work record — fixture task

- **Date**: 2026-11-13
- **Task**: Do a bounded thing
- **Dispatched-by**: coordinator primary
- **Worker**: fixture-worker-x1
- **Brief header**: [project:Test]
- **Status**: delivered

## Task brief
Do the bounded thing.
Stay within scope constraints.

## Delivered
- `foo.py` (new)

## Verification evidence
- `python3 foo.py` — exit 0.

## Open items
- None.
"""


def make_record(root: Path, text: str = CLEAN, slug: str = "2026-11-13-fixture",
                subdir: str = "work") -> Path:
    d = root / subdir / slug
    d.mkdir(parents=True, exist_ok=True)
    p = d / "RECORD.md"
    p.write_text(text, encoding="utf-8")
    return p


def lint(path: Path, tag_map: dict[str, str] | None = None) -> wrl.RecordResult:
    return wrl.lint_record(path, tag_map=tag_map or {"work/": "Test"},
                           base=path.parents[2])


def messages(result: wrl.RecordResult, severity: str | None = None) -> list[str]:
    return [f.message for f in result.findings
            if severity is None or f.severity == severity]


def git(*args: str, cwd: Path) -> None:
    subprocess.run(["git", *args], cwd=str(cwd), check=True,
                   capture_output=True, text=True)


class TempRootCase(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        self.addCleanup(self.tmp.cleanup)
        self.root = Path(self.tmp.name).resolve()


class CleanRecordTests(TempRootCase):
    def test_clean_record_passes(self):
        result = lint(make_record(self.root))
        self.assertEqual(result.status, "PASS", msg=str(messages(result)))

    def test_clean_record_inside_git_repo_passes(self):
        git("init", "-q", cwd=self.root)
        git("config", "user.email", "t@example.com", cwd=self.root)
        git("config", "user.name", "t", cwd=self.root)
        path = make_record(self.root)
        git("add", "-A", cwd=self.root)
        git("commit", "-q", "-m", "record", cwd=self.root)
        result = lint(path)
        self.assertEqual(result.status, "PASS", msg=str(messages(result)))

    def test_template_comment_block_ignored(self):
        commented = ("<!--\nFORMAT TEMPLATE\n    - Status:      delivered | "
                     "delivered-unverified | blocked | failed\n    - Worker: x\n-->\n"
                     + CLEAN)
        result = lint(make_record(self.root, text=commented))
        self.assertEqual(result.status, "PASS", msg=str(messages(result)))

    def test_prose_header_and_dot_separator_parse(self):
        text = CLEAN.replace(
            "- **Date**: 2026-11-13\n- **Task**: Do a bounded thing\n"
            "- **Dispatched-by**: coordinator primary\n- **Worker**: fixture-worker-x1\n"
            "- **Brief header**: [project:Test]\n- **Status**: delivered\n",
            "Date 2026-11-13 · Task: Do a bounded thing · Dispatched-by: coordinator primary · "
            "Worker: fixture-worker-x1 · Brief header: [project:Test] · Status: delivered\n")
        result = lint(make_record(self.root, text=text))
        self.assertEqual(result.status, "PASS", msg=str(messages(result)))

    def test_section_prefix_match_accepted(self):
        text = CLEAN.replace("## Task brief", "## Task brief (summary)")
        text = text.replace("## Verification evidence", "## Verification evidence (UP-CHECK)")
        result = lint(make_record(self.root, text=text))
        self.assertEqual(result.status, "PASS", msg=str(messages(result)))


class HeaderFieldTests(TempRootCase):
    def test_missing_required_field_fails(self):
        text = CLEAN.replace("- **Worker**: fixture-worker-x1\n", "")
        result = lint(make_record(self.root, text=text))
        self.assertEqual(result.status, "FAIL")
        self.assertIn("missing required header field(s): Worker", messages(result, "fail")[0])

    def test_multiple_missing_fields_listed(self):
        text = CLEAN.replace("- **Worker**: fixture-worker-x1\n", "")
        text = text.replace("- **Status**: delivered\n", "")
        result = lint(make_record(self.root, text=text))
        self.assertTrue(any("Worker" in m and "Status" in m for m in messages(result, "fail")))

    def test_date_dirname_mismatch_warns(self):
        path = make_record(self.root)
        result = lint(path)
        # same date -> no warning
        self.assertFalse(any("does not match record directory" in m for m in messages(result)))
        text = CLEAN.replace("**Date**: 2026-11-13", "**Date**: 2026-11-10")
        result = lint(make_record(self.root, text=text, slug="2026-11-13-late"))
        self.assertTrue(any("does not match record directory" in m
                            for m in messages(result, "warn")))


class StatusVocabularyTests(TempRootCase):
    def test_bad_status_fails(self):
        text = CLEAN.replace("**Status**: delivered", "**Status**: done")
        result = lint(make_record(self.root, text=text))
        self.assertEqual(result.status, "FAIL")
        self.assertTrue(any("outside the vocabulary" in m for m in messages(result, "fail")))

    def test_conflicting_status_fails(self):
        text = CLEAN.replace("**Status**: delivered", "**Status**: delivered then blocked")
        result = lint(make_record(self.root, text=text))
        self.assertEqual(result.status, "FAIL")
        self.assertTrue(any("conflicting" in m for m in messages(result, "fail")))

    def test_delivered_unverified_is_valid(self):
        text = CLEAN.replace("**Status**: delivered", "**Status**: delivered-unverified")
        result = lint(make_record(self.root, text=text))
        self.assertEqual(result.status, "PASS", msg=str(messages(result)))

    def test_extra_status_prose_warns(self):
        text = CLEAN.replace("**Status**: delivered", "**Status**: delivered, all green")
        result = lint(make_record(self.root, text=text))
        self.assertEqual(result.status, "WARN")
        self.assertTrue(any("extra prose" in m for m in messages(result, "warn")))


class SectionTests(TempRootCase):
    def test_missing_section_fails(self):
        text = CLEAN.replace("## Open items\n- None.\n", "")
        result = lint(make_record(self.root, text=text))
        self.assertEqual(result.status, "FAIL")
        self.assertTrue(any("Open items" in m for m in messages(result, "fail")))

    def test_short_brief_warns(self):
        text = CLEAN.replace("Do the bounded thing.\nStay within scope constraints.\n",
                             "Do the thing.\n")
        result = lint(make_record(self.root, text=text))
        self.assertTrue(any("under 2 lines" in m for m in messages(result, "warn")))

    def test_long_brief_warns(self):
        extra = "\n".join(f"brief line {i}." for i in range(8))
        text = CLEAN.replace("Stay within scope constraints.", "Stay in scope.\n" + extra)
        result = lint(make_record(self.root, text=text))
        self.assertTrue(any("task brief is" in m for m in messages(result, "warn")))

    def test_length_budget_warns(self):
        filler = "\n".join(f"filler line {i} with some words." for i in range(80))
        text = CLEAN + filler + "\n"
        result = lint(make_record(self.root, text=text))
        self.assertTrue(any("exceed the 80-line budget" in m for m in messages(result, "warn")))


class TagTests(TempRootCase):
    def test_missing_tag_warns(self):
        text = CLEAN.replace("- **Brief header**: [project:Test]\n", "")
        result = lint(make_record(self.root, text=text))
        self.assertEqual(result.status, "WARN")
        self.assertTrue(any("no [project:...] brief-header tag" in m
                            for m in messages(result, "warn")))

    def test_explicit_none_brief_header_warns(self):
        text = CLEAN.replace("[project:Test]", "none")
        result = lint(make_record(self.root, text=text))
        self.assertEqual(result.status, "WARN")
        self.assertTrue(any("no [project:...] brief-header tag" in m
                            for m in messages(result, "warn")))

    def test_tag_found_in_brief_section_counts(self):
        text = CLEAN.replace("- **Brief header**: [project:Test]\n", "")
        text = text.replace("Do the bounded thing.",
                            "Per brief `[project:Test]`, do the bounded thing.")
        result = lint(make_record(self.root, text=text))
        self.assertEqual(result.status, "PASS", msg=str(messages(result)))

    def test_tag_directory_mismatch_fails(self):
        result = lint(make_record(self.root))  # CLEAN carries [project:Test]
        self.assertEqual(result.status, "PASS")
        text = CLEAN.replace("[project:Test]", "[project:Elsewhere]")
        result = lint(make_record(self.root, text=text, slug="2026-11-13-mismatch"))
        self.assertEqual(result.status, "FAIL")
        self.assertTrue(any("does not match this directory" in m
                            for m in messages(result, "fail")))

    def test_subproject_tag_matches_parent(self):
        text = CLEAN.replace("[project:Test]", "[project:Test.subproject]")
        result = lint(make_record(self.root, text=text))
        self.assertEqual(result.status, "PASS", msg=str(messages(result)))

    def test_unmapped_directory_skips_consistency(self):
        text = CLEAN.replace("[project:Test]", "[project:Anything]")
        path = make_record(self.root, text=text, subdir="some-project/work")
        result = wrl.lint_record(path, tag_map={"work/": "Test"}, base=self.root)
        self.assertFalse(any("project tag" in m for m in messages(result)))
        self.assertFalse(any("no [project:...]" in m for m in messages(result)))


class GitAppendOnlyTests(TempRootCase):
    def setUp(self):
        super().setUp()
        git("init", "-q", cwd=self.root)
        git("config", "user.email", "t@example.com", cwd=self.root)
        git("config", "user.name", "t", cwd=self.root)

    def _commit_all(self, msg):
        git("add", "-A", cwd=self.root)
        git("commit", "-q", "-m", msg, cwd=self.root)

    def test_append_only_violation_fails(self):
        path = make_record(self.root)
        self._commit_all("v1")
        path.write_text(CLEAN.replace("- `foo.py` (new)", "- `bar.py` (rewritten history)"),
                        encoding="utf-8")
        self._commit_all("v2")
        result = lint(path)
        self.assertEqual(result.status, "FAIL")
        self.assertTrue(any("append-only violation" in m for m in messages(result, "fail")))

    def test_pure_append_allowed(self):
        path = make_record(self.root)
        self._commit_all("v1")
        path.write_text(CLEAN + "- Follow-up item added later.\n", encoding="utf-8")
        self._commit_all("v2")
        result = lint(path)
        self.assertNotEqual(result.status, "FAIL")

    def test_uncommitted_changes_warn(self):
        path = make_record(self.root)
        self._commit_all("v1")
        path.write_text(CLEAN + "- not yet committed\n", encoding="utf-8")
        result = lint(path)
        self.assertTrue(any("uncommitted changes" in m for m in messages(result, "warn")))

    def test_untracked_record_skips_git_checks(self):
        path = make_record(self.root)
        result = lint(path)
        self.assertNotEqual(result.status, "FAIL")
        self.assertFalse(any("uncommitted" in m or "append-only" in m
                             for m in messages(result)))


class ModeTests(TempRootCase):
    def test_since_filters_by_directory_date(self):
        make_record(self.root, slug="2026-11-11-old")
        make_record(self.root, slug="2026-11-13-new")
        records = wrl.find_records(self.root)
        kept = [r for r in records if (d := wrl._record_date(r, self.root)) and d >= "2026-11-13"]
        self.assertEqual([r.parent.name for r in kept], ["2026-11-13-new"])

    def test_find_records_covers_remote_agent_operations(self):
        make_record(self.root, subdir="remote-agent/operations/episode/work")
        make_record(self.root, subdir="operations/other-ep/work")
        found = {r.parent.name for r in wrl.find_records(self.root)}
        self.assertIn("2026-11-13-fixture", found)
        self.assertEqual(len(found), 1)  # same slug in both roots -> deduped set
        self.assertEqual(len(wrl.find_records(self.root)), 2)

    def test_default_scan_roots(self):
        make_record(self.root, subdir="remote-agent/operations/ep/work")
        (self.root / "work").mkdir()
        roots = wrl.default_scan_roots(self.root)
        self.assertIn(self.root / "work", roots)
        self.assertIn(self.root / "remote-agent/operations/ep/work", roots)


class CliTests(TempRootCase):
    def setUp(self):
        super().setUp()
        self.script = Path(wrl.__file__).resolve()

    def _run(self, *args):
        return subprocess.run([sys.executable, str(self.script), *args],
                              capture_output=True, text=True, check=False)

    def test_exit_0_on_clean_tree(self):
        make_record(self.root)
        r = self._run("--root", str(self.root), "--no-default-tags",
                      "--project-tag", "work/=Test")
        self.assertEqual(r.returncode, 0, msg=r.stdout + r.stderr)
        self.assertIn("1 pass", r.stdout)

    def test_exit_1_on_fail(self):
        make_record(self.root, text=CLEAN.replace("- **Worker**: fixture-worker-x1\n", ""))
        r = self._run("--root", str(self.root), "--no-default-tags",
                      "--project-tag", "work/=Test")
        self.assertEqual(r.returncode, 1, msg=r.stdout + r.stderr)

    def test_record_mode_single_file(self):
        path = make_record(self.root)
        r = self._run("--root", str(self.root), "--no-default-tags",
                      "--project-tag", "work/=Test", "--record", str(path))
        self.assertEqual(r.returncode, 0, msg=r.stdout + r.stderr)
        self.assertIn("[PASS]", r.stdout)

    def test_missing_record_file_exits_2(self):
        r = self._run("--root", str(self.root), "--record", "nope/RECORD.md")
        self.assertEqual(r.returncode, 2)

    def test_empty_tree_exits_0(self):
        r = self._run("--root", str(self.root))
        self.assertEqual(r.returncode, 0)
        self.assertIn("No RECORD.md files found", r.stdout)

    def test_bad_project_tag_flag_exits_2(self):
        r = self._run("--root", str(self.root), "--project-tag", "no-separator")
        self.assertEqual(r.returncode, 2)


if __name__ == "__main__":
    unittest.main()
