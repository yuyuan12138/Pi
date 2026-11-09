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

    def test_numbered_and_bulleted_lines_tolerated(self):
        qs = h2.parse_queries(
            "1. TARGET=A QUERY=numbered task\n"
            "- TARGET=B QUERY=bulleted task", 4)
        self.assertEqual([q["target"] for q in qs], ["A", "B"])
        self.assertEqual(qs[0]["text"], "numbered task")


class TestQueryLinesParsing(unittest.TestCase):
    def test_parse_query_lines(self):
        self.assertEqual(h2.parse_query_lines("QUERY=one\nQUERY=two", 3),
                         ["one", "two"])

    def test_numbered_tolerated(self):
        self.assertEqual(h2.parse_query_lines("1. QUERY=one\n2) QUERY=two", 3),
                         ["one", "two"])

    def test_target_lines_rejected(self):
        # TARGET=A QUERY=... must not parse as a body query
        self.assertEqual(h2.parse_query_lines("TARGET=A QUERY=x", 3), [])

    def test_cap_and_dedupe(self):
        self.assertEqual(h2.parse_query_lines("QUERY=a\nQUERY=a\nQUERY=b\nQUERY=c", 2),
                         ["a", "b"])


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


# ---------------------------------------------------------------------------
# v1: full-list probe parsing
# ---------------------------------------------------------------------------


FULL_LIST = ["generated-control-surface", "generative-apps", "mc-rsi-episode",
             "security-audit", "show-me", "telegram-bridge",
             "workspace-checkpoint", "wps-cloud-sheet"]


class TestFullListParsing(unittest.TestCase):
    def test_pick_from_full_list(self):
        r = h2.parse_probe_answer("SKILL: show-me", FULL_LIST)
        self.assertEqual(r["pick"], "show-me")

    def test_ambiguous_across_full_list_is_miss(self):
        r = h2.parse_probe_answer("SKILL: show-me or telegram-bridge", FULL_LIST)
        self.assertIsNone(r["pick"])

    def test_sibling_prefix_names_dont_confuse(self):
        r = h2.parse_probe_answer("SKILL: generative-apps", FULL_LIST)
        self.assertEqual(r["pick"], "generative-apps")
        r2 = h2.parse_probe_answer("SKILL: generated-control-surface", FULL_LIST)
        self.assertEqual(r2["pick"], "generated-control-surface")

    def test_unknown_name_is_miss_full_list(self):
        r = h2.parse_probe_answer("SKILL: feishu-user-plugin", FULL_LIST)
        self.assertIsNone(r["pick"])

    def test_build_probe_prompt_lists_all_candidates(self):
        prompt = h2.build_probe_prompt("some task", [(n, f"{n} does things") for n in FULL_LIST])
        for n in FULL_LIST:
            self.assertIn(n, prompt)


# ---------------------------------------------------------------------------
# v1: stem-leak rejection / trap validation / sensitivity gate / name guard
# ---------------------------------------------------------------------------


class TestStemLeak(unittest.TestCase):
    def setUp(self):
        self._tmp = tempfile.TemporaryDirectory()
        self.root = Path(self._tmp.name)
        self.addCleanup(self._tmp.cleanup)
        self.skill = make_skill(self.root, "alpha",
                                "Manage telegram buttons and voice replies")

    def test_no_overlap_ok(self):
        ok, reason = h2.validate_body_query("Brew chamomile tea with honey", self.skill)
        self.assertTrue(ok)

    def test_three_shared_stems_ok(self):
        # exactly 3 shared stems (telegram, button, voice) -> at the limit, accepted
        ok, reason = h2.validate_body_query("telegram button voice checks", self.skill)
        self.assertTrue(ok)

    def test_four_shared_stems_rejected(self):
        ok, reason = h2.validate_body_query(
            "telegram button voice reply management", self.skill)
        self.assertFalse(ok)
        self.assertIn("description_leak", reason)

    def test_leak_stems_helper(self):
        shared = h2.description_leak_stems("telegram button voice reply management",
                                           self.skill.description)
        self.assertTrue(len(shared) >= 4)

    def test_ban_name_stems(self):
        ok, reason = h2.validate_body_query("alpha runbook steps", self.skill,
                                            ban_name_stems=True)
        self.assertFalse(ok)
        self.assertIn("target_name_stem_in_query", reason)
        ok2, _ = h2.validate_body_query("runbook steps for relays", self.skill,
                                        ban_name_stems=True)
        self.assertTrue(ok2)


