#!/usr/bin/env python3
"""Dispatch guard for user-data writer tools (WPS ledger writes today).

Standing user rule: a write into shared external state (ledger rows, cloud
sheets, docs, any shared data store) is never performed inline by the
coordinator main session — every write runs inside a dispatched subagent, and
the dispatcher exports DISPATCHED_BY for that child. Prose alone gets forgotten
under flow ("just checking the sheet... while I'm here"), so this module makes
the rule mechanical: the first action of any writer script is guard_write(),
which refuses to continue when the marker is absent.

Provenance: DISPATCHED_BY names the dispatch (subagent id / task label),
PI_SESSION_ID the session that issued it. Both are readable via provenance().

Dispatched run:
    DISPATCHED_BY=sa30 PI_SESSION_ID=xyz python3 add_entry.py --amount 25 ...

Read-only tools (wps_read.py) intentionally do not import this module: reading
and locating data inline stays allowed, only writes are gated.
"""
import os
import sys

REFUSAL = (
    "write blocked: DISPATCHED_BY unset — user-data writes must run inside "
    "a dispatched subagent"
)


def provenance():
    """Dispatch provenance markers from the environment (empty strings if unset)."""
    return {
        "dispatched_by": os.environ.get("DISPATCHED_BY", "").strip(),
        "session_id": os.environ.get("PI_SESSION_ID", "").strip(),
    }


def check_writable():
    """True when a dispatch marker is present. Non-fatal probe for callers."""
    return bool(provenance()["dispatched_by"])


def guard_write(tool_name):
    """Exit nonzero unless this process runs under a stated dispatch.

    Returns the provenance dict on success so callers can log/echo it.
    `tool_name` identifies the writer in the caller's own error handling.
    """
    prov = provenance()
    if not check_writable():
        print(REFUSAL, file=sys.stderr, flush=True)
        raise SystemExit(2)
    return dict(prov, tool=tool_name)
