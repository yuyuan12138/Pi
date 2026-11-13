#!/usr/bin/env python3
"""Work-record compliance linter (Project-Space Standard §6, Theme D3b).

Mechanically checks work RECORDs for what was previously convention-only:
  - required header fields (Date, Task, Dispatched-by, Worker, Status)
  - status vocabulary (delivered | delivered-unverified | blocked | failed)
  - required body sections (Task brief, Delivered, Verification evidence,
    Open items)
  - [project:<name>] brief-header tag presence and consistency with the
    directory's project space (path-prefix map, overridable via --project-tag)
  - append-only discipline: a tracked RECORD whose content was later removed
    or modified in a commit is flagged (pure appends — e.g. new Open items —
    are allowed, per the standard's follow-up rule). Read-only git access.

Severity model: FAIL = structural nonconformance (missing required field or
section, bad status, tag/directory mismatch, append-only violation).
WARN = advisory (missing tag on a backfill, extra status prose, length budget,
date/dirname mismatch, uncommitted changes). Exit 1 only on FAIL.

Scan scope: <root>/work/**/RECORD.md plus project-space work/ dirs under
remote-agent/operations/*/work/ and operations/*/work/ when present.

Usage:
  python3 tools/work_record_lint.py                 # --all (default)
  python3 tools/work_record_lint.py --since 2026-11-13
  python3 tools/work_record_lint.py --record work/2026-11-13/x/RECORD.md

Read-only tool: never edits records or git state.
"""
from __future__ import annotations

import argparse
import re
import subprocess
import sys
from dataclasses import dataclass, field
from pathlib import Path

STATUS_TERMS = ("delivered-unverified", "delivered", "blocked", "failed")  # longest first
REQUIRED_HEADER_FIELDS = ("Date", "Task", "Dispatched-by", "Worker", "Status")
REQUIRED_SECTIONS = ("Task brief", "Delivered", "Verification evidence", "Open items")
LINE_BUDGET = 80  # Project-Space Standard §8: work RECORD ≤80 lines

TAG_RE = re.compile(r"\[project:([A-Za-z0-9][A-Za-z0-9._-]*)\]", re.IGNORECASE)
DATE_RE = re.compile(r"^\d{4}-\d{2}-\d{2}")
# Field match requiring a colon (all fields except Date/Status, which are also
# accepted in the "Date 2026-11-13" prose form seen in the wild).
FIELD_COLON_RE = re.compile(
    r"^(date|task|dispatched-by|worker|status|brief header)\b[ \t]*[:：][ \t]*(.+)$", re.I)
FIELD_PROSE_RE = re.compile(r"^(date|status)\b[ \t]+(\d{4}-\d{2}-\d{2}.*|.*)$", re.I)

# Default directory -> expected project tag (relative to scan root; longest
# prefix wins). Built-ins reflect this workspace; override/extend with
# --project-tag PREFIX=TAG, or clear with --no-default-tags.
DEFAULT_PROJECT_TAG_MAP = {
    "work/": "PiAgents",
    "remote-agent/operations/20261029-minimal-sword-episode/work/": "minecraft",
}


@dataclass
class Finding:
    severity: str  # "warn" | "fail"
    message: str


@dataclass
class RecordResult:
    path: Path
    findings: list[Finding] = field(default_factory=list)

    @property
    def status(self) -> str:
        if any(f.severity == "fail" for f in self.findings):
            return "FAIL"
        if self.findings:
            return "WARN"
        return "PASS"

    def add(self, severity: str, message: str) -> None:
        self.findings.append(Finding(severity, message))


def strip_comments(text: str) -> str:
    """Remove HTML comments (embedded template blocks must not be parsed)."""
    return re.sub(r"<!--.*?-->", "", text, flags=re.DOTALL)


def _split_sections(text: str) -> list[tuple[str, str]]:
    """Return [(normalized_h2_heading, section_body)] for a comment-stripped text."""
    sections: list[tuple[str, str]] = []
    current_head: str | None = None
    body: list[str] = []
    for line in text.splitlines():
        m = re.match(r"^##\s+(.+?)\s*#*\s*$", line)
        if m:
            if current_head is not None:
                sections.append((current_head, "\n".join(body)))
            current_head = m.group(1)
            body = []
        elif current_head is not None:
            body.append(line)
    if current_head is not None:
        sections.append((current_head, "\n".join(body)))
    return sections


def _norm(heading: str) -> str:
    return re.sub(r"[^a-z0-9]+", " ", heading.lower()).strip()


