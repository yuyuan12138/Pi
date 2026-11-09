#!/usr/bin/env python3
"""skills_doctor — inventory and health-check pi skills across the scan roots.

pi 1.5.0 loads skills from three roots:
  1. <agentDir>/skills                      (user skills)
  2. <cwd>/.pi/skills                       (project skills)
  3. extension skillPaths, e.g. the pi-telegram package's dist/skills

This tool:
  - inventories every skill (name, root, description, mtime)
  - loads them through the REAL installed 1.5.0 loader (dist/core/skills.js)
    with skillPaths passed explicitly (includeDefaults alone + empty
    skillPaths is a known trap: project/extension skills would be missed)
  - detects:
      * duplicate names across roots (loader collisions + walk cross-check)
      * malformed / description-less entries the loader silently skips
        (missing frontmatter, missing description, invalid name, ...)
      * stale facts in SKILL.md bodies (dead model names presented as
        current, removed hostnames/aliases)
      * references to paths/files that no longer exist (checked against the
        skill dir, the containing git root and its depth-1 child repos, and
        the doctor cwd; remote-only artifacts are exempted explicitly)
      * description overlap pairs (name+description similarity above a
        threshold — Skill++ style router-displacement risk)
  - writes a human report and a JSON dump

Usage:
  python3 tools/skills_doctor.py [--json OUT.json] [--threshold 0.60]
                                 [--no-loader] [--quiet]

Exit codes: 0 = no findings, 1 = findings reported, 2 = tool error.
The loader run is skipped with --no-loader (offline mode used by tests).
"""

from __future__ import annotations

import argparse
import difflib
import json
import os
import re
import subprocess
import sys
import tempfile
from datetime import datetime, timezone
from pathlib import Path

# --------------------------------------------------------------------------
# Configuration
# --------------------------------------------------------------------------

AGENT_DIR = Path.home() / ".pi" / "agent"
CWD = Path("/Users/yuyuan/PiAgents")
RELEASE_DIR = AGENT_DIR / "install" / "releases" / "1.5.0"
LOADER_JS = (
    RELEASE_DIR
    / "node_modules/@earendil-works/pi-coding-agent/dist/core/skills.js"
)
TELEGRAM_SKILLS = (
    AGENT_DIR / "npm/node_modules/@llblab/pi-telegram/dist/skills"
)

MAX_NAME_LENGTH = 64
MAX_DESCRIPTION_LENGTH = 1024
NAME_RE = re.compile(r"^[a-z0-9-]+$")

# Stale-fact patterns: (id, compiled regex, reason). Extensible — add a tuple
# when a fact dies (retired model, removed host/alias, renamed tool).
STALE_FACT_PATTERNS = [
    (
        "dead-model-qwen3-5",
        re.compile(r"\bQwen3-5\b", re.IGNORECASE),
        "dead model name 'Qwen3-5' presented as current (retired as a "
        "current/default model; episode default is deepseek via axonhub, "
        "subagent default GLM-5.3-Flash)",
    ),
    (
        "removed-host-chenzhuang",
        re.compile(r"\bChenZhuang-Remote\b"),
        "removed SSH alias 'ChenZhuang-Remote' (production MC host is "
        "wangruojun@49.235.120.201 via pinned ssh_once ED25519 transport)",
    ),
    (
        "removed-host-wangruojun-docker-01",
        re.compile(r"\bwangruojun-docker-01\b"),
        "removed hostname 'wangruojun-docker-01' (production MC host is "
        "wangruojun@49.235.120.201 via pinned ssh_once ED25519 transport)",
    ),
]

# Tokens that are documented remote-host artifacts (created/read on the
# production MC host, not local files) — exempt from the missing-reference
# check. Keep this list short and cited; local scripts must never go here.
REMOTE_ONLY_REFERENCES = {
    "preflight-report.json",
    "episode-config.json",
    "prepared-artifact.json",
    "run-marker.json",
    "final-report.json",
    "summary.json",
    "server-owned.json",
    "owned-resources.jsonl",
    "remote-stderr.log",
    "server.properties",
    "level.dat",
}

# OOXML zip parts (word/, ppt/, xl/ ...) live inside .docx/.pptx/.xlsx
# archives, not on the filesystem — never filesystem references.
VIRTUAL_PATH_PREFIXES = ("ppt/", "word/", "xl/")

# Placeholder segments in prose and workflow examples ("path/to/x.html",
# "your_server.py", "footage/clip_a.mp4") — template/runtime text, not
# concrete references to files that should exist.
PLACEHOLDER_SEGMENTS = {
    "path", "to", "your", "example", "some", "my", "dest",
    "footage", "segments", "highlights", "output", "outputs",
    "generated", "clips", "temp", "tmp", "build", "repo-root",
}
PLACEHOLDER_SEGMENT_RE = re.compile(
    r"^(your(?:[_-].*)?|path[-_]?to.*|.*-N)$", re.IGNORECASE
)
# case-SENSITIVE: a literal 'NN' inside a lowercase word is a numeric
# placeholder ('waveNN-reset-driver.py'), not a real filename
PLACEHOLDER_NN_RE = re.compile(r"^[a-z0-9.\/-]*NN[a-z0-9.\/-]*$")

