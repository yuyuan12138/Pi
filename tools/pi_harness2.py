#!/usr/bin/env python3
"""pi-harness2 v0 — observe-mode Harness² loop for the Pi agent's own harness.

Implements a Propose–Probe–Compose loop (arXiv 2610.14224, "Harness²") over the
Pi agent's skill-routing layer, in strict observe mode:

  inventory   scan skill roots (frontmatter name/description + body size) and
              read-only lists of AGENTS.md files, MCP servers, KB concepts.
  run         find route-confusable skill pairs (token Jaccard + shared salient
              stems + shared trigger terms) -> propose Skill++-style rewritten
              descriptions (model-assisted, validated) -> probe routing with
              synthetic queries (current vs proposed correct-pick rate) ->
              compose a Markdown report + proposals JSON + one journal line.
  apply       GATED apply of a proposals file: explicit flag, mtime drift
              check, BEFORE-content check, .bak backup, printed diff, and a
              second --yes confirmation. Never run automatically.

Observe mode guarantee: `run` and `inventory` never write any harness file.
The only files they create live under the output dir (default ./harness2/):
report-<ts>.md, proposals-<ts>.json, journal.jsonl (append-only run memory).

Probe endpoint: OpenAI-compatible chat completions (default
http://127.0.0.1:18002/v1, model GLM-5.3-Flash). temperature=0; reasoning
models that spend the budget on reasoning_content get ONE retry with
max_tokens=6000 when content is empty and finish_reason=="length".
reasoning_content is NEVER treated as the answer.

Stdlib only. No daemons, no background work, no auto-apply.
"""

from __future__ import annotations

import argparse
import difflib
import hashlib
import json
import os
import random
import re
import shutil
import sys
import threading
import time
import urllib.error
import urllib.request
from concurrent.futures import ThreadPoolExecutor
from dataclasses import dataclass, field
from datetime import datetime, timezone
from pathlib import Path

REPO_ROOT = Path(__file__).resolve().parent.parent
DEFAULT_OUT_DIR = REPO_ROOT / "harness2"
HOME = Path.home()
PI_AGENT_DIR = HOME / ".pi" / "agent"

DEFAULT_BASE_URL = "http://127.0.0.1:18002/v1"
DEFAULT_MODEL = "GLM-5.3-Flash"
DEFAULT_K = 4
DEFAULT_CAP = 120
DEFAULT_THRESHOLD = 0.30
MAX_TOKENS = 4000
RETRY_TOKENS = 6000
CALL_TIMEOUT = 60
CONCURRENCY = 2
DESC_MAX_CHARS = 200
BODY_EXCERPT_CHARS = 2500

DEFAULT_SKILL_ROOTS = [
    PI_AGENT_DIR / "skills",
    REPO_ROOT / ".pi" / "skills",
    PI_AGENT_DIR
    / "npm"
    / "node_modules"
    / "@llblab"
    / "pi-telegram"
    / "dist"
    / "skills",
]

# ---------------------------------------------------------------------------
# Text utilities (frontmatter, tokenization, similarity)
# ---------------------------------------------------------------------------

STOPWORDS = {
    "a", "an", "the", "for", "and", "or", "to", "of", "in", "on", "with",
    "when", "use", "uses", "used", "using", "by", "is", "are", "be", "been",
    "it", "its", "this", "that", "as", "at", "from", "into", "via", "if",
    "then", "than", "so", "such", "not", "no", "nor", "but", "while", "also",
    "more", "most", "only", "per", "every", "their", "them", "they", "your",
    "you", "our", "we", "his", "her", "she", "he", "will", "can", "may",
    "should", "would", "must", "do", "does", "did", "done", "has", "have",
    "had", "was", "were", "what", "which", "who", "whom", "how", "why",
    "all", "any", "each", "other", "some", "own", "same", "s", "t",
}

# Generic routing-trigger vocabulary: terms whose appearance in two skill
# descriptions plausibly makes a name+description router confuse them.
TRIGGER_TERMS = {
    "button", "telegram", "voice", "message", "html", "markdown", "diagram",
    "app", "surface", "render", "deliver", "show", "explain", "artifact",
    "control", "security", "audit", "checkpoint", "sheet", "spreadsheet",
    "deploy", "episode", "world", "model", "server", "report", "review",
}

WEIGHT_SALIENT = 0.10
WEIGHT_TRIGGER = 0.15
SALIENT_AUTO_FLAG = 4  # >= this many shared salient stems flags regardless of score


def _stem(token: str) -> str:
    if token.endswith("ies") and len(token) > 4:
        return token[:-3] + "y"
    for suffix in ("ing", "ed", "es", "s"):
        if len(token) > 4 and token.endswith(suffix):
            return token[: -len(suffix)]
    return token


def tokenize(text: str) -> set:
    words = re.findall(r"[a-z0-9]+", text.lower())
    return {_stem(w) for w in words if w not in STOPWORDS and len(w) > 2}


def _unquote(value: str) -> str:
    value = value.strip()
    if len(value) >= 2 and value[0] == value[-1] and value[0] in "\"'":
        inner = value[1:-1]
        if value[0] == '"':
            inner = inner.replace('\\"', '"').replace("\\n", "\n").replace("\\\\", "\\")
        return inner
    return value


def parse_frontmatter(text: str) -> dict:
    """Minimal stdlib YAML-frontmatter parser for scalar keys.

    Supports: single-line scalars, quoted scalars, block scalars (>, |), and
    indented plain multiline continuation (folded with spaces). List items
    ("- x") under a key are collected into a list. Best effort by design.
    """
    lines = text.splitlines()
    if not lines or lines[0].strip() != "---":
        return {}
    meta: dict = {}
    key = None
    i = 1
    while i < len(lines):
        line = lines[i]
        if line.strip() == "---":
            break
        if line[:1] in (" ", "\t"):
            if key is None:
                i += 1
                continue
            stripped = line.strip()
            if stripped.startswith("- "):
                if not isinstance(meta.get(key), list):
                    meta[key] = []
                meta[key].append(_unquote(stripped[2:]))
            elif meta.get(key):
                prev = meta[key]
                if isinstance(prev, str):
                    meta[key] = (prev + " " + stripped).strip()
            i += 1
            continue
        m = re.match(r"^([A-Za-z0-9_.-]+)\s*:\s*(.*)$", line)
        if not m:
            key = None
            i += 1
            continue
        key, val = m.group(1), m.group(2).strip()
        if val in (">", "|", ">-", "|-", ">+", "|+"):
            block = []
            i += 1
            while i < len(lines) and (lines[i][:1] in (" ", "\t") or lines[i].strip() == ""):
                if lines[i].strip():
                    block.append(lines[i].strip())
                i += 1
            meta[key] = " ".join(block)
            continue
        if val == "":
            meta[key] = ""
            i += 1
            continue
        meta[key] = _unquote(val)
        i += 1
    return meta


