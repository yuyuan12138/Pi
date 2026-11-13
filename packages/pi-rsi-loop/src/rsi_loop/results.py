"""Canonical experiment-results loading (crash-resume rule).

FRAMEWORK RULE (from the MC engine's c005 bug class): a crash-resume may gate
ONLY on a TERMINAL results.json — the driver's final write, marked by a
top-level ``verdict`` object. Intermediate per-arm writes (same file, written
before the A/B finished) are rejected, so a resume can never accept on
partial metrics.

Canonical results.json shape (part of the adapter contract, see ADAPTER.md):

    {
      "verdict": {"result": "treatment_favors" | ...},   # terminal marker
      "finished_at": "<iso8601>",
      "results": {
        "control":   {"arm": "control",   "outcome": "completed" | ...,
                      "model_requests": <int>, "error_code_counts": {...},
                      "token_totals": {"total_tokens": <int>}},
        "treatment": {... same shape ...}
      }
    }

ADDITIVE (Theme C3 evidence auto-plumbing): after a cycle closes, the ENGINE
may add a top-level ``evidence`` key (``rsi-loop-evidence/1`` schema, see
``rsi_loop.evidence``) to this envelope — engine-written, never
driver-written. Consumers must treat it as optional; files without it (all
results written before C3) load exactly as before.
"""
import json
from pathlib import Path

INFRA_OUTCOMES = frozenset({'infra_failure', 'timeout'})


def load_terminal_results(auto_dir, terminal_key='verdict', require_treatment=True):
    """Load a driver's results.json into the canonical engine shape.

    Returns ``{'ok': True, 'results', 'verdict', 'finished_at', 'doc',
    'diagnostics'}`` or ``{'ok': False, 'diagnostics'}`` — every failure
    carries the exact path + keys attempted (fail loudly, never silently
    'no metrics'). No exception escapes for absent/corrupt files; the
    diagnostics are the evidence chain.
    """
    auto_dir = Path(auto_dir)
    path = auto_dir / 'results.json'
    diagnostics = {'path': str(path)}
    try:
        doc = json.loads(path.read_text())
    except (OSError, ValueError) as error:
        diagnostics['error'] = '%s: %s' % (type(error).__name__, str(error)[:160])
        return {'ok': False, 'diagnostics': diagnostics}
    if not isinstance(doc, dict):
        diagnostics['error'] = 'results_json_not_an_object'
        diagnostics['keys'] = []
        return {'ok': False, 'diagnostics': diagnostics}
    diagnostics['keys'] = sorted(doc.keys())
    diagnostics['terminal_verdict_present'] = isinstance(doc.get(terminal_key), dict)
    if not diagnostics['terminal_verdict_present']:
        diagnostics['error'] = ('results_unterminal_no_%s (intermediate per-arm write)'
                                % terminal_key)
        return {'ok': False, 'diagnostics': diagnostics}
    inner = doc.get('results')
    if not isinstance(inner, dict):
        diagnostics['error'] = 'results_key_missing_or_not_a_dict'
        return {'ok': False, 'diagnostics': diagnostics}
    diagnostics['results_keys'] = sorted(inner.keys())
    diagnostics['treatment_present'] = 'treatment' in inner
    if require_treatment and 'treatment' not in inner:
        diagnostics['error'] = 'treatment_key_missing_from_results'
        return {'ok': False, 'diagnostics': diagnostics}
    evidence = doc.get('evidence')            # optional, engine-written (C3)
    diagnostics['evidence_present'] = isinstance(evidence, dict)
    return {'ok': True, 'results': inner, 'verdict': doc.get(terminal_key) or {},
            'finished_at': doc.get('finished_at'), 'doc': doc,
            'evidence': evidence if isinstance(evidence, dict) else None,
            'diagnostics': diagnostics}


def error_code_delta(control, treatment):
    """Per-code treatment-minus-control delta, nonzero entries only.

    Pure; the single definition of the delta the AcceptGate rejects on and
    the evidence record reports (Theme C3). Raises TypeError on malformed
    counts — the gate lets that surface (infra strike); reporting callers
    degrade honestly instead.
    """
    control = control or {}
    treatment = treatment or {}
    codes = set(control.get('error_code_counts') or {}) \
        | set(treatment.get('error_code_counts') or {})
    delta = {}
    for code in codes:
        d = (treatment.get('error_code_counts') or {}).get(code, 0) \
            - (control.get('error_code_counts') or {}).get(code, 0)
        if d:
            delta[code] = d
    return delta


def arm_tokens(arm):
    """total_tokens of one canonical arm dict (0 when absent/malformed)."""
    totals = (arm or {}).get('token_totals') or {}
    value = totals.get('total_tokens')
    return value if isinstance(value, int) and value > 0 else 0


def is_completed_outcome(arm, extra_not_completed=()):
    """True when the arm ran to a terminal, comparable outcome.

    A capped arm (stopped at its per-arm budget) is INCOMPLETE: a capped
    treatment is never a completed datapoint and a capped control is never a
    valid baseline. Framework vocabulary; adapters may extend the set.
    """
    outcome = (arm or {}).get('outcome')
    not_completed = INFRA_OUTCOMES | {'aborted_budget', 'died', 'cap_reached'} \
        | set(extra_not_completed)
    return outcome is not None and outcome not in not_completed