class TestTrapValidation(unittest.TestCase):
    def setUp(self):
        self._tmp = tempfile.TemporaryDirectory()
        self.root = Path(self._tmp.name)
        self.addCleanup(self._tmp.cleanup)
        self.target = make_skill(self.root, "alpha",
                                 "Manage telegram buttons and voice replies")
        self.neighbor = make_skill(self.root, "beta",
                                   "Brew chamomile tea and honey infusions")

    def test_valid_trap_uses_neighbor_vocabulary(self):
        ok, reason = h2.validate_trap_query("brew chamomile honey infusion steps",
                                            self.target, self.neighbor)
        self.assertTrue(ok)

    def test_insufficient_neighbor_vocabulary_rejected(self):
        ok, reason = h2.validate_trap_query("random unrelated task words here",
                                            self.target, self.neighbor)
        self.assertFalse(ok)
        self.assertIn("insufficient_neighbor_vocabulary", reason)

    def test_trap_leaking_target_description_rejected(self):
        # 4 stems shared with the TARGET description despite neighbor vocabulary
        ok, reason = h2.validate_trap_query(
            "telegram button voice reply brew chamomile", self.target, self.neighbor)
        self.assertFalse(ok)
        self.assertIn("description_leak", reason)

    def test_single_neighbor_stem_insufficient(self):
        ok, reason = h2.validate_trap_query("brewing some unrelated workflow",
                                            self.target, self.neighbor)
        self.assertFalse(ok)
        self.assertIn("insufficient_neighbor_vocabulary", reason)


class TestSensitivityGate(unittest.TestCase):
    def test_pass_significant_drop(self):
        passed, reason = h2.sensitivity_gate(38, 40, 20, 40)
        self.assertTrue(passed)

    def test_fail_no_separation(self):
        passed, reason = h2.sensitivity_gate(40, 40, 40, 40)
        self.assertFalse(passed)
        self.assertIn("no separation", reason)

    def test_fail_drop_not_significant(self):
        passed, reason = h2.sensitivity_gate(40, 40, 39, 40)
        self.assertFalse(passed)
        self.assertIn("below required", reason)

    def test_fail_mutated_better(self):
        passed, reason = h2.sensitivity_gate(30, 40, 35, 40)
        self.assertFalse(passed)
        self.assertIn("no separation", reason)

    def test_boundary_exactly_min_drop_passes(self):
        passed, _ = h2.sensitivity_gate(40, 40, 36, 40)  # drop = 0.10
        self.assertTrue(passed)

    def test_empty_inputs_fail(self):
        passed, reason = h2.sensitivity_gate(0, 0, 0, 0)
        self.assertFalse(passed)
        self.assertIn("no queries", reason)

    def test_partial_ceiling_case(self):
        # current=100% AND mutated=100% -> must fail (the honesty-gate case)
        passed, _ = h2.sensitivity_gate(40, 40, 40, 40)
        self.assertFalse(passed)