@dataclass
class Skill:
    name: str
    description: str
    path: str
    root: str
    body_chars: int
    mtime: float
    tokens: set = field(default_factory=set)

    @property
    def body_excerpt(self) -> str:
        text = Path(self.path).read_text(encoding="utf-8", errors="replace")
        fm_end = text.find("\n---", 3)
        body = text[fm_end + 4:] if fm_end != -1 else text
        body = body.strip()
        if len(body) > BODY_EXCERPT_CHARS:
            return body[:BODY_EXCERPT_CHARS] + "\n[... body truncated ...]"
        return body


def discover_skills(roots) -> list:
    skills: dict = {}
    for root in roots:
        rootp = Path(root).expanduser()
        if not rootp.is_dir():
            continue
        for skill_md in sorted(rootp.glob("*/SKILL.md")):
            try:
                text = skill_md.read_text(encoding="utf-8", errors="replace")
            except OSError:
                continue
            meta = parse_frontmatter(text)
            name = str(meta.get("name") or skill_md.parent.name)
            desc = str(meta.get("description") or "")
            rp = str(skill_md.resolve())
            if rp in skills:
                continue
            st = skill_md.stat()
            skills[rp] = Skill(
                name=name,
                description=desc,
                path=rp,
                root=str(rootp),
                body_chars=len(text),
                mtime=st.st_mtime,
                tokens=tokenize(name + " " + desc),
            )
    return sorted(skills.values(), key=lambda s: s.name)


# ---------------------------------------------------------------------------
# Confusable-pair detection
# ---------------------------------------------------------------------------


def corpus_df(skills: list) -> dict:
    df: dict = {}
    for s in skills:
        for t in s.tokens:
            df[t] = df.get(t, 0) + 1
    return df


def pair_signals(a: Skill, b: Skill, df: dict, threshold: float,
                 n_docs: int = None) -> dict:
    shared = a.tokens & b.tokens
    union = a.tokens | b.tokens
    jac = len(shared) / len(union) if union else 0.0
    n = n_docs if n_docs is not None else max(len(df), 1)
    salient = sorted(t for t in shared if df.get(t, 0) < n)
    triggers = sorted(t for t in shared if t in TRIGGER_TERMS)
    score = jac + WEIGHT_SALIENT * min(len(salient), 6) + WEIGHT_TRIGGER * min(len(triggers), 4)
    flagged = score >= threshold or len(salient) >= SALIENT_AUTO_FLAG
    return {
        "jaccard": round(jac, 4),
        "salient": salient,
        "triggers": triggers,
        "score": round(score, 4),
        "threshold": threshold,
        "confusable": flagged,
    }


def find_confusable(skills: list, threshold: float) -> list:
    df = corpus_df(skills)
    n_docs = max(len(skills), 1)
    pairs = []
    for i in range(len(skills)):
        for j in range(i + 1, len(skills)):
            sig = pair_signals(skills[i], skills[j], df, threshold, n_docs)
            if sig["confusable"]:
                pairs.append((skills[i], skills[j], sig))
    pairs.sort(key=lambda p: -p[2]["score"])
    return pairs


# ---------------------------------------------------------------------------
# Probe model client (OpenAI-compatible, urllib, budget + concurrency caps)
# ---------------------------------------------------------------------------


class BudgetExhausted(Exception):
    pass


class ProbeClient:
    """OpenAI-compatible chat client with a global call cap and latency log."""

    def __init__(self, base_url: str, model: str, api_key: str = None,
                 cap: int = DEFAULT_CAP, timeout: int = CALL_TIMEOUT):
        self.base_url = base_url.rstrip("/")
        self.model = model
        self.api_key = api_key
        self.cap = cap
        self.timeout = timeout
        self.calls = 0
        self.tokens = 0
        self.latencies = []
        self._lock = threading.Lock()

    def _acquire(self) -> None:
        with self._lock:
            if self.calls >= self.cap:
                raise BudgetExhausted(f"call cap {self.cap} reached")
            self.calls += 1

    def _record(self, usage: dict, latency: float) -> None:
        with self._lock:
            self.tokens += int((usage or {}).get("total_tokens") or 0)
            self.latencies.append(latency)

    def verify(self) -> tuple:
        """GET /models to confirm the endpoint is reachable. (bool, detail)"""
        try:
            req = urllib.request.Request(
                self.base_url + "/models",
                headers={"Authorization": f"Bearer {self.api_key}"} if self.api_key else {},
            )
            with urllib.request.urlopen(req, timeout=10) as resp:
                data = json.loads(resp.read().decode("utf-8"))
            ids = [m.get("id") for m in data.get("data", [])]
            return True, ids
        except Exception as exc:  # noqa: BLE001 — any failure means "down"
            return False, f"{type(exc).__name__}: {exc}"

    def _post(self, messages: list, max_tokens: int) -> dict:
        payload = {
            "model": self.model,
            "messages": messages,
            "temperature": 0,
            "max_tokens": max_tokens,
        }
        body = json.dumps(payload).encode("utf-8")
        headers = {"Content-Type": "application/json"}
        if self.api_key:
            headers["Authorization"] = f"Bearer {self.api_key}"
        req = urllib.request.Request(
            self.base_url + "/chat/completions", data=body, headers=headers, method="POST"
        )
        start = time.monotonic()
        try:
            with urllib.request.urlopen(req, timeout=self.timeout) as resp:
                data = json.loads(resp.read().decode("utf-8"))
        except urllib.error.HTTPError as exc:
            detail = ""
            try:
                detail = exc.read().decode("utf-8", errors="replace")[:300]
            except Exception:  # noqa: BLE001
                pass
            return {"ok": False, "error": f"HTTP {exc.code}: {detail}",
                    "latency": time.monotonic() - start}
        except Exception as exc:  # noqa: BLE001
            return {"ok": False, "error": f"{type(exc).__name__}: {exc}",
                    "latency": time.monotonic() - start}
        latency = time.monotonic() - start
        self._record(data.get("usage"), latency)
        choices = data.get("choices") or []
        if not choices:
            return {"ok": False, "error": "response has no choices", "latency": latency}
        msg = choices[0].get("message") or {}
        # NOTE: reasoning_content is deliberately ignored — never the answer.
        content = msg.get("content")
        if not isinstance(content, str):
            content = ""
        return {
            "ok": True,
            "content": content,
            "finish_reason": choices[0].get("finish_reason"),
            "usage": data.get("usage") or {},
            "latency": latency,
            "reasoning_chars": len(msg.get("reasoning_content") or "")
            if isinstance(msg.get("reasoning_content"), str) else 0,
        }

    def chat(self, messages: list, max_tokens: int = MAX_TOKENS,
             purpose: str = "misc") -> dict:
        """One logical completion. Length-truncated empty content retries ONCE
        with a larger budget (reasoning models burn tokens before answering)."""
        try:
            self._acquire()
        except BudgetExhausted as exc:
            return {"ok": False, "error": f"budget_exhausted: {exc}",
                    "latency": 0.0, "purpose": purpose}
        result = self._post(messages, max_tokens)
        if (
            result.get("ok")
            and result.get("content", "") == ""
            and result.get("finish_reason") == "length"
        ):
            try:
                self._acquire()
            except BudgetExhausted as exc:
                result["error"] = f"budget_exhausted on retry: {exc}"
                result["purpose"] = purpose
                return result
            result = self._post(messages, RETRY_TOKENS)
            result["retried"] = True
        result["purpose"] = purpose
        return result


