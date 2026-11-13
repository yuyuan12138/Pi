"""rsi_loop CLI: evidence read-back (Theme C3).

    python -m rsi_loop --evidence STATE.json [--cycle ID]   # per-cycle records
    python -m rsi_loop --evidence auto-<cycle>/             # results envelope
    python -m rsi_loop --evidence auto-<cycle>/results.json # same

Exit codes: 0 evidence printed · 2 path missing / unrecognized · 3 artifact
present but unreadable (e.g. results.json not terminal — diagnostics on
stderr as one JSON line).
"""
import argparse
import json
import sys

from .evidence import EvidenceReadError, read_evidence


def main(argv=None):
    parser = argparse.ArgumentParser(
        prog='python -m rsi_loop',
        description='RSI-loop evidence read-back: per-cycle evidence records '
                    'as JSON, for ledger/autopsy tooling (no driver-log '
                    're-parsing).')
    parser.add_argument('--evidence', metavar='PATH',
                        help='state file, experiment auto_dir, or results.json')
    parser.add_argument('--cycle', metavar='ID', default=None,
                        help='only this cycle id (state-file source only)')
    args = parser.parse_args(argv)
    if not args.evidence:
        parser.error('--evidence PATH is required')
    try:
        payload = read_evidence(args.evidence, cycle_id=args.cycle)
    except FileNotFoundError:
        print(json.dumps({'error': 'path_not_found_or_not_evidence_source',
                          'path': args.evidence}), file=sys.stderr)
        return 2
    except EvidenceReadError as error:
        print(json.dumps(error.diagnostics, ensure_ascii=False), file=sys.stderr)
        return 3
    print(json.dumps(payload, indent=2, ensure_ascii=False))
    return 0


if __name__ == '__main__':
    sys.exit(main())