class TestNeighborNameGuard(unittest.TestCase):
    def test_detects_exact_name(self):
        bad = h2.find_embedded_skill_name(
            "excludes app authoring (generative-apps)", FULL_LIST, exclude="show-me")
        self.assertEqual(bad, "generative-apps")

    def test_clean_description_passes(self):
        bad = h2.find_embedded_skill_name(
            "excludes reusable app authoring and button generation", FULL_LIST,
            exclude="show-me")
        self.assertIsNone(bad)

    def test_own_name_excluded(self):
        bad = h2.find_embedded_skill_name(
            "show-me explains work with diagrams", FULL_LIST, exclude="show-me")
        self.assertIsNone(bad)

    def test_word_boundary(self):
        # 'generative-applications' does not contain the exact name 'generative-apps'
        bad = h2.find_embedded_skill_name(
            "tooling for generative-applications", FULL_LIST, exclude="show-me")
        self.assertIsNone(bad)

    def test_generate_proposal_guard_rejects_and_retries(self):
        td = tempfile.TemporaryDirectory()
        self.addCleanup(td.cleanup)
        root = Path(td.name)
        a = make_skill(root, "skill-a", "Alpha description here")
        b = make_skill(root, "skill-b", "Beta description here")

        def responder(req):
            return completion("description: defers to skill-b for beta tasks; alpha keeps x.\n"
                              "rationale: body evidence")

        with MockEndpoint(responder) as base:
            client = h2.ProbeClient(base, "test-model", cap=10)
            prop = h2.generate_proposal(client, a, b, ["skill-a", "skill-b"])
        self.assertEqual(prop["status"], "rejected")
        self.assertIsNone(prop["after"])
        self.assertTrue(prop["reject_reason"].startswith("neighbor_name_in_description"))
        self.assertEqual(prop["attempts"], 2)
        self.assertEqual(client.calls, 2)

    def test_generate_proposal_guard_recovers_on_retry(self):
        td = tempfile.TemporaryDirectory()
        self.addCleanup(td.cleanup)
        root = Path(td.name)
        a = make_skill(root, "skill-a", "Alpha description here")
        b = make_skill(root, "skill-b", "Beta description here")
        calls = []

        def responder(req):
            calls.append(1)
            if len(calls) == 1:
                return completion("description: defers to skill-b for beta tasks.\n"
                                  "rationale: body evidence")
            return completion("description: alpha keeps x; excludes beta territory.\n"
                              "rationale: body evidence")

        with MockEndpoint(responder) as base:
            client = h2.ProbeClient(base, "test-model", cap=10)
            prop = h2.generate_proposal(client, a, b, ["skill-a", "skill-b"])
        self.assertEqual(prop["status"], "proposed")
        self.assertEqual(prop["after"], "alpha keeps x; excludes beta territory.")
        self.assertEqual(client.calls, 2)


class TestFewShotPrompt(unittest.TestCase):
    def setUp(self):
        self._tmp = tempfile.TemporaryDirectory()
        self.root = Path(self._tmp.name)
        self.addCleanup(self._tmp.cleanup)
        self.skill = make_skill(self.root, "show-me", "Explains things with diagrams")
        self.neighbor = make_skill(self.root, "generative-apps", "Builds apps")
        self.prompt = h2.build_proposal_prompt(
            self.skill, self.neighbor, ["show-me", "generative-apps",
                                        "generated-control-surface"])

    def test_good_example_present(self):
        self.assertIn("GOOD (show-me", self.prompt)

    def test_bad_example_present(self):
        self.assertIn("BAD (generated-control-surface", self.prompt)
        self.assertIn("(generative-apps)", self.prompt)  # the embedding that flipped routing

    def test_guard_reason_named(self):
        self.assertIn("neighbor_name_in_description", self.prompt)

    def test_forbidden_names_listed(self):
        self.assertIn("generated-control-surface", self.prompt)


# ---------------------------------------------------------------------------
# v1: body/trap generation against the local fixture
# ---------------------------------------------------------------------------