# ---------------------------------------------------------------------------
# Strict output parsers
# ---------------------------------------------------------------------------


def parse_probe_answer(content: str, candidates: list) -> dict:
    """Parse `SKILL: <name>` strictly. Returns {"pick": name|None, "reason": str}.

    Exactly one distinct candidate name across SKILL lines -> pick.
    Missing, zero matches, or both candidates matched -> miss (never crash).
    reasoning_content never reaches this function.
    """
    picks = []
    saw_line = False
    for line in (content or "").splitlines():
        stripped = line.strip()
        if not stripped.upper().startswith("SKILL:"):
            continue
        saw_line = True
        val = stripped.split(":", 1)[1].strip().strip("*`_\"'").strip()
        if not val:
            continue
        matched = [c for c in candidates if c in val]
        distinct = sorted(set(matched))
        if len(distinct) == 1:
            picks.append(distinct[0])
        elif len(distinct) > 1:
            return {"pick": None, "reason": f"ambiguous SKILL line: {val[:80]}"}
        else:
            return {"pick": None, "reason": f"unknown skill in SKILL line: {val[:80]}"}
    if not saw_line:
        return {"pick": None, "reason": "no SKILL: line in response"}
    if len(set(picks)) == 1:
        return {"pick": picks[0], "reason": "ok"}
    return {"pick": None, "reason": "no single unambiguous SKILL line"}


def parse_queries(content: str, k: int) -> list:
    """Parse `TARGET=<A|B> QUERY=<text>` lines (tolerating code fences)."""
    text = _strip_fences(content or "")
    queries = []
    seen = set()
    for line in text.splitlines():
        m = re.match(r"^\s*TARGET\s*=\s*([ABab])\s*QUERY\s*=\s*(.+?)\s*$", line)
        if not m:
            continue
        q = m.group(2).strip()
        if not q or q.lower() in seen:
            continue
        seen.add(q.lower())
        queries.append({"target": m.group(1).upper(), "text": q})
        if len(queries) >= k:
            break
    return queries


def _strip_fences(text: str) -> str:
    if "```" not in text:
        return text
    lines = text.splitlines()
    return "\n".join(l for l in lines if not l.strip().startswith("```"))


def validate_proposal_line(raw: str) -> tuple:
    """Validate a model-produced replacement description.

    Accepts exactly one `description: <content>` line (plus at most one
    `rationale:` line). Content must be non-empty, <= DESC_MAX_CHARS,
    newline-free, and free of control characters.
    Returns (ok, content, rationale, reason).
    """
    text = _strip_fences(raw or "")
    lines = [l.rstrip() for l in text.splitlines() if l.strip()]
    desc_lines = [l for l in lines if l.strip().lower().startswith("description:")]
    rationale_lines = [l for l in lines if l.strip().lower().startswith("rationale:")]
    other = [l for l in lines
             if l not in desc_lines and l not in rationale_lines]
    if len(desc_lines) != 1:
        return False, None, None, f"expected exactly one description: line, got {len(desc_lines)}"
    if other:
        return False, None, None, f"unexpected extra output lines: {other[0][:60]!r}"
    rationale = ""
    if rationale_lines:
        rationale = rationale_lines[0].split(":", 1)[1].strip()
        if len(rationale) > 400:
            rationale = rationale[:400]
    content = desc_lines[0].split(":", 1)[1].strip()
    if content and content[0] in "\"'" and content[-1:] == content[0] and len(content) >= 2:
        content = _unquote(content)
    if not content.strip():
        return False, None, None, "empty description content"
    if "\n" in content or "\r" in content:
        return False, None, None, "newline in description content"
    if any(ord(c) < 32 for c in content):
        return False, None, None, "control character in description content"
    if len(content) > DESC_MAX_CHARS:
        return False, None, None, f"description longer than {DESC_MAX_CHARS} chars ({len(content)})"
    if content.strip() in ("---", '"""', "'''"):
        return False, None, None, "description content is a YAML delimiter"
    return True, content, rationale, "ok"


# ---------------------------------------------------------------------------
# Prompt builders
# ---------------------------------------------------------------------------

CONTEXT_HINTS = [
    "a code review discussion",
    "a weekly status update",
    "a debugging session",
    "an onboarding document",
    "a release checklist",
    "a data cleanup task",
    "a customer support reply",
    "a design review",
    "a retrospective meeting",
    "a local configuration tweak",
    "a mobile messaging thread",
    "an incident postmortem",
]


def query_seed(a: str, b: str, k: int) -> random.Random:
    digest = hashlib.sha256(f"{a}|{b}|k={k}".encode("utf-8")).hexdigest()
    return random.Random(int(digest[:8], 16))