def _header_region(text: str) -> str:
    """Text between the H1 title line and the first H2 heading."""
    lines = text.splitlines()
    start = 0
    while start < len(lines) and not lines[start].startswith("# "):
        start += 1
    start += 1
    end = start
    while end < len(lines) and not lines[end].startswith("## "):
        end += 1
    return "\n".join(lines[start:end])


def parse_header_fields(header_text: str) -> dict[str, str]:
    """Extract canonical header fields from the header region.

    Accepts the template's bullet form ("- **Field**: value"), prose form
    ("Date 2026-11-13"), and '·'-separated multi-field lines. First occurrence
    wins.
    """
    fields: dict[str, str] = {}
    for raw in header_text.splitlines():
        line = raw.strip().lstrip("-*").strip().replace("**", "")
        for seg in line.split("·"):
            seg = seg.strip()
            m = FIELD_COLON_RE.match(seg) or FIELD_PROSE_RE.match(seg)
            if not m:
                continue
            name = m.group(1).lower()
            value = m.group(2).strip()
            if name not in fields and value:
                fields[name] = value
    return fields


def parse_status(value: str) -> tuple[list[str], bool]:
    """Return (status terms found, exact_match) for a Status field value."""
    found: list[str] = []
    masked = value
    for term in STATUS_TERMS:  # longest first so 'delivered-unverified' wins
        pattern = re.compile(r"\b" + re.escape(term) + r"\b", re.I)
        if pattern.search(masked):
            found.append(term)
            masked = pattern.sub(" ", masked)
    return found, value.strip().lower() in STATUS_TERMS


def extract_tag(fields: dict[str, str], header_text: str, sections: list[tuple[str, str]]) -> str | None:
    """Project tag: Brief-header field value first, then anywhere in the
    header region, then the Task-brief section (the record cites its brief)."""
    brief_header = fields.get("brief header")
    if brief_header and brief_header.strip().lower() not in ("none", "n/a", "-"):
        m = TAG_RE.search(brief_header)
        if m:
            return m.group(1)
    m = TAG_RE.search(header_text)
    if m:
        return m.group(1)
    for head, body in sections:
        if _norm(head).startswith("task brief"):
            m = TAG_RE.search(body)
            if m:
                return m.group(1)
    return None


def lint_record(path: Path, tag_map: dict[str, str], base: Path | None = None) -> RecordResult:
    """Lint one RECORD. `base` is the scan root used to key the project-tag map
    (may differ from the file's git repo root for nested repos)."""
    result = RecordResult(path=path)
    try:
        raw = path.read_text(encoding="utf-8", errors="replace")
    except OSError as exc:
        result.add("fail", f"unreadable: {exc}")
        return result
    text = strip_comments(raw)

    # --- header fields -----------------------------------------------------
    header_text = _header_region(text)
    fields = parse_header_fields(header_text)
    missing = [f for f in REQUIRED_HEADER_FIELDS if f.lower() not in fields]
    if missing:
        result.add("fail",
                   f"missing required header field(s): {', '.join(missing)} "
                   f"(required by Project-Space Standard §6)")

    # --- status vocabulary --------------------------------------------------
    status_value = fields.get("status")
    if status_value:
        terms, exact = parse_status(status_value)
        if not terms:
            result.add("fail",
                       f"status '{status_value}' is outside the vocabulary "
                       f"(delivered | delivered-unverified | blocked | failed)")
        elif len(terms) > 1:
            result.add("fail",
                       f"status '{status_value}' contains conflicting vocabulary terms: "
                       f"{', '.join(terms)}")
        elif not exact:
            result.add("warn",
                       f"status '{status_value}' carries extra prose; use the bare "
                       f"vocabulary term and move detail to the body")

    # --- required body sections ----------------------------------------------
    sections = _split_sections(text)
    norm_heads = [_norm(h) for h, _ in sections]
    missing_sections = [r for r in REQUIRED_SECTIONS
                        if not any(h.startswith(_norm(r)) for h in norm_heads)]
    if missing_sections:
        result.add("fail",
                   f"missing required body section(s): {', '.join(missing_sections)}")
    else:
        # brief length: standard says 2-6 lines
        for head, body in sections:
            if _norm(head).startswith("task brief"):
                brief_lines = [ln for ln in body.splitlines() if ln.strip()]
                if len(brief_lines) < 2:
                    result.add("warn", "task brief under 2 lines (standard: 2-6)")
                elif len(brief_lines) > 6:
                    result.add("warn",
                               f"task brief is {len(brief_lines)} lines (standard: 2-6)")
                break

    # --- project tag ----------------------------------------------------------
    try:
        rel = path.resolve().relative_to(base).as_posix() if base else path.resolve().as_posix()
    except ValueError:
        rel = path.resolve().as_posix()
    expected_tag = _expected_tag(rel, tag_map)
    tag = extract_tag(fields, header_text, sections)
    if tag is None:
        if expected_tag is not None:
            result.add("warn",
                       f"no [project:...] brief-header tag cited (expected '{expected_tag}' "
                       f"for this directory); backfills may declare 'Brief header: none' — "
                       f"flagged for visibility")
    elif expected_tag is not None:
        if tag != expected_tag and not tag.startswith(expected_tag + "."):
            result.add("fail",
                       f"project tag [project:{tag}] does not match this directory's "
                       f"project space ('{expected_tag}')")
    if tag is not None and not re.fullmatch(r"[A-Za-z0-9][A-Za-z0-9._-]*", tag):
        result.add("fail", f"malformed project tag '[project:{tag}]'")

    # --- date vs directory name ------------------------------------------------
    date_value = fields.get("date", "")
    m_dir = re.match(r"(\d{4}-\d{2}-\d{2})", path.parent.name)
    m_date = DATE_RE.match(date_value)
    if m_dir and m_date and m_dir.group(1) != m_date.group(0):
        result.add("warn",
                   f"Date field ({m_date.group(0)}) does not match record directory "
                   f"date prefix ({m_dir.group(1)})")

    # --- length budget ------------------------------------------------------------
    content_lines = [ln for ln in text.splitlines() if ln.strip()]
    if len(content_lines) > LINE_BUDGET:
        result.add("warn",
                   f"{len(content_lines)} content lines exceed the {LINE_BUDGET}-line "
                   f"budget (§8; template comment blocks excluded)")

    # --- append-only check (read-only git) ------------------------------------------
    _append_only_check(result, path)

    return result