class TestQueryGeneration(unittest.TestCase):
    def setUp(self):
        self._tmp = tempfile.TemporaryDirectory()
        self.root = Path(self._tmp.name)
        self.addCleanup(self._tmp.cleanup)

    def test_body_gen_validates_and_regen(self):
        skill = make_skill(self.root, "alpha", "Manage telegram buttons and voice replies",
                           body="Run fix_buttons.py then restart relay daemon. " * 20)
        attempts = []

        def responder(req):
            attempts.append(req["messages"][0]["content"])
            if len(attempts) == 1:
                return completion(
                    "QUERY=alpha run fix_buttons.py on row three\n"       # valid
                    "QUERY=telegram button voice reply management\n"      # leak (5 stems)
                    "QUERY=alpha restart the relay daemon")               # valid
            return completion(
                "QUERY=alpha archive the exported button audit csv\n"     # valid
                "QUERY=telegram button voice reply manager\n")            # leak again

        with MockEndpoint(responder) as base:
            client = h2.ProbeClient(base, "test-model", cap=10)
            batch = h2.generate_body_queries(client, skill, 3)
        self.assertEqual(len(attempts), 2)
        self.assertTrue(batch["regen"])
        self.assertEqual(len(batch["queries"]), 3)
        self.assertEqual(len(batch["dropped"]), 2)
        self.assertTrue(all("description_leak" in d["reason"] for d in batch["dropped"]))
        self.assertEqual(client.calls, 2)

    def test_body_gen_parse_failure_then_giveup(self):
        skill = make_skill(self.root, "alpha", "Manage telegram buttons and voice replies")
        with MockEndpoint(lambda req: completion("no parseable lines at all")) as base:
            client = h2.ProbeClient(base, "test-model", cap=10)
            batch = h2.generate_body_queries(client, skill, 3)
        self.assertEqual(batch["queries"], [])
        self.assertTrue(batch["error"])
        self.assertEqual(client.calls, 2)

    def test_trap_gen_balanced_directions(self):
        a = make_skill(self.root, "alpha", "Manage telegram buttons and voice replies")
        b = make_skill(self.root, "beta", "Brew chamomile tea and honey infusions")
        attempts = []

        def responder(req):
            attempts.append(req["messages"][0]["content"])
            if len(attempts) == 1:
                return completion(
                    "TARGET=A QUERY=alpha steps to chamomile honey blend\n"   # valid A-trap
                    "TARGET=B QUERY=telegram button voice beta brew\n")       # leak: 3 vs beta? no -> valid
            return completion("TARGET=B QUERY=chamomile brewing beta checklist")

        with MockEndpoint(responder) as base:
            client = h2.ProbeClient(base, "test-model", cap=10)
            batch = h2.generate_trap_queries(client, a, b, 2)
        targets = sorted(q["target"] for q in batch["queries"])
        self.assertEqual(targets, ["alpha", "beta"])
        self.assertEqual(client.calls, 1)  # first attempt already balanced+valid

    def test_trap_gen_regen_on_leak(self):
        a = make_skill(self.root, "alpha", "Manage telegram buttons and voice replies")
        b = make_skill(self.root, "beta", "Brew chamomile tea and honey infusions")
        attempts = []

        def responder(req):
            attempts.append(req["messages"][0]["content"])
            if len(attempts) == 1:
                return completion(
                    "TARGET=A QUERY=telegram button voice reply manager\n"  # target leak
                    "TARGET=B QUERY=chamomile honey beta brew\n")           # no alpha vocab
            return completion("TARGET=A QUERY=chamomile infusion alpha checklist")

        with MockEndpoint(responder) as base:
            client = h2.ProbeClient(base, "test-model", cap=10)
            batch = h2.generate_trap_queries(client, a, b, 2)
        self.assertTrue(batch["regen"])
        self.assertEqual([q["target"] for q in batch["queries"]], ["alpha"])
        self.assertEqual(len(batch["dropped"]), 2)
        self.assertTrue(any("description_leak" in d["reason"] for d in batch["dropped"]))
        self.assertEqual(client.calls, 2)

    def test_progress_print_every_10_calls(self):
        import io
        from contextlib import redirect_stdout
        buf = io.StringIO()
        with MockEndpoint(lambda req: completion("SKILL: show-me")) as base:
            client = h2.ProbeClient(base, "test-model", cap=12)
            with redirect_stdout(buf):
                for _ in range(10):
                    client.chat([{"role": "user", "content": "hi"}])
        self.assertIn("[pi-harness2 progress] calls=10/12", buf.getvalue())