def build_query_prompt(a: Skill, b: Skill, k: int) -> str:
    rng = query_seed(a.name, b.name, k)
    hints = rng.sample(CONTEXT_HINTS, 2)
    return (
        "You generate probe data for a skill-routing benchmark.\n"
        "A router will see ONLY each skill's name + description and must pick one skill per user task.\n"
        f"Skill A = {a.name}: {a.description}\n"
        f"Skill B = {b.name}: {b.description}\n"
        f"Ground the tasks in everyday engineering contexts such as: {hints[0]}; {hints[1]}.\n\n"
        f"Write exactly {k} short realistic user task messages (one sentence each): "
        f"{max(k // 2, 1)} whose correct skill is A, and {k - max(k // 2, 1)} whose correct skill is B. "
        "Phrase each task so the NEIGHBOR skill's vocabulary appears plausibly (surface ambiguity), "
        "but exactly one skill is actually the right one to load.\n"
        "Output STRICTLY, one per line, no numbering, no markdown:\n"
        "TARGET=A QUERY=<one sentence>\n"
        "TARGET=B QUERY=<one sentence>"
    )


def build_probe_prompt(task: str, candidates: list) -> str:
    lines = [f"- {name}: {desc}" for name, desc in candidates]
    return (
        "You are a skill router. Given a user task and a candidate skill list "
        "(name + description only), decide which ONE skill should be loaded.\n\n"
        f"User task: {task}\n\n"
        "Candidate skills:\n" + "\n".join(lines) + "\n\n"
        "Answer with exactly one line in this format and nothing else:\n"
        "SKILL: <name>"
    )


def build_proposal_prompt(skill: Skill, neighbor: Skill) -> str:
    return (
        "You optimize one skill description for a router that sees ONLY name + description "
        "(Skill++ style rewrite).\n\n"
        f"Skill: {skill.name}\n"
        f"Current description:\n\"{skill.description}\"\n\n"
        f"Closest confusable neighbor: {neighbor.name}\n"
        f"Neighbor description:\n\"{neighbor.description}\"\n\n"
        f"Skill body excerpt (ground truth for what it supports):\n{skill.body_excerpt}\n\n"
        "Rewrite the description as ONE single line that states:\n"
        "(i) what this skill's body actually supports,\n"
        f"(ii) how it differs from the neighbor {neighbor.name},\n"
        "(iii) what related territory it explicitly excludes (name the neighbor or the territory).\n"
        f"Hard limits: the description content must be at most {DESC_MAX_CHARS} characters, "
        "one line, no newlines, no markdown, plain text.\n\n"
        "Reply with EXACTLY these two lines and nothing else:\n"
        "description: <the rewritten one-line description>\n"
        "rationale: <one short sentence citing the body evidence>"
    )


# ---------------------------------------------------------------------------
# Proposal generation
# ---------------------------------------------------------------------------


def generate_proposal(client: ProbeClient, skill: Skill, neighbor: Skill) -> dict:
    """Model-assisted Skill++ rewrite. Invalid outputs are recorded, not crash."""
    prompt = build_proposal_prompt(skill, neighbor)
    raw_all = []
    attempt_prompt = prompt
    for attempt in range(2):
        resp = client.chat([{"role": "user", "content": attempt_prompt}],
                           purpose="proposal")
        raw_all.append(resp)
        if not resp.get("ok"):
            return {
                "status": "rejected", "after": None, "rationale": None,
                "reject_reason": f"model call failed: {resp.get('error')}",
                "raw": "", "attempts": attempt + 1,
            }
        ok, content, rationale, reason = validate_proposal_line(resp.get("content", ""))
        if ok:
            return {
                "status": "proposed", "after": content, "rationale": rationale,
                "reject_reason": None, "raw": resp.get("content", ""),
                "attempts": attempt + 1,
            }
        if attempt == 0:
            attempt_prompt = (
                f"{prompt}\n\nYour previous reply was invalid ({reason}). "
                "Reply again with exactly the two lines, description first, "
                f"content <= {DESC_MAX_CHARS} chars, one line each."
            )
    return {
        "status": "rejected", "after": None, "rationale": None,
        "reject_reason": reason, "raw": (raw_all[-1] or {}).get("content", ""),
        "attempts": 2,
    }


# ---------------------------------------------------------------------------
# The run loop
# ---------------------------------------------------------------------------


@dataclass
class PairResult:
    a: Skill
    b: Skill
    signals: dict
    queries: list = field(default_factory=list)
    query_error: str = None
    probe_error: str = None
    current_correct: int = 0
    proposed_correct: int = 0
    probed_proposed: int = 0
    avg_latency: float = 0.0
    call_count: int = 0
    proposals: dict = field(default_factory=dict)  # skill name -> proposal dict

    @property
    def names(self):
        return [self.a.name, self.b.name]


def probe_pair(client: ProbeClient, executor: ThreadPoolExecutor,
               a: Skill, b: Skill, signals: dict, k: int) -> PairResult:
    res = PairResult(a=a, b=b, signals=signals)
    gen = client.chat([{"role": "user", "content": build_query_prompt(a, b, k)}],
                      purpose="query-gen")
    res.call_count += 1
    if not gen.get("ok"):
        res.query_error = f"query generation failed: {gen.get('error')}"
        return res
    queries = parse_queries(gen.get("content", ""), k)
    if not queries:
        res.query_error = "query generation returned no parseable TARGET/QUERY lines"
        return res
    res.queries = queries

    prop_futures = {
        a.name: executor.submit(generate_proposal, client, a, b),
        b.name: executor.submit(generate_proposal, client, b, a),
    }
    proposals = {name: fut.result() for name, fut in prop_futures.items()}
    for name, prop in proposals.items():
        skill = a if name == a.name else b
        neighbor = b if name == a.name else a
        res.proposals[name] = {
            "skill": name,
            "file": skill.path,
            "before": skill.description,
            "after": prop.get("after"),
            "rationale": prop.get("rationale"),
            "status": prop["status"],
            "reject_reason": prop.get("reject_reason"),
            "attempts": prop.get("attempts", 1),
            "mtime_at_proposal": skill.mtime,
        }
        res.call_count += prop.get("attempts", 1)

    # Probe: current descriptions for all queries; proposed description only on
    # the side whose proposal is valid (neighbor stays current).
    probe_jobs = []  # (side, query, candidates)
    for q in queries:
        target = a.name if q["target"] == "A" else b.name
        res_current = [(a.name, a.description), (b.name, b.description)]
        probe_jobs.append(("current", q, target, res_current))
        prop = proposals.get(target) or {}
        if prop.get("status") == "proposed" and prop.get("after"):
            cand = []
            for name, desc in res_current:
                cand.append((name, prop["after"]) if name == target else (name, desc))
            probe_jobs.append(("proposed", q, target, cand))

    futures = {
        executor.submit(
            client.chat,
            [{"role": "user", "content": build_probe_prompt(q["text"], cand)}],
            purpose=f"probe-{side}",
        ): (side, q, target)
        for side, q, target, cand in probe_jobs
    }
    latencies = []
    by_key: dict = {}
    for fut, (side, q, target) in futures.items():
        resp = fut.result()
        res.call_count += 1
        if not resp.get("ok"):
            by_key.setdefault((side, q["text"]), []).append(
                {"pick": None, "reason": f"call failed: {resp.get('error')}", "latency": resp.get("latency", 0.0)}
            )
            continue
        latencies.append(resp.get("latency", 0.0))
        parsed = parse_probe_answer(resp.get("content", ""), [a.name, b.name])
        parsed["latency"] = resp.get("latency", 0.0)
        by_key.setdefault((side, q["text"]), []).append(parsed)

    detailed = []
    for q in queries:
        target = a.name if q["target"] == "A" else b.name
        cur = (by_key.get(("current", q["text"])) or [None])[0]
        prp = (by_key.get(("proposed", q["text"])) or [None])[0]
        cur_correct = bool(cur and cur.get("pick") == target)
        prp_record = None
        if prp is not None:
            prp_record = {
                "pick": prp.get("pick"), "correct": prp.get("pick") == target,
                "latency": prp.get("latency"), "reason": prp.get("reason"),
            }
            res.probed_proposed += 1
            if prp_record["correct"]:
                res.proposed_correct += 1
        if cur_correct:
            res.current_correct += 1
        detailed.append({
            "query": q["text"], "target": target,
            "current": {"pick": (cur or {}).get("pick"), "correct": cur_correct,
                        "latency": (cur or {}).get("latency"), "reason": (cur or {}).get("reason")},
            "proposed": prp_record,
        })
    res.queries = detailed
    if latencies:
        res.avg_latency = round(sum(latencies) / len(latencies), 2)
    if res.probed_proposed == 0 and any(
        p["status"] == "proposed" for p in res.proposals.values()
    ):
        res.probe_error = "no proposed-side probe results (call failures?)"
    return res


