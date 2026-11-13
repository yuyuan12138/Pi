"""Pluggable ports: the six seams a project fills to run the loop.

Each port is documented as a base class; adapters subclass or duck-type.
Default implementations ship for the parts that proved generic in the MC
engine: AcceptGate (pinned accept criteria), RecordingApplier (no-op apply
for dry-run/observe), SaturationCurriculum (streak+variance node policy).
"""
import abc

from .results import INFRA_OUTCOMES, arm_tokens, error_code_delta, is_completed_outcome
from .state import utcnow

DEFAULT_REQUEST_IMPROVEMENT = 0.15
SATURATION_SUCCESS_STREAK = 3
SATURATION_VARIANCE = 0.30
FAILURE_HOLD_STREAK = 5


# ------------------------------------------------------------- LedgerSource --

class LedgerSource(abc.ABC):
    """SENSE port: project evidence in.

    ``sense(cycle_id)`` must return a dict with at least::

        {
          'ledger':      {..., 'error_code_counts': {code: count},
                          'baseline_requests': <int|None>},   # proposer input
          'frontier':    <any JSON-able frontier snapshot or None>,
          'next_before': <target identifier or None>,         # gate input
        }

    Honest degradation: a missing frontier/next_before must be None, never
    fabricated. ``post_experiment(cycle_id)`` (optional, default None) is the
    post-treatment re-sense for the frontier-advanced gate criterion; return
    ``{'next_after': ...}`` or None.
    """

    def sense(self, cycle_id):
        raise NotImplementedError

    def post_experiment(self, cycle_id):
        return None


# ----------------------------------------------------------------- Proposer --

class Proposer(abc.ABC):
    """PROPOSE port: raw hypotheses.

    ``propose(ledger, frontier, node, *, rejections=None, raw_sink=None,
    extra_context=None)`` returns ``(raw_text, doc)`` where ``doc`` contains
    ``'hypotheses'``: a list of raw hypothesis dicts (schema: ADAPTER.md).

    Contract details the engine relies on:
    - ``rejections`` is the engine's rejection memory (novelty pressure);
      an honest proposer MUST NOT repeat a rejected proposal's target+intent.
    - raise ProposerUnavailable when no real proposal is obtainable — the
      engine pauses, it never fabricates.
    - set ``self.last_usage = {'prompt_tokens', 'completion_tokens',
      'total_tokens'}`` so the engine can account budget.
    """

    last_usage = {}

    def propose(self, ledger, frontier, node, *, rejections=None, raw_sink=None,
                extra_context=None):
        raise NotImplementedError


# ----------------------------------------------------------- ExperimentRunner --

class ExperimentRunner(abc.ABC):
    """EXPERIMENT port: A/B driver + scorer.

    ``__call__(entry, proposals_path, remaining_budget, cycle_id)`` returns
    the canonical exp_out::

        {'ok': True,  'auto_dir': <dir>, 'results': {control, treatment, verdict},
         'finished_at': ..., 'diagnostics': {...}}
        {'ok': False, 'reason': '<machine_reason>', 'auto_dir': ..., 'diagnostics': ...}

    ``load_results(auto_dir, started_at=None)`` is the crash-resume read: it
    MUST apply the terminal-only rule (rsi_loop.load_terminal_results) and
    never relaunch anything.
    """

    def __call__(self, entry, proposals_path, remaining_budget, cycle_id):
        raise NotImplementedError

    def load_results(self, auto_dir, started_at=None):
        from .results import load_terminal_results
        return load_terminal_results(auto_dir)


# --------------------------------------------------------------------- Gate --

class Gate(abc.ABC):
    """GATE port: accept/reject on the project's pinned criteria."""

    def decide(self, control, treatment, next_before, next_after, *, budget_ok=True):
        raise NotImplementedError