# ---------------------------------------------------------------------------
# v1: full cmd_run end-to-end (offline fixture) — both sensitivity branches
# ---------------------------------------------------------------------------


def _make_three_skills(root: Path):
    make_skill(root, "alpha", "Manage telegram buttons and voice replies",
               body="Run fix_buttons.py --row 3; restart relay daemon; edit config.yaml. " * 10)
    make_skill(root, "beta", "Manage telegram button surfaces and styling",
               body="Use kettle.py at 80 degrees; add chamomile leaves; steep timer. " * 10)
    make_skill(root, "gamma", "Unrelated gamma accounting ledger entries",
               body="post_entries.sh --month 9; reconcile totals; export ledger.csv. " * 10)
    return h2.discover_skills([root])


def _run_cmd_run(responder, tmp_root, out_dir, k_body=1, k_trap=2):
    import types
    with MockEndpoint(responder) as base:
        args = types.SimpleNamespace(
            root=[str(tmp_root)], k_body=k_body, k_trap=k_trap, cap=60, threshold=0.30,
            leak_max_stems=3, min_trap_stems=2, ban_target_name_stems=False,
            base_url=base, model="test-model", api_key=None, out_dir=str(out_dir))
        rc = h2.cmd_run(args)
    return rc


def _battery_responder(name_picks_correctly=True):
    """Router stub: picks the candidate named in the task text.

    With name_picks_correctly=False, it detects the MUTATED list (alpha's slot
    carries beta's description) and deliberately swaps alpha<->beta picks, so
    mutated accuracy drops and the sensitivity gate can pass.
    """

    def responder(req):
        content = req["messages"][0]["content"]
        if "grounded in" in content and "SKILL.md body" in content:  # body query gen
            m = re.search(r"Skill name: (\S+)", content)
            return completion(f"QUERY={m.group(1)} body procedure task one")
        if "trap tasks" in content:  # trap query gen
            return completion(
                "TARGET=A QUERY=alpha styled surface procedure\n"
                "TARGET=B QUERY=beta button voice checklist")
        if "Skill++ style rewrite" in content:  # proposal
            m = re.search(r"^Skill: (\S+)$", content, re.M)
            return completion(f"description: {m.group(1)} keeps its own territory clearly.\n"
                              "rationale: body evidence")
        if "You are a skill router" in content:  # probe
            cands = re.findall(r"^- (\S+): (.*)$", content, re.M)
            task = re.search(r"User task: (.+)$", content, re.M).group(1)
            mutated = any(n == "alpha" and "surfaces" in d for n, d in cands)
            pick = None
            for n, _d in cands:
                if n in task:
                    pick = n
                    break
            if mutated and name_picks_correctly is False and pick in ("alpha", "beta"):
                pick = "beta" if pick == "alpha" else "alpha"
            if pick is None:
                pick = cands[0][0]
            return completion(f"SKILL: {pick}")
        return completion("")

    return responder