# ---------------------------------------------------------------------------
# Compose: report + proposals JSON + journal
# ---------------------------------------------------------------------------


def utc_ts() -> str:
    return datetime.now(timezone.utc).strftime("%Y%m%dT%H%M%SZ")


def quoted_desc(content: str) -> str:
    return 'description: "' + content.replace("\\", "\\\\").replace('"', '\\"') + '"'


def write_report(path: Path, ctx: dict) -> None:
    L = []
    ap = L.append
    ap(f"# pi-harness2 observation report — {ctx['ts']}")
    ap("")
    ap("- mode: **observe** (no harness files modified; artifacts only)")
    ap(f"- endpoint: {ctx['base_url']} model `{ctx['model']}` (verified: {ctx['endpoint_ok']})")
    ap(f"- parameters: K={ctx['k']} confusable-threshold={ctx['threshold']} cap={ctx['cap']}")
    ap(f"- probe calls: {ctx['probe_calls']} / cap {ctx['cap']}, total tokens: {ctx['probe_tokens']}")
    ap("")
    ap("## 概览")
    ap("")
    ap(f"Skill inventory: **{len(ctx['skills'])} skills**, "
       f"AGENTS.md files: **{len(ctx['agents'])}**, "
       f"MCP servers: **{len(ctx['mcp'])}**, "
       f"KB concepts: **{len(ctx['kb'])}**.")
    ap("")
    ap("| skill | root | bytes | description length |")
    ap("|---|---|---:|---:|")
    for s in ctx["skills"]:
        ap(f"| {s.name} | `{s.root}` | {s.body_chars} | {len(s.description)} |")
    ap("")
    ap(f"Route-confusable pairs: **{len(ctx['pairs'])}** "
       f"(score = token-Jaccard + {WEIGHT_SALIENT}*salient-shared-stems + "
       f"{WEIGHT_TRIGGER}*shared-trigger-terms, threshold {ctx['threshold']}).")
    for a, b, sig in ctx["pairs"]:
        ap(f"- {a.name} <> {b.name}: score={sig['score']} "
           f"jaccard={sig['jaccard']} salient={sig['salient']} triggers={sig['triggers']}")
    ap("")
    ap("## 每对的探针结果表")
    ap("")
    ap("| pair | status | queries | current correct | proposed correct | avg latency(s) | calls |")
    ap("|---|---|---:|---:|---:|---:|---:|")
    for pr in ctx["pair_results"]:
        nq = len(pr.queries)
        n_prop = pr.probed_proposed
        if pr.query_error:
            status = f"探针失败 (probe failed: {pr.query_error})"
        elif nq and n_prop == 0:
            status = "UNPROBED (no valid proposed description)"
        else:
            status = "OK"
        cur_rate = f"{pr.current_correct}/{nq}" if nq else "—"
        prop_rate = f"{pr.proposed_correct}/{n_prop}" if n_prop else "—"
        ap(f"| {pr.a.name} <> {pr.b.name} | {status} | {nq} | {cur_rate} | {prop_rate} "
           f"| {pr.avg_latency} | {pr.call_count} |")
    ap("")
    ap("## Proposals 提案 diff 块（BEFORE / AFTER + rationale + 探针证据）")
    ap("")
    if not ctx["all_proposals"]:
        ap("_No proposals were generated (no confusable pairs, or generation failed)._")
        ap("")
    for p in ctx["all_proposals"]:
        pair_str = " <> ".join(p["pair"])
        ap(f"### {p['skill']} ({pair_str}) — status: **{p['status']}**")
        ap("")
        ap("```diff")
        ap(f"- {quoted_desc(p['before'])}")
        if p.get("after"):
            ap(f"+ {quoted_desc(p['after'])}")
        else:
            ap(f"+ # no valid AFTER — rejected: {p.get('reject_reason')}")
        ap("```")
        ap("")
        if p.get("rationale"):
            ap(f"- rationale: {p['rationale']}")
        if p.get("reject_reason"):
            ap(f"- rejection reason: {p['reject_reason']}")
        ev = p.get("probe") or {}
        if ev:
            ap(f"- probe evidence: current {ev.get('current_correct', '—')}/"
               f"{ev.get('queries', '—')}, proposed {ev.get('proposed_correct', '—')}/"
               f"{ev.get('probed', '—')} correct picks (target = this skill's queries)")
            for q in ev.get("detail", []):
                ap(f"  - `{q['query'][:90]}` → target {q['target']}: "
                   f"current={q['current'].get('pick')} proposed="
                   f"{(q['proposed'] or {}).get('pick')}")
        ap("")
    ap("## 非技能层观察（仅报告，不做提案）")
    ap("")
    ap("**AGENTS.md rule files**")
    for ag in ctx["agents"]:
        ap(f"- `{ag['path']}` — {ag['bytes']} bytes, {ag['lines']} lines, "
           f"{ag['bullets']} bullet/numbered rule lines")
    ap("")
    ap("**MCP servers** (names only)")
    if ctx["mcp"]:
        for name in ctx["mcp"]:
            ap(f"- {name}")
    else:
        ap("- (none configured)")
    ap("")
    ap("**KB concepts** (`knowledge-base/knowledge/concepts/`)")
    for kb in ctx["kb"]:
        ap(f"- {kb['name']} — approval: {kb['approval']}, last_reviewed: "
           f"{kb['last_reviewed']} ({kb['age_days']} days ago)")
    ap("")
    ap("## 下一步建议")
    ap("")
    for line in ctx["recommendations"]:
        ap(f"- {line}")
    ap("")
    path.write_text("\n".join(L), encoding="utf-8")


