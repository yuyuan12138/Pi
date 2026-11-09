#!/usr/bin/env python3
"""memory_doctor.py — contradiction sweeper for the Pi observational-memory store.

Scans the memory index (SQLite FTS5 store built by extensions-src/memory-index)
plus the knowledge-base markdown, and reports CONTRADICTION CLUSTERS: entries
about the same entity/fact asserting different values (model names, host
addresses, endpoints, lifecycle/status claims). Newest entry wins; each cluster
lists both sides with dates and a recommended superseding entry.

v1 is READ-ONLY on the database (opened with mode=ro + query_only; watermarks
are never touched). The only write path is the opt-in `--apply` supersede
mechanism, which APPENDS a dated corrective entry to
knowledge-base/daily/<today>.md in the established daily-log format.
Historical entries are never edited or deleted; clusters whose newest side is
already a KB (daily/concept) entry are considered already superseded and are
not written again (idempotent re-runs are also enforced by a per-cluster
marker line check).

Usage:
  python3 tools/memory_doctor.py                       # read-only demo sweep
  python3 tools/memory_doctor.py --json out.json --report out.md
  python3 tools/memory_doctor.py --apply --yes         # append corrective entries
"""

from __future__ import annotations

import argparse
import datetime as _dt
import hashlib
import json
import os
import re
import shutil
import sqlite3
import sys
import tempfile
from dataclasses import dataclass, field

DEFAULT_DB = os.path.expanduser("~/.pi/agent/memory/index.db")
DEFAULT_KB = "/Users/yuyuan/PiAgents/knowledge-base"

SEVERITY_ORDER = {"low": 0, "medium": 1, "high": 2}

# --------------------------------------------------------------------------
# Credential screening — mirrors extensions-src/memory-index/src/credentials.ts
# (same intent: content matching these is excluded from scanning/reports).
# Fixtures in tests deliberately use NON-flagged tokens; do not "fix" that.
# --------------------------------------------------------------------------
CREDENTIAL_PATTERNS = (
    ("aws-access-key", re.compile(r"\bAKIA[0-9A-Z]{16}\b")),
    ("openai-style-key", re.compile(r"\bsk-[A-Za-z0-9_-]{20,}\b")),
    ("github-pat", re.compile(r"\bgh[pousr]_[A-Za-z0-9]{20,}\b")),
    ("google-api-key", re.compile(r"\bAIza[0-9A-Za-z_-]{35}\b")),
    ("slack-token", re.compile(r"\bxox[abprs]-[A-Za-z0-9-]{10,}\b")),
    ("private-key-block", re.compile(r"-----BEGIN [A-Z ]*PRIVATE KEY-----")),
    ("jwt", re.compile(r"\beyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{5,}\b")),
    ("generic-secret-assignment",
     re.compile(r"\b(?:password|passwd|secret|api[_-]?key|token)\b\s*[:=]\s*['\"]?[^\s'\"]{8,}", re.I)),
)


def credential_flag(text: str) -> str | None:
    for name, rx in CREDENTIAL_PATTERNS:
        if rx.search(text):
            return name
    return None


# --------------------------------------------------------------------------
# Data model
# --------------------------------------------------------------------------

@dataclass
class Entry:
    entry_id: str           # obs_id for db rows, derived id for direct-md rows
    kind: str               # observation | daily | concept
    ts: str                 # ISO-8601 UTC
    project: str
    content: str
    source_path: str        # kb file path for KB rows, "" for observations
    session_id: str = ""

    @property
    def source_label(self) -> str:
        if self.source_path:
            return self.source_path
        return f"session:{self.session_id or 'unknown'}"


@dataclass
class Fact:
    ftype: str              # model | endpoint | lifecycle
    value: str              # normalized value (or claim for lifecycle)
    display: str            # value as seen in text
    negated: bool
    ts: str
    entry: Entry
    unit: str               # bullet/section text the fact came from
    sent_tokens: frozenset  # entity-candidate tokens of the sentence
    subject: frozenset = frozenset()  # lifecycle: tokens naming the subject
    sent_idx: int = -1      # index of the sentence within the unit
    span: tuple = ()        # (start, end) of the value match within the sentence
    sent_text: str = ""     # the sentence the value was found in


@dataclass
class Source:
    obs_id: str
    kind: str
    ts: str
    excerpt: str
    source_path: str
    session_id: str


@dataclass
class Cluster:
    cid: str
    ftype: str
    entity_label: str
    current_value: str
    current_facts: list = field(default_factory=list)
    stale: list = field(default_factory=list)   # [{value, facts}]
    score: int = 0
    tier: str = "low"
    has_explicit_correction: bool = False
    kb_correction_present: bool = False
    apply_needed: bool = False
    note: str = ""


# --------------------------------------------------------------------------
# Loading — index.db (READ-ONLY) and KB markdown
# --------------------------------------------------------------------------

# Schema mirrors extensions-src/memory-index/src/db.ts SCHEMA_SQL (used by the
# test fixture builder; the real db is only ever opened read-only).
SCHEMA_SQL = """
CREATE TABLE IF NOT EXISTS meta(key TEXT PRIMARY KEY, value TEXT NOT NULL);
CREATE TABLE IF NOT EXISTS obs(
  obs_id TEXT PRIMARY KEY,
  entry_id TEXT NOT NULL DEFAULT '',
  session_id TEXT NOT NULL DEFAULT '',
  session_path TEXT NOT NULL DEFAULT '',
  source_path TEXT NOT NULL DEFAULT '',
  kind TEXT NOT NULL,
  project TEXT NOT NULL,
  ts TEXT NOT NULL,
  content TEXT NOT NULL,
  source_entry_ids TEXT NOT NULL DEFAULT '[]'
);
CREATE INDEX IF NOT EXISTS idx_obs_project_kind_ts ON obs(project, kind, ts);
CREATE VIRTUAL TABLE IF NOT EXISTS obs_fts USING fts5(
  tokens,
  obs_id UNINDEXED,
  session_id UNINDEXED,
  entry_id UNINDEXED,
  ts UNINDEXED,
  kind UNINDEXED,
  project UNINDEXED,
  tokenize='unicode61'
);
CREATE TABLE IF NOT EXISTS watermarks(
  path TEXT PRIMARY KEY,
  byte_offset INTEGER NOT NULL,
  size INTEGER NOT NULL,
  mtime_ms INTEGER NOT NULL
);
"""


