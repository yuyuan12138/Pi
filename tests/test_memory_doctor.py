#!/usr/bin/env python3
"""Tests for tools/memory_doctor.py.

The fixture database is built at test runtime in a temp directory with the
exact schema of extensions-src/memory-index (db.ts SCHEMA_SQL). The REAL
index.db (~/.pi/agent/memory/index.db) is never opened here.

Fixture tokens are deliberately NON-credential-shaped: RFC 5737 documentation
IPs (192.0.2.0/24, 198.51.100.0/24), `.test`-style aliases and fake model
names. The one credential-SCREENING test uses `api_key: deadbeef...`, which
matches memory_doctor's own generic-secret screener but NOT the repo
staged-content guard patterns (no telegram-token / sk- / gh_ / AKIA shapes).
"""

import json
import os
import sqlite3
import sys
import tempfile
import unittest
import datetime as dt

TOOLS_DIR = os.path.join(os.path.dirname(os.path.abspath(__file__)), "..", "tools")
sys.path.insert(0, os.path.abspath(TOOLS_DIR))

import memory_doctor as md  # noqa: E402


FIXTURE_TS = {
    "qwen_policy": "2026-11-01T10:00:00.000Z",
    "qwen_worker": "2026-11-02T10:00:00.000Z",
    "alias_old": "2026-11-02T11:00:00.000Z",
    "alias_new": "2026-11-03T11:00:00.000Z",
    "exporter_active": "2026-11-01T12:00:00.000Z",
    "exporter_retired": "2026-11-05T12:00:00.000Z",
    "glm_unrelated": "2026-11-07T10:00:00.000Z",
}


def build_fixture_db(path: str):
    conn = sqlite3.connect(path)
    conn.executescript(md.SCHEMA_SQL)
    conn.execute("INSERT OR REPLACE INTO meta(key, value) VALUES('schema_version','1')")
    conn.execute("INSERT OR REPLACE INTO meta(key, value) VALUES('tokenizer','bigram')")
    rows = [
        # (obs_id, kind, ts, content)
        ("fxqwen000001", "observation", FIXTURE_TS["qwen_policy"],
         "Dispatch bounded coding tasks with subagent_spawn explicitly selecting model "
         "training-coder/Qwen3-5; keep the primary model unchanged."),
        ("fxqwen000002", "observation", FIXTURE_TS["qwen_worker"],
         "Worker sa5 used training-coder/Qwen3-5 for the refactor dispatch and delivered "
         "the merged patch with passing tests."),
        ("fxalias00001", "observation", FIXTURE_TS["alias_old"],
         "MC RSI episode deployments reach the remote host via the SSH alias Ops-Remote."),
        ("fxalias00003", "observation", "2026-11-02T11:30:00.000Z",
         "sa23 episode deployment also used the SSH alias Ops-Remote for the MC host."),
        ("fxalias00002", "observation", FIXTURE_TS["alias_new"],
         "MC RSI remote host is ops@198.51.100.7 for all episode deployments, correcting "
         "the outdated alias runbook; ssh config updated."),
        ("fxexp0000001", "observation", FIXTURE_TS["exporter_active"],
         "The legacy ledger exporter still works for the nightly sync; keep using the "
         "ledger exporter."),
        ("fxexp0000002", "observation", FIXTURE_TS["exporter_retired"],
         "User ruling: remove the ledger exporter entirely; it must not be used anymore."),
        ("fxunrel00001", "observation", FIXTURE_TS["glm_unrelated"],
         "Primary chat stays on glm-5.2 via the bigmodel provider; unrelated note about "
         "browser cookies."),
    ]
    for obs_id, kind, ts, content in rows:
        conn.execute(
            "INSERT INTO obs(obs_id, entry_id, session_id, session_path, source_path, kind,"
            " project, ts, content, source_entry_ids) VALUES(?,?,?,?,?,?,?,?,?,?)",
            (obs_id, "", "sess-" + obs_id[:6], "", "", kind, "/fixtures/piagents", ts, content, "[]"),
        )
        conn.execute(
            "INSERT INTO obs_fts(tokens, obs_id, session_id, entry_id, ts, kind, project)"
            " VALUES(?,?,?,?,?,?,?)",
            (" ".join(content.lower().split()), obs_id, "sess-" + obs_id[:6], "", ts, kind,
             "/fixtures/piagents"),
        )
    conn.execute("INSERT INTO watermarks(path, byte_offset, size, mtime_ms) VALUES(?,?,?,?)",
                 ("/fixtures/sessions/alpha.jsonl", 100, 200, 1700000000000))
    conn.commit()
    conn.close()