def build_recommendations(pair_results: list, kb: list, agents: list) -> list:
    recs = []
    improved = [pr for pr in pair_results
                if pr.probed_proposed and pr.proposed_correct > pr.current_correct]
    flat = [pr for pr in pair_results
            if pr.probed_proposed and pr.proposed_correct <= pr.current_correct]
    if improved:
        recs.append("Probe confirms description rewrites move routing on "
                    + ", ".join(f"{pr.a.name}/{pr.b.name}" for pr in improved)
                    + " — v1 could graduate these to a gated `--apply` review.")
    if flat:
        recs.append("Pairs where the rewrite did not help "
                    + ", ".join(f"{pr.a.name}/{pr.b.name}" for pr in flat)
                    + " — description edits alone are insufficient; consider adding "
                    "an explicit 'Use when / Do NOT use for' disambiguation section in the skill body.")
    rejected = [p for pr in pair_results for p in pr.proposals.values()
                if p["status"] == "rejected"]
    if rejected:
        recs.append(f"{len(rejected)} proposal(s) were rejected by output validation — "
                    "v1 should add few-shot examples to the proposal prompt.")
    stale = [k for k in kb if k.get("age_days") is not None and k["age_days"] >= 14]
    if stale:
        recs.append("KB concepts stale (>=14 days since last_reviewed): "
                    + ", ".join(k["name"] for k in stale) + " — KB lifecycle review is a v1 target.")
    recs.append("AGENTS.md rules were only counted, never probed — v1 should extend the "
                "probe to rule-following checks (Harness² covers prompts/rules too).")
    recs.append("Keep observe mode until probe correctness is trusted; then enable `apply` "
                "with mtime + content gates and human diff review.")
    return recs


def build_proposals_json(ctx: dict) -> dict:
    entries = []
    for idx, p in enumerate(ctx["all_proposals"], 1):
        entries.append({
            "id": f"p-{idx:03d}",
            "pair": p["pair"],
            "skill": p["skill"],
            "file": p["file"],
            "before": p["before"],
            "after": p.get("after"),
            "rationale": p.get("rationale"),
            "status": p["status"],
            "reject_reason": p.get("reject_reason"),
            "mtime_at_proposal": p.get("mtime_at_proposal"),
            "probe": p.get("probe"),
        })
    return {
        "schema": "pi-harness2/proposals-v0",
        "created_utc": ctx["ts"],
        "mode": "observe",
        "model": ctx["model"],
        "base_url": ctx["base_url"],
        "threshold": ctx["threshold"],
        "k": ctx["k"],
        "probe_calls": ctx["probe_calls"],
        "probe_tokens": ctx["probe_tokens"],
        "entries": entries,
    }


def append_journal(path: Path, record: dict) -> bool:
    """Append one JSONL line per run; idempotent on run_id."""
    path.parent.mkdir(parents=True, exist_ok=True)
    run_id = record.get("run_id")
    if run_id and path.exists():
        try:
            for line in path.read_text(encoding="utf-8").splitlines():
                if not line.strip():
                    continue
                try:
                    existing = json.loads(line)
                except json.JSONDecodeError:
                    continue
                if existing.get("run_id") == run_id:
                    return False
        except OSError:
            pass
    with path.open("a", encoding="utf-8") as fh:
        fh.write(json.dumps(record, ensure_ascii=False, sort_keys=True) + "\n")
    return True


# ---------------------------------------------------------------------------
# Inventory of non-skill layers (read-only)
# ---------------------------------------------------------------------------


def inventory_agents(paths=None) -> list:
    paths = paths or [PI_AGENT_DIR / "AGENTS.md", REPO_ROOT / "AGENTS.md"]
    out = []
    for p in paths:
        p = Path(p)
        if not p.is_file():
            out.append({"path": str(p), "missing": True, "bytes": 0, "lines": 0, "bullets": 0})
            continue
        text = p.read_text(encoding="utf-8", errors="replace")
        lines = text.splitlines()
        bullets = sum(1 for l in lines if re.match(r"^\s*(?:[-*]|\d+\.)\s", l))
        out.append({"path": str(p), "missing": False, "bytes": len(text.encode("utf-8")),
                    "lines": len(lines), "bullets": bullets})
    return out


def inventory_mcp(path=None) -> list:
    p = Path(path or PI_AGENT_DIR / "mcp.json")
    if not p.is_file():
        return []
    try:
        data = json.loads(p.read_text(encoding="utf-8"))
    except (OSError, json.JSONDecodeError):
        return []
    return sorted((data.get("mcpServers") or {}).keys())


def inventory_kb(root=None) -> list:
    rootp = Path(root or REPO_ROOT / "knowledge-base" / "knowledge" / "concepts")
    out = []
    if not rootp.is_dir():
        return out
    today = datetime.now(timezone.utc).date()
    for md in sorted(rootp.glob("*.md")):
        meta = parse_frontmatter(md.read_text(encoding="utf-8", errors="replace"))
        lr = str(meta.get("last_reviewed") or "")
        age = None
        if lr:
            try:
                age = (today - datetime.strptime(lr[:10], "%Y-%m-%d").date()).days
            except ValueError:
                age = None
        out.append({"name": md.stem, "approval": str(meta.get("approval") or "unknown"),
                    "last_reviewed": lr or "unknown", "age_days": age})
    return out


