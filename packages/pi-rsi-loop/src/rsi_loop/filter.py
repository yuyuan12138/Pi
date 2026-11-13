"""FILTER port helpers: proposal validation with rejection logging.

Generic invariants (framework) + adapter validator hook (project scope
rules — MC: hot library shape via wave_loop.validate_staged; toy consumer:
its own validator). Every rejection is logged with its reason.
"""
import re

NAME_RE = re.compile(r'[A-Za-z_][A-Za-z0-9_]{0,31}')

DEFAULT_CHANGE_KEYS = frozenset({'file', 'action', 'name', 'skill', 'deactivate', 'diff'})


def entry_from_raw(raw_hyp, cycle_id, position):
    """Map one raw proposer hypothesis to the canonical engine entry.

    Canonical change shape: ``{'file', 'action', 'name'?, 'skill'?,
    'deactivate'?, 'diff'?}`` — ``action='patch'`` + ``diff`` marks a
    cold/architecture-scope change (MC: artifact source patch); the engine
    treats scope as an adapter-owned runner-routing key only.
    """
    change = raw_hyp.get('change') or {}
    entry = {'id': 'C%sH%d' % (cycle_id, position), 'raw_id': raw_hyp.get('id'),
             'description': raw_hyp.get('description'),
             'novelty': raw_hyp.get('novelty'),
             'target_file': change.get('file'),
             'action': change.get('action'),
             'name': change.get('name'),
             'skill': change.get('skill'),
             'deactivate': change.get('deactivate') or [],
             'prediction': raw_hyp.get('prediction'),
             'falsifiable': raw_hyp.get('falsifiable'),
             'evidence': raw_hyp.get('evidence') or []}
    if change.get('action') == 'patch' and isinstance(change.get('diff'), str):
        entry['cold_diff'] = change['diff']
    entry['_change_keys'] = list(change.keys()) if isinstance(change, dict) else None
    return entry


def validate_entry_generic(entry, adapter_validator=None,
                           change_keys=DEFAULT_CHANGE_KEYS):
    """Generic filter invariants for ONE entry. Returns a problem list
    (empty = pass). Adapter validator extends, never weakens, this list."""
    problems = []
    extra_keys = set(entry.get('_change_keys') or []) - set(change_keys)
    if extra_keys:
        problems.append('unexpected_change_keys:%s' % sorted(extra_keys))
    if entry.get('falsifiable') is False:
        problems.append('not_falsifiable')
    prediction = entry.get('prediction')
    if not isinstance(prediction, dict) \
            or not isinstance(prediction.get('error_code'), str) or not prediction['error_code'] \
            or not isinstance(prediction.get('error_count_target'), int) \
            or not isinstance(prediction.get('max_requests'), int) or prediction['max_requests'] <= 0:
        problems.append('prediction_not_measurable')
    if entry.get('action') == 'patch':
        if not isinstance(entry.get('cold_diff'), str) or not entry.get('cold_diff'):
            problems.append('cold_diff_missing')
        return problems
    if entry.get('action') not in ('add', 'modify', 'remove'):
        problems.append('action_invalid')
    name = entry.get('name')
    if not isinstance(name, str) or not NAME_RE.fullmatch(name or ''):
        problems.append('name_invalid')
    skill = entry.get('skill') or {}
    if entry.get('action') in ('add', 'modify'):
        if not isinstance(skill, dict) or not isinstance(skill.get('when'), str) \
                or not isinstance(skill.get('source'), str):
            problems.append('skill_object_invalid')
    if adapter_validator is not None:
        problems.extend(adapter_validator(entry))
    return problems


def filter_proposals(raw_hypotheses, cycle_id, adapter_validator=None,
                     k_max=3, change_keys=DEFAULT_CHANGE_KEYS):
    """Filter over raw proposer output. Returns (accepted, rejected).
    Every rejection is logged with its reason (spec: queue failures logged)."""
    if not isinstance(raw_hypotheses, list):
        return [], [{'id': None, 'reason': 'hypotheses_not_a_list'}]
    rejected, accepted = [], []
    if len(raw_hypotheses) > k_max:
        rejected.append({'id': None,
                         'reason': 'k_overflow:%d>%d_truncated' % (len(raw_hypotheses), k_max)})
        raw_hypotheses = raw_hypotheses[:k_max]
    for position, raw in enumerate(raw_hypotheses, 1):
        if not isinstance(raw, dict):
            rejected.append({'id': None, 'reason': 'hypothesis_not_an_object'})
            continue
        entry = entry_from_raw(raw, cycle_id, position)
        problems = validate_entry_generic(entry, adapter_validator=adapter_validator,
                                          change_keys=change_keys)
        entry.pop('_change_keys', None)
        if problems:
            rejected.append({'id': entry['id'], 'raw_id': entry['raw_id'],
                             'reason': 'validation_failed', 'problems': problems})
        else:
            accepted.append(entry)
    return accepted, rejected