# Lines matching this (or the 3 lines above, for list intros like
# "The parent creates ... shared run files:") describe files the workflow
# CREATES — outputs, not references. Such tokens are not flagged.
OUTPUT_CONTEXT_RE = re.compile(
    r"\b(creat(?:e|es|ed|ing)|writ(?:e|es|ing|ten)|sav(?:e|es|ed|ing)"
    r"|produc(?:e|es|ing|ed)|generat(?:e|es|ing|ed)|emits?|stores?"
    r"|output|outputs|writer|fresh|new writable)\b",
    re.IGNORECASE,
)
EXAMPLE_CONTEXT_RE = re.compile(
    r"\b(e\.g\.|i\.e\.|such as|for example|example:|named|called)\b",
    re.IGNORECASE,
)
# Command-example lines: a token following a --flag is that flag's example
# value, not a filesystem reference.
CLI_FLAG_VALUE_RE = re.compile(r"--?[A-Za-z][A-Za-z0-9_-]*\s+$")
# ASCII file-tree example lines (├── references/ └── aws.md)
TREE_LINE_RE = re.compile(r"[├└│]", re.IGNORECASE)

# Path-like token extraction. A token qualifies if it contains '/' (relative
# or absolute path) or ends with a known file extension (bare script name).
KNOWN_EXTENSIONS = {
    ".py", ".md", ".json", ".sh", ".js", ".cjs", ".mjs", ".ts", ".tsx",
    ".yaml", ".yml", ".toml", ".cfg", ".ini", ".txt", ".html", ".css",
    ".csv", ".c", ".h", ".rs", ".go", ".sql",
}
PATH_TOKEN_RE = re.compile(r"[A-Za-z0-9_.@+-]*(?:/[A-Za-z0-9_.@+-]+)+/?[A-Za-z0-9_.@+-]*|[A-Za-z0-9_.@+-]+\.[A-Za-z0-9]+")
URL_RE = re.compile(r"[a-zA-Z][a-zA-Z0-9+.-]*://")
DEFAULT_THRESHOLD = 0.60

SEV_ERROR = "error"
SEV_WARNING = "warning"
SEV_INFO = "info"


class SkillsDoctorError(RuntimeError):
    """Raised when the doctor itself cannot run."""


# --------------------------------------------------------------------------
# Real loader (node subprocess)
# --------------------------------------------------------------------------

LOADER_RUNNER = """\
import {{ loadSkills, loadSkillsFromDir }} from '{loader}';
const cfg = JSON.parse(process.argv[2]);
const out = {{ global: null, perDir: {{}} }};
out.global = loadSkills({{
  agentDir: cfg.agentDir,
  skillPaths: cfg.skillPaths,
  includeDefaults: cfg.includeDefaults,
  cwd: cfg.cwd,
}});
for (const dir of cfg.probeDirs || []) {{
  out.perDir[dir] = loadSkillsFromDir({{ dir, source: 'path' }});
}}
process.stdout.write(JSON.stringify(out));
"""


def run_real_loader(
    agent_dir: str,
    skill_paths: list[str],
    cwd: str,
    probe_dirs: list[str] | None = None,
    include_defaults: bool = True,
    loader_js: Path | None = None,
) -> dict:
    """Run the real installed pi loader; return its parsed output."""
    loader_js = Path(loader_js or LOADER_JS)
    if not loader_js.exists():
        raise SkillsDoctorError(f"loader not installed at {loader_js}")
    script = LOADER_RUNNER.format(loader=str(loader_js).replace("'", "\\'"))
    cfg = {
        "agentDir": agent_dir,
        "skillPaths": skill_paths,
        "includeDefaults": include_defaults,
        "cwd": cwd,
        "probeDirs": probe_dirs or [],
    }
    with tempfile.NamedTemporaryFile(
        "w", suffix=".mjs", delete=False
    ) as handle:
        handle.write(script)
        script_path = handle.name
    try:
        proc = subprocess.run(
            ["node", script_path, json.dumps(cfg)],
            capture_output=True,
            text=True,
            timeout=60,
        )
    finally:
        os.unlink(script_path)
    if proc.returncode != 0:
        raise SkillsDoctorError(
            f"loader subprocess failed (rc={proc.returncode}): "
            f"{proc.stderr.strip()[:500]}"
        )
    try:
        return json.loads(proc.stdout)
    except json.JSONDecodeError as exc:
        raise SkillsDoctorError(f"loader output not JSON: {exc}") from exc


# --------------------------------------------------------------------------
# Frontmatter (minimal mirror of the loader's expectations; the loader stays
# authoritative — this parser only classifies skipped entries and splits the
# body for stale-fact / reference scans)
# --------------------------------------------------------------------------