def _open_ro(db_path: str):
    """Open the index strictly read-only. Falls back to a temp copy if the
    on-disk WAL state prevents a read-only open (never writes to the original)."""
    try:
        conn = sqlite3.connect(f"file:{db_path}?mode=ro", uri=True)
        conn.execute("PRAGMA query_only=1")
        conn.execute("SELECT COUNT(*) FROM obs").fetchone()
        return conn, None
    except sqlite3.Error:
        tmp = tempfile.mkdtemp(prefix="memory_doctor_ro_")
        for suffix in ("", "-wal", "-shm"):
            src = db_path + suffix
            if os.path.exists(src):
                shutil.copy2(src, os.path.join(tmp, os.path.basename(db_path) + suffix))
        copy_path = os.path.join(tmp, os.path.basename(db_path))
        conn = sqlite3.connect(f"file:{copy_path}?mode=ro", uri=True)
        conn.execute("PRAGMA query_only=1")
        return conn, tmp


def load_db(db_path: str) -> list[Entry]:
    if not os.path.exists(db_path):
        raise FileNotFoundError(f"memory index not found: {db_path}")
    conn, tmp = _open_ro(db_path)
    try:
        rows = conn.execute(
            "SELECT obs_id, session_id, source_path, kind, project, ts, content FROM obs"
        ).fetchall()
    finally:
        conn.close()
        if tmp:
            shutil.rmtree(tmp, ignore_errors=True)
    entries = []
    for obs_id, session_id, source_path, kind, project, ts, content in rows:
        if credential_flag(content):
            continue  # screened out, same policy as the indexer write path
        entries.append(Entry(obs_id, kind, ts, project, content, source_path, session_id))
    return entries


def derived_id(*parts: str) -> str:
    return hashlib.sha256("\0".join(parts).encode("utf-8")).hexdigest()[:12]


def _date_to_iso(date_str: str) -> str | None:
    if re.fullmatch(r"\d{4}-\d{2}-\d{2}", date_str):
        return f"{date_str}T12:00:00.000Z"
    return None


def split_daily_sections(text: str):
    """Mirror parse-kb.ts splitDailySections: one section per `## ` heading."""
    sections, current = [], None
    for line in text.splitlines():
        if line.startswith("## "):
            if current:
                sections.append(current)
            current = {"heading": line[3:].strip(), "body": []}
        elif current is not None:
            current["body"].append(line)
    if current:
        sections.append(current)
    return [(s["heading"], "\n".join(s["body"]).strip()) for s in sections
            if s["body"] or s["heading"]]


def load_kb_md(kb_root: str, known_keys: set | None = None) -> list[Entry]:
    """Parse daily/*.md and knowledge/concepts/*.md directly (fallback/second
    source for rows the db may not hold yet, e.g. credential-skipped or
    not-yet-refreshed sections). Rows already present in the db are skipped
    via (source_path, section-content) keys."""
    entries = []
    daily_dir = os.path.join(kb_root, "daily")
    concepts_dir = os.path.join(kb_root, "knowledge", "concepts")
    if os.path.isdir(daily_dir):
        for fname in sorted(os.listdir(daily_dir)):
            if not fname.endswith(".md"):
                continue
            path = os.path.join(daily_dir, fname)
            day_iso = _date_to_iso(fname[:-3]) or _dt.datetime.fromtimestamp(
                os.path.getmtime(path), _dt.timezone.utc).strftime("%Y-%m-%dT%H:%M:%S.000Z")
            raw = open(path, encoding="utf-8", errors="replace").read()
            for i, (heading, body) in enumerate(split_daily_sections(raw)):
                content = f"## {heading}\n\n{body}" if heading else body
                if credential_flag(content) or credential_flag(heading):
                    continue
                key = (path, content)
                if known_keys is not None and key in known_keys:
                    continue
                entries.append(Entry(derived_id("kb-daily", path, str(i), heading),
                                     "daily", day_iso, "", content, path))
    if os.path.isdir(concepts_dir):
        for fname in sorted(os.listdir(concepts_dir)):
            if not fname.endswith(".md"):
                continue
            path = os.path.join(concepts_dir, fname)
            raw = open(path, encoding="utf-8", errors="replace").read()
            body = re.sub(r"^---\r?\n[\s\S]*?\r?\n---\r?\n?", "", raw, count=1).strip()
            if not body or credential_flag(body):
                continue
            fm_updated = None
            m = re.search(r"^updated:\s*(\d{4}-\d{2}-\d{2})\s*$", raw, re.M)
            if m:
                fm_updated = m.group(1)
            ts = (_date_to_iso(fm_updated) if fm_updated else None) or _dt.datetime.fromtimestamp(
                os.path.getmtime(path), _dt.timezone.utc).strftime("%Y-%m-%dT%H:%M:%S.000Z")
            title_m = re.search(r"^title:\s*(.+)$", raw, re.M)
            title = title_m.group(1).strip() if title_m else os.path.basename(fname)[:-3]
            content = f"# {title}\n\n{body}"
            key = (path, content)
            if known_keys is not None and key in known_keys:
                continue
            entries.append(Entry(derived_id("kb-concept", path), "concept", ts, "", content, path))
    return entries


def db_known_keys(db_path: str) -> set:
    """(source_path, content) keys of KB rows already in the db."""
    if not os.path.exists(db_path):
        return set()
    conn, tmp = _open_ro(db_path)
    try:
        rows = conn.execute(
            "SELECT source_path, content FROM obs WHERE kind IN ('daily','concept')"
        ).fetchall()
    finally:
        conn.close()
        if tmp:
            shutil.rmtree(tmp, ignore_errors=True)
    return {(p, c) for p, c in rows}


# --------------------------------------------------------------------------
# Fact extraction
# --------------------------------------------------------------------------

STOPWORDS = frozenset("""
the a an and or of to in on for with is was are were be been being am
this that these those it its as at by from into after before new now then
than so but if when while which who what where how why all any both each
few more most other some such same too very one two three first last next
previous prior earlier later today yesterday tomorrow date time times
use used uses using via per not no never without within must should can
could will would may might shall do does did done doing has have had having
get gets got gotten set sets putting out up down over under also only still
already just about against between through during above below there here
their them they we our us you your i me my he she his hers herself himself
itself because until again once own off further been being whose
user assistant agent agents entry entries note notes log logs line lines
commit commits file files value values name names named call called calls
running run runs ran try tries tried need needs needed want wanted make
makes made work worked works keep kept let lets take takes took give gives
gave go goes went come comes came see saw seen say said says tell told
still yet even much many lot lots bit way ways thing things stuff
de de/es du
""".split())

