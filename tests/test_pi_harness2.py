#!/usr/bin/env python3
"""Offline tests for tools/pi_harness2.py — no external network calls.

Run:  python3 -m unittest tests/test_pi_harness2.py -v
All model traffic in these tests goes to a local http.server fixture.
"""

from __future__ import annotations

import json
import os
import re
import shutil
import sys
import tempfile
import threading
import unittest
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path

TOOLS_DIR = Path(__file__).resolve().parent.parent / "tools"
sys.path.insert(0, str(TOOLS_DIR))

import pi_harness2 as h2  # noqa: E402
from concurrent.futures import ThreadPoolExecutor  # noqa: E402


def completion(content, finish_reason="stop", total_tokens=42, reasoning=None):
    msg = {"role": "assistant", "content": content}
    if reasoning is not None:
        msg["reasoning_content"] = reasoning
    return {
        "id": "test", "object": "chat.completion", "model": "test-model",
        "choices": [{"index": 0, "message": msg, "finish_reason": finish_reason}],
        "usage": {"prompt_tokens": 10, "completion_tokens": 32,
                  "total_tokens": total_tokens},
    }


class _Handler(BaseHTTPRequestHandler):
    def log_message(self, *args):  # silence
        pass

    def _send(self, code, payload: bytes):
        self.send_response(code)
        self.send_header("Content-Type", "application/json")
        self.send_header("Content-Length", str(len(payload)))
        self.end_headers()
        self.wfile.write(payload)

    def do_GET(self):
        if self.path.endswith("/models"):
            body = json.dumps({"object": "list",
                               "data": [{"id": "test-model"}]}).encode()
            self._send(200, body)
        else:
            self._send(404, b'{"error":"not found"}')

    def do_POST(self):
        length = int(self.headers.get("Content-Length", 0))
        raw = self.rfile.read(length).decode("utf-8")
        try:
            req = json.loads(raw)
        except json.JSONDecodeError:
            self._send(400, b'{"error":"bad json"}')
            return
        responder = getattr(self.server, "responder", None)
        if responder is None:
            self._send(500, b'{"error":"no responder"}')
            return
        resp = responder(req)
        if resp is None:  # convention: None -> HTTP 500
            self._send(500, b'{"error":"server exploded"}')
            return
        self._send(200, json.dumps(resp).encode("utf-8"))


class MockEndpoint:
    """Local OpenAI-style endpoint fixture; responder(req_dict)->dict|None."""

    def __init__(self, responder):
        self.server = ThreadingHTTPServer(("127.0.0.1", 0), _Handler)
        self.server.responder = responder
        self.thread = threading.Thread(target=self.server.serve_forever, daemon=True)

    @property
    def base_url(self):
        host, port = self.server.server_address[:2]
        return f"http://{host}:{port}/v1"

    def __enter__(self):
        self.thread.start()
        return self.base_url

    def __exit__(self, *exc):
        self.server.shutdown()
        self.server.server_close()
        self.thread.join(timeout=5)
        return False


def make_skill(root: Path, name: str, description: str, body="hello body") -> h2.Skill:
    d = root / name
    d.mkdir(parents=True, exist_ok=True)
    (d / "SKILL.md").write_text(
        f"---\nname: {name}\ndescription: {description}\n---\n\n{body}\n",
        encoding="utf-8")
    skills = h2.discover_skills([root])
    return next(s for s in skills if s.name == name)


# ---------------------------------------------------------------------------
# Frontmatter parsing
# ---------------------------------------------------------------------------