def split_frontmatter(text: str) -> tuple[dict | None, str, str | None, int]:
    """Return (frontmatter|None, body, error, line_offset). Mirrors
    utils/frontmatter.js block extraction; parses simple top-level scalars
    only. line_offset = lines before the body (body line numbers convert to
    file line numbers by adding it)."""
    normalized = text.replace("\r\n", "\n").replace("\r", "\n")
    normalized = normalized.lstrip("﻿")
    if not normalized.startswith("---"):
        return None, normalized, None, 0
    end = normalized.find("\n---", 3)
    if end == -1:
        return None, normalized, "frontmatter block not closed ('---' terminator missing)", 0
    yaml_string = normalized[4:end]
    body_start = end + 4
    raw_body = normalized[body_start:]
    lead = len(raw_body) - len(raw_body.lstrip())
    body = raw_body.strip()
    # file-relative line offset: number of newlines before the first body
    # character (body was stripped of leading whitespace like the loader's
    # .trim())
    line_offset = normalized.count("\n", 0, body_start + lead)
    fm: dict = {}
    for raw_line in yaml_string.split("\n"):
        line = raw_line.rstrip()
        if not line.strip() or line.strip().startswith("#"):
            continue
        if line[:1] in (" ", "\t"):
            continue  # nested YAML — not needed for name/description
        match = re.match(r"^([A-Za-z0-9_-]+)\s*:\s*(.*)$", line)
        if not match:
            continue
        key, value = match.group(1), match.group(2).strip()
        if len(value) >= 2 and value[0] == value[-1] and value[0] in "'\"":
            value = value[1:-1]
        fm.setdefault(key, value)
    return fm, body, None, line_offset


def validate_skill_meta(fm: dict | None, declared: bool) -> list[str]:
    """Return loader-equivalent validation problems for a skill file."""
    problems: list[str] = []
    if fm is None:
        problems.append("no frontmatter block")
        return problems
    name = fm.get("name")
    if not isinstance(name, str) or not name:
        if declared:
            problems.append("no 'name' in frontmatter (falls back to dir name)")
    else:
        if len(name) > MAX_NAME_LENGTH:
            problems.append(
                f"name exceeds {MAX_NAME_LENGTH} characters ({len(name)})"
            )
        if not NAME_RE.match(name):
            problems.append(
                "name contains invalid characters (must be lowercase a-z, "
                "0-9, hyphens only)"
            )
        if name.startswith("-") or name.endswith("-") or "--" in name:
            problems.append("name must not start/end with '-' or contain '--'")
    description = fm.get("description")
    if not isinstance(description, str) or not description.strip():
        problems.append("description is required (loader skips the skill)")
    elif len(description) > MAX_DESCRIPTION_LENGTH:
        problems.append(
            "description exceeds "
            f"{MAX_DESCRIPTION_LENGTH} characters ({len(description)})"
        )
    return problems


# --------------------------------------------------------------------------
# Root walk (mirrors loader discovery: SKILL.md marks a skill root and stops
# recursion; otherwise only top-level .md children are candidates)
# --------------------------------------------------------------------------

def walk_root(root: Path) -> list[dict]:
    """Find candidate skill files under one root. Returns entries with
    path, declared (SKILL.md or not), and dir."""
    entries: list[dict] = []
    if not root.exists():
        return entries

    def visit(directory: Path, top_level: bool) -> None:
        try:
            children = sorted(directory.iterdir())
        except OSError:
            return
        skill_file = next(
            (c for c in children if c.name == "SKILL.md" and c.is_file()), None
        )
        if skill_file is not None:
            entries.append(
                {"path": skill_file, "declared": True, "dir": directory}
            )
            return  # skill root: loader does not recurse further
        for child in children:
            if child.name.startswith(".") or child.name == "node_modules":
                continue
            if child.is_dir():
                visit(child, False)
            elif top_level and child.is_file() and child.suffix == ".md":
                entries.append(
                    {"path": child, "declared": False, "dir": directory}
                )

    visit(root, True)
    return entries


def root_label_for(path: Path, roots: list[tuple[str, Path]]) -> str:
    resolved = path.resolve()
    for label, root in roots:
        try:
            resolved.relative_to(root.resolve())
            return label
        except ValueError:
            continue
    return "unknown"


# --------------------------------------------------------------------------
# Stale facts + reference checks
# --------------------------------------------------------------------------

def scan_stale_facts(name: str, description: str, body: str, line_offset: int = 0) -> list[dict]:
    findings: list[dict] = []
    for source, text, offset in (
        ("description", description, 0),
        ("body", body, line_offset),
    ):
        for pattern_id, pattern, reason in STALE_FACT_PATTERNS:
            for match in pattern.finditer(text):
                line_no = text.count("\n", 0, match.start()) + 1 + offset
                findings.append(
                    {
                        "skill": name,
                        "check": "stale_fact",
                        "severity": SEV_ERROR,
                        "pattern": pattern_id,
                        "source": source,
                        "line": line_no if source == "body" else None,
                        "excerpt": text[max(0, match.start() - 40):match.end() + 40].strip(),
                        "reason": reason,
                    }
                )
    return findings


def _has_known_ext(token: str) -> bool:
    return Path(token).suffix in KNOWN_EXTENSIONS


def _is_domainish(first_segment: str) -> bool:
    """'doi.org', '10.1038', 'www.overleaf.com' — a dotted first segment
    with no leading './' is a domain/DOI, not a relative path."""
    return "." in first_segment and not first_segment.startswith(".")