MODEL_RX = re.compile(
    r"\b(?:[a-z][a-z0-9_-]*/)?(?:qwen|glm|deepseek|kimi|minimax|claude|gpt|gemini|llama|mistral"
    r"|grok|ERNIE|baichuan|yi-)[\w.+-]*\d[\w.+-]*",
    re.I,
)
# provider-qualified names whose bare slug lacks a version digit
# (e.g. deepseek/deepseek-flash under a known provider namespace)
PROVIDER_QUALIFIED_RX = re.compile(r"\b(?:training-coder|deepseek)/[A-Za-z][\w.+-]*")
IP_RX = re.compile(r"\b(?:([a-z][\w.-]{0,30})@)?((?:\d{1,3}\.){3}\d{1,3})(?::(\d{2,5}))?\b")
ALIAS_RX = re.compile(r"\b([A-Z][A-Za-z0-9]*(?:-[A-Za-z0-9]+)+)\b")
DOCKERHOST_RX = re.compile(r"\b([a-z][\w-]*-docker-\d+)\b")
LOCALHOST_RX = re.compile(r"\b(localhost)(?::(\d{2,5}))?\b", re.I)

NEG_BEFORE_RX = re.compile(
    r"\b(?:not|never|no more|instead of|rather than|≠|!=|dead|removed|retired|stale|wrong|"
    r"nonexistent)\s*(?:the\s+|a\s+|an\s+)?\Z", re.I)
NEG_PAREN_RX = re.compile(r"\(\s*not\s+\Z", re.I)
NEG_AFTER_RX = re.compile(
    r"^\s*(?:(?:is|was|now|alias|endpoint|tunnel|name|model|url)\s+){0,2}"
    r"(?:wrong|dead|retired|stale|removed|gone|404s?|nonexistent|invalid|missing|rejected)",
    re.I)

RETIRE_RX = re.compile(
    r"\b(retire[ds]?|removing|removed?|deprecat\w+|deleted?|no longer|not supported|"
    r"unavailable|dead|stale|obsolete|must not be used|never be used|remove the|drop the|"
    r"absorbed|404s?|disabled)\b", re.I)
ACTIVE_RX = re.compile(
    r"\b(works?|working|available|supported|usable|still use|continue|keep using|"
    r"is live|\blive\b|remains)\b", re.I)

# an endpoint-alias token only counts when the sentence is actually about
# hosts/ssh/remote machines (prevents SWE-bench / PHQ-9 style label noise)
# an endpoint-alias token only counts when it sits RIGHT NEXT to a host word
# (prevents SWE-bench / read-only / Server-side style label noise)
HOST_CONTEXT_RX = re.compile(
    r"\b(ssh|alias|host|hostname|server|remote|vm|machine|login|reach|tunnel|forward)\b", re.I)
ALIAS_ANCHOR_BEFORE_RX = re.compile(r"\b(alias|host|hostname|vm|machine|node|box|server)\s*[:=]?\s*$", re.I)
ALIAS_ANCHOR_AFTER_RX = re.compile(r"^\s*(?:is|was|at|/)\s*(?:the\s+)?(?:host|hostname|machine|server|vm|node)\b", re.I)

MODEL_FILE_SUFFIX_RX = re.compile(
    r"\.(?:sh|log|json|py|md|bak|ts|js|txt|yaml|yml|csv|jq|zip|tar|gz)\b", re.I)

# connection-generic tokens: they glue EVERY endpoint sentence together, so
# they are excluded from the shared-entity computation (values + role tokens
# like mc/wangruojun/mihomo carry the entity)
GENERIC_ENDPOINT = frozenset(
    "server ssh remote host hostname port tunnel forward local machine login address "
    "connection connect connected network proxy ip dns endpoint listen listening "
    "port ported public private via per http https url api config configuration "
    "json yaml curl docker container service deploy deployed deployment release".split())

# lifecycle claims have no distinguishing value (all retired-vs-active), so
# the shared-entity computation must rely on real subject tokens only
GENERIC_LIFECYCLE = frozenset(
    "episode live model session actor bot turn message chat path user request "
    "log test tool task run worker agent dispatch reload bridge file command "
    "error failure fail blocked block dig web stream key data end start fix "
    "fixed support context profile default update updated change changed "
    "config setting settings commit value name time line list output send sent "
    "deliver delivered delivery arrive arrived return returned tail append "
    "watcher reader post http url read write preview inject injected ping "
    "target target serve server call called asking wait waiting complete "
    "completed terminal trigger triggered fired succeed succeeded success".split())

SENT_SPLIT_RX = re.compile(r"\n+|[。；;]|[.!?](?=\s)")
MODEL_FILLER = {"model", "alias", "name", "provider", "endpoint", "default", "defaults"}


def _norm_token(tok: str) -> str:
    t = tok.lower()
    if len(t) > 4 and t.endswith("ies"):
        t = t[:-3] + "y"
    elif len(t) > 4 and t.endswith("s") and not t.endswith("ss"):
        t = t[:-1]
    return t


def content_tokens(text: str) -> set:
    toks = set()
    for raw in re.findall(r"[A-Za-z0-9][A-Za-z0-9_.+-]*", text):
        for piece in re.split(r"[._+-]", raw):
            if len(piece) < 3 or not re.search(r"[A-Za-z]", piece):
                continue
            t = _norm_token(piece)
            if t in STOPWORDS or len(t) < 3:
                continue
            toks.add(t)
    return toks


MODEL_FAMILY_RX = re.compile(r"^(?:qwen|glm|deepseek|kimi|gpt|claude|gemini|llama|mistral)", re.I)


def _negated(text: str, start: int, end: int) -> bool:
    before = text[max(0, start - 40):start]
    if NEG_BEFORE_RX.search(before) or NEG_PAREN_RX.search(before):
        return True
    after = text[end:end + 40]
    return bool(NEG_AFTER_RX.match(after))


SUBJ_FILLERS = frozenset(
    "the a an is was are were has have had been being now still already also only "
    "just very its it this that their there for of and or with from into".split())