class TestFrontmatter(unittest.TestCase):
    def test_single_line(self):
        meta = h2.parse_frontmatter(
            "---\nname: foo\ndescription: does things\n---\n\nbody")
        self.assertEqual(meta["name"], "foo")
        self.assertEqual(meta["description"], "does things")

    def test_block_scalar_multiline(self):
        text = ("---\nname: bar\ndescription: >-\n  first part\n  second part\n"
                "---\n\nbody")
        meta = h2.parse_frontmatter(text)
        self.assertEqual(meta["description"], "first part second part")

    def test_pipe_block_multiline(self):
        text = "---\nname: bar\ndescription: |\n  line one\n  line two\n---\n"
        meta = h2.parse_frontmatter(text)
        self.assertEqual(meta["description"], "line one line two")

    def test_plain_multiline_continuation(self):
        text = ("---\nname: bar\ndescription: starts here\n  and continues\n"
                "other: x\n---\n")
        meta = h2.parse_frontmatter(text)
        self.assertEqual(meta["description"], "starts here and continues")
        self.assertEqual(meta["other"], "x")

    def test_quoted_value_with_colon(self):
        meta = h2.parse_frontmatter(
            '---\nname: q\ndescription: "Use this: carefully"\n---\n')
        self.assertEqual(meta["description"], "Use this: carefully")

    def test_no_frontmatter(self):
        self.assertEqual(h2.parse_frontmatter("just text"), {})

    def test_list_and_scalars(self):
        text = ("---\ntitle: T\napproval: unreviewed\nlast_reviewed: 2026-11-04\n"
                "evidence:\n  - one\n  - two\n---\n")
        meta = h2.parse_frontmatter(text)
        self.assertEqual(meta["approval"], "unreviewed")
        self.assertEqual(meta["last_reviewed"], "2026-11-04")
        self.assertEqual(meta["evidence"], ["one", "two"])


class TestDiscoverSkills(unittest.TestCase):
    def test_discover_and_dedupe(self):
        with tempfile.TemporaryDirectory() as td:
            root = Path(td)
            make_skill(root, "alpha", "Alpha does A things")
            make_skill(root, "beta", "Beta does B things")
            # name missing -> falls back to directory name
            d = root / "gamma"
            d.mkdir()
            (d / "SKILL.md").write_text("---\ndescription: gamma things\n---\n",
                                        encoding="utf-8")
            skills = h2.discover_skills([root, root])  # duplicate root
            names = [s.name for s in skills]
            self.assertEqual(names, ["alpha", "beta", "gamma"])
            self.assertEqual(len(skills), len(set(s.path for s in skills)))

    def test_missing_root_ignored(self):
        skills = h2.discover_skills(["/nonexistent/root/xyz"])
        self.assertEqual(skills, [])


# ---------------------------------------------------------------------------
# Similarity / confusable detection
# ---------------------------------------------------------------------------


class TestSimilarity(unittest.TestCase):
    def test_identical_descriptions_flagged(self):
        with tempfile.TemporaryDirectory() as td:
            root = Path(td)
            a = make_skill(root, "aa", "Manage telegram buttons and voice replies")
            b = make_skill(root, "bb", "Manage telegram buttons and voice replies")
            sig = h2.pair_signals(a, b, h2.corpus_df([a, b]), h2.DEFAULT_THRESHOLD, n_docs=2)
            self.assertTrue(sig["confusable"])
            self.assertGreater(sig["jaccard"], 0.9)

    def test_disjoint_descriptions_not_flagged(self):
        with tempfile.TemporaryDirectory() as td:
            root = Path(td)
            a = make_skill(root, "aa", "Chmod minecraft world directories via rcon")
            b = make_skill(root, "bb", "Brew herbal tea with chamomile and honey")
            sig = h2.pair_signals(a, b, h2.corpus_df([a, b]), h2.DEFAULT_THRESHOLD, n_docs=2)
            self.assertFalse(sig["confusable"])

    def test_threshold_behavior(self):
        with tempfile.TemporaryDirectory() as td:
            root = Path(td)
            a = make_skill(root, "aa", "Render telegram button surfaces")
            b = make_skill(root, "bb", "Style telegram button surfaces")
            df = h2.corpus_df([a, b])
            low = h2.pair_signals(a, b, df, 0.10, n_docs=2)
            high = h2.pair_signals(a, b, df, 0.99, n_docs=2)
            self.assertTrue(low["confusable"])
            self.assertFalse(high["confusable"])

    def test_trigger_terms_flag(self):
        # Few shared tokens overall, but the shared ones are routing triggers.
        with tempfile.TemporaryDirectory() as td:
            root = Path(td)
            a = make_skill(root, "aa", "Zyx wvu telegram button qpo")
            b = make_skill(root, "bb", "Nml kji telegram button hgf")
            sig = h2.pair_signals(a, b, h2.corpus_df([a, b]), h2.DEFAULT_THRESHOLD, n_docs=2)
            self.assertTrue(sig["confusable"])
            self.assertIn("telegram", sig["triggers"])

    def test_find_confusable_no_self_pairs(self):
        with tempfile.TemporaryDirectory() as td:
            root = Path(td)
            make_skill(root, "aa", "One shared telegram surface")
            make_skill(root, "bb", "Two shared telegram surface")
            make_skill(root, "cc", "Unrelated tea brewing entirely")
            pairs = h2.find_confusable(h2.discover_skills([root]), 0.10)
            for a, b, _sig in pairs:
                self.assertNotEqual(a.name, b.name)
            self.assertTrue(any({a.name, b.name} == {"aa", "bb"} for a, b, _ in pairs))
            self.assertFalse(any("cc" in (a.name, b.name) for a, b, _ in pairs))


