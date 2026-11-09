#!/usr/bin/env python3
"""pi-harness2 v1 — observe-mode Harness² loop for the Pi agent's own harness.

Implements a Propose–Probe–Compose loop (arXiv 2610.14224, "Harness²") over the
Pi agent's skill-routing layer, in strict observe mode:

  inventory   scan skill roots (frontmatter name/description + body size) and
              read-only lists of AGENTS.md files, MCP servers, KB concepts.
  run (v1)    find route-confusable skill pairs -> generate BODY-grounded
              queries (K_body per skill, description-withheld, stem-leak
              validated) + NEIGHBOR-vocabulary trap queries (K_trap per pair,
              reverse stem validation) -> propose Skill++-style rewritten
              descriptions (model-assisted, neighbor-name guard) -> probe
              routing on the FULL candidate list (every query picks one of all
              skills by name+description) against CURRENT / PROPOSED /
              MUTATED (top-pair descriptions swapped) -> sensitivity gate ->
              compose a Markdown report + proposals JSON + one journal v2 line.
  apply       GATED apply of a proposals file: explicit flag, mtime drift
              check, BEFORE-content check, .bak backup, printed diff, and a
              second --yes confirmation. Never run automatically.

v1 probe protocol (discriminating by design):
- Full-list routing: every query is answered against ALL inventoried skills
  (~8), not just the confusable pair, so realistic confusion is measured and
  per-pair breakdowns stay honest.
- Body-grounded queries are generated from the SKILL.md body with the
  description withheld from the generator; any query sharing >= 4 word-stems
  with the target's description is rejected as a leak (one regeneration, then
  dropped and counted) — this removes the v0 ceiling effect where queries were
  built from description vocabulary (32/32 current score).
- Trap queries reuse the NEIGHBOR's description vocabulary while requiring the
  target's body; reverse stem validation requires >= 2 neighbor-description
  stems and rejects target-description leaks.
- Sensitivity control (falsifiability gate): the same battery is probed against
  a MUTATED list with the two most-confusable descriptions swapped. Mutated
  must be significantly (>= MIN_SENSITIVITY_DROP) below current, else the run
  is marked `probe_invalid: sensitivity check failed`. The mutation is never
  weakened to force separation; queries are hardened instead.
- Proposal guard: a rewrite containing another skill's exact name (word
  boundary) is rejected with reason `neighbor_name_in_description`.

Journal v2 line: {ts, mode:"observe", queries, overall:{current,proposed,
mutated}, sensitivity:"pass|fail", proposals_accepted_by_probe:N, ...}.
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
DEFAULT_K = 4            # legacy pairwise probe (probe_pair, kept for v0 tests)
DEFAULT_K_BODY = 3       # v1: body-grounded queries per skill
DEFAULT_K_TRAP = 2       # v1: neighbor-vocabulary trap queries per confusable pair
DEFAULT_CAP = 200
DEFAULT_THRESHOLD = 0.30
MAX_TOKENS = 4000
RETRY_TOKENS = 6000
CALL_TIMEOUT = 60
CONCURRENCY = 2
DESC_MAX_CHARS = 200
BODY_EXCERPT_CHARS = 2500
LEAK_MAX_SHARED = 3          # reject a query sharing >3 word-stems with the target description
MIN_TRAP_NEIGHBOR_STEMS = 2  # trap query must reuse >=2 stems of the neighbor's description
MIN_SENSITIVITY_DROP = 0.10  # MUTATED rate must be >=10pp below CURRENT for a valid probe

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
        if self.calls and self.calls % 10 == 0:
            print(f"[pi-harness2 progress] calls={self.calls}/{self.cap} "
                  f"tokens={self.tokens} last_purpose={purpose}", flush=True)
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
    """Parse `TARGET=<A|B> QUERY=<text>` lines (tolerating code fences and
    optional leading numbering/bullets like '1.' or '-')."""
    text = _strip_fences(content or "")
    queries = []
    seen = set()
    for line in text.splitlines():
        m = re.match(r"^\s*(?:\d+[.)]\s*|[-*]\s+)?TARGET\s*=\s*([ABab])\s*QUERY\s*=\s*(.+?)\s*$", line)
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


def parse_query_lines(content: str, k: int) -> list:
    """Parse `QUERY=<text>` lines (body-query format; tolerates code fences and
    optional leading numbering/bullets).

    Lines of the TARGET=A QUERY=... form do NOT match (anchored on QUERY=),
    so mixed output is rejected rather than silently mis-parsed.
    """
    text = _strip_fences(content or "")
    out = []
    seen = set()
    for line in text.splitlines():
        m = re.match(r"^\s*(?:\d+[.)]\s*|[-*]\s+)?QUERY\s*=\s*(.+?)\s*$", line)
        if not m:
            continue
        q = m.group(1).strip()
        if not q or q.lower() in seen:
            continue
        seen.add(q.lower())
        out.append(q)
        if len(out) >= k:
            break
    return out


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
# v1 query validation (stem-leak, trap, neighbor-name guard)
# ---------------------------------------------------------------------------


def _fold_stem(stem: str) -> str:
    """Fold trailing 'e' so singular/plural stems compare equal (surface~surfac)."""
    return stem[:-1] if len(stem) > 3 and stem.endswith("e") else stem


def description_leak_stems(query: str, description: str) -> list:
    """Sorted word-stems shared between a query text and a skill description.

    Validation-only normalization: v0 scoring's _stem output is folded on both
    sides so plural/singular pairs (surface/surfaces) count as shared.
    """
    q = {_fold_stem(t) for t in tokenize(query)}
    d = {_fold_stem(t) for t in tokenize(description)}
    return sorted(q & d)


def validate_body_query(text: str, skill: Skill,
                        max_shared: int = LEAK_MAX_SHARED,
                        ban_name_stems: bool = False) -> tuple:
    """Body query must be grounded in the BODY, not the description vocabulary.

    Reject when >max_shared word-stems are shared with the target's DESCRIPTION
    (default: reject at >= 4 shared stems). With ban_name_stems (hardness++),
    also reject queries containing any stem of the target's NAME.
    """
    shared = description_leak_stems(text, skill.description)
    if len(shared) > max_shared:
        return False, f"description_leak: {len(shared)} shared stems {shared[:8]}"
    if ban_name_stems:
        name_hits = sorted(tokenize(text) & tokenize(skill.name))
        if name_hits:
            return False, f"target_name_stem_in_query: {name_hits[:6]}"
    return True, "ok"


def validate_trap_query(text: str, target: Skill, neighbor: Skill,
                        max_shared: int = LEAK_MAX_SHARED,
                        min_neighbor_stems: int = MIN_TRAP_NEIGHBOR_STEMS,
                        ban_name_stems: bool = False) -> tuple:
    """Trap query: NEIGHBOR's vocabulary, but THIS skill's body is required.

    Reverse stem validation: neighbor-description stems are REQUIRED
    (>= min_neighbor_stems) so the trap genuinely reuses the neighbor's
    vocabulary; target-description stems are rejected beyond the leak
    threshold so the query does not simply quote the target's description.
    """
    shared_target = description_leak_stems(text, target.description)
    if len(shared_target) > max_shared:
        return False, (f"description_leak: {len(shared_target)} stems shared with "
                       f"{target.name}'s description {shared_target[:8]}")
    shared_neighbor = description_leak_stems(text, neighbor.description)
    if len(shared_neighbor) < min_neighbor_stems:
        return False, (f"insufficient_neighbor_vocabulary: only {len(shared_neighbor)} "
                       f"stems of {neighbor.name}'s description {shared_neighbor}")
    if ban_name_stems:
        name_hits = sorted(tokenize(text) & tokenize(target.name))
        if name_hits:
            return False, f"target_name_stem_in_query: {name_hits[:6]}"
    return True, "ok"


def find_embedded_skill_name(description: str, all_names: list,
                             exclude: str) -> str or None:
    """First other skill whose exact name appears (word-boundary) in description."""
    for name in sorted(all_names):
        if name == exclude:
            continue
        if re.search(r"\b" + re.escape(name) + r"\b", description):
            return name
    return None


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


def build_body_query_prompt(skill: Skill, k: int) -> str:
    return (
        "You generate probe tasks for a skill-routing benchmark.\n"
        "A router will see ONLY each skill's name + description and must pick one skill per task. "
        "We test whether tasks grounded in a skill's BODY (its procedures, files, tools, steps) "
        "route correctly even when they share no vocabulary with the description.\n\n"
        f"Skill name: {skill.name}\n"
        "SKILL.md body (ground truth — the description is deliberately withheld):\n"
        f"{skill.body_excerpt}\n\n"
        f"Write exactly {k} short realistic user task messages (one sentence each) that require "
        "THIS skill's body to be loaded — grounded in specific procedures, file names, tool "
        "names, commands, flags, or step sequences from the body above.\n"
        "Rules:\n"
        "- Do NOT reuse wording from the skill description (it is withheld; avoid generic "
        "summary vocabulary).\n"
        f"- Do NOT mention the skill name '{skill.name}' in the task text.\n"
        "- Each task must be a realistic request an expert could answer only with this body.\n"
        "Output STRICTLY, one per line, no numbering, no markdown:\n"
        "QUERY=<one sentence>"
    )


def build_trap_query_prompt(a: Skill, b: Skill, k: int) -> str:
    k_a = (k + 1) // 2
    k_b = k - k_a
    return (
        "You generate trap tasks for a skill-routing benchmark.\n"
        "A router sees ONLY name + description. A trap task is phrased with the NEIGHBOR's "
        "description vocabulary but actually requires THIS skill's body (its procedures, "
        "files, tools, steps).\n\n"
        f"Skill A = {a.name}\n description (vocabulary source for A-target traps): {a.description}\n"
        f" body excerpt:\n{a.body_excerpt}\n\n"
        f"Skill B = {b.name}\n description (vocabulary source for B-target traps): {b.description}\n"
        f" body excerpt:\n{b.body_excerpt}\n\n"
        f"Write exactly {k} short realistic user task messages (one sentence each): "
        f"{k_a} with TARGET=A — phrased using words typical of B's description above, but the "
        f"correct skill is A because only A's body supports the task; and {k_b} with "
        "TARGET=B — the reverse (A's vocabulary, B's body).\n"
        "Rules:\n"
        "- Reuse the neighbor's description vocabulary prominently (that is what makes it a trap).\n"
        "- Exactly one skill is actually right; do not make both plausible.\n"
        "- Do not mention either skill name in the task text.\n"
        "- One sentence each, no numbering, no markdown.\n"
        "Output STRICTLY:\n"
        "TARGET=A QUERY=<one sentence>\n"
        "TARGET=B QUERY=<one sentence>"
    )


def build_proposal_prompt(skill: Skill, neighbor: Skill,
                          all_names: list = None) -> str:
    names = list(all_names) if all_names else [skill.name, neighbor.name]
    other_names = [n for n in names if n != skill.name]
    return (
        "You optimize one skill description for a router that sees ONLY name + description "
        "(Skill++ style rewrite). The router picks among ALL of these skills:\n"
        + ", ".join(names) + "\n\n"
        f"Skill: {skill.name}\n"
        f"Current description:\n\"{skill.description}\"\n\n"
        f"Closest confusable neighbor: {neighbor.name}\n"
        f"Neighbor description:\n\"{neighbor.description}\"\n\n"
        f"Skill body excerpt (ground truth for what it supports):\n{skill.body_excerpt}\n\n"
        "Few-shot calibration from the previous run (v0):\n"
        "GOOD (show-me; probed 2/2 — grounded in body outputs, contrasts territory):\n"
        "description: Explains completed work, changes, structure, or ideas via truthful "
        "Markdown, diagrams, and focused HTML artifacts with truth labels; explanation only, "
        "not app building or button generation.\n"
        "BAD (generated-control-surface; probed 0/2 while current was 4/4 — embedding the "
        "neighbor's exact name made the router pick the NEIGHBOR):\n"
        "description: Every response emits truthful prompt buttons projecting current evidence, "
        "capabilities, and intent; ephemeral surfaces only, not reusable deterministic apps or "
        "bound methods (generative-apps).\n\n"
        "GUARD: any output containing another skill's exact name is auto-rejected "
        "(reason: neighbor_name_in_description). Exact names you must NOT use: "
        + ", ".join(other_names) + ".\n"
        "Describe excluded territory in ordinary words (e.g. 'not reusable app authoring'), "
        "never by naming another skill.\n\n"
        "Rewrite the description as ONE single line that states:\n"
        "(i) what this skill's body actually supports,\n"
        "(ii) how it differs from the neighbor's territory,\n"
        "(iii) what related territory it explicitly excludes (describe the territory; do NOT "
        "name the other skill).\n"
        f"Hard limits: the description content must be at most {DESC_MAX_CHARS} characters, "
        "one line, no newlines, no markdown, plain text.\n\n"
        "Reply with EXACTLY these two lines and nothing else:\n"
        "description: <the rewritten one-line description>\n"
        "rationale: <one short sentence citing the body evidence>"
    )


# ---------------------------------------------------------------------------
# Proposal generation
# ---------------------------------------------------------------------------


def generate_proposal(client: ProbeClient, skill: Skill, neighbor: Skill,
                      all_names: list = None) -> dict:
    """Model-assisted Skill++ rewrite with the neighbor-name guard.

    Invalid outputs (format or guard) get ONE regeneration attempt, then are
    recorded as rejected — never crash, never auto-apply.
    """
    names = list(all_names) if all_names else [skill.name, neighbor.name]
    prompt = build_proposal_prompt(skill, neighbor, names)
    raw_all = []
    attempt_prompt = prompt
    reason = None
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
            embedded = find_embedded_skill_name(content, names, exclude=skill.name)
            if embedded is None:
                return {
                    "status": "proposed", "after": content, "rationale": rationale,
                    "reject_reason": None, "raw": resp.get("content", ""),
                    "attempts": attempt + 1,
                }
            reason = (f"neighbor_name_in_description: contains exact name '{embedded}' "
                      "(word-boundary match)")
            content = None
        if attempt == 0:
            attempt_prompt = (
                f"{prompt}\n\nYour previous reply was invalid ({reason}). "
                "Reply again with exactly the two lines, description first, "
                f"content <= {DESC_MAX_CHARS} chars, one line each. "
                "Never include another skill's exact name in the description.")
    return {
        "status": "rejected", "after": None, "rationale": None,
        "reject_reason": reason, "raw": (raw_all[-1] or {}).get("content", ""),
        "attempts": 2,
    }


def generate_body_queries(client: ProbeClient, skill: Skill, k: int,
                          max_shared: int = LEAK_MAX_SHARED,
                          ban_name_stems: bool = False) -> dict:
    """Generate k body-grounded queries for one skill.

    The generator sees the SKILL.md body with the description withheld.
    Leaks (>max_shared stems shared with the target description) get one
    regeneration attempt; whatever still fails is dropped and counted.
    """
    base_prompt = build_body_query_prompt(skill, k)
    prompt = base_prompt
    valid: list = []
    dropped: list = []
    regen = False
    calls = 0
    error = None
    for attempt in range(2):
        resp = client.chat([{"role": "user", "content": prompt}],
                           purpose="body-query-gen")
        calls += 1
        if not resp.get("ok"):
            error = f"model call failed: {resp.get('error')}"
            break
        texts = parse_query_lines(resp.get("content", ""), k)
        if not texts:
            error = error or "no parseable QUERY= lines"
            if attempt == 0:
                regen = True
                prompt = (base_prompt + "\n\nYour previous reply had no parseable "
                          "QUERY= lines. Output ONLY lines of the form QUERY=<one sentence>.")
                continue
            break
        known = {t.lower() for t in valid}
        for t in texts:
            if t.lower() in known:
                continue
            ok, reason = validate_body_query(t, skill, max_shared, ban_name_stems)
            if ok:
                valid.append(t)
                known.add(t.lower())
            else:
                dropped.append({"text": t, "reason": reason})
        if len(valid) >= k:
            break
        if attempt == 0:
            regen = True
            feedback = "; ".join(d["reason"] for d in dropped) or "insufficient valid queries"
            prompt = (base_prompt +
                      f"\n\nYour previous tasks had validation failures ({feedback}). "
                      f"Write {k - len(valid)} NEW task(s) grounded in concrete body "
                      "specifics, avoiding description vocabulary.")
    if not valid and not error:
        error = "no valid body queries after validation"
    return {"skill": skill.name, "queries": valid[:k], "dropped": dropped,
            "regen": regen, "error": error, "calls": calls}


def generate_trap_queries(client: ProbeClient, a: Skill, b: Skill, k: int,
                          max_shared: int = LEAK_MAX_SHARED,
                          min_neighbor_stems: int = MIN_TRAP_NEIGHBOR_STEMS,
                          ban_name_stems: bool = False) -> dict:
    """Generate k trap queries for pair (a, b): neighbor's vocabulary, target's body.

    Both directions are generated (A-target and B-target); reverse stem
    validation requires neighbor-description stems and rejects target leaks.
    One regeneration attempt; failures are dropped and counted.
    """
    base_prompt = build_trap_query_prompt(a, b, k)
    prompt = base_prompt
    valid: list = []
    dropped: list = []
    regen = False
    calls = 0
    error = None
    for attempt in range(2):
        resp = client.chat([{"role": "user", "content": prompt}],
                           purpose="trap-query-gen")
        calls += 1
        if not resp.get("ok"):
            error = f"model call failed: {resp.get('error')}"
            break
        parsed = parse_queries(resp.get("content", ""), k * 2)
        if not parsed:
            error = error or "no parseable TARGET/QUERY lines"
            if attempt == 0:
                regen = True
                prompt = (base_prompt + "\n\nYour previous reply had no parseable "
                          "TARGET=/QUERY= lines. Output ONLY the strict "
                          "TARGET=A QUERY=... / TARGET=B QUERY=... lines.")
                continue
            break
        known = {q["text"].lower() for q in valid}
        for q in parsed:
            if q["text"].lower() in known:
                continue
            target, neighbor = (a, b) if q["target"] == "A" else (b, a)
            ok, reason = validate_trap_query(q["text"], target, neighbor,
                                             max_shared, min_neighbor_stems,
                                             ban_name_stems)
            if ok:
                valid.append({"text": q["text"], "target": target.name})
                known.add(q["text"].lower())
            else:
                dropped.append({"text": q["text"], "target": target.name,
                                "reason": reason})
        directions = {q["target"] for q in valid}
        balanced = k < 2 or directions == {a.name, b.name}
        if len(valid) >= k and balanced:
            break
        if attempt == 0:
            regen = True
            missing = {a.name, b.name} - directions
            feedback = "; ".join(d["reason"] for d in dropped) or "insufficient valid traps"
            prompt = (base_prompt +
                      f"\n\nYour previous tasks had validation failures ({feedback})."
                      + (f" Missing direction(s): {', '.join(sorted(missing))}." if missing else "")
                      + " Write the strict TARGET=A QUERY=... / TARGET=B QUERY=... lines.")
    if not valid and not error:
        error = "no valid trap queries after validation"
    return {"pair": [a.name, b.name], "queries": valid[:k], "dropped": dropped,
            "regen": regen, "error": error, "calls": calls}


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
# v1 full-list battery (CURRENT / PROPOSED / MUTATED) + sensitivity gate
# ---------------------------------------------------------------------------


@dataclass
class BatteryQuery:
    text: str
    target: str
    kind: str            # "body" | "trap"
    pair: tuple = None   # trap queries: (a_name, b_name)


def sensitivity_gate(current_correct: int, current_total: int,
                     mutated_correct: int, mutated_total: int,
                     min_drop: float = MIN_SENSITIVITY_DROP) -> tuple:
    """Falsifiable sensitivity control: MUTATED must be significantly below CURRENT.

    The mutation (top-pair description swap) is fixed; this gate is never
    weakened to force separation. Returns (passed, reason).
    """
    if current_total <= 0 or mutated_total <= 0:
        return False, "no queries probed (current_total or mutated_total is 0)"
    cur = current_correct / current_total
    mut = mutated_correct / mutated_total
    if mut >= cur:
        return False, (f"mutated {mut:.0%} >= current {cur:.0%} — the router ignores "
                       "the description swap (no separation)")
    drop = cur - mut
    if drop + 1e-9 < min_drop:
        return False, (f"drop {drop:.0%} below required {min_drop:.0%} "
                       f"(current {cur:.0%} vs mutated {mut:.0%})")
    return True, (f"mutated {mut:.0%} is {drop:.0%} below current {cur:.0%} "
                  f"(required >= {min_drop:.0%})")


def run_full_list_battery(client: ProbeClient, executor: ThreadPoolExecutor,
                          queries: list, skills: list, proposals: dict,
                          mutated_pair: tuple) -> dict:
    """Probe every query against the FULL candidate list in three variants.

    - current:  inventoried name+description list
    - proposed: target skill's description replaced by its accepted proposal
                (only for queries whose target has a valid proposal)
    - mutated:  the two most-confusable descriptions SWAPPED (all queries)

    Correctness = the router picked the query's true target skill.
    """
    by_name = {s.name: s for s in skills}
    ordered = [s.name for s in skills]
    base = [(n, by_name[n].description) for n in ordered]
    if mutated_pair:
        ma, mb = mutated_pair
        mutated = []
        for n, d in base:
            if n == ma:
                mutated.append((n, by_name[mb].description))
            elif n == mb:
                mutated.append((n, by_name[ma].description))
            else:
                mutated.append((n, d))
    else:
        mutated = list(base)

    jobs = []  # (variant, idx, candidates)
    for idx, q in enumerate(queries):
        jobs.append(("current", idx, base))
        prop = proposals.get(q.target) or {}
        if prop.get("status") == "proposed" and prop.get("after"):
            cands = [(n, prop["after"] if n == q.target else d) for n, d in base]
            jobs.append(("proposed", idx, cands))
        jobs.append(("mutated", idx, mutated))

    futures = {}
    for variant, idx, cands in jobs:
        fut = executor.submit(client.chat,
                              [{"role": "user",
                                "content": build_probe_prompt(queries[idx].text, cands)}],
                              purpose=f"probe-{variant}")
        futures[fut] = (variant, idx)

    answers: dict = {idx: {} for idx in range(len(queries))}
    latencies = []
    call_failures = 0
    for fut, (variant, idx) in futures.items():
        resp = fut.result()
        if not resp.get("ok"):
            call_failures += 1
            answers[idx][variant] = {"pick": None, "reason": f"call failed: {resp.get('error')}",
                                     "latency": resp.get("latency", 0.0)}
            continue
        latencies.append(resp.get("latency", 0.0))
        parsed = parse_probe_answer(resp.get("content", ""), ordered)
        parsed["latency"] = resp.get("latency", 0.0)
        answers[idx][variant] = parsed

    results = []
    for idx, q in enumerate(queries):
        per = answers[idx]
        cur = per.get("current") or {"pick": None, "reason": "not probed"}
        mut = per.get("mutated") or {"pick": None, "reason": "not probed"}
        results.append({
            "text": q.text, "target": q.target, "kind": q.kind,
            "pair": list(q.pair) if q.pair else None,
            "current": {**cur, "correct": cur.get("pick") == q.target},
            "proposed": per.get("proposed"),
            "mutated": {**mut, "correct": mut.get("pick") == q.target},
        })
    return {
        "results": results,
        "avg_latency": round(sum(latencies) / len(latencies), 2) if latencies else 0.0,
        "call_failures": call_failures,
    }


def compute_battery_metrics(results: list, proposals: dict, pairs: list) -> dict:
    """Overall + per-pair + per-skill(proposal) metrics over battery results."""
    total = len(results)
    cur_ok = sum(1 for r in results if r["current"]["correct"])
    probed = [r for r in results if r["proposed"] is not None]
    prop_ok = sum(1 for r in probed if r["proposed"].get("pick") == r["target"])
    mut_ok = sum(1 for r in results if r["mutated"]["correct"])
    overall = {
        "current": {"correct": cur_ok, "total": total,
                    "rate": round(cur_ok / total, 4) if total else 0.0},
        "proposed": {"correct": prop_ok, "probed": len(probed),
                     "rate": round(prop_ok / len(probed), 4) if probed else 0.0},
        "mutated": {"correct": mut_ok, "total": total,
                    "rate": round(mut_ok / total, 4) if total else 0.0},
    }

    per_pair = []
    for a, b, sig in pairs:
        targeted = [r for r in results
                    if (r.get("pair") and tuple(r["pair"]) == (a.name, b.name))
                    or (r["kind"] == "body" and r["target"] in (a.name, b.name))]
        tprop = [r for r in targeted if r["proposed"] is not None]
        per_pair.append({
            "pair": [a.name, b.name], "score": sig.get("score"),
            "targeted": len(targeted),
            "current": {"correct": sum(1 for r in targeted if r["current"]["correct"]),
                        "total": len(targeted)},
            "proposed": {"correct": sum(1 for r in tprop
                                        if r["proposed"].get("pick") == r["target"]),
                         "probed": len(tprop)},
            "mutated": {"correct": sum(1 for r in targeted if r["mutated"]["correct"]),
                        "total": len(targeted)},
        })

    per_skill = {}
    for name, prop in (proposals or {}).items():
        if not prop:
            continue
        targeted = [r for r in results if r["target"] == name]
        tprop = [r for r in targeted if r["proposed"] is not None]
        cur_correct = sum(1 for r in targeted if r["current"]["correct"])
        cur_rate = (cur_correct / len(targeted)) if targeted else 0.0
        prop_correct = sum(1 for r in tprop if r["proposed"].get("pick") == name)
        prop_rate = (prop_correct / len(tprop)) if tprop else None
        per_skill[name] = {
            "status": prop.get("status"), "neighbor": prop.get("neighbor"),
            "reject_reason": prop.get("reject_reason"),
            "targeted_current": {"correct": cur_correct, "total": len(targeted)},
            "targeted_proposed": {"correct": prop_correct, "probed": len(tprop)},
            # accepted = probed and did not damage routing on this skill's queries
            "accepted_by_probe": bool(tprop) and prop_rate is not None
                                 and prop_rate >= cur_rate,
        }
    return {"overall": overall, "per_pair": per_pair, "per_skill": per_skill}


# ---------------------------------------------------------------------------
# Compose: report + proposals JSON + journal
# ---------------------------------------------------------------------------


def utc_ts() -> str:
    return datetime.now(timezone.utc).strftime("%Y%m%dT%H%M%SZ")


def quoted_desc(content: str) -> str:
    return 'description: "' + content.replace("\\", "\\\\").replace('"', '\\"') + '"'


def write_report(path: Path, ctx: dict) -> None:
    """Dispatcher: v1 battery ctx vs legacy v0 pair-probe ctx."""
    if ctx.get("battery") is not None:
        _write_report_v1(path, ctx)
        return
    _write_report_v0(path, ctx)


def _pick_cell(rec: dict) -> str:
    if not rec:
        return "—"
    pick = rec.get("pick")
    if pick:
        return pick
    return f"miss:{(rec.get('reason') or '?')[:36]}"


def _write_report_v1(path: Path, ctx: dict) -> None:
    L = []
    ap = L.append
    metrics = ctx["metrics"]
    ov = metrics["overall"]
    battery = ctx["battery"]
    sens = ctx["sensitivity"]
    mp = battery.get("mutated_pair") or []
    validity = (f"probe_invalid — {ctx['probe_invalid']}" if ctx.get("probe_invalid")
                else "valid")
    ap(f"# pi-harness2 v1 observation report — {ctx['ts']}")
    ap("")
    ap(f"- run validity: **{validity}**")
    ap("- mode: **observe** (no harness files modified; artifacts only)")
    ap(f"- endpoint: {ctx['base_url']} model `{ctx['model']}` (verified: {ctx['endpoint_ok']})")
    ap(f"- parameters: k_body={ctx['k_body']} k_trap={ctx['k_trap']} "
       f"confusable-threshold={ctx['threshold']} cap={ctx['cap']}; leak rule: reject query "
       f"when >{ctx['leak_max_stems']} stems shared with target description; trap needs "
       f">={ctx['min_trap_stems']} neighbor-description stems; "
       f"ban-target-name-stems={ctx['ban_name_stems']}")
    ap(f"- probe calls: {ctx['probe_calls']} / cap {ctx['cap']}, tokens: {ctx['probe_tokens']}, "
       f"wall: {battery.get('wall_seconds', 0)}s")
    ap("")
    if ctx.get("probe_invalid"):
        ap("> **WARNING: probe_invalid — " + ctx["probe_invalid"] + ".** "
          "Routing deltas from this run must not be trusted; harden the queries and re-run "
          "(the mutation itself is never weakened).")
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
        ap(f"- {a.name} <> {b.name}: score={sig['score']} jaccard={sig['jaccard']} "
           f"salient={sig['salient']} triggers={sig['triggers']}")
    ap("")
    ap("## 探针协议（v1，discriminating probe）")
    ap("")
    ap("- **Full-list routing**: every query is answered against ALL inventoried skills "
       "(name + description only); the router picks exactly one.")
    ap("- **Body-grounded queries** (K_body per skill): generated from the SKILL.md body "
       "with the description withheld; leaks sharing >=4 word-stems with the target "
       "description are rejected (one regeneration, then dropped + counted).")
    ap("- **Neighbor-vocabulary trap queries** (K_trap per pair): phrased with the "
       "NEIGHBOR's description vocabulary but requiring the target's body; reverse stem "
       "validation (neighbor stems required, target-description leak rejected).")
    ap("- **MUTATED control**: the two most-confusable descriptions are swapped in the "
       "candidate list and the SAME battery is re-probed; mutated must be >=10pp below "
       "current or the run is marked probe_invalid.")
    ap("- **Proposal guard**: rewrites containing another skill's exact name "
       "(word-boundary) are rejected with reason `neighbor_name_in_description`.")
    ap("")
    ap("## 总体结果")
    ap("")
    ap("| variant | correct | total/probed | rate |")
    ap("|---|---:|---:|---:|")
    ap(f"| current | {ov['current']['correct']} | {ov['current']['total']} "
       f"| {ov['current']['rate']:.0%} |")
    ap(f"| proposed | {ov['proposed']['correct']} | {ov['proposed']['probed']} "
       f"| {ov['proposed']['rate']:.0%} |")
    ap(f"| MUTATED (swap {' <> '.join(mp)}) | {ov['mutated']['correct']} "
       f"| {ov['mutated']['total']} | {ov['mutated']['rate']:.0%} |")
    ap("")
    ap(f"- sensitivity: **{sens['verdict']}** — {sens['reason']}")
    ap("")
    ap("## 每对的探针结果表（per-pair breakdown）")
    ap("")
    ap("| pair | targeted queries | current | proposed | mutated |")
    ap("|---|---:|---|---|---|")
    for pp in metrics["per_pair"]:
        ap(f"| {' <> '.join(pp['pair'])} | {pp['targeted']} "
           f"| {pp['current']['correct']}/{pp['current']['total']} "
           f"| {pp['proposed']['correct']}/{pp['proposed']['probed']} "
           f"| {pp['mutated']['correct']}/{pp['mutated']['total']} |")
    ap("")
    ap("## Sensitivity control（mutated 对照）")
    ap("")
    ap(f"- mutated pair: {' <> '.join(mp)} — their two descriptions were swapped in the "
       "candidate list; every query was re-probed against the mutated list.")
    ap(f"- verdict: **{sens['verdict']}** — {sens['reason']}")
    flips = [r for r in battery["results"]
             if r["current"]["correct"] and not r["mutated"]["correct"]]
    ap(f"- queries correct under current but wrong under mutated: **{len(flips)}** "
       f"of {ov['current']['correct']} currently-correct queries")
    for r in flips[:12]:
        ap(f"  - [{r['kind']}] `{r['text'][:84]}` → target {r['target']}: "
           f"mutated picked {_pick_cell(r['mutated'])}")
    ap("")
    ap("## Query 生成与丢弃")
    ap("")
    ap("| skill/pair | kind | kept | dropped | regen | note |")
    ap("|---|---|---:|---:|---|---|")
    for name in sorted(battery.get("body_batches", {})):
        bt = battery["body_batches"][name]
        ap(f"| {name} | body | {len(bt['queries'])} | {len(bt['dropped'])} "
           f"| {bt['regen']} | {(bt.get('error') or 'ok')[:60]} |")
    for key in sorted(battery.get("trap_batches", {})):
        tb = battery["trap_batches"][key]
        ap(f"| {' <> '.join(key)} | trap | {len(tb['queries'])} | {len(tb['dropped'])} "
           f"| {tb['regen']} | {(tb.get('error') or 'ok')[:60]} |")
    drop_total = sum(len(b["dropped"]) for b in battery.get("body_batches", {}).values()) \
        + sum(len(b["dropped"]) for b in battery.get("trap_batches", {}).values())
    ap("")
    ap(f"- generated queries dropped by validation: **{drop_total}**; cross-skill duplicate "
       f"texts skipped: **{battery.get('duplicate_drops', 0)}**; probe call failures: "
       f"**{battery.get('call_failures', 0)}**")
    ap("")
    drop_reasons: dict = {}
    for b in battery.get("body_batches", {}).values():
        for d in b["dropped"]:
            drop_reasons[d["reason"].split(":")[0]] = drop_reasons.get(d["reason"].split(":")[0], 0) + 1
    for b in battery.get("trap_batches", {}).values():
        for d in b["dropped"]:
            drop_reasons[d["reason"].split(":")[0]] = drop_reasons.get(d["reason"].split(":")[0], 0) + 1
    if drop_reasons:
        ap("- drop reasons: " + ", ".join(f"{k}={v}" for k, v in sorted(drop_reasons.items())))
        ap("")
    ap("## 逐条结果（battery detail）")
    ap("")
    ap("| kind | target | query | current | proposed | mutated |")
    ap("|---|---|---|---|---|---|")
    for r in battery["results"]:
        ap(f"| {r['kind']} | {r['target']} | `{r['text'][:70]}` "
           f"| {_pick_cell(r['current'])} | {_pick_cell(r['proposed'])} "
           f"| {_pick_cell(r['mutated'])} |")
    ap("")
    ap("## Proposals 提案 diff 块（BEFORE / AFTER + rationale + per-skill 探针证据）")
    ap("")
    if not ctx["all_proposals"]:
        ap("_No proposals were generated (no confusable pairs, or generation failed)._")
        ap("")
    for p in ctx["all_proposals"]:
        pair_str = " <> ".join(p["pair"])
        ap(f"### {p['skill']} ({pair_str}) — status: **{p['status']}**"
           + (f" — accepted_by_probe: {p.get('accepted_by_probe')}"
              if p["status"] == "proposed" else ""))
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
        if ev and "targeted_current" in ev:
            tc, tp = ev["targeted_current"], ev["targeted_proposed"]
            ap(f"- probe evidence (targeted queries): current {tc['correct']}/{tc['total']}, "
               f"proposed {tp['correct']}/{tp['probed']}")
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


def _write_report_v0(path: Path, ctx: dict) -> None:
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


def build_recommendations_v1(metrics: dict, sensitivity: str,
                             all_proposals: list, kb: list) -> list:
    recs = []
    ov = metrics["overall"]
    if sensitivity == "fail":
        recs.append("Sensitivity control FAILED — run marked probe_invalid. Harden the "
                    "queries (stricter --leak-max-stems, --ban-target-name-stems) and "
                    "re-run; never weaken the mutation to force separation.")
    elif sensitivity == "pass":
        recs.append("Sensitivity control passed — the full-list probe separates description "
                    f"signal from name priors (current {ov['current']['rate']:.0%} vs "
                    f"mutated {ov['mutated']['rate']:.0%}); deltas are interpretable.")
    else:
        recs.append("No confusable pairs detected — sensitivity control not applicable.")
    accepted = [name for name, ps in metrics["per_skill"].items()
                if ps.get("accepted_by_probe")]
    damaged = [name for name, ps in metrics["per_skill"].items()
               if ps.get("status") == "proposed" and not ps.get("accepted_by_probe")]
    if accepted:
        recs.append("Probe-accepted rewrites (no routing damage): " + ", ".join(sorted(accepted))
                    + " — candidates for a gated --apply review.")
    if damaged:
        recs.append("Rewrites that damaged routing on their own queries: "
                    + ", ".join(sorted(damaged)) + " — do not apply; body-level "
                    "disambiguation may be needed instead.")
    rejected = [p for p in all_proposals if p["status"] == "rejected"]
    if rejected:
        reasons: dict = {}
        for p in rejected:
            key = (p.get("reject_reason") or "unknown").split(":")[0]
            reasons[key] = reasons.get(key, 0) + 1
        recs.append(f"{len(rejected)} proposal(s) rejected "
                    "(" + ", ".join(f"{k}={v}" for k, v in sorted(reasons.items())) + ")")
    stale = [k for k in kb if k.get("age_days") is not None and k["age_days"] >= 14]
    if stale:
        recs.append("KB concepts stale (>=14 days since last_reviewed): "
                    + ", ".join(k["name"] for k in stale) + " — KB lifecycle review is a v1 target.")
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
            "accepted_by_probe": p.get("accepted_by_probe"),
            "probe": p.get("probe"),
        })
    return {
        "schema": "pi-harness2/proposals-v0",
        "created_utc": ctx["ts"],
        "mode": "observe",
        "model": ctx["model"],
        "base_url": ctx["base_url"],
        "threshold": ctx["threshold"],
        "k": ctx.get("k", ctx.get("k_body")),
        "k_body": ctx.get("k_body"),
        "k_trap": ctx.get("k_trap"),
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
    if args.k_body < 1 or args.k_trap < 1 or args.cap < 1:
        print("ERROR: --k-body, --k-trap and --cap must be >= 1", file=sys.stderr)
        return 2
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

    def journal_record(queries: int, overall: dict, sensitivity: str,
                       accepted: int, **extra) -> dict:
        rec = {
            "ts": ts, "mode": "observe", "queries": queries,
            "overall": overall, "sensitivity": sensitivity,
            "proposals_accepted_by_probe": accepted,
            "probe": {"calls": client.calls, "cost_tokens": client.tokens},
            "decisions": "none (observe)", "run_id": run_id,
        }
        rec.update(extra)
        return rec

    zero_overall = {"current": "0/0", "proposed": "0/0", "mutated": "0/0"}
    endpoint_ok, detail = client.verify()
    if not endpoint_ok:
        msg = (f"ERROR: probe endpoint unreachable: {base_url} ({detail}). "
               "Skipping probe; writing artifacts marked UNPROBED.")
        print(msg, file=sys.stderr)
        ctx = {
            "ts": ts, "k": args.k_body, "threshold": args.threshold, "cap": args.cap,
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
        append_journal(out_dir / "journal.jsonl",
                       journal_record(0, zero_overall, "n/a", 0,
                                      error="endpoint unreachable"))
        return 2

    confusable = find_confusable(skills, args.threshold)
    print(f"inventory: {len(skills)} skills, {len(confusable)} confusable pairs "
          f"(k_body={args.k_body}, k_trap={args.k_trap})", flush=True)
    wall_start = time.monotonic()
    executor = ThreadPoolExecutor(max_workers=CONCURRENCY)
    try:
        # -- phase 1: body-grounded queries (description withheld from generator)
        print(f"[phase] body query generation: {len(skills)} skills x k_body={args.k_body}",
              flush=True)
        body_futs = {executor.submit(generate_body_queries, client, s, args.k_body,
                                     args.leak_max_stems, args.ban_target_name_stems): s.name
                     for s in skills}
        body_batches = {}
        for fut, name in body_futs.items():
            body_batches[name] = fut.result()
        print(f"[phase] body queries: kept="
              f"{sum(len(b['queries']) for b in body_batches.values())} dropped="
              f"{sum(len(b['dropped']) for b in body_batches.values())}", flush=True)

        # -- phase 2: neighbor-vocabulary trap queries per confusable pair
        print(f"[phase] trap query generation: {len(confusable)} pairs x k_trap={args.k_trap}",
              flush=True)
        trap_futs = {executor.submit(generate_trap_queries, client, a, b, args.k_trap,
                                     args.leak_max_stems, args.min_trap_stems,
                                     args.ban_target_name_stems): (a.name, b.name)
                     for a, b, _sig in confusable}
        trap_batches = {}
        for fut, key in trap_futs.items():
            trap_batches[key] = fut.result()
        print(f"[phase] trap queries: kept="
              f"{sum(len(b['queries']) for b in trap_batches.values())} dropped="
              f"{sum(len(b['dropped']) for b in trap_batches.values())}", flush=True)

        # -- phase 3: one Skill++ proposal per skill vs its most-confusable neighbor
        best_neighbor: dict = {}
        for a, b, sig in confusable:
            for s, other in ((a, b), (b, a)):
                cur = best_neighbor.get(s.name)
                if cur is None or sig["score"] > cur[1]:
                    best_neighbor[s.name] = (other, sig["score"])
        all_names = [s.name for s in skills]
        print(f"[phase] proposals: {len(best_neighbor)} skills vs best neighbor", flush=True)
        prop_futs = {executor.submit(generate_proposal, client, s,
                                     best_neighbor[s.name][0], all_names): s.name
                     for s in skills if s.name in best_neighbor}
        skills_by_name = {s.name: s for s in skills}
        proposals: dict = {}
        for fut, name in prop_futs.items():
            p = fut.result()
            p["neighbor"] = best_neighbor[name][0].name
            p["file"] = skills_by_name[name].path
            p["before"] = skills_by_name[name].description
            p["mtime_at_proposal"] = skills_by_name[name].mtime
            proposals[name] = p
        prop_ok_n = sum(1 for p in proposals.values() if p["status"] == "proposed")
        print(f"[phase] proposals: proposed={prop_ok_n} "
              f"rejected={len(proposals) - prop_ok_n}", flush=True)

        # -- assemble the query battery (body + trap; duplicate texts skipped)
        queries: list = []
        seen_texts = set()
        duplicate_drops = 0
        for s in skills:
            for t in body_batches.get(s.name, {}).get("queries", []):
                if t.lower() in seen_texts:
                    duplicate_drops += 1
                    continue
                seen_texts.add(t.lower())
                queries.append(BatteryQuery(text=t, target=s.name, kind="body"))
        for (an, bn), batch in trap_batches.items():
            for q in batch["queries"]:
                if q["text"].lower() in seen_texts:
                    duplicate_drops += 1
                    continue
                seen_texts.add(q["text"].lower())
                queries.append(BatteryQuery(text=q["text"], target=q["target"],
                                            kind="trap", pair=(an, bn)))
        if not queries:
            print("ERROR: no valid queries were generated — nothing to probe.", file=sys.stderr)
            ctx = {
                "ts": ts, "k": args.k_body, "threshold": args.threshold, "cap": args.cap,
                "base_url": base_url, "model": model, "endpoint_ok": True,
                "skills": skills, "agents": agents, "mcp": mcp, "kb": kb,
                "pairs": confusable, "pair_results": [], "all_proposals": [],
                "probe_calls": client.calls, "probe_tokens": client.tokens,
                "recommendations": ["Query generation produced no valid queries — "
                                    "inspect drop reasons and re-run."],
            }
            report_path = out_dir / f"report-{ts}.md"
            write_report(report_path, ctx)
            append_journal(out_dir / "journal.jsonl",
                           journal_record(0, zero_overall, "n/a", 0,
                                          error="no valid queries generated",
                                          report=report_path.name))
            return 2

        # -- phase 4: full-list battery (CURRENT / PROPOSED / MUTATED)
        mutated_pair = (confusable[0][0].name, confusable[0][1].name) if confusable else None
        n_prop_probe_jobs = sum(1 for q in queries
                                if (proposals.get(q.target) or {}).get("status") == "proposed")
        print(f"[phase] full-list battery: {len(queries)} queries x "
              f"(current + mutated + {n_prop_probe_jobs} proposed) candidates="
              f"{len(skills)}", flush=True)
        battery = run_full_list_battery(client, executor, queries, skills,
                                        proposals, mutated_pair)
    finally:
        executor.shutdown(wait=True)
    wall = round(time.monotonic() - wall_start, 1)

    metrics = compute_battery_metrics(battery["results"], proposals, confusable)
    ov = metrics["overall"]
    if confusable:
        sens_passed, sens_reason = sensitivity_gate(
            ov["current"]["correct"], ov["current"]["total"],
            ov["mutated"]["correct"], ov["mutated"]["total"])
        sensitivity = "pass" if sens_passed else "fail"
    else:
        sens_passed, sensitivity = False, "n/a"
        sens_reason = "no confusable pairs — no mutated control possible"
    probe_invalid = "sensitivity check failed" if sensitivity == "fail" else None

    all_proposals = []
    for name in sorted(proposals):
        p = proposals[name]
        ps = metrics["per_skill"].get(name, {})
        all_proposals.append({
            "id": f"p-{len(all_proposals) + 1:03d}",
            "pair": [name, p.get("neighbor")],
            "skill": name, "file": p.get("file"),
            "before": p.get("before"), "after": p.get("after"),
            "rationale": p.get("rationale"), "status": p.get("status"),
            "reject_reason": p.get("reject_reason"),
            "attempts": p.get("attempts", 1),
            "mtime_at_proposal": p.get("mtime_at_proposal"),
            "accepted_by_probe": ps.get("accepted_by_probe", False),
            "probe": {"targeted_current": ps.get("targeted_current"),
                      "targeted_proposed": ps.get("targeted_proposed")},
        })
    accepted_by_probe_n = sum(1 for p in all_proposals if p.get("accepted_by_probe"))

    ctx = {
        "ts": ts, "k_body": args.k_body, "k_trap": args.k_trap,
        "threshold": args.threshold, "cap": args.cap,
        "leak_max_stems": args.leak_max_stems,
        "min_trap_stems": args.min_trap_stems,
        "ban_name_stems": args.ban_target_name_stems,
        "base_url": base_url, "model": model, "endpoint_ok": True,
        "skills": skills, "agents": agents, "mcp": mcp, "kb": kb,
        "pairs": confusable,
        "battery": {
            "results": battery["results"],
            "body_batches": body_batches, "trap_batches": trap_batches,
            "mutated_pair": list(mutated_pair) if mutated_pair else None,
            "duplicate_drops": duplicate_drops,
            "call_failures": battery["call_failures"],
            "avg_latency": battery["avg_latency"],
            "wall_seconds": wall,
        },
        "metrics": metrics,
        "sensitivity": {"verdict": sensitivity, "reason": sens_reason},
        "probe_invalid": probe_invalid,
        "all_proposals": all_proposals,
        "probe_calls": client.calls, "probe_tokens": client.tokens,
        "recommendations": build_recommendations_v1(metrics, sensitivity,
                                                    all_proposals, kb),
    }
    report_path = out_dir / f"report-{ts}.md"
    write_report(report_path, ctx)
    props = build_proposals_json(ctx)
    proposals_path = out_dir / f"proposals-{ts}.json"
    proposals_path.write_text(json.dumps(props, ensure_ascii=False, indent=2),
                              encoding="utf-8")
    overall_str = {
        "current": f"{ov['current']['correct']}/{ov['current']['total']}",
        "proposed": f"{ov['proposed']['correct']}/{ov['proposed']['probed']}",
        "mutated": f"{ov['mutated']['correct']}/{ov['mutated']['total']}",
    }
    append_journal(out_dir / "journal.jsonl",
                   journal_record(len(queries), overall_str, sensitivity,
                                  accepted_by_probe_n,
                                  probe_invalid=probe_invalid,
                                  report=report_path.name,
                                  proposals=proposals_path.name))

    proposed_n = sum(1 for p in all_proposals if p["status"] == "proposed")
    print(
        f"pi-harness2 v1 run {ts}: skills={len(skills)} pairs={len(confusable)} "
        f"proposals={proposed_n} (rejected {len(all_proposals) - proposed_n}) "
        f"queries={len(queries)} | current {overall_str['current']} "
        f"({ov['current']['rate']:.0%}) vs proposed {overall_str['proposed']} "
        f"({ov['proposed']['rate']:.0%}) vs MUTATED {overall_str['mutated']} "
        f"({ov['mutated']['rate']:.0%})"
    )
    if probe_invalid:
        print(f"WARNING: {probe_invalid} — sensitivity {sensitivity} ({sens_reason}). "
              "Run marked probe_invalid; harden queries and re-run.", flush=True)
    else:
        print(f"sensitivity: {sensitivity} — {sens_reason}", flush=True)
    print(f"probe totals: calls={client.calls}/{args.cap} tokens={client.tokens} "
          f"wall={wall}s "
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
    p_run.add_argument("--k-body", type=int, default=DEFAULT_K_BODY,
                       help="body-grounded queries per skill (generated from SKILL.md body, "
                            "description withheld, stem-leak validated)")
    p_run.add_argument("--k-trap", type=int, default=DEFAULT_K_TRAP,
                       help="neighbor-vocabulary trap queries per confusable pair "
                            "(split across both directions)")
    p_run.add_argument("--leak-max-stems", type=int, default=LEAK_MAX_SHARED,
                       help="reject a generated query when MORE than this many word-stems "
                            "are shared with the target description")
    p_run.add_argument("--min-trap-stems", type=int, default=MIN_TRAP_NEIGHBOR_STEMS,
                       help="trap queries must reuse at least this many neighbor-description stems")
    p_run.add_argument("--ban-target-name-stems", action="store_true",
                       help="hardness++: also reject queries containing any stem of the "
                            "target skill's name")
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