# lifecycle claims must NAME their subject next to the status marker — bare
# markers alone made every 'live/stale' sentence a claim and chained unrelated
# topics into one cluster
RETIRE_SUBJECT_PATTERNS = (
    (re.compile(r"\b(?:remove[sd]?|removing|retire[sd]?|deprecat\w+|drop(?:ped|s)?|delet\w+"
                r"|absorb\w*|uninstall\w*)\s+(?:the\s+|a\s+|an\s+)?", re.I), "after"),
    (re.compile(r"\b(?:is|was|has\s+been|are|were)\s+(?:now\s+)?"
                r"(?:retired|removed|deprecated|dead|stale|obsolete|gone|unavailable|disabled)\b", re.I), "before"),
    (re.compile(r"\bdead\s+", re.I), "after"),
    (re.compile(r"\b404s?\b", re.I), "before"),
    (re.compile(r"\b(?:is|was)\s+no\s+longer\b", re.I), "before"),
)
ACTIVE_SUBJECT_PATTERNS = (
    (re.compile(r"\b(?:still\s+)?works?\b", re.I), "before"),
    (re.compile(r"\b(?:is|are|remains?)\s+(?:still\s+)?(?:available|supported|usable|live|working)\b", re.I), "before"),
    (re.compile(r"\blive\s+", re.I), "after"),
    (re.compile(r"\bkeep\s+(?:using\s+|use\s+)", re.I), "after"),
)


def _subject_tokens(side_text: str, max_tokens: int = 3) -> frozenset:
    toks = re.findall(r"[A-Za-z0-9][\w-]*", side_text)
    out = []
    for tok in reversed(toks):
        t = _norm_token(tok)
        if t in STOPWORDS or t in SUBJ_FILLERS or len(t) < 3:
            if out:
                break
            continue
        out.append(t)
        if len(out) >= max_tokens:
            break
    return frozenset(out)


def _subject_after(text: str, max_tokens: int = 3) -> frozenset:
    toks = re.findall(r"[A-Za-z0-9][\w-]*", text)
    out = []
    for tok in toks:
        t = _norm_token(tok)
        if t in STOPWORDS or t in SUBJ_FILLERS or len(t) < 3:
            if out:
                break
            continue
        out.append(t)
        if len(out) >= max_tokens:
            break
    return frozenset(out)


DIRECTIVE_RX = re.compile(
    r"\b(user ruling|ruling|directive|user directed|user decided|user ordered|decision|"
    r"must not|no longer be)\b", re.I)


def _lifecycle_claims(sent: str) -> list[tuple[str, frozenset]]:
    """All subject-anchored claims in one sentence (a sentence may report one
    component live and another retired, e.g. an audit line)."""
    claims = []
    for value, patterns in (("retired", RETIRE_SUBJECT_PATTERNS), ("active", ACTIVE_SUBJECT_PATTERNS)):
        for rx, side in patterns:
            for m in rx.finditer(sent):
                subject = (_subject_tokens(sent[:m.start()]) if side == "before"
                           else _subject_after(sent[m.end():]))
                if subject:
                    claims.append((value, subject))
    # dedupe identical (claim, subject) pairs
    seen, out = set(), []
    for value, subject in claims:
        key = (value, tuple(sorted(subject)))
        if key not in seen:
            seen.add(key)
            out.append((value, subject))
    return out


def _sentences(text: str) -> list[str]:
    return [s.strip() for s in SENT_SPLIT_RX.split(text) if s.strip()]


def units_of(content: str) -> list[str]:
    """Scan granularity: bullets when the entry has them, else whole content.
    (The indexer stores one row per `## ` section; contradictions are best
    judged per bullet inside those sections.)"""
    lines = [ln for ln in content.splitlines() if ln.strip()]
    bullets = [ln for ln in lines if ln.lstrip().startswith("- ")]
    if len(bullets) >= 2:
        return [re.sub(r"^\s*-\s*", "", b).strip() for b in bullets]
    return [content.strip()] if content.strip() else []


def _norm_model_value(matched: str) -> str:
    base = matched.split("/")[-1].lower().strip(".-")
    return base


CORRECTION_BETWEEN_RX = re.compile(
    r"\b(?:instead of|rather than|superseded by|replaced by|replaced with)\b", re.I)



def _correction_pass(sent: str, sfacts: list[Fact]) -> None:
    by_type: dict[str, list[Fact]] = {}
    for f in sfacts:
        if f.ftype in ("model", "endpoint") and f.span:
            by_type.setdefault(f.ftype, []).append(f)
    for fl in by_type.values():
        fl.sort(key=lambda f: f.span[0])
        for i in range(len(fl)):
            for j in range(i + 1, len(fl)):
                a, b = fl[i], fl[j]
                gap = sent[a.span[1]:b.span[0]]
                if CORRECTION_BETWEEN_RX.search(gap):
                    a.negated = True
                    b.negated = False


