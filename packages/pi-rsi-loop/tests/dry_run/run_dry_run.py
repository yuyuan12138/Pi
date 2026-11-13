#!/usr/bin/env python3
"""CLI entry for the toy second consumer's dry-run acceptance run.

    python3 run_dry_run.py [--workspace DIR] [--observe]

Completes ONE full loop iteration in dry-run (zero side effects outside the
workspace; observe posture with --observe). Exit code is the engine's
stable exit code (7 = cycles_done, 6 = observe_window_done).
"""
import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent))

import toy_consumer                                        # noqa: E402

if __name__ == '__main__':
    sys.exit(toy_consumer.main())