# ---------------------------------------------------------------------------
# Apply subcommand (gated; never invoked by run/inventory)
# ---------------------------------------------------------------------------


def rewrite_description(text: str, new_content: str) -> str:
    """Replace ONLY the description value inside the first frontmatter block."""
    lines = text.splitlines(keepends=True)
    if not lines or lines[0].strip() != "---":
        raise ValueError("no frontmatter block found")
    out = []
    in_fm = True
    replaced = False
    i = 0
    while i < len(lines):
        line = lines[i]
        if in_fm and i > 0 and line.strip() == "---":
            in_fm = False
            out.append(line)
            i += 1
            continue
        m = re.match(r"^([A-Za-z0-9_.-]+\s*):\s*(.*)$", line) if in_fm else None
        if m and m.group(1).strip() == "description" and not replaced:
            rest = m.group(2).strip()
            out.append(f'description: "{new_content}"\n')
            replaced = True
            i += 1
            if rest in (">", "|", ">-", "|-", ">+", "|+"):
                while i < len(lines) and (lines[i][:1] in (" ", "\t") or lines[i].strip() == ""):
                    i += 1
            else:
                while i < len(lines) and lines[i][:1] in (" ", "\t") and lines[i].strip():
                    i += 1
            continue
        out.append(line)
        i += 1
    if not replaced:
        raise ValueError("no description key found in frontmatter")
    return "".join(out)


def apply_proposal_entry(entry: dict, yes: bool) -> dict:
    """Apply one proposal entry under all gates. Returns an outcome record."""
    outcome = {"id": entry.get("id"), "skill": entry.get("skill"),
               "file": entry.get("file"), "action": None}
    if not entry.get("after"):
        outcome["action"] = "refused"
        outcome["reason"] = "entry has no AFTER description (rejected/UNPROBED proposal)"
        return outcome
    if entry.get("status") not in ("proposed",):
        outcome["action"] = "refused"
        outcome["reason"] = f"entry status is {entry.get('status')!r}, not 'proposed'"
        return outcome
    path = Path(entry.get("file") or "")
    if not path.is_file():
        outcome["action"] = "refused"
        outcome["reason"] = f"file missing: {path}"
        return outcome
    st = path.stat()
    recorded = entry.get("mtime_at_proposal")
    if recorded is None or abs(st.st_mtime - float(recorded)) > 1e-6:
        outcome["action"] = "refused"
        outcome["reason"] = (f"file changed since proposal (mtime {st.st_mtime} vs "
                             f"recorded {recorded})")
        return outcome
    text = path.read_text(encoding="utf-8")
    meta = parse_frontmatter(text)
    if meta.get("description") != entry.get("before"):
        outcome["action"] = "refused"
        outcome["reason"] = "current description does not match proposal BEFORE"
        return outcome
    try:
        new_text = rewrite_description(text, entry["after"])
    except ValueError as exc:
        outcome["action"] = "refused"
        outcome["reason"] = f"rewrite failed: {exc}"
        return outcome
    diff = "".join(difflib.unified_diff(
        text.splitlines(keepends=True), new_text.splitlines(keepends=True),
        fromfile=f"{path} (before)", tofile=f"{path} (after)"))
    print(diff, end="" if diff.endswith("\n") else "\n")
    if not yes:
        outcome["action"] = "would-apply"
        outcome["reason"] = "dry run: rerun with --yes to write"
        return outcome
    backup = path.with_suffix(path.suffix + ".bak")
    shutil.copy2(path, backup)
    path.write_text(new_text, encoding="utf-8")
    outcome["action"] = "applied"
    outcome["reason"] = f"backup written to {backup}"
    return outcome


# ---------------------------------------------------------------------------
# CLI commands
# ---------------------------------------------------------------------------


def resolve_roots(args_roots) -> list:
    roots = [Path(r) for r in args_roots] if args_roots else list(DEFAULT_SKILL_ROOTS)
    return roots


def cmd_inventory(args) -> int:
    skills = discover_skills(resolve_roots(args.root))
    agents = inventory_agents()
    mcp = inventory_mcp()
    kb = inventory_kb()
    print(f"skills ({len(skills)}):")
    for s in skills:
        print(f"  - {s.name:<28} {s.body_chars:>7} bytes  desc={len(s.description):>3} chars  {s.path}")
    print(f"counts: skills={len(skills)} agents_md={len(agents)} "
          f"mcp_servers={len(mcp)} kb_concepts={len(kb)}")
    print(f"  AGENTS.md: {', '.join(a['path'] for a in agents)}")
    print(f"  MCP servers: {', '.join(mcp) if mcp else '(none)'}")
    print(f"  KB concepts: {', '.join(k['name'] for k in kb) if kb else '(none)'}")
    return 0