# ---------------------------------------------------------------------------
# Proposal validation
# ---------------------------------------------------------------------------


class TestProposalValidation(unittest.TestCase):
    def test_valid_single_line(self):
        ok, content, rationale, _ = h2.validate_proposal_line(
            "description: Explains work with markdown diagrams; excludes app authoring.")
        self.assertTrue(ok)
        self.assertEqual(content,
                         "Explains work with markdown diagrams; excludes app authoring.")

    def test_valid_with_rationale(self):
        ok, content, rationale, _ = h2.validate_proposal_line(
            "description: Short and true.\nrationale: body supports this.")
        self.assertTrue(ok)
        self.assertEqual(content, "Short and true.")
        self.assertEqual(rationale, "body supports this.")

    def test_reject_two_description_lines(self):
        ok, _c, _r, reason = h2.validate_proposal_line(
            "description: one\ndescription: two")
        self.assertFalse(ok)
        self.assertIn("exactly one", reason)

    def test_reject_unexpected_lines(self):
        ok, _c, _r, reason = h2.validate_proposal_line(
            "description: one\nhello world")
        self.assertFalse(ok)
        self.assertIn("unexpected extra output lines", reason)

    def test_reject_too_long(self):
        content = "x" * 201
        ok, _c, _r, reason = h2.validate_proposal_line(f"description: {content}")
        self.assertFalse(ok)
        self.assertIn("longer than", reason)

    def test_reject_empty(self):
        ok, _c, _r, reason = h2.validate_proposal_line("description:   ")
        self.assertFalse(ok)
        self.assertIn("empty", reason)

    def test_reject_missing_prefix(self):
        ok, _c, _r, _reason = h2.validate_proposal_line("just some text, no prefix")
        self.assertFalse(ok)

    def test_reject_control_chars(self):
        ok, _c, _r, reason = h2.validate_proposal_line("description: bad\x01stuff")
        self.assertFalse(ok)
        self.assertIn("control character", reason)

    def test_fenced_single_line_accepted(self):
        ok, content, _r, _reason = h2.validate_proposal_line(
            "```\ndescription: fenced but fine\n```")
        self.assertTrue(ok)
        self.assertEqual(content, "fenced but fine")

    def test_max_boundary(self):
        ok, content, _r, _ = h2.validate_proposal_line("description: " + "x" * 200)
        self.assertTrue(ok)
        self.assertEqual(len(content), 200)


class TestQueryParsing(unittest.TestCase):
    def test_parse_lines(self):
        qs = h2.parse_queries(
            "TARGET=A QUERY=first task\n"
            "TARGET=B QUERY=second task\n"
            "TARGET=A QUERY=third task\n"
            "TARGET=B QUERY=fourth task", 4)
        self.assertEqual([q["target"] for q in qs], ["A", "B", "A", "B"])

    def test_dedupe_and_cap(self):
        qs = h2.parse_queries(
            "TARGET=A QUERY=same\nTARGET=A QUERY=same\nTARGET=B QUERY=other", 4)
        self.assertEqual(len(qs), 2)

    def test_garbage_returns_empty(self):
        self.assertEqual(h2.parse_queries("no useful content here", 4), [])

    def test_fences_tolerated(self):
        qs = h2.parse_queries("```\nTARGET=A QUERY=fenced task\n```", 4)
        self.assertEqual(qs, [{"target": "A", "text": "fenced task"}])