def extract_facts(entry: Entry) -> list[Fact]:
    facts = []
    for unit in units_of(entry.content):
        for sent_idx, sent in enumerate(_sentences(unit)):
            stoks = frozenset(content_tokens(sent))
            sfacts: list[Fact] = []

            def add(f: Fact) -> None:
                facts.append(f)
                sfacts.append(f)
            # model names
            seen_spans = []
            for rx in (MODEL_RX, PROVIDER_QUALIFIED_RX):
                for m in rx.finditer(sent):
                    if any(m.start() < e and m.end() > s for s, e in seen_spans):
                        continue
                    tail = sent[m.end():]
                    value = _norm_model_value(m.group(0))
                    if not value or value.isdigit():
                        continue
                    if MODEL_FILE_SUFFIX_RX.search(value) or MODEL_FILE_SUFFIX_RX.match(tail):
                        continue  # glm5-launch.sh / glm5-vllm.log are files, not models
                    neg = _negated(sent, m.start(), m.end())
                    add(Fact("model", value, m.group(0), neg, entry.ts, entry, unit, stoks,
                                      sent_idx=sent_idx, span=(m.start(), m.end()), sent_text=sent))
                    seen_spans.append((m.start(), m.end()))
            # endpoints: user@ip / ip:port / localhost:port / SSH aliases / docker hosts
            for m in IP_RX.finditer(sent):
                user, ip, port = m.group(1), m.group(2), m.group(3)
                if ip in ("0.0.0.0", "255.255.255.255"):
                    continue
                octets = ip.split(".")
                if any(int(o) > 255 for o in octets):
                    continue
                display = (f"{user}@{ip}" if user else ip) + (f":{port}" if port else "")
                value = f"{ip}:{port}" if port else ip
                neg = _negated(sent, m.start(), m.end())
                add(Fact("endpoint", value, display, neg, entry.ts, entry, unit, stoks,
                                  sent_idx=sent_idx, span=(m.start(), m.end()), sent_text=sent))
            for m in LOCALHOST_RX.finditer(sent):
                port = m.group(2)
                value = f"localhost:{port}" if port else "localhost"
                neg = _negated(sent, m.start(), m.end())
                add(Fact("endpoint", value, m.group(0), neg, entry.ts, entry, unit, stoks,
                                  sent_idx=sent_idx, span=(m.start(), m.end()), sent_text=sent))
            for m in ALIAS_RX.finditer(sent):
                alias = m.group(1)
                if alias in ("PI_MC_PROFILE", "SSH", "RSI", "MC", "WPS", "PID", "HTTP", "HTTPS",
                             "JSON", "SQL", "SDK", "API", "TODO", "FIXME", "NOTE", "P0", "P1"):
                    continue
                if MODEL_FAMILY_RX.match(alias):
                    continue  # model names are model facts, not endpoint aliases
                if not HOST_CONTEXT_RX.search(sent):
                    continue  # only host/ssh/remote-context sentences yield aliases
                parts = alias.split("-")
                if any(len(p) <= 1 for p in parts):
                    continue  # regex-text noise like A-Za-z0-9
                if MODEL_FILE_SUFFIX_RX.search(sent[m.end():m.end() + 8] or ""):
                    continue  # file names (…-report.md) are not hosts
                before = sent[:m.start()]
                if not (ALIAS_ANCHOR_BEFORE_RX.search(before)
                        or before.rstrip().endswith(("/", "／"))
                        or ALIAS_ANCHOR_AFTER_RX.match(sent[m.end():])):
                    continue  # not adjacent to a host/alias word → label, not a host
                value = alias.lower()
                neg = _negated(sent, m.start(), m.end())
                add(Fact("endpoint", value, alias, neg, entry.ts, entry, unit, stoks,
                                  sent_idx=sent_idx, span=(m.start(), m.end()), sent_text=sent))
            for m in DOCKERHOST_RX.finditer(sent):
                neg = _negated(sent, m.start(), m.end())
                add(Fact("endpoint", m.group(1).lower(), m.group(1), neg,
                                  entry.ts, entry, unit, stoks, sent_idx=sent_idx,
                                  span=(m.start(), m.end()), sent_text=sent))
            _correction_pass(sent, sfacts)
            # lifecycle claims (all subject-anchored claims per sentence)
            if len(stoks) >= 3:
                for value, subject in _lifecycle_claims(sent):
                    add(Fact("lifecycle", value,
                             "retired/removed" if value == "retired" else "active/available",
                             False, entry.ts, entry, unit, stoks, subject, sent_idx, sent_text=sent))
    # drop facts whose unit was credential-screened (defence in depth)
    return [f for f in facts if not credential_flag(f.unit)]


def _same_identity_endpoint(v1: str, v2: str) -> bool:
    """Endpoint value identity: same host = same endpoint; same explicit port
    is treated as the same service seen through different addresses (loopback
    vs public tunnel) — those are aliases, not contradictions."""
    def parts(v):
        host, _, port = v.partition(":")
        host = "127.0.0.1" if host.lower() == "localhost" else host
        return host, port
    h1, p1 = parts(v1)
    h2, p2 = parts(v2)
    if h1 == h2:
        return True
    return bool(p1 and p1 == p2)


def conflict(a: Fact, b: Fact, rare_tokens: dict, compat_pairs=frozenset()) -> bool:
    if a.ftype != b.ftype or a.negated or b.negated:
        return False
    # two endpoints named in ONE sentence are usually two legs/details of the
    # same mapping (tunnel local→remote), not a contradiction
    if a.entry.entry_id == b.entry.entry_id and a.sent_idx == b.sent_idx:
        return False
    if a.ftype == "endpoint":
        if _same_identity_endpoint(a.value, b.value):
            return False
        if frozenset((a.value.partition(":")[0].lower(), b.value.partition(":")[0].lower())) in compat_pairs:
            return False  # values named together anywhere = facets of one setup
        # a loopback listener vs a public host is only a contradiction when BOTH
        # sides talk about tunnels/forwards/port-mapping (otherwise they are
        # different roles: local tunnel vs remote game server)
        loop = ("127.0.0.1", "localhost")
        v1, v2 = a.value.partition(":")[0], b.value.partition(":")[0]
        if (v1 in loop) != (v2 in loop):
            ctx_rx = re.compile(r"\b(tunnel|forward|map|mapped|mapping|port\b)", re.I)
            if not (ctx_rx.search(a.unit) and ctx_rx.search(b.unit)):
                return False
    elif a.value == b.value:
        return False
    generic = {"endpoint": GENERIC_ENDPOINT, "lifecycle": GENERIC_LIFECYCLE}.get(a.ftype, frozenset())
    shared = (a.sent_tokens & b.sent_tokens) - generic
    strong_subject = False
    if a.ftype == "lifecycle":
        # the subject itself must overlap: same component, opposite claims
        subj = a.subject & b.subject
        if not subj:
            return False
        strong_subject = len(subj) >= 2  # two shared subject tokens = same entity
    if len(shared) < 2:
        return False
    if not strong_subject:
        union = a.sent_tokens | b.sent_tokens
        if len(union) and len(shared) / len(union) < 0.10:
            return False
    rare = rare_tokens.get(a.ftype, frozenset())
    if a.ftype == "lifecycle" and strong_subject:
        return True
    return bool(shared & rare)


class _UF:
    def __init__(self):
        self.parent = {}

    def find(self, x):
        self.parent.setdefault(x, x)
        while self.parent[x] != x:
            self.parent[x] = self.parent[self.parent[x]]
            x = self.parent[x]
        return x

    def union(self, a, b):
        ra, rb = self.find(a), self.find(b)
        if ra != rb:
            self.parent[rb] = ra


SUPersede_MARK_RX = re.compile(
    r"\b(supersed\w*|correct\w*|instead|never|no longer|stale|wrong|404s?|retired|removed|"
    r"removing|remove|drop|must not|replace[ds]?|deprecat\w*|fix\w*|revert\w*)\b", re.I)


