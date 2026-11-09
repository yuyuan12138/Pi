#!/usr/bin/env python3
"""Offline tests for tools/skills_doctor.py — no network calls.

Run:  python3 -m unittest tests/test_skills_doctor.py -v

Uses committed fixture skill trees under tests/fixtures/skills_doctor/
(root_a, root_b). The real pi 1.5.0 loader smoke test runs only when node
and the installed release are present (still fully local).
"""

from __future__ import annotations

import json
import shutil
import sys
import unittest
from pathlib import Path

TOOLS_DIR = Path(__file__).resolve().parent.parent / "tools"
sys.path.insert(0, str(TOOLS_DIR))

import skills_doctor as sd  # noqa: E402

FIXTURES = Path(__file__).resolve().parent / "fixtures" / "skills_doctor"
ROOT_A = FIXTURES / "root_a"
ROOT_B = FIXTURES / "root_b"


def fixture_roots() -> list[tuple[str, Path]]:
    return [("root_a", ROOT_A), ("root_b", ROOT_B)]


def findings_by_check(result: dict, key: str) -> list[dict]:
    return result["findings"].get(key) or []


class WalkInventoryTests(unittest.TestCase):
    def test_walk_finds_all_fixture_skills(self):
        entries = sd.walk_root(ROOT_A) + sd.walk_root(ROOT_B)
        names = sorted(e["path"].parent.name for e in entries)
        self.assertEqual(
            names,
            ["alpha", "alpha", "badname", "beta", "brokenfm", "gamma",
             "hidden-gem", "nodesc"],
        )
        declared = [e for e in entries if e["declared"]]
        self.assertEqual(len(declared), 8)

    def test_scan_inventory_counts(self):
        result = sd.scan(fixture_roots(), use_loader=False)
        self.assertEqual(result["summary"]["skills_on_disk"], 8)
        roots_seen = {item["root"] for item in result["inventory"]}
        self.assertEqual(roots_seen, {"root_a", "root_b"})


class DuplicateTests(unittest.TestCase):
    def test_duplicate_name_across_roots_detected(self):
        result = sd.scan(fixture_roots(), use_loader=False)
        dupes = findings_by_check(result, "duplicates")
        alpha_dupes = [d for d in dupes if d.get("name") == "alpha"]
        self.assertEqual(len(alpha_dupes), 1)
        self.assertEqual(set(alpha_dupes[0]["roots"]), {"root_a", "root_b"})
        self.assertIn("multiple roots", alpha_dupes[0]["reason"])


class MalformedTests(unittest.TestCase):
    def test_nodesc_detected(self):
        result = sd.scan(fixture_roots(), use_loader=False)
        malformed = findings_by_check(result, "malformed")
        nodesc = [m for m in malformed if m["skill"] == "nodesc"]
        self.assertTrue(
            any("description is required" in m["reason"] for m in nodesc),
            f"missing-description not detected: {nodesc}",
        )

    def test_broken_frontmatter_detected(self):
        result = sd.scan(fixture_roots(), use_loader=False)
        malformed = findings_by_check(result, "malformed")
        broken = [m for m in malformed if m["skill"] == "brokenfm"]
        self.assertTrue(
            any("not closed" in m["reason"] for m in broken),
            f"unclosed frontmatter not detected: {broken}",
        )

    def test_invalid_name_detected(self):
        result = sd.scan(fixture_roots(), use_loader=False)
        malformed = findings_by_check(result, "malformed")
        bad = [m for m in malformed if m["skill"] == "Bad_Name"]
        self.assertTrue(
            any("invalid characters" in m["reason"] for m in bad),
            f"invalid name not detected: {bad}",
        )

    def test_clean_skill_not_flagged(self):
        result = sd.scan(fixture_roots(), use_loader=False)
        malformed = findings_by_check(result, "malformed")
        self.assertFalse(
            any(m["skill"] == "alpha" for m in malformed),
            f"clean alpha flagged as malformed: {malformed}",
        )


