#!/usr/bin/env python3
"""Best-effort staged-content checks; no network or working-tree changes."""
import re
import subprocess
import sys
from pathlib import PurePosixPath

MAX_BYTES = 1024 * 1024
SECRET_PATTERNS = (
    re.compile(rb'-----BEGIN (?:RSA |EC |OPENSSH )?PRIVATE KEY-----'),
    re.compile(rb'\b\d{6,12}:[A-Za-z0-9_-]{30,}\b'),
    re.compile(rb'\bsk-[A-Za-z0-9_-]{20,}\b'),
    re.compile(rb'\bgh[pousr]_[A-Za-z0-9]{20,}\b'),
    re.compile(rb'\bAKIA[A-Z0-9]{16}\b'),
)
BLOCKED_DIRS = {'node_modules', '.venv', '__pycache__', '.ssh', 'secrets', 'credentials',
                'private', 'sessions', 'transcripts', 'checkpoints', 'models', 'backups'}


def content_problem(path, content):
    p = PurePosixPath(path)
    lower = p.name.lower()
    if any(part.lower() in BLOCKED_DIRS for part in p.parts):
        return 'private/runtime/artifact directory'
    if '.pi' in p.parts and 'skills' not in p.parts:
        return 'Pi runtime/configuration path'
    if lower == '.env' or lower.startswith('.env.') or p.suffix.lower() in {
            '.pem', '.key', '.p12', '.pfx', '.sqlite', '.sqlite3', '.db'}:
        return 'credential or database filename'
    if len(content) > MAX_BYTES:
        return 'file exceeds 1 MiB; review scope and use a deliberate artifact strategy'
    if b'\0' in content:
        return 'binary content requires separate approval'
    if any(pattern.search(content) for pattern in SECRET_PATTERNS):
        return 'possible credential/private-key content'
    return None


def git(*args):
    return subprocess.check_output(['git', *args], stderr=subprocess.PIPE)


def main():
    try:
        paths = git('diff', '--cached', '--name-only', '--diff-filter=ACMR', '-z').split(b'\0')
        problems = []
        for raw in filter(None, paths):
            path = raw.decode('utf-8', errors='surrogateescape')
            size = int(git('cat-file', '-s', ':' + path))
            if size > MAX_BYTES:
                reason = 'staged file exceeds 1 MiB'
            else:
                reason = content_problem(path, git('show', ':' + path))
            if reason:
                problems.append((path, reason))
        if problems:
            print('Commit blocked by best-effort staged-content guard:', file=sys.stderr)
            for path, reason in problems:
                print(f'  {path!r}: {reason}', file=sys.stderr)
            print('Review staging; do not bypass the guard to include sensitive files.', file=sys.stderr)
            return 1
        return 0
    except (OSError, ValueError, subprocess.CalledProcessError):
        print('Commit guard could not inspect staged content; stopping commit.', file=sys.stderr)
        return 1


if __name__ == '__main__':
    sys.exit(main())