def build_clusters(facts: list[Fact], today_iso: str = "") -> list[Cluster]:
    by_type: dict[str, list[Fact]] = {}
    for f in facts:
        by_type.setdefault(f.ftype, []).append(f)

    rare_tokens: dict[str, frozenset] = {}
    # lifecycle subjects must be genuinely distinctive (else 'live'/'session'
    # sentences chain into one giant cluster); model/endpoint values carry
    # enough signal for the looser threshold
    rare_frac = {"lifecycle": 0.05, "model": 0.25, "endpoint": 0.25}
    for ftype, fl in by_type.items():
        n = len(fl)
        df: dict[str, int] = {}
        # df over unique sentence units: a sentence yielding several facts
        # (e.g. a positive and a negated model mention) must count once
        seen_units: set = set()
        for f in fl:
            unit_key = (f.entry.entry_id, f.sent_tokens)
            if unit_key in seen_units:
                continue
            seen_units.add(unit_key)
            for t in f.sent_tokens:
                df[t] = df.get(t, 0) + 1
        threshold = max(2, int(rare_frac.get(ftype, 0.25) * n))
        rare_tokens[ftype] = frozenset(t for t, c in df.items() if c <= threshold)

    # endpoint values that co-occur in one sentence anywhere (server inventories,
    # tunnel mappings) are compatible facets, never contradicting values;
    # co-occurrence is keyed by host identity so port variants still count
    def ep_key(v: str) -> str:
        return v.partition(":")[0].lower()

    compat_pairs = set()
    sent_groups: dict = {}
    for f in by_type.get("endpoint", []):
        sent_groups.setdefault((f.entry.entry_id, f.unit, f.sent_idx), []).append(ep_key(f.value))
    for vals in sent_groups.values():
        uniq = sorted(set(vals))
        for i in range(len(uniq)):
            for j in range(i + 1, len(uniq)):
                compat_pairs.add(frozenset((uniq[i], uniq[j])))

    uf = _UF()
    for ftype, fl in by_type.items():
        inverted: dict[str, list[int]] = {}
        for i, f in enumerate(fl):
            for t in f.sent_tokens & rare_tokens[ftype]:
                inverted.setdefault(t, []).append(i)
        # lifecycle pairs may share only their (non-rare) subject tokens —
        # index subjects too so those pairs get tested
        subj_index: dict[str, list[int]] = {}
        if ftype == "lifecycle":
            for i, f in enumerate(fl):
                for t in f.subject:
                    subj_index.setdefault(t, []).append(i)
        for i, f in enumerate(fl):
            candidates = set()
            for t in f.sent_tokens & rare_tokens[ftype]:
                candidates.update(inverted.get(t, ()))
            for t in f.subject:
                candidates.update(subj_index.get(t, ()))
            for j in candidates:
                if j <= i:
                    continue
                g = fl[j]
                if conflict(f, g, rare_tokens, compat_pairs):
                    uf.union(id(f), id(g))

    groups: dict[int, list[Fact]] = {}
    for ftype, fl in by_type.items():
        for f in fl:
            groups.setdefault(uf.find(id(f)), []).append(f)

    clusters = []
    for members in groups.values():
        if len(members) < 2:
            continue
        ftype = members[0].ftype
        positive = [f for f in members if not f.negated]
        if not positive:
            continue
        values: dict[str, list[Fact]] = {}
        for f in positive:
            values.setdefault(f.value, []).append(f)
        if len(values) < 2:
            continue
        group_map = {v: v for v in values}
        if ftype == "endpoint":
            # merge value groups that are the same identity (host or same-port
            # alias) so 'ip' and 'ip:port' land in one stale group
            uf_val = _UF()
            vlist = list(values)
            for i in range(len(vlist)):
                for j in range(i + 1, len(vlist)):
                    if _same_identity_endpoint(vlist[i], vlist[j]):
                        uf_val.union(vlist[i], vlist[j])
            merged: dict[str, list[Fact]] = {}
            for v, fs in values.items():
                root = uf_val.find(v)
                group_map[v] = root
                merged.setdefault(root, [])
                merged[root].extend(fs)
            values = merged
        # newest positive fact decides the current value (newest wins; on an
        # equal-ts tie the durable KB row is preferred over a session observation).
        # lifecycle exception: an explicit directive ("user ruling: remove X")
        # outranks a later merely descriptive claim about the same subject
        if ftype == "lifecycle":
            directive = [f for f in positive if DIRECTIVE_RX.search(f.sent_text)]
            pool = directive if directive else positive
            newest = max(pool, key=lambda f: (f.ts, f.entry.kind in ("daily", "concept")))
        else:
            newest = max(positive, key=lambda f: (f.ts, f.entry.kind in ("daily", "concept")))
        current_value = group_map[newest.value]
        current_facts = values[current_value]
        stale = [{"value": v, "facts": fs} for v, fs in sorted(values.items())
                 if v != current_value]
        all_tokens = {}
        for f in members:
            generic = {"endpoint": GENERIC_ENDPOINT, "lifecycle": GENERIC_LIFECYCLE}.get(ftype, frozenset())
            for t in f.sent_tokens - generic:
                all_tokens[t] = all_tokens.get(t, 0) + 1
        shared_across = [t for t, c in all_tokens.items() if c >= 2]
        shared_across.sort(key=lambda t: (-all_tokens[t], t))
        entity_label = "+".join(shared_across[:4]) or ftype

        newest_ts = max(f.ts for f in positive)
        stale_facts = [f for side in stale for f in side["facts"]]
        stale_newest_ts = max((f.ts for f in stale_facts), default="")
        has_explicit = any(SUPersede_MARK_RX.search(f.sent_text) for f in current_facts)
        kb_correction = any(f.entry.kind in ("daily", "concept") for f in current_facts)
        stale_has_obs = any(f.entry.kind == "observation" for f in stale_facts)

        score = 10
        if has_explicit:
            score += 25
        if stale_has_obs:
            score += 20
        if kb_correction:
            score += 15
        score += min(20, 4 * len(stale_facts))
        if stale_newest_ts and newest_ts and newest_ts[:10] != stale_newest_ts[:10]:
            try:
                d_new = _dt.date.fromisoformat(newest_ts[:10])
                d_old = _dt.date.fromisoformat(stale_newest_ts[:10])
                if 0 <= (d_new - d_old).days <= 3:
                    score += 5
            except ValueError:
                pass
        score = min(100, score)
        tier = "high" if score >= 65 else ("medium" if score >= 40 else "low")

        # conservative write gate: only clusters where the newest side itself
        # carries a correction signal (or a high-severity newest-wins) propose a
        # corrective entry; everything else is review-manual
        apply_needed = (not kb_correction) and (
            tier == "high" or (tier == "medium" and has_explicit))
        h = hashlib.md5()
        h.update(ftype.encode())
        h.update(entity_label.encode())
        h.update(current_value.encode())
        h.update(",".join(sorted(side["value"] for side in stale)).encode())
        cid = h.hexdigest()[:12]

        clusters.append(Cluster(cid, ftype, entity_label, current_value,
                                current_facts, stale, score, tier,
                                has_explicit, kb_correction, apply_needed))
    clusters.sort(key=lambda c: (-c.score, c.ftype, c.cid))
    return clusters