# ---------------------------------------------------------------------------
# Probe answer parsing
# ---------------------------------------------------------------------------


class TestProbeAnswerParsing(unittest.TestCase):
    CANDS = ["show-me", "generative-apps"]

    def test_success(self):
        r = h2.parse_probe_answer("thinking...\nSKILL: show-me", self.CANDS)
        self.assertEqual(r["pick"], "show-me")

    def test_punctuation_tolerated(self):
        r = h2.parse_probe_answer("SKILL: show-me.", self.CANDS)
        self.assertEqual(r["pick"], "show-me")

    def test_missing_line_is_miss(self):
        r = h2.parse_probe_answer("I would pick show-me probably", self.CANDS)
        self.assertIsNone(r["pick"])

    def test_ambiguous_is_miss(self):
        r = h2.parse_probe_answer("SKILL: show-me or generative-apps", self.CANDS)
        self.assertIsNone(r["pick"])
        self.assertIn("ambiguous", r["reason"])

    def test_unknown_name_is_miss(self):
        r = h2.parse_probe_answer("SKILL: telegram-bridge", self.CANDS)
        self.assertIsNone(r["pick"])

    def test_empty_content_is_miss(self):
        r = h2.parse_probe_answer("", self.CANDS)
        self.assertIsNone(r["pick"])

    def test_reasoning_content_never_used(self):
        # parse only ever receives message.content; reasoning text is ignored
        resp = completion("", reasoning="SKILL: show-me")
        content = resp["choices"][0]["message"]["content"]
        self.assertIsNone(h2.parse_probe_answer(content, self.CANDS)["pick"])


# ---------------------------------------------------------------------------
# Client against the local fixture
# ---------------------------------------------------------------------------


class TestClientAgainstFixture(unittest.TestCase):
    def test_verify_and_chat_success(self):
        with MockEndpoint(lambda req: completion("SKILL: show-me")) as base:
            c = h2.ProbeClient(base, "test-model", cap=10)
            ok, models = c.verify()
            self.assertTrue(ok)
            self.assertEqual(models, ["test-model"])
            r = c.chat([{"role": "user", "content": "hi"}])
            self.assertTrue(r["ok"])
            self.assertEqual(r["content"], "SKILL: show-me")
            self.assertEqual(c.calls, 1)
            self.assertEqual(c.tokens, 42)
            self.assertEqual(len(c.latencies), 1)

    def test_length_truncated_retry_uses_larger_budget(self):
        seen_max_tokens = []

        def responder(req):
            seen_max_tokens.append(req.get("max_tokens"))
            if req.get("max_tokens") == 4000:
                return completion("", finish_reason="length")
            return completion("SKILL: show-me")

        with MockEndpoint(responder) as base:
            c = h2.ProbeClient(base, "test-model", cap=10)
            r = c.chat([{"role": "user", "content": "hi"}])
            self.assertTrue(r["ok"])
            self.assertEqual(r["content"], "SKILL: show-me")
            self.assertTrue(r.get("retried"))
            self.assertEqual(seen_max_tokens, [4000, 6000])
            self.assertEqual(c.calls, 2)

    def test_no_retry_when_content_present(self):
        counts = []

        def responder(req):
            counts.append(1)
            return completion("SKILL: show-me", finish_reason="length")

        with MockEndpoint(responder) as base:
            c = h2.ProbeClient(base, "test-model", cap=10)
            r = c.chat([{"role": "user", "content": "hi"}])
            self.assertTrue(r["ok"])
            self.assertEqual(r["content"], "SKILL: show-me")
            self.assertEqual(len(counts), 1)  # no retry: content was non-empty

    def test_garbage_answer_is_miss_not_crash(self):
        with MockEndpoint(lambda req: completion("blah blah no marker")) as base:
            c = h2.ProbeClient(base, "test-model", cap=10)
            r = c.chat([{"role": "user", "content": "hi"}])
            parsed = h2.parse_probe_answer(r["content"], ["show-me"])
            self.assertIsNone(parsed["pick"])

    def test_budget_cap_enforced(self):
        with MockEndpoint(lambda req: completion("SKILL: show-me")) as base:
            c = h2.ProbeClient(base, "test-model", cap=1)
            r1 = c.chat([{"role": "user", "content": "1"}])
            r2 = c.chat([{"role": "user", "content": "2"}])
            self.assertTrue(r1["ok"])
            self.assertFalse(r2["ok"])
            self.assertIn("budget_exhausted", r2["error"])
            self.assertEqual(c.calls, 1)

    def test_http_500_recorded_not_raised(self):
        with MockEndpoint(lambda req: None) as base:
            c = h2.ProbeClient(base, "test-model", cap=10)
            r = c.chat([{"role": "user", "content": "hi"}])
            self.assertFalse(r["ok"])
            self.assertIn("HTTP 500", r["error"])

    def test_connection_error_recorded_not_raised(self):
        c = h2.ProbeClient("http://127.0.0.1:1/v1", "test-model", cap=10, timeout=2)
        r = c.chat([{"role": "user", "content": "hi"}])
        self.assertFalse(r["ok"])

    def test_verify_down(self):
        c = h2.ProbeClient("http://127.0.0.1:1/v1", "test-model", timeout=2)
        ok, detail = c.verify()
        self.assertFalse(ok)
        self.assertTrue(detail)