class AcceptGate(Gate):
    """The MC-proven accept gate (pinned criteria, pure).

    Accept iff: primary metric (frontier advanced OR same-node requests
    improved >= threshold) AND no error code worsened (any treatment-control
    delta > 0 counts as a regression signal) AND budget ok AND the treatment
    arm completed AND (when a control arm exists) the control arm completed.
    Never auto-modifies anything — decision + evidence only.
    """

    def __init__(self, threshold=DEFAULT_REQUEST_IMPROVEMENT,
                 extra_not_completed=()):
        self.threshold = threshold
        self.extra_not_completed = tuple(extra_not_completed)

    def requests_improved(self, control_requests, treatment_requests):
        if not isinstance(control_requests, int) or not isinstance(treatment_requests, int):
            return False, None
        if control_requests <= 0:
            return False, None
        improvement = (control_requests - treatment_requests) / control_requests
        return improvement >= self.threshold, round(improvement, 4)

    @staticmethod
    def frontier_advanced(next_before, next_after):
        """Frontier advanced: the target identifier changed pre/post."""
        return bool(next_before and next_after and next_before != next_after)

    def decide(self, control, treatment, next_before, next_after, *, budget_ok=True):
        evidence = {}
        if treatment is None:
            return {'decision': 'reject', 'reason': 'no_treatment_metrics', 'evidence': {}}
        if not is_completed_outcome(treatment, self.extra_not_completed):
            return {'decision': 'reject',
                    'reason': 'treatment_not_completed:%s' % treatment.get('outcome'),
                    'evidence': {'outcome': treatment.get('outcome')}}
        if control is not None and control.get('outcome') == 'cap_reached':
            return {'decision': 'reject',
                    'reason': 'control_not_completed:cap_reached',
                    'evidence': {'outcome': control.get('outcome'),
                                 'model_requests': control.get('model_requests'),
                                 'note': 'control stopped at its per-arm request budget with '
                                         'the goal unmet: truncated baseline, no valid comparison'}}
        improved, improvement = self.requests_improved(
            control.get('model_requests') if control else None,
            treatment.get('model_requests'))
        advanced = self.frontier_advanced(next_before, next_after)
        evidence['requests_improvement'] = improvement
        evidence['requests_improved'] = improved
        evidence['frontier_advanced'] = advanced
        evidence['next_before'] = next_before
        evidence['next_after'] = next_after
        if not (advanced or improved):
            return {'decision': 'reject', 'reason': 'primary_metric_not_met', 'evidence': evidence}
        if control is not None:
            delta = error_code_delta(control, treatment)
            worsened = sorted(c for c, d in delta.items() if d > 0)
            evidence['error_code_delta'] = delta
            if worsened:
                return {'decision': 'reject',
                        'reason': 'errors_worsened:%s' % ','.join(worsened),
                        'evidence': evidence}
        if not budget_ok:
            return {'decision': 'reject', 'reason': 'budget_exceeded', 'evidence': evidence}
        evidence['verdict_result'] = treatment.get('verdict_result')
        return {'decision': 'accept', 'reason': 'primary_metric_met_no_regressions',
                'evidence': evidence}


# ------------------------------------------------------------------- Applier --

class Applier(abc.ABC):
    """APPLY port: write an accepted change.

    ``__call__(entry, cycle_id, description, node, *, dry=False)`` returns::

        {'applied': True, 'commit': ..., 'revert_procedure': ...}   # live success
        {'applied': False, 'dry': True, 'would_write': ...}         # dry-run plan
        {'applied': False, 'error': '<reason>'}                     # failure

    AUTHORIZATION (framework): the engine calls this only when mode == 'live'
    and the cycle is not an observe cycle; the applier owns HOW (atomic
    write, git commit, hot-file scope) and MUST keep its scope minimal.
    On failure the engine counts the cycle as not accepted.
    """

    def __call__(self, entry, cycle_id, description, node, *, dry=False):
        raise NotImplementedError


class RecordingApplier(Applier):
    """No-op applier: records what it WOULD do, writes nothing. The dry-run /
    observe default and the toy-consumer apply port."""

    def __init__(self, would_write=None):
        self.would_write = would_write
        self.calls = []

    def __call__(self, entry, cycle_id, description, node, *, dry=False):
        record = {'applied': False, 'noop': True, 'dry': bool(dry),
                  'would_write': self.would_write,
                  'hypothesis': entry.get('id'), 'cycle': cycle_id}
        self.calls.append(record)
        return record


# ---------------------------------------------------------------- Curriculum --

class Curriculum(abc.ABC):
    """CURRICULUM port: what to target next.

    ``update(cycle_id, accepted_now, treatment, state)`` returns a transition
    dict carrying at least ``'transition'`` (saturation vocabulary:
    advance | hold_flag | hold_variance | hold_no_ladder | none | ...).
    The port owns ``state.data['node']`` and may append to its history.
    """

    def update(self, cycle_id, accepted_now, treatment, state):
        raise NotImplementedError


def request_variance_ok(requests, max_variance=SATURATION_VARIANCE,
                        min_streak=SATURATION_SUCCESS_STREAK):
    """Coefficient of variation of the last successes' request counts
    < max_variance (pure; MC-proven saturation rule)."""
    values = [r for r in requests if isinstance(r, int) and r > 0]
    if len(values) < min_streak:
        return False, None
    mean = sum(values) / len(values)
    if mean <= 0:
        return False, None
    var = sum((v - mean) ** 2 for v in values) / len(values)
    cv = (var ** 0.5) / mean
    return cv < max_variance, round(cv, 4)