# --------------------------------------------------------------------------
# Reporting
# --------------------------------------------------------------------------

def _excerpt(text: str, limit: int = 220) -> str:
    text = " ".join(text.split())
    return text if len(text) <= limit else text[: limit - 1] + "…"


def _src(f: Fact) -> Source:
    return Source(f.entry.entry_id, f.entry.kind, f.ts, _excerpt(f.unit),
                  f.entry.source_path, f.entry.session_id)


def cluster_payload(c: Cluster) -> dict:
    def fact_srcs(fs):
        seen, out = set(), []
        for f in sorted(fs, key=lambda x: x.ts, reverse=True):
            if f.entry.entry_id in seen:
                continue
            seen.add(f.entry.entry_id)
            s = _src(f)
            out.append({"obs_id": s.obs_id, "kind": s.kind, "ts": s.ts,
                        "excerpt": s.excerpt, "source_path": s.source_path,
                        "session_id": s.session_id})
        return out

    newest_current = max(c.current_facts, key=lambda f: (f.ts, f.entry.kind in ("daily", "concept")))
    return {
        "id": c.cid,
        "type": c.ftype,
        "entity_label": c.entity_label,
        "severity": {"tier": c.tier, "score": c.score},
        "current": {"value": c.current_value, "newest_ts": newest_current.ts,
                    "sources": fact_srcs(c.current_facts)},
        "stale": [{"value": side["value"],
                   "first_ts": min(f.ts for f in side["facts"]),
                   "last_ts": max(f.ts for f in side["facts"]),
                   "count": len(side["facts"]),
                   "sources": fact_srcs(side["facts"])} for side in c.stale],
        "has_explicit_correction": c.has_explicit_correction,
        "kb_correction_present": c.kb_correction_present,
        "apply_needed": c.apply_needed,
        "recommended_entry": {
            "ts": newest_current.ts, "kind": newest_current.entry.kind,
            "source": newest_current.entry.source_label,
            "excerpt": _excerpt(newest_current.unit),
        },
        "note": c.note,
    }


def build_report(clusters: list[Cluster], meta: dict, top: int) -> str:
    lines = []
    lines.append(f"# Memory Doctor — contradiction sweep {meta['generated_at']}")
    lines.append("")
    lines.append(f"- db: `{meta['db_path']}` (read-only, {meta['entries_scanned']} entries)")
    lines.append(f"- kb: `{meta['kb_root']}` (direct-md additions: {meta.get('kb_md_added', 0)})")
    lines.append(f"- facts extracted: {meta['facts_extracted']}; clusters found: "
                 f"{meta['total_clusters']} (showing top {min(top, meta['total_clusters'])})")
    tiers = {"high": 0, "medium": 0, "low": 0}
    for c in clusters:
        tiers[c.tier] += 1
    lines.append(f"- severity: {tiers['high']} high / {tiers['medium']} medium / {tiers['low']} low; "
                 f"{sum(1 for c in clusters if c.apply_needed)} would need a corrective entry via --apply")
    lines.append("")
    if not clusters:
        lines.append("No contradiction clusters found.")
        return "\n".join(lines) + "\n"
    for i, c in enumerate(clusters[:top], 1):
        payload = cluster_payload(c)
        lines.append(f"## {i}. [{c.tier.upper()}] {c.ftype}: {c.entity_label} "
                     f"(score {c.score}, id {c.cid})")
        cur = payload["current"]
        lines.append(f"- CURRENT (newest wins): `{c.current_value}` "
                     f"— newest {cur['newest_ts'][:10]} via {cur['sources'][0]['kind']}")
        stale_sorted = sorted(payload["stale"], key=lambda s: (-s["count"], s["value"]))
        major = [s for s in stale_sorted if s["count"] > 1]
        minor = [s for s in stale_sorted if s["count"] == 1]
        for side in major[:10]:
            lines.append(f"- STALE: `{side['value']}` — {side['count']} entries, "
                         f"{side['first_ts'][:10]} → {side['last_ts'][:10]}")
        if minor:
            names = ", ".join(f"`{s['value']}`" for s in minor[:15])
            more = f" … (+{len(minor) - 15} more)" if len(minor) > 15 else ""
            lines.append(f"- STALE (1 entry each): {names}{more}")
        lines.append("- sources:")
        shown = 0
        for side in payload["stale"]:
            for s in side["sources"]:
                if shown >= 6:
                    break
                lines.append(f"    - [{s['ts'][:10]} {s['kind']}] ({s['obs_id']}) "
                             f"\"{s['excerpt']}\"")
                shown += 1
        for s in cur["sources"][:2]:
            lines.append(f"    - [{s['ts'][:10]} {s['kind']}] ({s['obs_id']}) "
                         f"\"{s['excerpt']}\"  ← current")
        status = ("already superseded in KB (no write needed)" if c.kb_correction_present
                  else ("corrective entry recommended (run --apply)" if c.apply_needed
                        else "review manually"))
        rec = payload["recommended_entry"]
        lines.append(f"- supersession: {status}")
        lines.append(f"- recommended entry: [{rec['ts'][:10]} {rec['kind']}] "
                     f"{rec['source']} — \"{rec['excerpt']}\"")
        lines.append("")
    return "\n".join(lines) + "\n"


# --------------------------------------------------------------------------
# Supersede write path (--apply): append corrective entries to today's daily
# --------------------------------------------------------------------------

def _local_now():
    return _dt.datetime.now().astimezone()