# ---------------------------------------------------------------------------
# Journal idempotency
# ---------------------------------------------------------------------------


class TestJournal(unittest.TestCase):
    def test_append_once_per_run_id(self):
        with tempfile.TemporaryDirectory() as td:
            path = Path(td) / "journal.jsonl"
            rec = {"ts": "t", "mode": "observe", "pairs": 1, "proposed": 1,
                   "probe": {"calls": 2, "cost_tokens": 9},
                   "decisions": "none (observe)", "run_id": "abc"}
            self.assertTrue(h2.append_journal(path, rec))
            self.assertFalse(h2.append_journal(path, rec))  # idempotent
            lines = path.read_text().splitlines()
            self.assertEqual(len(lines), 1)
            self.assertEqual(json.loads(lines[0])["run_id"], "abc")

    def test_different_run_ids_append(self):
        with tempfile.TemporaryDirectory() as td:
            path = Path(td) / "journal.jsonl"
            for rid in ("a", "b"):
                h2.append_journal(path, {"run_id": rid, "mode": "observe"})
            self.assertEqual(len(path.read_text().splitlines()), 2)

    def test_corrupt_lines_tolerated(self):
        with tempfile.TemporaryDirectory() as td:
            path = Path(td) / "journal.jsonl"
            path.write_text("not json at all\n", encoding="utf-8")
            self.assertTrue(h2.append_journal(path, {"run_id": "x"}))
            self.assertEqual(len(path.read_text().splitlines()), 2)

    def test_record_shape(self):
        with tempfile.TemporaryDirectory() as td:
            path = Path(td) / "journal.jsonl"
            h2.append_journal(path, {"ts": "t", "mode": "observe", "pairs": 2,
                                     "proposed": 3,
                                     "probe": {"calls": 5, "cost_tokens": 100},
                                     "decisions": "none (observe)", "run_id": "r"})
            rec = json.loads(path.read_text().splitlines()[0])
            for key in ("ts", "mode", "pairs", "proposed", "probe", "decisions"):
                self.assertIn(key, rec)
            self.assertEqual(rec["decisions"], "none (observe)")


# ---------------------------------------------------------------------------
# Apply gates (temp skills root; no real files touched)
# ---------------------------------------------------------------------------

SAMPLE_SKILL = """---
name: demo-skill
description: >-
  Old description spanning
  multiple folded lines.
---
# Body

Keep this body intact.
"""


def build_entry(root: Path, yes=True) -> dict:
    skill = make_skill(root, "demo-skill", "")  # placeholder, replaced below
    # Recreate with a folded multiline description to exercise rewrite:
    d = root / "demo-skill"
    (d / "SKILL.md").write_text(SAMPLE_SKILL, encoding="utf-8")
    skills = h2.discover_skills([root])
    skill = next(s for s in skills if s.name == "demo-skill")
    return {
        "id": "p-001", "pair": ["demo-skill", "neighbor"],
        "skill": "demo-skill", "file": skill.path,
        "before": skill.description,
        "after": "New grounded description; differs from neighbor; excludes X.",
        "rationale": "body evidence", "status": "proposed",
        "mtime_at_proposal": skill.mtime,
    }