class SaturationCurriculum(Curriculum):
    """MC-proven saturation policy: 3 consecutive successes + request
    variance <30% -> advance node (to ``next_node_fn(state)``); 5 consecutive
    failures -> hold + flag (never a fabricated node). Difficulty-escalation
    against an external ladder is an ADAPTER concern (see ADAPTER.md)."""

    def __init__(self, next_node_fn=None):
        self.next_node_fn = next_node_fn

    def update(self, cycle_id, accepted_now, treatment, state):
        c = state.data['counters']
        prior = [cyc.get('treatment_requests')
                 for cyc in state.data['cycles'][-SATURATION_SUCCESS_STREAK:]
                 if cyc.get('accepted')]
        success_requests = ([treatment.get('model_requests')]
                            if accepted_now and isinstance(treatment, dict)
                            and isinstance(treatment.get('model_requests'), int) else []) + prior
        transition = self._pure(c['consecutive_successes'], c['consecutive_failures'],
                                success_requests, self.next_node_fn(state) if self.next_node_fn else None,
                                state.data['node']['current'])
        if transition['transition'] == 'advance':
            state.data['node']['history'].append(
                {'from': transition['previous_node'], 'to': transition['node'],
                 'at': utcnow(), 'cycle': cycle_id})
            state.data['node']['current'] = transition['node']
        if transition.get('flag') and transition['flag'] not in state.data.setdefault('node_flags', []):
            state.data['node_flags'].append(transition['flag'])
        if transition['transition'] == 'advance' \
                and 'five_consecutive_failures' in state.data.get('node_flags', []):
            state.data['node_flags'].remove('five_consecutive_failures')
        return transition

    @staticmethod
    def _pure(consecutive_successes, consecutive_failures, success_requests,
              ladder_next, current_node):
        if consecutive_failures >= FAILURE_HOLD_STREAK:
            return {'transition': 'hold_flag', 'node': current_node,
                    'flag': 'five_consecutive_failures'}
        if consecutive_successes >= SATURATION_SUCCESS_STREAK:
            ok, cv = request_variance_ok(success_requests)
            if ok and ladder_next:
                return {'transition': 'advance', 'node': ladder_next,
                        'previous_node': current_node, 'request_cv': cv}
            if ok and not ladder_next:
                return {'transition': 'hold_no_ladder', 'node': current_node,
                        'request_cv': cv, 'flag': 'ladder_next_unavailable'}
            return {'transition': 'hold_variance', 'node': current_node, 'request_cv': cv}
        return {'transition': 'none', 'node': current_node}


# --------------------------------------------------------- observe estimate --

def observe_estimate(entry, ledger, threshold=DEFAULT_REQUEST_IMPROVEMENT):
    """DRY estimate for observe mode: no experiment is run; the would-accept
    decision is PREDICTION-BASED (labelled estimate_no_experiment): predicted
    max_requests <= (1 - threshold) * baseline requests, or the predicted
    error count target below the observed count for that code. Pure."""
    baseline = ledger.get('baseline_requests')
    prediction = entry.get('prediction') or {}
    evidence = {'prediction': prediction, 'baseline_requests': baseline}
    would = False
    if isinstance(baseline, int) and isinstance(prediction.get('max_requests'), int) and baseline > 0:
        would = would or prediction['max_requests'] <= (1 - threshold) * baseline
        evidence['predicted_requests_ratio'] = round(prediction['max_requests'] / baseline, 4)
    code = prediction.get('error_code')
    observed = (ledger.get('error_code_counts') or {}).get(code)
    if isinstance(observed, int) and isinstance(prediction.get('error_count_target'), int):
        would = would or prediction['error_count_target'] < observed
        evidence['observed_%s' % code] = observed
    return {'kind': 'estimate_no_experiment', 'would_accept': would, 'evidence': evidence}


__all__ = ['LedgerSource', 'Proposer', 'ExperimentRunner', 'Gate', 'AcceptGate',
           'Applier', 'RecordingApplier', 'Curriculum', 'SaturationCurriculum',
           'request_variance_ok', 'observe_estimate', 'INFRA_OUTCOMES',
           'DEFAULT_REQUEST_IMPROVEMENT', 'SATURATION_SUCCESS_STREAK',
           'SATURATION_VARIANCE', 'FAILURE_HOLD_STREAK', 'arm_tokens',
           'is_completed_outcome', 'error_code_delta']
