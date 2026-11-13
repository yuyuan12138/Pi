"""Per-cycle evidence records (Theme C3): the hypothesis chain, auto-plumbed.

GAP closed: a cycle's terminal evidence (arm metrics, gate inputs + verdict,
apply/revert outcome, proposer provenance) used to land wherever the adapter's
driver wrote it — the hypothesis/acceptance chain was only as good as manual
plumbing. The ENGINE now auto-collects a bounded, structured evidence record
per cycle across the experiment->gate->apply stages and persists it:

- into the cycle record in the state file (``record['evidence']``) — every
  closed cycle gets one, including observe / no-proposal / infra paths;
- into the cycle's results envelope (``auto_dir/results.json``) as an
  ADDITIVE top-level ``evidence`` key, written by the engine only after the
  envelope is TERMINAL (verdict present). Drivers never write this key and
  old envelopes (pre-C3) load unchanged.

Read-back for ledger/autopsy tooling (no driver-log re-parsing):
``python -m rsi_loop --evidence <state.json|auto_dir|results.json>`` —
``rsi_loop.evidence.read_evidence``.

Framework invariants untouched: budget caps, two-strikes breaker,
crash-resume (terminal results only — the evidence key is never part of
terminality and is never read for gating), observe mode never applies.

Schema (``rsi-loop-evidence/1``): all strings bounded, dicts/lists capped —
an evidence record is bounded by construction, whatever a driver returns.
"""
import json
import os
import stat
from pathlib import Path

from .results import arm_tokens, error_code_delta
from .state import utcnow

EVIDENCE_SCHEMA = 'rsi-loop-evidence/1'
ERROR_CODES_MAX = 20              # per-arm / per-delta code cap (omitted counted)
STR_MAX = 400                     # any string value cap
DICT_KEYS_MAX = 20                # generic dict cap (verdict / scorer_output / ...)
LIST_ITEMS_MAX = 20               # generic list cap


def _truncate(text):
    if len(text) <= STR_MAX:
        return text
    return text[:STR_MAX] + '...[+%d chars]' % (len(text) - STR_MAX)


def _bound(value):
    """Bounded deep-copy of one JSON value (honest truncation, no crashes)."""
    if isinstance(value, str):
        return _truncate(value)
    if isinstance(value, (int, float, bool)) or value is None:
        return value
    if isinstance(value, dict):
        items = list(value.items())[:DICT_KEYS_MAX]
        out = {str(k): _bound(v) for k, v in items}
        if len(value) > DICT_KEYS_MAX:
            out['_evidence_truncated'] = True
        return out
    if isinstance(value, (list, tuple)):
        out = [_bound(v) for v in list(value)[:LIST_ITEMS_MAX]]
        if len(value) > LIST_ITEMS_MAX:
            out.append('[+%d more]' % (len(value) - LIST_ITEMS_MAX))
        return out
    return _truncate(str(value))          # non-JSON scalars degrade to text


def bounded_error_codes(counts, max_codes=ERROR_CODES_MAX):
    """Cap an error_code_counts dict: keep the ``max_codes`` highest counts
    (count desc, then code), report the omitted remainder separately."""
    if not isinstance(counts, dict):
        return {}, 0
    if len(counts) <= max_codes:
        return {str(k): v for k, v in counts.items()}, 0

    def count_key(item):
        value = item[1]
        return (-(value if isinstance(value, (int, float)) and
                  not isinstance(value, bool) else 0), str(item[0]))

    ordered = sorted(counts.items(), key=count_key)
    return {str(k): v for k, v in ordered[:max_codes]}, len(counts) - max_codes


def _safe_tokens(arm):
    """arm_tokens with honest degradation: reporting must never crash on a
    malformed arm (the gate path may; evidence may not)."""
    try:
        return arm_tokens(arm)
    except (TypeError, AttributeError):
        return 0


def arm_summary(arm, name):
    """Bounded summary of one canonical arm: outcome, requests, tokens,
    error codes, optional scorer_output/verdict_result passthrough.
    Honest degradation: None/malformed arm -> None, never a fabricated row."""
    if not isinstance(arm, dict):
        return None
    codes, omitted = bounded_error_codes(arm.get('error_code_counts'))
    summary = {'arm': _truncate(str(arm.get('arm') or name)),
               'outcome': arm.get('outcome'),
               'model_requests': arm.get('model_requests'),
               'total_tokens': _safe_tokens(arm),
               'error_code_counts': codes}
    if omitted:
        summary['error_code_counts_omitted'] = omitted
    if arm.get('verdict_result') is not None:
        summary['verdict_result'] = _bound(arm.get('verdict_result'))
    if arm.get('scorer_output') is not None:
        summary['scorer_output'] = _bound(arm.get('scorer_output'))
    return summary