class TestApplyGates(unittest.TestCase):
    def setUp(self):
        self._tmp = tempfile.TemporaryDirectory()
        self.root = Path(self._tmp.name)
        self.addCleanup(self._tmp.cleanup)

    def test_apply_writes_and_backs_up(self):
        entry = build_entry(self.root)
        outcome = h2.apply_proposal_entry(entry, yes=True)
        self.assertEqual(outcome["action"], "applied")
        p = Path(entry["file"])
        self.assertTrue(p.with_suffix(".md.bak").exists())
        new_meta = h2.parse_frontmatter(p.read_text())
        self.assertEqual(new_meta["description"], entry["after"])
        self.assertIn("Keep this body intact.", p.read_text())  # body untouched
        bak_meta = h2.parse_frontmatter(p.with_suffix(".md.bak").read_text())
        self.assertEqual(bak_meta["description"], entry["before"])

    def test_dry_run_without_yes(self):
        entry = build_entry(self.root)
        outcome = h2.apply_proposal_entry(entry, yes=False)
        self.assertEqual(outcome["action"], "would-apply")
        self.assertEqual(h2.parse_frontmatter(
            Path(entry["file"]).read_text())["description"], entry["before"])
        self.assertFalse(Path(entry["file"]).with_suffix(".md.bak").exists())

    def test_refuse_mtime_drift(self):
        entry = build_entry(self.root)
        p = Path(entry["file"])
        st = p.stat()
        os.utime(p, (st.st_atime + 100, st.st_mtime + 100))
        outcome = h2.apply_proposal_entry(entry, yes=True)
        self.assertEqual(outcome["action"], "refused")
        self.assertIn("changed since proposal", outcome["reason"])

    def test_refuse_before_mismatch(self):
        entry = build_entry(self.root)
        p = Path(entry["file"])
        # Rewrite content but keep the recorded mtime.
        text = p.read_text().replace("Old description spanning", "Tampered description xx")
        st = p.stat()
        p.write_text(text)
        os.utime(p, (st.st_atime, st.st_mtime))
        outcome = h2.apply_proposal_entry(entry, yes=True)
        self.assertEqual(outcome["action"], "refused")
        self.assertIn("does not match proposal BEFORE", outcome["reason"])

    def test_refuse_missing_file(self):
        entry = build_entry(self.root)
        entry["file"] = str(self.root / "nope" / "SKILL.md")
        outcome = h2.apply_proposal_entry(entry, yes=True)
        self.assertEqual(outcome["action"], "refused")
        self.assertIn("missing", outcome["reason"])

    def test_refuse_missing_after(self):
        entry = build_entry(self.root)
        entry["after"] = None
        outcome = h2.apply_proposal_entry(entry, yes=True)
        self.assertEqual(outcome["action"], "refused")
        self.assertIn("no AFTER", outcome["reason"])

    def test_refuse_bad_status(self):
        entry = build_entry(self.root)
        entry["status"] = "rejected"
        outcome = h2.apply_proposal_entry(entry, yes=True)
        self.assertEqual(outcome["action"], "refused")

    def test_reapply_refused(self):
        entry = build_entry(self.root)
        self.assertEqual(h2.apply_proposal_entry(entry, yes=True)["action"], "applied")
        outcome = h2.apply_proposal_entry(entry, yes=True)
        self.assertEqual(outcome["action"], "refused")

    def test_cmd_apply_refuses_unknown_schema(self):
        with tempfile.TemporaryDirectory() as td:
            bad = Path(td) / "bad.json"
            bad.write_text(json.dumps({"schema": "other", "entries": []}))
            rc = h2.cmd_apply(type("A", (), {"proposals": str(bad), "yes": True})())
            self.assertEqual(rc, 1)

    def test_cmd_apply_missing_file(self):
        rc = h2.cmd_apply(type("A", (), {
            "proposals": str(self.root / "missing.json"), "yes": True})())
        self.assertEqual(rc, 1)