class StaleFactTests(unittest.TestCase):
    def test_dead_model_detected_in_body_and_description(self):
        result = sd.scan(fixture_roots(), use_loader=False)
        stale = findings_by_check(result, "stale_facts")
        beta_hits = [s for s in stale if s["skill"] == "beta"]
        sources = {s["source"] for s in beta_hits}
        self.assertEqual(sources, {"body", "description"})
        self.assertTrue(all(s["pattern"] == "dead-model-qwen3-5" for s in beta_hits))
        # line numbers must be file-relative (frontmatter offset included)
        body_line = next(s["line"] for s in beta_hits if s["source"] == "body")
        skill_file = (ROOT_A / "beta" / "SKILL.md").read_text()
        self.assertEqual(
            skill_file.split("\n")[body_line - 1].find("Qwen3-5") >= 0, True
        )

    def test_removed_host_patterns(self):
        text = "connect via ChenZhuang-Remote or wangruojun-docker-01 today"
        hits = sd.scan_stale_facts("x", "", text)
        patterns = {h["pattern"] for h in hits}
        self.assertEqual(
            patterns,
            {"removed-host-chenzhuang", "removed-host-wangruojun-docker-01"},
        )

    def test_clean_skills_have_no_stale_facts(self):
        result = sd.scan(fixture_roots(), use_loader=False)
        stale = findings_by_check(result, "stale_facts")
        self.assertFalse(any(s["skill"] == "alpha" for s in stale))


class ReferenceTests(unittest.TestCase):
    def test_missing_reference_detected(self):
        result = sd.scan(fixture_roots(), use_loader=False)
        refs = findings_by_check(result, "missing_references")
        beta_missing = [r for r in refs if r["skill"] == "beta"]
        self.assertTrue(
            any(r["token"] == "ghost_tools.py" for r in beta_missing),
            f"ghost_tools.py not flagged: {beta_missing}",
        )

    def test_existing_reference_not_flagged(self):
        result = sd.scan(fixture_roots(), use_loader=False)
        refs = findings_by_check(result, "missing_references")
        alpha_refs = [r for r in refs if r["skill"] == "alpha"]
        self.assertEqual(
            alpha_refs, [], f"clean alpha reference false-positives: {alpha_refs}"
        )

    def test_qualifies_rejects_prose_and_junk(self):
        self.assertFalse(sd._qualifies("before/after"))
        self.assertFalse(sd._qualifies("775/664"))
        self.assertFalse(sd._qualifies("10/month"))
        self.assertFalse(sd._qualifies("I/O"))
        self.assertFalse(sd._qualifies("4/10"))
        self.assertFalse(sd._qualifies("path/to/generated.html"))
        self.assertFalse(sd._qualifies("your_server.py"))
        self.assertFalse(sd._qualifies("waveNN-reset-driver.py"))
        self.assertFalse(sd._qualifies("ppt/slides/slideN.xml"))
        self.assertFalse(sd._qualifies("doi.org/10.48550/arXiv.1234"))
        self.assertTrue(sd._qualifies("scripts/run_eval.py"))
        self.assertTrue(sd._qualifies("remote-agent/operations/20261029-minimal-x"))

    def test_extract_skips_templates_urls_and_namespaces(self):
        body = (
            "use `artifact-receipt-<run>.json` and `world/stats/<uuid>.json`\n"
            "see https://example.com/a.md and `minecraft:story/enter_the_end`\n"
            "run `python3 helper.py --output results.json` for discovery\n"
            "then write findings to `findings.json` at the end\n"
            "line refs like `helper.py:12` count as helper.py\n"
            "link [x](helper.py) and [gone](missing_link.md) both count\n"
        )
        tokens = [t["token"] for t in sd.extract_path_tokens(body)]
        self.assertNotIn("results.json", tokens)  # --flag example value
        self.assertNotIn("findings.json", tokens)  # output context
        self.assertNotIn("https://example.com/a.md", tokens)
        self.assertIn("helper.py", tokens)
        self.assertIn("missing_link.md", tokens)

    def test_line_numbers_are_file_relative(self):
        text = (
            "---\nname: t\ndescription: d\n---\n\n"
            "body line with `ghost.py` ref\n"
        )
        fm, body, _, offset = sd.split_frontmatter(text)
        tokens = sd.extract_path_tokens(body, line_offset=offset)
        self.assertEqual(tokens[0]["line"], 6)