def proposer_provenance(proposer):
    """Provenance of the proposal (Theme C3): model + prompt-hash when the
    proposer exposes them (HttpProposer does), class name as the identity
    floor. Missing fields stay None — never fabricated."""
    model = getattr(proposer, 'model', None)
    return {'model': _truncate(str(model)) if model is not None else None,
            'proposer': type(proposer).__name__,
            'prompt_hash': getattr(proposer, 'last_prompt_hash', None)}


def build_cycle_evidence(cycle_id, *, provenance=None, hypothesis=None,
                         control=None, treatment=None, verdict=None,
                         auto_dir=None, runner_ok=None, runner_reason=None,
                         gate=None, apply=None, revert=None,
                         observe=False, mode=None, node=None,
                         budget_spent=None, budget_cap=None,
                         recorded_at=None):
    """Assemble ONE bounded evidence record (``rsi-loop-evidence/1``).

    All inputs are optional and honestly degradable: a section is present
    only when its stage produced data (observe/no-proposal cycles carry no
    experiment section; a cycle that never reached apply carries none).
    Never raises on malformed inputs — reporting must not kill a cycle.
    """
    evidence = {'schema': EVIDENCE_SCHEMA, 'cycle_id': cycle_id,
                'recorded_at': recorded_at or utcnow(),
                'mode': mode, 'node': node, 'observe': bool(observe),
                'provenance': _bound(provenance) if provenance else None,
                'hypothesis': _bound(hypothesis) if hypothesis else None,
                'experiment': None, 'gate': None, 'apply': None,
                'budget': {'spent': budget_spent, 'cap': budget_cap}}

    has_experiment = (not observe) and (auto_dir is not None or runner_ok is not None
                                        or runner_reason is not None
                                        or control is not None or treatment is not None)
    if has_experiment:
        arms = None
        delta = None
        tokens = None
        if control is not None or treatment is not None:
            arms = {'control': arm_summary(control, 'control'),
                    'treatment': arm_summary(treatment, 'treatment')}
            if control is not None and treatment is not None:
                try:
                    raw_delta = error_code_delta(control, treatment)
                except TypeError:
                    raw_delta = None
                if raw_delta is not None:
                    delta, omitted = bounded_error_codes(raw_delta)
                    if omitted:
                        delta = dict(delta)
                        delta['error_code_delta_omitted'] = omitted
            tokens = {'control': _safe_tokens(control),
                      'treatment': _safe_tokens(treatment),
                      'total': _safe_tokens(control) + _safe_tokens(treatment)}
        evidence['experiment'] = {
            'ok': bool(runner_ok) if runner_ok is not None else None,
            'reason': runner_reason,
            'auto_dir': _truncate(str(auto_dir)) if auto_dir is not None else None,
            'arms': arms, 'error_code_delta': delta, 'tokens': tokens,
            'verdict': _bound(verdict) if verdict else None}

    if isinstance(gate, dict):
        inputs = gate.get('inputs')
        if not isinstance(inputs, dict):
            gate_evidence = gate.get('evidence') or {}
            inputs = {'next_before': gate_evidence.get('next_before'),
                      'next_after': gate_evidence.get('next_after'),
                      'budget_ok': None}
        evidence['gate'] = {'decision': gate.get('decision'),
                            'reason': gate.get('reason'),
                            'inputs': _bound(inputs),
                            'evidence': _bound(gate.get('evidence'))}

    if isinstance(apply, dict):
        apply_evidence = {'applied': apply.get('applied'),
                          'commit': apply.get('commit'),
                          'dry': apply.get('dry'), 'noop': apply.get('noop'),
                          'reason': apply.get('reason'),
                          'error': _bound(apply.get('error'))}
        if isinstance(revert, dict) and revert.get('cycle') == cycle_id:
            apply_evidence['revert_commit'] = revert.get('commit')
            apply_evidence['revert_file'] = revert.get('file')
        evidence['apply'] = apply_evidence
    return evidence