class TestRewriteDescription(unittest.TestCase):
    def test_block_scalar_replaced_single_line(self):
        new = h2.rewrite_description(SAMPLE_SKILL, "Brand new description")
        self.assertIn('description: "Brand new description"', new)
        self.assertNotIn("Old description", new)
        self.assertIn("Keep this body intact.", new)

    def test_body_description_lines_untouched(self):
        text = SAMPLE_SKILL + "\nUse `description: not-frontmatter` carefully.\n"
        new = h2.rewrite_description(text, "New")
        self.assertEqual(new.count("description: \""), 1)
        self.assertIn("`description: not-frontmatter`", new)

    def test_no_frontmatter_raises(self):
        with self.assertRaises(ValueError):
            h2.rewrite_description("plain text", "New")

    def test_no_description_key_raises(self):
        with self.assertRaises(ValueError):
            h2.rewrite_description("---\nname: x\n---\nbody", "New")


# ---------------------------------------------------------------------------
# Offline pipeline integration (probe_pair end-to-end against fixture)
# ---------------------------------------------------------------------------


class TestPipelineOffline(unittest.TestCase):
    def _run(self, probe_reply=None, proposal_reply="ok"):
        td = tempfile.TemporaryDirectory()
        self.addCleanup(td.cleanup)
        root = Path(td.name)
        a = make_skill(root, "skill-a",
                       "Handle telegram buttons and surfaces", body="body A " * 50)
        b = make_skill(root, "skill-b",
                       "Render telegram button surfaces", body="body B " * 50)

        def responder(req):
            content = req["messages"][0]["content"]
            if "You generate probe data" in content:
                return completion(
                    "TARGET=A QUERY=fix the telegram button row\n"
                    "TARGET=B QUERY=render a telegram button surface\n"
                    "TARGET=A QUERY=explain the button admission rule\n"
                    "TARGET=B QUERY=style the surface matrix")
            if "Skill++ style rewrite" in content:
                m = re.search(r"^Skill: (\S+)$", content, re.M)
                return completion(
                    f"description: {m.group(1)} grounded rewrite; differs; excludes.\n"
                    "rationale: body evidence")
            if "You are a skill router" in content:
                if probe_reply is not None:
                    return completion(probe_reply)
                m = re.search(r"^- (\S+):", content, re.M)
                return completion(f"SKILL: {m.group(1)}")
            return completion("")

        with MockEndpoint(responder) as base:
            client = h2.ProbeClient(base, "test-model", cap=50)
            ex = ThreadPoolExecutor(2)
            try:
                result = h2.probe_pair(client, ex, a, b, {"score": 1.0}, 4)
            finally:
                ex.shutdown(wait=True)
        return result

    def test_full_pair_probe(self):
        res = self._run()
        self.assertEqual(len(res.queries), 4)
        self.assertEqual(res.probed_proposed, 4)
        # first candidate is skill-a, so A-targeted queries hit, B-targeted miss
        self.assertEqual(res.current_correct, 2)
        self.assertEqual(res.proposed_correct, 2)
        self.assertEqual(set(res.proposals), {"skill-a", "skill-b"})
        self.assertTrue(all(p["status"] == "proposed" for p in res.proposals.values()))
        self.assertEqual(res.call_count, 1 + 2 + 8)

    @staticmethod
    def _missed(res):
        return sum(1 for q in res.queries if q["current"]["pick"] is None)

    def test_garbage_probes_are_misses(self):
        res = self._run(probe_reply="I like turtles")
        self.assertEqual(len(res.queries), 4)
        self.assertEqual(res.current_correct, 0)
        self.assertEqual(res.proposed_correct, 0)
        for q in res.queries:
            self.assertIsNone(q["current"]["pick"])
            self.assertIsNone(q["proposed"]["pick"])

    def test_proposal_rejection_recorded(self):
        with tempfile.TemporaryDirectory() as td:
            root = Path(td)
            a = make_skill(root, "skill-a", "Alpha description here")
            b = make_skill(root, "skill-b", "Beta description here")

            def responder(req):
                content = req["messages"][0]["content"]
                if "Skill++ style rewrite" in content:
                    return completion("line one\nline two\nline three")
                return completion("")

            with MockEndpoint(responder) as base:
                client = h2.ProbeClient(base, "test-model", cap=50)
                prop = h2.generate_proposal(client, a, b)
            self.assertEqual(prop["status"], "rejected")
            self.assertIsNone(prop["after"])
            self.assertEqual(prop["attempts"], 2)
            self.assertEqual(client.calls, 2)