class OverlapTests(unittest.TestCase):
    def test_identical_descriptions_flagged(self):
        result = sd.scan(fixture_roots(), use_loader=False, threshold=0.6)
        overlaps = findings_by_check(result, "description_overlaps")
        pairs = {frozenset(o["pair"]) for o in overlaps}
        self.assertIn(frozenset({"beta", "gamma"}), pairs)

    def test_distinct_descriptions_not_flagged(self):
        result = sd.scan(fixture_roots(), use_loader=False, threshold=0.6)
        overlaps = findings_by_check(result, "description_overlaps")
        pairs = {frozenset(o["pair"]) for o in overlaps}
        self.assertNotIn(frozenset({"alpha", "beta"}), pairs)
        self.assertNotIn(frozenset({"alpha", "gamma"}), pairs)


class LoaderTests(unittest.TestCase):
    """Real-loader smoke test — skipped when node or the release is absent."""

    def setUp(self):
        if not shutil.which("node"):
            self.skipTest("node not available")
        if not sd.LOADER_JS.exists():
            self.skipTest(f"loader not installed at {sd.LOADER_JS}")

    def test_real_loader_loads_fixture_root_and_reports_collision(self):
        result = sd.run_real_loader(
            str(sd.AGENT_DIR),
            [str(ROOT_A), str(ROOT_B)],
            str(FIXTURES),
            probe_dirs=[],
            include_defaults=False,
        )
        names = sorted(s["name"] for s in result["global"]["skills"])
        # alpha appears in both roots; the loader keeps the first (root_a)
        # and emits a collision diagnostic
        self.assertEqual(names.count("alpha"), 1)
        self.assertIn("beta", names)
        collisions = [
            d for d in result["global"]["diagnostics"] if d.get("type") == "collision"
        ]
        self.assertEqual(len(collisions), 1)
        self.assertEqual(collisions[0]["collision"]["name"], "alpha")

    def test_real_loader_flags_missing_description(self):
        nodesc_dir = ROOT_B / "nodesc"
        result = sd.run_real_loader(
            str(sd.AGENT_DIR),
            [],
            str(FIXTURES),
            probe_dirs=[str(nodesc_dir)],
            include_defaults=False,
        )
        # global load must NOT include nodesc (no skillPaths to it)
        self.assertNotIn("nodesc", [s["name"] for s in result["global"]["skills"]])
        per_dir = result["perDir"][str(nodesc_dir)]
        self.assertEqual(per_dir["skills"], [])
        self.assertTrue(
            any("description is required" in d["message"] for d in per_dir["diagnostics"])
        )

    def test_scan_with_loader_on_fixtures(self):
        result = sd.scan(
            fixture_roots(),
            agent_dir=sd.AGENT_DIR,
            cwd=FIXTURES,
            use_loader=True,
            include_defaults=False,
        )
        self.assertTrue(result["loader"]["used"])
        # alpha collision (loader keeps root_a's copy)
        self.assertGreaterEqual(result["summary"]["duplicates"], 1)
        # hidden-gem: valid skill silently ignored via root_b/.gitignore
        silent = findings_by_check(result, "silently_skipped")
        self.assertTrue(
            any(f["skill"] == "hidden-gem" for f in silent),
            f"hidden-gem not surfaced as silently skipped: {silent}",
        )
        # nodesc is reported by the loader itself (not silent) and must show
        # up in the walk-based malformed check
        self.assertTrue(
            any(
                m["skill"] == "nodesc"
                for m in findings_by_check(result, "malformed")
            )
        )
        self.assertTrue(result["loader"]["diagnostics"])


class ReportTests(unittest.TestCase):
    def test_render_report_contains_sections(self):
        result = sd.scan(fixture_roots(), use_loader=False)
        report = sd.render_report(result)
        for section in (
            "Duplicates", "Malformed entries", "Silently skipped",
            "Stale facts", "Missing references", "Description overlaps",
            "Inventory:",
        ):
            self.assertIn(section, report)

    def test_json_round_trip(self):
        result = sd.scan(fixture_roots(), use_loader=False)
        payload = json.dumps(result)
        reparsed = json.loads(payload)
        self.assertEqual(reparsed["summary"], result["summary"])


if __name__ == "__main__":
    unittest.main()