def persist_evidence_envelope(auto_dir, evidence, results_name='results.json'):
    """Write the engine's evidence record into the cycle's results envelope
    (``auto_dir/results.json``) as an ADDITIVE top-level ``evidence`` key.

    Only a TERMINAL envelope (dict with a dict ``verdict``) is ever touched —
    the engine never writes into a non-terminal file (an intermediate write
    may belong to a still-running driver). The original file mode is
    preserved; the write is atomic (tmp + replace). verdict/results/
    finished_at are never modified.

    Returns ``(path, None)`` on success or ``(None, reason)``; never raises
    for absent/corrupt/untouchable envelopes (the state record carries the
    evidence regardless).
    """
    path = Path(auto_dir) / results_name
    try:
        raw = path.read_text()
        mode = stat.S_IMODE(path.stat().st_mode)
    except OSError as error:
        return None, 'results_json_unreadable:%s' % type(error).__name__
    try:
        doc = json.loads(raw)
    except ValueError:
        return None, 'results_json_corrupt'
    if not isinstance(doc, dict) or not isinstance(doc.get('verdict'), dict):
        return None, 'results_not_terminal'
    doc['evidence'] = evidence
    tmp = path.with_name(path.name + '.tmp')
    try:
        tmp.write_text(json.dumps(doc, indent=2, ensure_ascii=False) + '\n')
        os.chmod(tmp, mode)
        os.replace(tmp, path)
    except OSError as error:
        try:
            tmp.unlink()
        except OSError:
            pass
        return None, 'results_json_write_failed:%s' % type(error).__name__
    return path, None


class EvidenceReadError(Exception):
    """Read-back failure with diagnostics (CLI exit code 3)."""

    def __init__(self, error, diagnostics=None):
        super().__init__(error)
        self.diagnostics = {'error': error, **(diagnostics or {})}


def read_evidence(path, cycle_id=None):
    """Evidence read-back for ledger/autopsy tooling. Accepts:
    - a state file -> ``{'source': 'state', 'cycles': [{cycle_id, accepted,
      observe, gate_decision, evidence}, ...]}`` (evidence None for records
      written before C3 — old state files read back honestly);
    - an auto_dir (or a results.json file) -> the envelope's engine-written
      evidence via the terminal-only loader.

    ``cycle_id`` filters the state source. Raises FileNotFoundError (caller
    maps to exit 2) or EvidenceReadError (exit 3)."""
    path = Path(path)
    if path.is_dir():
        if not (path / 'results.json').is_file():
            raise FileNotFoundError(str(path))
        return _read_envelope(path)
    if path.is_file():
        if path.name == 'results.json':
            return _read_envelope(path.parent)
        return _read_state(path, cycle_id)
    raise FileNotFoundError(str(path))


def _read_envelope(auto_dir):
    from .results import load_terminal_results
    loaded = load_terminal_results(auto_dir)
    if not loaded['ok']:
        raise EvidenceReadError(loaded['diagnostics'].get('error',
                                                          'results_not_terminal'),
                                loaded['diagnostics'])
    return {'source': 'results_envelope',
            'path': str(Path(auto_dir) / 'results.json'),
            'evidence': loaded.get('evidence')}


def _read_state(path, cycle_id):
    try:
        data = json.loads(path.read_text())
    except (OSError, ValueError) as error:
        raise EvidenceReadError('state_file_unreadable',
                                {'path': str(path),
                                 'error': '%s: %s' % (type(error).__name__,
                                                      str(error)[:160])})
    if not isinstance(data, dict) or not isinstance(data.get('cycles'), list):
        raise EvidenceReadError('not_an_rsi_loop_state_file', {'path': str(path)})
    records = []
    for record in data['cycles']:
        if not isinstance(record, dict):
            continue
        if cycle_id is not None and record.get('id') != cycle_id:
            continue
        records.append({'cycle_id': record.get('id'),
                        'accepted': record.get('accepted'),
                        'observe': record.get('observe'),
                        'gate_decision': (record.get('gate') or {}).get('decision'),
                        'evidence': record.get('evidence')})
    return {'source': 'state', 'path': str(path), 'cycles': records}


__all__ = ['EVIDENCE_SCHEMA', 'ERROR_CODES_MAX', 'STR_MAX', 'arm_summary',
           'bounded_error_codes', 'proposer_provenance', 'build_cycle_evidence',
           'persist_evidence_envelope', 'read_evidence', 'EvidenceReadError']