class TestComposeOffline(unittest.TestCase):
    """write_report/build_proposals_json/journal on mock probe results."""

    def _ctx(self):
        td = tempfile.TemporaryDirectory()
        self.addCleanup(td.cleanup)
        root = Path(td.name)
        a = make_skill(root, "skill-a", "Handle telegram buttons and surfaces")
        b = make_skill(root, "skill-b", "Render telegram button surfaces")

        def responder(req):
            content = req["messages"][0]["content"]
            if "You generate probe data" in content:
                return completion(
                    "TARGET=A QUERY=fix the telegram button row\n"
                    "TARGET=B QUERY=render a telegram button surface")
            if "Skill++ style rewrite" in content:
                m = re.search(r"^Skill: (\S+)$", content, re.M)
                return completion(
                    f"description: {m.group(1)} grounded rewrite.\nrationale: body")
            m = re.search(r"^- (\S+):", content, re.M)
            return completion(f"SKILL: {m.group(1)}")

        with MockEndpoint(responder) as base:
            client = h2.ProbeClient(base, "test-model", cap=50)
            ex = ThreadPoolExecutor(2)
            try:
                pr = h2.probe_pair(client, ex, a, b, {"score": 1.0}, 2)
            finally:
                ex.shutdown(wait=True)
        proposals = []
        for name, p in pr.proposals.items():
            entry = dict(p)
            entry["pair"] = pr.names
            detailed = [q for q in pr.queries if q["target"] == name]
            entry["probe"] = {
                "queries": len(pr.queries), "targeted_queries": len(detailed),
                "current_correct": sum(1 for q in detailed if q["current"]["correct"]),
                "proposed_correct": sum(1 for q in detailed
                                        if (q["proposed"] or {}).get("correct")),
                "probed": len([q for q in detailed if q["proposed"] is not None]),
                "detail": detailed,
            }
            proposals.append(entry)
        ctx = {
            "ts": "20260101T000000Z", "k": 2, "threshold": 0.3, "cap": 120,
            "base_url": base, "model": "test-model", "endpoint_ok": True,
            "skills": [a, b], "agents": [], "mcp": [], "kb": [],
            "pairs": [(a, b, {"score": 1.0, "jaccard": 0.5, "salient": [],
                              "triggers": []})],
            "pair_results": [pr], "all_proposals": proposals,
            "probe_calls": client.calls, "probe_tokens": client.tokens,
            "recommendations": ["rec one"],
        }
        return ctx

    def test_report_and_proposals_written(self):
        ctx = self._ctx()
        out = Path(tempfile.mkdtemp())
        self.addCleanup(shutil.rmtree, out, ignore_errors=True)
        report = out / "report-test.md"
        h2.write_report(report, ctx)
        text = report.read_text(encoding="utf-8")
        for marker in ("## 概览", "## 每对的探针结果表", "## 下一步建议",
                       "skill-a <> skill-b"):
            self.assertIn(marker, text)
        props = h2.build_proposals_json(ctx)
        self.assertEqual(props["schema"], "pi-harness2/proposals-v0")
        for entry in props["entries"]:
            self.assertLessEqual(len(entry["after"]), 200)
            self.assertTrue(entry["before"])
        (out / "proposals.json").write_text(json.dumps(props, ensure_ascii=False))
        rec = {"ts": "t", "mode": "observe", "pairs": 1, "proposed": 2,
               "probe": {"calls": ctx["probe_calls"],
                         "cost_tokens": ctx["probe_tokens"]},
               "decisions": "none (observe)", "run_id": "compose1"}
        self.assertTrue(h2.append_journal(out / "journal.jsonl", rec))


if __name__ == "__main__":
    unittest.main()