def _qualifies(token: str) -> bool:
    if len(token) < 3 or " " in token or token.endswith("/"):
        return False
    if URL_RE.search(token):
        return False
    segments = token.split("/")
    if any(seg in PLACEHOLDER_SEGMENTS for seg in segments):
        return False
    if any(PLACEHOLDER_SEGMENT_RE.match(seg) for seg in segments):
        return False
    if any(PLACEHOLDER_NN_RE.match(seg) for seg in segments):
        return False
    if token.startswith(VIRTUAL_PATH_PREFIXES):
        return False
    if "/" not in token:
        return _has_known_ext(token)
    if _is_domainish(segments[0]):
        return False
    # prose/permission junk: '775/664', '10/month', '502/timeout'
    if segments[0].isdigit() and len(segments[0]) <= 4:
        return False
    if _has_known_ext(token):
        return True
    # Extension-less slash token: prose pairs like '4/10', 'before/after',
    # 'I/O', 'Zotero/pyzotero' are not paths. Require a digit or underscore
    # in some segment as a path-y signal.
    if len(token) < 5:
        return False
    if any(len(seg) <= 1 for seg in segments):
        return False
    return any(
        any(ch in seg for ch in "0123456789_")
        for seg in segments
    )


def extract_path_tokens(body: str, line_offset: int = 0) -> list[dict]:
    """Extract path-like candidate tokens from backtick spans, bare text,
    and markdown link targets. Returns dicts with token, file-relative line
    (1-based), and context for suppression heuristics."""
    found: list[dict] = []
    seen: set[str] = set()
    lines = body.split("\n")

    def suppress(token: str, line_idx: int, before: str) -> bool:
        """True when the token is an example/output, not a real reference."""
        own = lines[line_idx]
        if OUTPUT_CONTEXT_RE.search(own):
            return True
        if EXAMPLE_CONTEXT_RE.search(own):
            return True
        if TREE_LINE_RE.search(own):
            return True
        if CLI_FLAG_VALUE_RE.search(before[-16:]):
            return True
        # A bare list item ('- `run-metadata.json`') may be an output
        # declared by an intro line above ("The parent creates ...:").
        stripped = own.lstrip()
        if stripped.startswith(("-", "*", "+")) and "`" in own:
            window = "\n".join(lines[max(0, line_idx - 6): line_idx + 1])
            if OUTPUT_CONTEXT_RE.search(window):
                return True
        return False

    def add(raw: str, line_idx: int, before: str) -> None:
        token = raw.strip().strip(".,;:-_")
        token = re.sub(r":\d+$", "", token)  # strip file.py:123 line refs
        if not _qualifies(token) or token in seen:
            return
        # field-list junk: '(run_id/actor_id/source_sha256' — every segment
        # an underscore identifier inside a parenthesis
        if (
            "/" in token
            and all("_" in seg for seg in token.split("/"))
            and not _has_known_ext(token)
            and before.rstrip().endswith("(")
        ):
            return
        if suppress(token, line_idx, before):
            return
        seen.add(token)
        found.append({"token": token, "line": line_idx + 1 + line_offset})

    for span_match in re.finditer(r"`([^`\n]+)`", body):
        span = span_match.group(1)
        line_idx = body.count("\n", 0, span_match.start())
        if URL_RE.search(span) or "<" in span or ">" in span or "$" in span:
            continue  # URL or placeholder template, not a concrete path
        for match in PATH_TOKEN_RE.finditer(span):
            if match.start() > 0 and span[match.start() - 1] == ":":
                continue  # namespaced id like 'minecraft:story/enter_the_end'
            add(match.group(0), line_idx, span[: match.start()])
    plain = URL_RE.sub(" ", body)
    for match in PATH_TOKEN_RE.finditer(plain):
        if match.start() > 0 and plain[match.start() - 1] == ":":
            continue
        # <metavar> placeholders: token inside angle brackets in bare text
        if plain[match.start() - 1: match.start()] == "<" or plain[match.end(): match.end() + 1] == ">":
            continue
        add(
            match.group(0),
            plain.count("\n", 0, match.start()),
            plain[max(0, match.start() - 16): match.start()],
        )
    # markdown link targets: [text](references/foo.md#anchor)
    for link_match in re.finditer(r"\]\(([^)\s]+)\)", body):
        target = link_match.group(1)
        if URL_RE.search(target) or target.startswith("#"):
            continue
        target = target.split("#")[0]
        if not target:
            continue
        line_idx = body.count("\n", 0, link_match.start())
        add(
            target,
            line_idx,
            body[max(0, link_match.start() - 16): link_match.start()],
        )
    return found


def declared_abs_dirs(body: str, limit: int = 4) -> list[Path]:
    """Absolute directories declared in the skill body (external repo
    checkouts, /tmp workspaces) that currently exist."""
    out: list[Path] = []
    seen: set[str] = set()
    for match in re.finditer(r"`?(/(?:[A-Za-z0-9_.@+-]+/)+[A-Za-z0-9_.@+-]+)/?`?", body):
        candidate = Path(match.group(1))
        key = str(candidate)
        if key in seen:
            continue
        seen.add(key)
        if candidate.is_dir():
            out.append(candidate)
            if len(out) >= limit:
                break
    return out