def cmd_run(args) -> int:
    out_dir = Path(args.out_dir).expanduser()
    out_dir.mkdir(parents=True, exist_ok=True)
    ts = utc_ts()
    run_id = hashlib.sha256(f"{ts}|{time.time_ns()}".encode()).hexdigest()[:12]
    skills = discover_skills(resolve_roots(args.root))
    agents = inventory_agents()
    mcp = inventory_mcp()
    kb = inventory_kb()

    api_key = args.api_key or os.environ.get("PI_HARNESS2_API_KEY")
    base_url = args.base_url or os.environ.get("PI_HARNESS2_BASE_URL") or DEFAULT_BASE_URL
    model = args.model or os.environ.get("PI_HARNESS2_MODEL") or DEFAULT_MODEL
    client = ProbeClient(base_url, model, api_key=api_key, cap=args.cap)

    endpoint_ok, detail = client.verify()
    if not endpoint_ok:
        msg = (f"ERROR: probe endpoint unreachable: {base_url} ({detail}). "
               "Skipping probe; writing artifacts marked UNPROBED.")
        print(msg, file=sys.stderr)
        ctx = {
            "ts": ts, "k": args.k, "threshold": args.threshold, "cap": args.cap,
            "base_url": base_url, "model": model, "endpoint_ok": False,
            "skills": skills, "agents": agents, "mcp": mcp, "kb": kb,
            "pairs": [], "pair_results": [], "all_proposals": [],
            "probe_calls": 0, "probe_tokens": 0,
            "recommendations": ["Endpoint was unreachable — nothing was probed; "
                                "re-run when the tunnel is up."],
        }
        write_report(out_dir / f"report-{ts}.md", ctx)
        props = build_proposals_json(ctx)
        (out_dir / f"proposals-{ts}.json").write_text(
            json.dumps(props, ensure_ascii=False, indent=2), encoding="utf-8")
        append_journal(out_dir / "journal.jsonl", {
            "ts": ts, "mode": "observe", "pairs": 0, "proposed": 0,
            "probe": {"calls": 0, "cost_tokens": 0},
            "decisions": "none (observe)", "run_id": run_id,
            "error": "endpoint unreachable",
        })
        return 2

    confusable = find_confusable(skills, args.threshold)
    pair_results = []
    executor = ThreadPoolExecutor(max_workers=CONCURRENCY)
    try:
        for a, b, sig in confusable:
            pair_results.append(probe_pair(client, executor, a, b, sig, args.k))
    finally:
        executor.shutdown(wait=True)

    all_proposals = []
    for pr in pair_results:
        for name, p in pr.proposals.items():
            entry = dict(p)
            entry["pair"] = pr.names
            detailed = [q for q in pr.queries if q["target"] == name]
            entry["probe"] = {
                "queries": len(pr.queries),
                "targeted_queries": len(detailed),
                "current_correct": sum(1 for q in detailed if q["current"]["correct"]),
                "proposed_correct": sum(1 for q in detailed
                                        if (q["proposed"] or {}).get("correct")),
                "probed": len([q for q in detailed if q["proposed"] is not None]),
                "detail": detailed,
            }
            all_proposals.append(entry)

    ctx = {
        "ts": ts, "k": args.k, "threshold": args.threshold, "cap": args.cap,
        "base_url": base_url, "model": model, "endpoint_ok": True,
        "skills": skills, "agents": agents, "mcp": mcp, "kb": kb,
        "pairs": confusable, "pair_results": pair_results,
        "all_proposals": all_proposals,
        "probe_calls": client.calls, "probe_tokens": client.tokens,
        "recommendations": build_recommendations(pair_results, kb, agents),
    }
    report_path = out_dir / f"report-{ts}.md"
    write_report(report_path, ctx)
    props = build_proposals_json(ctx)
    proposals_path = out_dir / f"proposals-{ts}.json"
    proposals_path.write_text(json.dumps(props, ensure_ascii=False, indent=2),
                              encoding="utf-8")
    proposed_n = sum(1 for p in all_proposals if p["status"] == "proposed")
    append_journal(out_dir / "journal.jsonl", {
        "ts": ts, "mode": "observe", "pairs": len(confusable),
        "proposed": proposed_n,
        "probe": {"calls": client.calls, "cost_tokens": client.tokens},
        "decisions": "none (observe)", "run_id": run_id,
        "report": report_path.name, "proposals": proposals_path.name,
    })

    total_q = sum(len(pr.queries) for pr in pair_results)
    cur_ok = sum(pr.current_correct for pr in pair_results)
    prop_ok = sum(pr.proposed_correct for pr in pair_results)
    prop_probed = sum(pr.probed_proposed for pr in pair_results)
    print(
        f"pi-harness2 run {ts}: pairs={len(confusable)} proposals={proposed_n} "
        f"(rejected {len(all_proposals) - proposed_n}) queries={total_q} | "
        f"current {cur_ok}/{total_q} vs proposed {prop_ok}/{prop_probed} correct picks"
    )
    print(f"probe totals: calls={client.calls}/{args.cap} tokens={client.tokens} "
          f"avg_latency={round(sum(client.latencies) / len(client.latencies), 2) if client.latencies else 0}s")
    print(f"report: {report_path}")
    print(f"proposals: {proposals_path}")
    return 0


def cmd_apply(args) -> int:
    props_path = Path(args.proposals).expanduser()
    if not props_path.is_file():
        print(f"ERROR: proposals file not found: {props_path}", file=sys.stderr)
        return 1
    try:
        data = json.loads(props_path.read_text(encoding="utf-8"))
    except json.JSONDecodeError as exc:
        print(f"ERROR: proposals file is not valid JSON: {exc}", file=sys.stderr)
        return 1
    entries = data.get("entries") or []
    if data.get("schema") != "pi-harness2/proposals-v0":
        print(f"ERROR: unexpected schema {data.get('schema')!r} — refusing.",
              file=sys.stderr)
        return 1
    refusals = 0
    for entry in entries:
        outcome = apply_proposal_entry(entry, yes=args.yes)
        tag = {"applied": "APPLIED", "would-apply": "WOULD APPLY (dry-run)",
               "refused": "REFUSED"}[outcome["action"]]
        print(f"[{tag}] {outcome['id']} {outcome['skill']}: {outcome['reason']}")
        if outcome["action"] == "refused":
            refusals += 1
    if refusals:
        print(f"{refusals} entr(y/ies) refused by gates — nothing was forced.")
        return 1
    if not args.yes:
        print("Dry run complete. Re-run with --yes to write changes.")
    return 0


def main(argv=None) -> int:
    parser = argparse.ArgumentParser(
        prog="pi_harness2",
        description="Observe-mode Harness² loop over the Pi agent's skill routing layer.")
    sub = parser.add_subparsers(dest="command", required=True)

    p_inv = sub.add_parser("inventory", help="list skills + AGENTS/MCP/KB counts")
    p_inv.add_argument("--root", action="append", default=None,
                       help="extra/additional skill root (repeatable)")
    p_inv.set_defaults(func=cmd_inventory)

    p_run = sub.add_parser("run", help="propose -> probe -> compose (observe mode)")
    p_run.add_argument("--k", type=int, default=DEFAULT_K, help="queries per pair")
    p_run.add_argument("--cap", type=int, default=DEFAULT_CAP, help="max total API calls")
    p_run.add_argument("--threshold", type=float, default=DEFAULT_THRESHOLD,
                       help="confusable score threshold")
    p_run.add_argument("--base-url", default=None)
    p_run.add_argument("--model", default=None)
    p_run.add_argument("--api-key", default=None)
    p_run.add_argument("--out-dir", default=str(DEFAULT_OUT_DIR))
    p_run.add_argument("--root", action="append", default=None)
    p_run.set_defaults(func=cmd_run)

    p_app = sub.add_parser("apply", help="GATED apply of a proposals JSON (explicit)")
    p_app.add_argument("proposals", help="path to proposals-*.json")
    p_app.add_argument("--yes", action="store_true",
                       help="second confirmation: actually write files")
    p_app.set_defaults(func=cmd_apply)

    args = parser.parse_args(argv)
    return args.func(args)


if __name__ == "__main__":
    sys.exit(main())