def _expected_tag(rel_path: str, tag_map: dict[str, str]) -> str | None:
    rel = rel_path.replace("\\", "/")
    best_prefix, best_tag = None, None
    for prefix, tag in tag_map.items():
        norm = prefix.replace("\\", "/")
        if not norm.endswith("/"):
            norm += "/"
        if rel.startswith(norm) and (best_prefix is None or len(norm) > len(best_prefix)):
            best_prefix, best_tag = norm, tag
    return best_tag


def _git(args: list[str], cwd: Path) -> subprocess.CompletedProcess[str] | None:
    try:
        return subprocess.run(["git", *args], cwd=str(cwd), capture_output=True,
                              text=True, check=False, timeout=30)
    except (OSError, subprocess.TimeoutExpired):
        return None


def _append_only_check(result: RecordResult, path: Path) -> None:
    """Flag removed/modified content in any commit after the record's first.

    Pure appends (no removed lines) are allowed per the standard's follow-up
    rule ('new records or new Open items'). All git access is read-only.
    """
    log = _git(["log", "--format=%H", "--reverse", "--", path.name], cwd=path.parent)
    if log is None or log.returncode != 0:
        return  # not in a git repo / git unavailable: skip silently
    commits = [c for c in log.stdout.split() if c]
    if not commits:
        return  # untracked/new record: nothing to compare yet
    for prev, cur in zip(commits, commits[1:]):
        diff = _git(["diff", "-u", "--no-color", prev, cur, "--", path.name],
                    cwd=path.parent)
        if diff is None or diff.returncode != 0:
            continue
        removed = [ln[1:] for ln in diff.stdout.splitlines()
                   if ln.startswith("-") and not ln.startswith("---") and ln[1:].strip()]
        if removed:
            short = (prev or "")[:8]
            short_cur = (cur or "")[:8]
            preview = removed[0].strip()
            if len(preview) > 80:
                preview = preview[:77] + "..."
            result.add("fail",
                       f"append-only violation: content removed/modified in commit "
                       f"{short_cur} (after {short}); first offending line: {preview!r}")
            break  # one violation finding is enough to act on
    dirty = _git(["status", "--porcelain", "--", path.name], cwd=path.parent)
    if dirty is not None and dirty.returncode == 0 and dirty.stdout.strip():
        result.add("warn", "record has uncommitted changes; commit to freeze it "
                           "(append-only discipline starts at the first commit)")


# --- scanning ------------------------------------------------------------------