def reference_bases(skill_dir: Path, cwd: Path, body: str = "") -> list[Path]:
    """Candidate bases for resolving relative references: the skill dir, its
    ancestors (through a containing extension package when under
    node_modules), every ancestor up to and including a git root, depth-1
    children of the git root, absolute directories declared in the skill body
    (e.g. an external repo path), and the doctor cwd."""
    bases: list[Path] = [skill_dir.resolve()]
    # extension package: add ancestors through the package root
    probe = skill_dir.resolve()
    for _ in range(10):
        if probe.parent.name == "node_modules":
            bases.append(probe)  # package root
            break
        if probe.parent == probe:
            break
        probe = probe.parent
    git_root: Path | None = None
    current = skill_dir.resolve()
    for _ in range(8):
        if (current / ".git").exists():
            git_root = current
            break
        if current.parent == current:
            break
        current = current.parent
    if git_root is not None:
        walk = git_root
        while True:
            if walk not in bases:
                bases.append(walk)
            if walk.parent == walk:
                break
            walk = walk.parent
        for child in sorted(git_root.iterdir()):
            if child.is_dir() and not child.name.startswith("."):
                bases.append(child)
    # absolute directories declared in the body (external repo checkouts)
    for candidate in declared_abs_dirs(body):
        if candidate not in bases:
            bases.append(candidate)
    if cwd not in bases:
        bases.append(cwd)
    return bases


def repo_filename_index(git_root: Path) -> set[str]:
    """Bare filenames present in the git root's tree (pruned walk)."""
    names: set[str] = set()
    prune = {".git", "node_modules", "__pycache__"}
    prefix_prune = ("artifact-", "records-", "world-used-", "prepared-", "auto-")
    count = 0
    for base, dirs, files in os.walk(git_root):
        dirs[:] = [
            d for d in dirs
            if d not in prune and not d.startswith(prefix_prune)
        ]
        for file_name in files:
            names.add(file_name)
            count += 1
            if count > 200_000:
                return names
    return names


def check_references(
    name: str,
    body: str,
    skill_dir: Path,
    cwd: Path,
    filename_index: set[str] | None,
    line_offset: int = 0,
) -> list[dict]:
    findings: list[dict] = []
    bases = reference_bases(skill_dir, cwd, body)
    for token_info in extract_path_tokens(body, line_offset=line_offset):
        token = token_info["token"]
        line_no = token_info["line"]
        if token in REMOTE_ONLY_REFERENCES or Path(token).name in REMOTE_ONLY_REFERENCES:
            continue
        candidates = []
        if token.startswith("~/"):
            candidates.append(Path.home() / token[2:])
        elif token.startswith("/."):
            # '/.pi/agent/...' convention: home-rooted, not filesystem root
            candidates.append(Path.home() / token.lstrip("/"))
        elif token.startswith("/"):
            # '/scripts/x.py' convention: skill-dir-rooted, not filesystem
            # root; '/tmp/...' and other absolutes checked as written
            candidates.append(skill_dir / token.lstrip("/"))
            candidates.append(Path(token))
        else:
            candidates.extend(base / token for base in bases)
        if any(candidate.exists() for candidate in candidates):
            continue
        bare = Path(token).name
        if filename_index and bare in filename_index:
            continue
        # extension-less multi-segment token whose FIRST segment is not a
        # directory anywhere: an identifier enumeration ('lava/hazard_floor',
        # 'anchor/radius/leashDist'), not a filesystem path
        if not _has_known_ext(token):
            first_seg = token.split("/")[0]
            dir_anywhere = any(
                (base / first_seg).is_dir()
                for base in [*bases, Path.home()]
            )
            if not dir_anywhere:
                continue
        findings.append(
            {
                "skill": name,
                "check": "missing_reference",
                "severity": SEV_INFO,
                "token": token,
                "line": line_no,
                "reason": "referenced path not found locally (remote-only, "
                          "generated, or dead — review)",
            }
        )
    return findings


# --------------------------------------------------------------------------
# Overlap detection
# --------------------------------------------------------------------------

def _normalize_for_sim(text: str) -> str:
    return re.sub(r"[^a-z0-9 ]+", " ", text.lower()).strip()


def similarity(a: str, b: str) -> float:
    return difflib.SequenceMatcher(None, _normalize_for_sim(a), _normalize_for_sim(b)).ratio()


def find_overlaps(skills: list[dict], threshold: float) -> list[dict]:
    pairs: list[dict] = []
    for i in range(len(skills)):
        for j in range(i + 1, len(skills)):
            a = skills[i]
            b = skills[j]
            score = similarity(
                f"{a['name']} {a['description']}",
                f"{b['name']} {b['description']}",
            )
            if score >= threshold:
                pairs.append(
                    {
                        "check": "description_overlap",
                        "severity": SEV_WARNING,
                        "pair": [a["name"], b["name"]],
                        "roots": [a.get("root"), b.get("root")],
                        "similarity": round(score, 3),
                        "threshold": threshold,
                        "reason": "name/description similarity above "
                                  "threshold — router-displacement risk "
                                  "(one description should defer to the "
                                  "other or be narrowed)",
                    }
                )
    pairs.sort(key=lambda item: -item["similarity"])
    return pairs


# --------------------------------------------------------------------------
# Main scan
# --------------------------------------------------------------------------

