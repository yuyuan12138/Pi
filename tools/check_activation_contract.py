#!/usr/bin/env python3
"""Grep test for docs/activation-contract.md (expansion plan A2).

For every package in packages/ and extensions-src/, collect the env vars the
code actually reads:
  - direct reads:  process.env.NAME
  - const reads:   env[CONST] / process.env[CONST], where CONST is resolved
                   from a same-file `const CONST = "NAME";` declaration
then assert that every collected var name appears in the doc's table row for
that package. Also assert the universal-rule evidence pointer
(docs/runbooks/pi-restart.md) is present.

Exit 0 = table is consistent with the code; exit 1 = list the failures.
This pins the env-var surface mechanically; the load-vs-per-call
classification is grounded by the file:line citations in the doc itself.

Usage:
    python3 tools/check_activation_contract.py [--doc PATH] [--root PATH]
"""
from __future__ import annotations

import argparse
import re
import sys
from pathlib import Path

# env[CONST] / process.env[CONST] — CONST resolved from same-file `const`s.
ENV_CONST_READ = re.compile(r"\b(?:process\.)?env\[([A-Z_][A-Z0-9_]*)\]")
CONST_DECL = re.compile(r'\bconst\s+([A-Z_][A-Z0-9_]*)\s*=\s*["\']([A-Za-z0-9_]+)["\']')
DIRECT_READ = re.compile(r"\bprocess\.env\.([A-Za-z_][A-Za-z0-9_]*)")
# Ignore obviously non-config matches (memberships like env.length never match
# the patterns above; nothing else needed today).

RUNBOOK_POINTER = "docs/runbooks/pi-restart.md"


def package_dirs(root: Path) -> list[Path]:
    dirs: list[Path] = []
    for sub in ("packages", "extensions-src"):
        base = root / sub
        if base.is_dir():
            dirs.extend(sorted(d for d in base.iterdir() if d.is_dir() and not d.name.startswith(".")))
    return dirs


def source_files(pkg: Path) -> list[Path]:
    skip_names = {"node_modules", "test", "tests", "__pycache__"}
    files: list[Path] = []
    for pattern in ("*.ts", "*.js"):
        files.extend(p for p in pkg.rglob(pattern) if not (skip_names & set(p.parts)) and not p.name.endswith(".d.ts"))
    return files


def env_reads(pkg: Path) -> dict[str, set[str]]:
    """file path (relative to pkg) -> set of env var names read there."""
    reads: dict[str, set[str]] = {}
    for f in source_files(pkg):
        try:
            text = f.read_text(encoding="utf-8", errors="replace")
        except OSError:
            continue
        consts = {name: value for name, value in CONST_DECL.findall(text)}
        names: set[str] = set(DIRECT_READ.findall(text))
        for const_name in ENV_CONST_READ.findall(text):
            if const_name in consts:  # same-file resolution only
                names.add(consts[const_name])
        # Keep only plausible config names (uppercase convention).
        names = {n for n in names if re.fullmatch(r"[A-Z][A-Z0-9_]+", n)}
        if names:
            reads[str(f.relative_to(pkg))] = names
    return reads


def doc_rows(doc_text: str) -> dict[str, str]:
    """package identifier (leading token of the first table cell) -> full row line."""
    rows: dict[str, str] = {}
    for line in doc_text.splitlines():
        if not line.startswith("| `"):
            continue
        cells = line.split("|")
        if len(cells) < 2:
            continue
        # First cell may carry a role suffix: `pi-fork` (fork tool) — key on the
        # FIRST backtick-quoted token in the cell.
        m = re.match(r"\s*`([^`]+)`", cells[1])
        first = m.group(1).strip() if m else ""
        if first:
            rows[first] = line
    return rows


def row_key_candidates(pkg_rel: str) -> list[str]:
    """Row identifiers that may name this package, most specific first."""
    base = pkg_rel.split("/")[-1]
    return [pkg_rel, base]


def main(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser(description=__doc__.splitlines()[0])
    parser.add_argument("--doc", default="docs/activation-contract.md")
    parser.add_argument("--root", default=Path(__file__).resolve().parent.parent)
    args = parser.parse_args(argv)

    root = Path(args.root).resolve()
    doc_path = root / args.doc
    if not doc_path.is_file():
        print(f"FAIL: doc not found: {doc_path}", file=sys.stderr)
        return 1
    doc_text = doc_path.read_text(encoding="utf-8")
    rows = doc_rows(doc_text)
    failures: list[str] = []

    if RUNBOOK_POINTER not in doc_text:
        failures.append(f"doc lost the universal-rule evidence pointer ({RUNBOOK_POINTER})")

    for pkg in package_dirs(root):
        pkg_rel = str(pkg.relative_to(root))
        row = next((rows[k] for k in row_key_candidates(pkg_rel) if k in rows), None)
        reads = env_reads(pkg)
        all_vars = sorted({v for names in reads.values() for v in names})
        if row is None:
            if all_vars or reads:
                failures.append(f"{pkg_rel}: code reads env vars {all_vars} but no contract table row exists")
            continue
        for where, names in sorted(reads.items()):
            for name in sorted(names):
                if f"`{name}`" not in row:
                    failures.append(
                        f"{pkg_rel}: env var {name} read in {where} but NOT named in its contract table row"
                    )

    if failures:
        print(f"activation-contract check: {len(failures)} failure(s)")
        for f in failures:
            print(f"  - {f}")
        print(f"Fix the rows in {args.doc} (or the code, if the row is right).")
        return 1
    print("activation-contract check: OK — every package env read is named in its table row.")
    return 0


if __name__ == "__main__":
    sys.exit(main())