def default_scan_roots(root: Path) -> list[Path]:
    roots = [root / "work"]
    for base in ("remote-agent/operations", "operations"):
        base_dir = root / base
        if base_dir.is_dir():
            roots.extend(sorted(d / "work" for d in base_dir.iterdir()
                                if d.is_dir() and (d / "work").is_dir()))
    return [r for r in roots if r.is_dir()]


def find_records(root: Path) -> list[Path]:
    records: set[Path] = set()
    for scan in default_scan_roots(root):
        for p in scan.rglob("RECORD.md"):
            if p.is_file():
                records.add(p.resolve())
    return sorted(records)


def _record_date(path: Path, root: Path) -> str | None:
    m = re.match(r"(\d{4}-\d{2}-\d{2})", path.parent.name)
    if m:
        return m.group(1)
    try:
        text = strip_comments(path.read_text(encoding="utf-8", errors="replace"))
        m = DATE_RE.match(parse_header_fields(_header_region(text)).get("date", ""))
        return m.group(0) if m else None
    except OSError:
        return None


def parse_project_tag_map(items: list[str]) -> dict[str, str]:
    tag_map: dict[str, str] = {}
    for item in items:
        if "=" not in item:
            print(f"error: --project-tag expects PREFIX=TAG, got: {item}", file=sys.stderr)
            raise SystemExit(2)
        prefix, tag = item.split("=", 1)
        if not tag.strip():
            print(f"error: --project-tag TAG must be non-empty: {item}", file=sys.stderr)
            raise SystemExit(2)
        tag_map[prefix.strip()] = tag.strip()
    return tag_map


def main(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser(
        description="Lint work RECORDs for Project-Space Standard §6 compliance "
                    "(read-only; exit 1 on any FAIL).")
    mode = parser.add_mutually_exclusive_group()
    mode.add_argument("--all", action="store_true", help="scan all known work/ roots (default)")
    mode.add_argument("--since", metavar="YYYY-MM-DD", help="only records dated on/after DATE")
    mode.add_argument("--record", metavar="PATH", help="lint a single RECORD file")
    parser.add_argument("--root", type=Path, default=None,
                        help="workspace root (default: parent of this script's directory)")
    parser.add_argument("--project-tag", action="append", default=[], metavar="PREFIX=TAG",
                        help="directory-prefix -> expected [project:] tag (repeatable)")
    parser.add_argument("--no-default-tags", action="store_true",
                        help="ignore the built-in project-tag map")
    args = parser.parse_args(argv)

    root = (args.root or Path(__file__).resolve().parent.parent).resolve()
    tag_map = {} if args.no_default_tags else dict(DEFAULT_PROJECT_TAG_MAP)
    tag_map.update(parse_project_tag_map(args.project_tag))

    scanned_note = ""
    if args.record:
        candidate = Path(args.record)
        if not candidate.is_absolute():
            for base in (Path.cwd(), root):
                if (base / candidate).is_file():
                    candidate = (base / candidate).resolve()
                    break
        if not candidate.is_file():
            print(f"error: record not found: {args.record}", file=sys.stderr)
            return 2
        results = [lint_record(candidate.resolve(), tag_map=tag_map, base=root)]
    else:
        records = find_records(root)
        if args.since:
            kept = [r for r in records if (d := _record_date(r, root)) and d >= args.since]
            dropped = len(records) - len(kept)
            records = kept
            scanned_note = f" ({dropped} records before {args.since} skipped)"
        if not records:
            print(f"No RECORD.md files found under {root} — nothing to lint.")
            return 0
        results = []
        for rec in records:
            results.append(lint_record(rec, tag_map=tag_map, base=root))

    fails = 0
    warns = 0
    passes = 0
    for res in results:
        status = res.status
        if status == "FAIL":
            fails += 1
        elif status == "WARN":
            warns += 1
        else:
            passes += 1
        print(f"[{status}] {res.path}")
        for f in res.findings:
            print(f"    {f.severity.upper()}: {f.message}")
    total = len(results)
    print(f"\nWork-record lint: {total} record(s){scanned_note} — "
          f"{passes} pass, {warns} warn, {fails} fail.")
    print(f"Fully compliant: {passes}/{total}.")
    return 1 if fails else 0


def _repo_root(path: Path) -> Path | None:
    """Git repo containing path (read-only), or None."""
    out = _git(["rev-parse", "--show-toplevel"], cwd=path.parent if path.is_file() else path)
    if out is not None and out.returncode == 0:
        return Path(out.stdout.strip())
    return None


if __name__ == "__main__":
    sys.exit(main())