def scan(
    roots: list[tuple[str, Path]],
    *,
    agent_dir: Path = AGENT_DIR,
    cwd: Path = CWD,
    threshold: float = DEFAULT_THRESHOLD,
    use_loader: bool = True,
    include_defaults: bool = True,
) -> dict:
    default_paths = {
        str((agent_dir / "skills").resolve()),
        str((cwd / ".pi" / "skills").resolve()),
    }
    # the real loader's skillPaths: every root that is not one of the two
    # default locations (empty skillPaths + includeDefaults=False is the
    # known 0-skills trap)
    skill_paths = [
        str(Path(path).resolve())
        for label, path in roots
        if str(Path(path).resolve()) not in default_paths
    ]
    loader_result: dict | None = None
    loader_error: str | None = None
    if use_loader:
        try:
            # Pass 1: global load. probeDirs filled after the walk below.
            loader_result = run_real_loader(
                str(agent_dir), skill_paths, str(cwd), probe_dirs=[],
                include_defaults=include_defaults,
            )
        except SkillsDoctorError as exc:
            loader_error = str(exc)
            loader_result = None

    # Inventory walk
    inventory: list[dict] = []
    walk_entries: list[dict] = []
    for label, root in roots:
        for entry in walk_root(root):
            entry["root"] = label
            walk_entries.append(entry)
    loaded_by_path: dict[str, dict] = {}
    loader_diagnostics: list[dict] = []
    collisions: list[dict] = []
    if loader_result:
        for skill in loader_result["global"]["skills"]:
            loaded_by_path[skill["filePath"]] = skill
        loader_diagnostics = loader_result["global"]["diagnostics"]
        collisions = [
            d for d in loader_diagnostics if d.get("type") == "collision"
        ]
    diag_paths: dict[str, list[str]] = {}
    for diag in loader_diagnostics:
        diag_paths.setdefault(diag.get("path", ""), []).append(
            diag.get("message", "")
        )

    for entry in walk_entries:
        path = entry["path"]
        try:
            stat = path.stat()
            mtime = datetime.fromtimestamp(stat.st_mtime, tz=timezone.utc)
            text = path.read_text(encoding="utf-8", errors="replace")
        except OSError as exc:
            inventory.append(
                {
                    "name": None,
                    "root": entry["root"],
                    "path": str(path),
                    "mtime": None,
                    "description": None,
                    "read_error": str(exc),
                }
            )
            continue
        fm, body, fm_error, _ = split_frontmatter(text)
        description = fm.get("description") if fm else None
        name = fm.get("name") if fm else None
        if not name:
            name = entry["dir"].name if entry["declared"] else path.stem
        inventory.append(
            {
                "name": name,
                "root": entry["root"],
                "path": str(path),
                "mtime": mtime.isoformat(),
                "description": description,
                "declared": entry["declared"],
                "loaded": str(path) in loaded_by_path,
            }
        )

    # Probe silently-skipped declared skills through the real loader
    silent_skips: list[dict] = []
    if loader_result is not None:
        loaded_paths = set(loaded_by_path)
        # Probe per ROOT (not per skill dir): the loader applies .gitignore
        # and other rules relative to the root, which a deeper probe would
        # bypass.
        skipped_entries = [
            entry for entry in walk_entries
            if str(entry["path"]) not in loaded_paths
            and str(entry["path"]) not in diag_paths
            and entry["declared"]
        ]
        root_path_by_label = {label: str(Path(path).resolve()) for label, path in roots}
        probe_roots: dict[str, list[dict]] = {}
        for entry in skipped_entries:
            root_str = root_path_by_label.get(entry["root"], str(entry["dir"]))
            probe_roots.setdefault(root_str, []).append(entry)
        if probe_roots:
            try:
                probe_result = run_real_loader(
                    str(agent_dir), skill_paths, str(cwd),
                    probe_dirs=list(probe_roots),
                    include_defaults=include_defaults,
                )
            except SkillsDoctorError as exc:
                loader_error = loader_error or str(exc)
                probe_result = None
            if probe_result:
                for root_str, entries in probe_roots.items():
                    root_result = probe_result["perDir"].get(root_str, {})
                    root_skills = {
                        s["filePath"] for s in root_result.get("skills", [])
                    }
                    root_diags: dict[str, list[str]] = {}
                    for d in root_result.get("diagnostics", []):
                        root_diags.setdefault(d.get("path", ""), []).append(
                            d.get("message", "")
                        )
                    for entry in entries:
                        path_str = str(entry["path"])
                        if path_str in root_skills:
                            # Loads from its root -> name shadowed by an
                            # earlier root (collision), not malformed.
                            reason = "skipped in global load: name shadowed " \
                                     "by an earlier root (collision)"
                            severity = SEV_WARNING
                        elif path_str in root_diags:
                            reason = "loader skip: " + "; ".join(root_diags[path_str])
                            severity = SEV_ERROR
                        else:
                            reason = "skipped with no loader diagnostics " \
                                     "(gitignore rule or shadowed file)"
                            severity = SEV_WARNING
                        silent_skips.append(
                            {
                                "skill": entry["dir"].name,
                                "check": "silently_skipped",
                                "severity": severity,
                                "path": path_str,
                                "reason": reason,
                            }
                        )

    # Walk-based classification of problems (works without the loader too)
    malformed: list[dict] = []
    duplicates: list[dict] = []
    for entry in walk_entries:
        path = entry["path"]
        try:
            text = path.read_text(encoding="utf-8", errors="replace")
        except OSError:
            continue
        fm, body, fm_error, _ = split_frontmatter(text)
        if fm_error:
            malformed.append(
                {
                    "skill": path.parent.name if entry["declared"] else path.stem,
                    "check": "malformed",
                    "severity": SEV_ERROR,
                    "path": str(path),
                    "reason": fm_error,
                }
            )
            continue
        problems = validate_skill_meta(fm, declared=entry["declared"])
        if entry["declared"]:
            for problem in problems:
                malformed.append(
                    {
                        "skill": (fm or {}).get("name") or entry["dir"].name,
                        "check": "malformed",
                        "severity": SEV_ERROR,
                        "path": str(path),
                        "reason": problem,
                    }
                )

    # Cross-root duplicate names from the walk
    by_name: dict[str, list[dict]] = {}
    for item in inventory:
        if item.get("name") and not item.get("read_error"):
            by_name.setdefault(item["name"], []).append(item)
    seen_dupe_paths: set[str] = set()
    for name, items in sorted(by_name.items()):
        roots_represented = {item["root"] for item in items}
        if len(items) > 1 or len(roots_represented) > 1:
            paths = [item["path"] for item in items]
            if not any(p in seen_dupe_paths for p in paths):
                seen_dupe_paths.update(paths)
                duplicates.append(
                    {
                        "check": "duplicate_name",
                        "severity": SEV_ERROR,
                        "name": name,
                        "paths": paths,
                        "roots": sorted(roots_represented),
                        "reason": "same skill name in multiple roots "
                                  "(loader keeps only the first root's copy)",
                    }
                )
    for collision in collisions:
        info = collision.get("collision", {})
        duplicates.append(
            {
                "check": "duplicate_name",
                "severity": SEV_ERROR,
                "name": info.get("name"),
                "winner": info.get("winnerPath"),
                "loser": info.get("loserPath"),
                "reason": f"loader collision: {collision.get('message')}",
            }
        )

    # Stale facts + references per skill
    stale: list[dict] = []
    missing_refs: list[dict] = []
    filename_index_cache: dict[str, set[str]] = {}

    def get_filename_index(skill_dir: Path, body: str = "") -> set[str]:
        """Union of the skill-dir tree index, the containing git-root tree
        index, and body-declared absolute dirs (each cached separately)."""
        git_root = None
        probe = skill_dir
        for _ in range(8):
            if (probe / ".git").exists():
                git_root = probe
                break
            if probe.parent == probe:
                break
            probe = probe.parent
        skill_key = f"skill:{skill_dir}"
        if skill_key not in filename_index_cache:
            names = set()
            prune = {".git", "node_modules", "__pycache__"}
            prefix_prune = ("artifact-", "records-", "world-used-", "prepared-", "auto-")
            for root, dirs, files in os.walk(skill_dir):
                dirs[:] = [d for d in dirs if d not in prune and not d.startswith(prefix_prune)]
                names.update(files)
            filename_index_cache[skill_key] = names
        index = set(filename_index_cache[skill_key])
        if git_root is not None:
            git_key = f"git:{git_root}"
            if git_key not in filename_index_cache:
                filename_index_cache[git_key] = repo_filename_index(git_root)
            index |= filename_index_cache[git_key]
        for declared_dir in declared_abs_dirs(body):
            dkey = f"declared:{declared_dir}"
            if dkey not in filename_index_cache:
                names = set()
                prune = {".git", "node_modules", "__pycache__"}
                for root, dirs, files in os.walk(declared_dir):
                    dirs[:] = [d for d in dirs if d not in prune]
                    names.update(files)
                    if len(names) > 50_000:
                        break
                filename_index_cache[dkey] = names
            index |= filename_index_cache[dkey]
        return index

    for entry in walk_entries:
        path = entry["path"]
        try:
            text = path.read_text(encoding="utf-8", errors="replace")
        except OSError:
            continue
        fm, body, _, line_offset = split_frontmatter(text)
        name = (fm or {}).get("name") or (
            entry["dir"].name if entry["declared"] else path.stem
        )
        description = (fm or {}).get("description", "") or ""
        stale.extend(
            scan_stale_facts(name, description, body, line_offset=line_offset)
        )
        skill_dir = Path(path).resolve().parent
        missing_refs.extend(
            check_references(
                name, body, skill_dir, cwd, get_filename_index(skill_dir, body),
                line_offset=line_offset,
            )
        )

    overlap_pairs = find_overlaps(
        [
            {
                "name": item["name"],
                "description": item.get("description") or "",
                "root": item["root"],
            }
            for item in inventory
            if item.get("name") and item.get("description")
        ],
        threshold,
    )

    findings = {
        "duplicates": duplicates,
        "malformed": malformed,
        "silently_skipped": silent_skips,
        "stale_facts": stale,
        "missing_references": missing_refs,
        "description_overlaps": overlap_pairs,
    }
    if loader_error:
        findings["loader_error"] = loader_error

    return {
        "generated_at": datetime.now(timezone.utc).isoformat(),
        "roots": [
            {"label": label, "path": str(root), "exists": root.exists()}
            for label, root in roots
        ],
        "loader": {
            "used": loader_result is not None,
            "loader_js": str(LOADER_JS),
            "loaded_count": (
                len(loader_result["global"]["skills"]) if loader_result else None
            ),
            "diagnostics": loader_diagnostics,
        },
        "inventory": inventory,
        "findings": findings,
        "summary": {
            "skills_on_disk": len(inventory),
            "loaded_by_loader": (
                len(loader_result["global"]["skills"]) if loader_result else None
            ),
            "duplicates": len(duplicates),
            "malformed": len(malformed),
            "silently_skipped": len(silent_skips),
            "stale_facts": len(stale),
            "missing_references": len(missing_refs),
            "description_overlaps": len(overlap_pairs),
        },
    }