class TestCmdRunV1(unittest.TestCase):
    def setUp(self):
        self._tmp = tempfile.TemporaryDirectory()
        self.root = Path(self._tmp.name) / "skills"
        self.root.mkdir(parents=True)
        self.out = Path(self._tmp.name) / "out"
        self.addCleanup(self._tmp.cleanup)

    def _journal(self):
        lines = (self.out / "journal.jsonl").read_text().splitlines()
        return json.loads(lines[-1])

    def test_end_to_end_sensitivity_fail_marks_probe_invalid(self):
        _make_three_skills(self.root)
        rc = _run_cmd_run(_battery_responder(name_picks_correctly=True), self.root, self.out)
        self.assertEqual(rc, 0)
        rec = self._journal()
        # v2 journal shape
        for key in ("ts", "mode", "queries", "overall", "sensitivity",
                    "proposals_accepted_by_probe"):
            self.assertIn(key, rec)
        self.assertEqual(rec["mode"], "observe")
        self.assertEqual(rec["queries"], 5)  # 3 body + 2 trap
        self.assertEqual(rec["overall"]["current"], "5/5")
        self.assertEqual(rec["overall"]["mutated"], "5/5")
        self.assertEqual(rec["sensitivity"], "fail")
        self.assertEqual(rec["probe_invalid"], "sensitivity check failed")
        self.assertEqual(rec["proposals_accepted_by_probe"], 2)
        report = next(self.out.glob("report-*.md")).read_text()
        self.assertIn("probe_invalid", report)
        self.assertIn("MUTATED", report)
        self.assertIn("每对的探针结果表", report)
        props = json.loads(next(self.out.glob("proposals-*.json")).read_text())
        self.assertEqual(len(props["entries"]), 2)  # alpha + beta (gamma has no pair)

    def test_end_to_end_sensitivity_pass(self):
        _make_three_skills(self.root)
        rc = _run_cmd_run(_battery_responder(name_picks_correctly=False), self.root, self.out)
        self.assertEqual(rc, 0)
        rec = self._journal()
        self.assertEqual(rec["sensitivity"], "pass")
        self.assertIsNone(rec["probe_invalid"])
        # mutated drops only the swapped pair's targeted queries (4 wrong), gamma stays right
        self.assertEqual(rec["overall"]["current"], "5/5")
        self.assertEqual(rec["overall"]["mutated"], "1/5")
        report = next(self.out.glob("report-*.md")).read_text()
        self.assertNotIn("probe_invalid", report.split("## 概览")[0])  # no banner

    def test_k_trap_balances_directions(self):
        _make_three_skills(self.root)
        rc = _run_cmd_run(_battery_responder(name_picks_correctly=True), self.root, self.out,
                          k_trap=2)
        self.assertEqual(rc, 0)
        rec = self._journal()
        self.assertEqual(rec["queries"], 5)  # k_body=1 x3 + k_trap=2 (1 per direction)

    def test_endpoint_down_writes_v2_journal(self):
        _make_three_skills(self.root)
        import types
        args = types.SimpleNamespace(
            root=[str(self.root)], k_body=1, k_trap=2, cap=5, threshold=0.30,
            leak_max_stems=3, min_trap_stems=2, ban_target_name_stems=False,
            base_url="http://127.0.0.1:1/v1", model="test-model", api_key=None,
            out_dir=str(self.out))
        rc = h2.cmd_run(args)
        self.assertEqual(rc, 2)
        rec = self._journal()
        self.assertIn("overall", rec)
        self.assertEqual(rec["sensitivity"], "n/a")
        self.assertEqual(rec["error"], "endpoint unreachable")


class TestLegacyCompat(unittest.TestCase):
    """v0 pairwise path must keep working for existing workflows/tests."""

    def test_defaults_constants(self):
        self.assertEqual(h2.DEFAULT_K_BODY, 3)
        self.assertEqual(h2.DEFAULT_K_TRAP, 2)
        self.assertEqual(h2.DEFAULT_CAP, 200)
        self.assertEqual(h2.LEAK_MAX_SHARED, 3)
        self.assertEqual(h2.MIN_TRAP_NEIGHBOR_STEMS, 2)
        self.assertEqual(h2.MIN_SENSITIVITY_DROP, 0.10)

    def test_probe_pair_still_available(self):
        self.assertTrue(callable(h2.probe_pair))
        self.assertTrue(callable(h2.build_recommendations))


if __name__ == "__main__":
    unittest.main()