KB_DAILY_1106 = """# 2026-11-06

## Ops notes

- 2026-11-06 | Coding-worker correction (supersedes the 2026-11-01 preference): subagent_spawn must target GLM-5.3-Flash, never training-coder/Qwen3-5. Source: fixture.
"""


class MemoryDoctorTestBase(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.mkdtemp(prefix="memory_doctor_test_")
        self.db_path = os.path.join(self.tmp, "index.db")
        build_fixture_db(self.db_path)
        self.kb_root = os.path.join(self.tmp, "kb")
        daily_dir = os.path.join(self.kb_root, "daily")
        os.makedirs(daily_dir)
        with open(os.path.join(daily_dir, "2026-11-06.md"), "w", encoding="utf-8") as fh:
            fh.write(KB_DAILY_1106)

    def tearDown(self):
        import shutil
        shutil.rmtree(self.tmp, ignore_errors=True)

    def scan(self, include_kb_md=True):
        return md.run_scan(self.db_path, self.kb_root, include_kb_md=include_kb_md)

    def find_cluster(self, clusters, ftype, value_substr=None):
        for c in clusters:
            if c.ftype != ftype:
                continue
            if value_substr and value_substr not in c.current_value \
                    and not any(value_substr in s["value"] for s in c.stale):
                continue
            return c
        return None


class TestScanBasics(MemoryDoctorTestBase):
    def test_model_cluster_newest_wins_with_kb_correction(self):
        _, _, clusters, _ = self.scan()
        c = self.find_cluster(clusters, "model", "glm-5.3-flash")
        self.assertIsNotNone(c, "model contradiction cluster not found")
        self.assertEqual(c.current_value, "glm-5.3-flash")
        stale_values = {s["value"] for s in c.stale}
        self.assertIn("qwen3-5", stale_values)
        self.assertTrue(c.kb_correction_present)
        self.assertFalse(c.apply_needed)
        newest_current = max(f.ts for f in c.current_facts)
        self.assertEqual(newest_current, "2026-11-06T12:00:00.000Z")

    def test_endpoint_cluster_alias_vs_host(self):
        _, _, clusters, _ = self.scan()
        c = self.find_cluster(clusters, "endpoint", "198.51.100.7")
        self.assertIsNotNone(c, "endpoint contradiction cluster not found")
        self.assertEqual(c.current_value, "198.51.100.7")
        self.assertEqual({s["value"] for s in c.stale}, {"ops-remote"})
        stale_dates = [f.ts for s in c.stale for f in s["facts"]]
        self.assertTrue(all(t < "2026-11-03T11:00" for t in stale_dates))
        self.assertFalse(c.kb_correction_present)

    def test_lifecycle_cluster_active_vs_retired(self):
        _, _, clusters, _ = self.scan()
        c = self.find_cluster(clusters, "lifecycle")
        self.assertIsNotNone(c, "lifecycle contradiction cluster not found")
        self.assertEqual(c.current_value, "retired")
        self.assertEqual({s["value"] for s in c.stale}, {"active"})
        self.assertTrue(c.has_explicit_correction)

    def test_same_value_is_not_a_contradiction(self):
        _, facts, clusters, _ = self.scan()
        glm_values = {f.value for f in facts if f.ftype == "model" and not f.negated}
        self.assertIn("glm-5.2", glm_values)
        for c in clusters:
            if c.ftype == "model":
                self.assertNotEqual(c.current_value, "glm-5.2")
                self.assertNotIn("glm-5.2", {s["value"] for s in c.stale},
                                 "single-mention glm-5.2 must not join a cluster")

    def test_negated_mention_is_flagged(self):
        entry = md.Entry("neg1", "observation", "2026-11-06T12:00:00.000Z", "",
                         "subagent_spawn must target GLM-5.3-Flash, never "
                         "training-coder/Qwen3-5.", "")
        facts = md.extract_facts(entry)
        by_val = {f.value: f for f in facts if f.ftype == "model"}
        self.assertFalse(by_val["glm-5.3-flash"].negated)
        self.assertTrue(by_val["qwen3-5"].negated)


class TestReadOnlyGuarantee(MemoryDoctorTestBase):
    def test_db_bytes_and_watermarks_untouched(self):
        before = open(self.db_path, "rb").read()
        entries, _, clusters, _ = self.scan(include_kb_md=False)
        self.assertEqual(len(entries), 8)
        after = open(self.db_path, "rb").read()
        self.assertEqual(before, after, "index.db was modified by a read-only scan")
        conn = sqlite3.connect(self.db_path)
        wm = conn.execute("SELECT path, byte_offset, size, mtime_ms FROM watermarks").fetchall()
        conn.close()
        self.assertEqual(wm, [("/fixtures/sessions/alpha.jsonl", 100, 200, 1700000000000)])
        for suffix in ("-wal", "-shm", "-journal"):
            self.assertFalse(os.path.exists(self.db_path + suffix),
                             f"read-only scan created {suffix}")

    def test_credential_screened_content_is_excluded(self):
        self.assertEqual(md.credential_flag("api_key: deadbeefcafebabe1234"),
                         "generic-secret-assignment")
        entry = md.Entry("sec1", "observation", "2026-11-08T10:00:00.000Z", "",
                         "rotated the worker api_key: deadbeefcafebabe1234 today; "
                         "subagent model training-coder/Qwen3-5.", "")
        self.assertEqual(md.extract_facts(entry), [])
        # and load_db drops such rows entirely
        db2 = os.path.join(self.tmp, "withsecret.db")
        build_fixture_db(db2)
        conn = sqlite3.connect(db2)
        conn.execute(
            "INSERT INTO obs(obs_id, entry_id, session_id, session_path, source_path, kind,"
            " project, ts, content, source_entry_ids) VALUES(?,?,?,?,?,?,?,?,?,?)",
            ("fxsecret0001", "", "sess-sec", "", "", "observation", "/fixtures/piagents",
             "2026-11-08T10:00:00.000Z",
             "rotated the worker api_key: deadbeefcafebabe1234 today", "[]"))
        conn.commit()
        conn.close()
        loaded = md.load_db(db2)
        self.assertNotIn("fxsecret0001", {e.entry_id for e in loaded})


class TestKbMdLoading(MemoryDoctorTestBase):
    def test_daily_md_sections_added_as_entries(self):
        _, _, clusters, kb_md_added = self.scan()
        self.assertEqual(kb_md_added, 1)
        c = self.find_cluster(clusters, "model", "glm-5.3-flash")
        self.assertIsNotNone(c)
        kinds = {f.entry.kind for f in c.current_facts}
        self.assertIn("daily", kinds)

    def test_split_daily_sections_mirrors_indexer(self):
        text = "preamble ignored\n## A\nbody a\n## B\nbody b\n"
        sections = md.split_daily_sections(text)
        self.assertEqual([h for h, _ in sections], ["A", "B"])
        self.assertEqual(sections[0][1], "body a")

    def test_derived_id_matches_indexer_convention(self):
        # node: createHash('sha256').update(parts.join('\0')).hex.slice(0,12)
        import hashlib
        expected = hashlib.sha256(b"kb-daily\x00/p/x.md\x000\x00H").hexdigest()[:12]
        self.assertEqual(md.derived_id("kb-daily", "/p/x.md", "0", "H"), expected)


class TestReportAndJson(MemoryDoctorTestBase):
    def test_report_and_json_written_and_sorted(self):
        report_path = os.path.join(self.tmp, "report.md")
        json_path = os.path.join(self.tmp, "report.json")
        rc = md.main(["--db", self.db_path, "--kb", self.kb_root,
                      "--report", report_path, "--json", json_path, "--top", "5"])
        self.assertEqual(rc, 0)
        report = open(report_path, encoding="utf-8").read()
        self.assertIn("Memory Doctor", report)
        self.assertIn("[HIGH]", report)  # lifecycle cluster scores high
        payload = json.load(open(json_path, encoding="utf-8"))
        self.assertEqual(payload["entries_scanned"], 9)  # 8 db + 1 kb-md
        scores = [c["severity"]["score"] for c in payload["clusters"]]
        self.assertEqual(scores, sorted(scores, reverse=True))
        types = {c["type"] for c in payload["clusters"]}
        self.assertTrue({"model", "endpoint", "lifecycle"} <= types)
        model = next(c for c in payload["clusters"] if c["type"] == "model")
        self.assertEqual(model["current"]["value"], "glm-5.3-flash")
        self.assertTrue(model["recommended_entry"]["source"].endswith("2026-11-06.md"))

    def test_min_severity_filter(self):
        rc = md.main(["--db", self.db_path, "--kb", self.kb_root,
                      "--report", os.path.join(self.tmp, "r.md"),
                      "--min-severity", "high"])
        self.assertEqual(rc, 0)

class TestApplySupersede(MemoryDoctorTestBase):
    def apply_fixed(self, clusters, confirm=True):
        now = dt.datetime(2026, 11, 10, 9, 30, tzinfo=dt.timezone.utc).astimezone()
        return md.append_corrections(self.kb_root, clusters, self.db_path,
                                     confirm=confirm, now=now)

    def test_apply_writes_corrective_entry_in_daily_format(self):
        _, _, clusters, _ = self.scan()
        written = self.apply_fixed(clusters)
        self.assertEqual(len(written), 2, "endpoint (high) + lifecycle (medium+explicit)")
        target = os.path.join(self.kb_root, "daily", "2026-11-10.md")
        self.assertTrue(os.path.exists(target))
        lines = [ln for ln in open(target, encoding="utf-8").read().splitlines() if ln.strip()]
        self.assertEqual(len(lines), 2)
        # endpoint cluster first (higher score): local-time timestamp, both values named
        now_local = dt.datetime(2026, 11, 10, 9, 30, tzinfo=dt.timezone.utc).astimezone()
        stamp = now_local.strftime("%Y-%m-%d %H:%M")
        self.assertTrue(lines[0].startswith(f"- {stamp} — Memory-doctor correction "
                                            "(supersedes the 2026-11-02 entries):"))
        self.assertIn("`ops-remote`", lines[0])
        self.assertIn("`198.51.100.7`", lines[0])
        self.assertIn("Source: tools/memory_doctor.py sweep 2026-11-10", lines[0])
        # lifecycle cluster second, retired-wording
        self.assertIn("current status is retired/removed", lines[1])
        self.assertIn("supersedes the 2026-11-01 entries", lines[1])
        # historical KB file untouched
        self.assertEqual(open(os.path.join(self.kb_root, "daily", "2026-11-06.md"),
                              encoding="utf-8").read(), KB_DAILY_1106)

    def test_apply_is_idempotent(self):
        _, _, clusters, _ = self.scan()
        self.apply_fixed(clusters)
        written2 = self.apply_fixed(clusters)
        self.assertEqual(written2, [], "second apply must not duplicate the correction")
        target = os.path.join(self.kb_root, "daily", "2026-11-10.md")
        lines = [ln for ln in open(target, encoding="utf-8").read().splitlines() if ln.strip()]
        self.assertEqual(len(lines), 2)

    def test_apply_never_touches_kb_corrected_or_low_clusters(self):
        _, _, clusters, _ = self.scan()
        self.apply_fixed(clusters)
        model = self.find_cluster(clusters, "model", "glm-5.3-flash")
        self.assertFalse(model.apply_needed)
        target = os.path.join(self.kb_root, "daily", "2026-11-10.md")
        if os.path.exists(target):
            self.assertNotIn("glm-5.3-flash", open(target, encoding="utf-8").read())

    def test_apply_requires_confirmation(self):
        _, _, clusters, _ = self.scan()
        self.assertEqual(self.apply_fixed(clusters, confirm=False), [])
        self.assertFalse(os.path.exists(os.path.join(self.kb_root, "daily", "2026-11-10.md")))

    def test_cli_apply_without_yes_refuses(self):
        rc = md.main(["--db", self.db_path, "--kb", self.kb_root, "--no-kb-md",
                      "--report", os.path.join(self.tmp, "r.md"), "--apply"])
        self.assertEqual(rc, 1)
        self.assertFalse(os.path.exists(os.path.join(self.kb_root, "daily", "2026-11-10.md")))


if __name__ == "__main__":
    unittest.main()