# --------------------------------------------------------------------------
# Reporting
# --------------------------------------------------------------------------

def render_report(result: dict) -> str:
    lines: list[str] = []
    summary = result["summary"]
    lines.append("SKILLS DOCTOR — report")
    lines.append(f"generated: {result['generated_at']}")
    lines.append("")
    lines.append("Roots:")
    for root in result["roots"]:
        state = "ok" if root["exists"] else "MISSING"
        count = sum(
            1 for item in result["inventory"]
            if item["root"] == root["label"]
        )
        lines.append(f"  [{state}] {root['label']}: {root['path']} ({count} skills)")
    loader = result["loader"]
    lines.append("")
    if loader["used"]:
        lines.append(
            f"Real loader: {loader['loaded_count']} skills loaded, "
            f"{len(loader['diagnostics'])} loader diagnostics"
        )
    else:
        lines.append(f"Real loader: NOT USED ({result['findings'].get('loader_error', 'disabled')})")
    lines.append("")
    lines.append(
        f"Findings: {summary['duplicates']} duplicate(s), "
        f"{summary['malformed']} malformed, "
        f"{summary['silently_skipped']} silently skipped, "
        f"{summary['stale_facts']} stale fact(s), "
        f"{summary['missing_references']} missing reference(s), "
        f"{summary['description_overlaps']} overlap pair(s)"
    )

    sections = [
        ("Duplicates", "duplicates"),
        ("Malformed entries", "malformed"),
        ("Silently skipped", "silently_skipped"),
        ("Stale facts", "stale_facts"),
        ("Missing references", "missing_references"),
        ("Description overlaps", "description_overlaps"),
    ]
    for title, key in sections:
        items = result["findings"].get(key) or []
        lines.append("")
        lines.append(f"== {title} ({len(items)}) ==")
        if not items:
            lines.append("  none")
        for item in items:
            if item["check"] == "duplicate_name":
                loc = ", ".join(item.get("paths", []))
                lines.append(f"  - {item.get('name')}: {item['reason']} ({loc})")
            elif item["check"] == "description_overlap":
                lines.append(
                    f"  - {item['pair'][0]} <-> {item['pair'][1]}: "
                    f"similarity {item['similarity']} (threshold {item['threshold']})"
                )
            elif item["check"] == "missing_reference":
                lines.append(
                    f"  - {item['skill']}:{item['line']} -> {item['token']} "
                    f"({item['reason']})"
                )
            elif item["check"] == "stale_fact":
                where = f"{item['source']}:{item['line']}" if item.get("line") else item["source"]
                lines.append(
                    f"  - {item['skill']} [{where}] {item['pattern']}: {item['reason']}"
                )
            else:
                lines.append(f"  - {item.get('skill', '')}: {item['reason']} ({item.get('path', '')})")
    lines.append("")
    lines.append("Inventory:")
    for item in sorted(
        result["inventory"], key=lambda i: (i["root"], str(i["name"]))
    ):
        mtime = (item.get("mtime") or "?")[:19]
        desc = (item.get("description") or "")[:72]
        flags = []
        if item.get("loaded") is False:
            flags.append("NOT-LOADED")
        flag_s = f" [{','.join(flags)}]" if flags else ""
        lines.append(f"  - {item['root']:<18} {item['name']:<28} {mtime} {desc}{flag_s}")
    return "\n".join(lines)