def corrective_line(c: Cluster, now: _dt.datetime, db_path: str) -> str:
    stale_vals = ", ".join(f"`{side['value']}`" for side in c.stale)
    stale_dates = min(f.ts[:10] for side in c.stale for f in side["facts"])
    n_stale = sum(len(side["facts"]) for side in c.stale)
    if c.ftype == "lifecycle":
        claim = "retired/removed — do not use it anymore" \
            if c.current_value == "retired" else "active/available again"
        old_claim = "active/available" if c.current_value == "retired" else "retired/removed"
        body = (f"{c.entity_label} — current status is {claim}; earlier records treating it "
                f"as {old_claim} ({stale_vals}) are stale and must not be propagated")
    else:
        body = (f"{c.entity_label} — current value is `{c.current_value}`; earlier records "
                f"naming {stale_vals} are stale and must not be propagated")
    return (f"- {now:%Y-%m-%d %H:%M} — Memory-doctor correction (supersedes the "
            f"{stale_dates} entries): {body} into worker contexts. Source: "
            f"tools/memory_doctor.py sweep {now:%Y-%m-%d} of {db_path} "
            f"(cluster {c.cid}, {n_stale} stale entries).")


def append_corrections(kb_root: str, clusters: list[Cluster], db_path: str,
                       confirm: bool, min_severity: str = "medium",
                       now: _dt.datetime | None = None) -> list[dict]:
    """Append dated corrective entries for confirmed clusters. Opt-in (--apply
    plus --yes for non-interactive use). Never edits/deletes history; skips
    clusters already superseded by a KB entry and clusters already corrected
    in today's file (idempotent)."""
    now = now or _local_now()
    if not confirm:
        return []
    daily_dir = os.path.join(kb_root, "daily")
    os.makedirs(daily_dir, exist_ok=True)
    today_path = os.path.join(daily_dir, f"{now:%Y-%m-%d}.md")
    existing = ""
    if os.path.exists(today_path):
        existing = open(today_path, encoding="utf-8").read()
    written = []
    for c in clusters:
        if not c.apply_needed or SEVERITY_ORDER[c.tier] < SEVERITY_ORDER[min_severity]:
            continue
        line = corrective_line(c, now, db_path)
        # idempotency: same cluster id or same stale value already corrected today
        if c.cid in existing or all(f"`{side['value']}`" in existing for side in c.stale):
            continue
        with open(today_path, "a", encoding="utf-8") as fh:
            if existing and not existing.endswith("\n"):
                fh.write("\n")
            fh.write(line + "\n")
        existing += line + "\n"
        written.append({"cluster": c.cid, "file": today_path, "line": line})
    return written


# --------------------------------------------------------------------------
# CLI
# --------------------------------------------------------------------------

def run_scan(db_path: str, kb_root: str, include_kb_md: bool = True):
    entries = load_db(db_path)
    known = None
    kb_md_added = 0
    if include_kb_md and kb_root and os.path.isdir(kb_root):
        known = db_known_keys(db_path)
        md_entries = load_kb_md(kb_root, known_keys=known)
        kb_md_added = len(md_entries)
        # a direct-md entry sharing an obs_id with a db row is a FRESHER copy
        # (e.g. today's correction appended after the last index refresh) —
        # the md version wins
        by_id = {e.entry_id: e for e in entries}
        for e in md_entries:
            by_id[e.entry_id] = e
        entries = list(by_id.values())
    facts = []
    for e in entries:
        facts.extend(extract_facts(e))
    clusters = build_clusters(facts)
    return entries, facts, clusters, kb_md_added


def main(argv=None) -> int:
    ap = argparse.ArgumentParser(description="Memory contradiction sweeper (v1, db read-only)")
    ap.add_argument("--db", default=DEFAULT_DB, help="memory index.db (opened read-only)")
    ap.add_argument("--kb", default=DEFAULT_KB, help="knowledge-base root")
    ap.add_argument("--top", type=int, default=10, help="clusters shown in the report")
    ap.add_argument("--min-severity", choices=list(SEVERITY_ORDER), default="low",
                    help="minimum severity to include in output")
    ap.add_argument("--json", dest="json_path", help="write machine-readable JSON here")
    ap.add_argument("--report", dest="report_path", help="write the human report here (default: stdout)")
    ap.add_argument("--no-kb-md", action="store_true", help="skip direct KB markdown loading")
    ap.add_argument("--apply", action="store_true",
                    help="append corrective entries for confirmed clusters (opt-in write path)")
    ap.add_argument("--yes", action="store_true",
                    help="confirm the --apply write (required non-interactively)")
    args = ap.parse_args(argv)

    entries, facts, clusters, kb_md_added = run_scan(
        args.db, args.kb, include_kb_md=not args.no_kb_md)
    min_rank = SEVERITY_ORDER[args.min_severity]
    clusters = [c for c in clusters if SEVERITY_ORDER[c.tier] >= min_rank]

    meta = {
        "generated_at": _local_now().strftime("%Y-%m-%dT%H:%M:%S%z"),
        "db_path": os.path.abspath(args.db),
        "kb_root": os.path.abspath(args.kb) if args.kb else "",
        "entries_scanned": len(entries),
        "facts_extracted": len(facts),
        "total_clusters": len(clusters),
        "kb_md_added": kb_md_added,
    }

    report = build_report(clusters, meta, args.top)
    if args.report_path:
        with open(args.report_path, "w", encoding="utf-8") as fh:
            fh.write(report)
    else:
        sys.stdout.write(report)

    if args.json_path:
        payload = dict(meta)
        payload["clusters"] = [cluster_payload(c) for c in clusters]
        with open(args.json_path, "w", encoding="utf-8") as fh:
            json.dump(payload, fh, ensure_ascii=False, indent=2)
            fh.write("\n")

    if args.apply:
        if not args.yes:
            print("--apply requires --yes as explicit confirmation; "
                  "nothing was written.", file=sys.stderr)
            return 1
        written = append_corrections(args.kb, clusters, os.path.abspath(args.db),
                                     confirm=True, min_severity="medium")
        if written:
            print(f"Appended {len(written)} corrective entr"
                  f"{'y' if len(written) == 1 else 'ies'}:")
            for w in written:
                print(f"  -> {w['file']} (cluster {w['cluster']})")
        else:
            print("No corrective entries needed: all confirmed clusters are already "
                  "superseded by KB entries (or below the severity gate).")
    return 0


if __name__ == "__main__":
    sys.exit(main())