def main(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser(description=__doc__.splitlines()[0])
    parser.add_argument("--json", dest="json_path", default=None,
                        help="write the JSON result to this path ('-' for stdout)")
    parser.add_argument("--threshold", type=float, default=DEFAULT_THRESHOLD,
                        help=f"description overlap threshold (default {DEFAULT_THRESHOLD})")
    parser.add_argument("--no-loader", action="store_true",
                        help="skip the real loader run (offline mode)")
    parser.add_argument("--quiet", action="store_true",
                        help="suppress the human report (JSON only)")
    args = parser.parse_args(argv)

    roots = [
        ("user", AGENT_DIR / "skills"),
        ("project", CWD / ".pi" / "skills"),
        ("telegram-extension", TELEGRAM_SKILLS),
    ]
    try:
        result = scan(
            roots,
            agent_dir=AGENT_DIR,
            cwd=CWD,
            threshold=args.threshold,
            use_loader=not args.no_loader,
        )
    except SkillsDoctorError as exc:
        print(f"skills_doctor: error: {exc}", file=sys.stderr)
        return 2

    if not args.quiet:
        print(render_report(result))
    if args.json_path:
        payload = json.dumps(result, indent=2, ensure_ascii=False)
        if args.json_path == "-":
            print(payload)
        else:
            Path(args.json_path).write_text(payload + "\n", encoding="utf-8")
            if not args.quiet:
                print(f"\nJSON written to {args.json_path}")

    findings = result["findings"]
    issue_count = sum(
        len(findings[key])
        for key in (
            "duplicates", "malformed", "silently_skipped", "stale_facts",
            "missing_references", "description_overlaps",
        )
    )
    return 1 if issue_count else 0


if __name__ == "__main__":
    sys.exit(main())
