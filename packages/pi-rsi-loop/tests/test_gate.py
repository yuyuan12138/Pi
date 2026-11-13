"""Unit tests for the AcceptGate (the MC-proven pinned criteria, pure)."""
import sys
import unittest
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[1] / 'src'))

from rsi_loop.ports import AcceptGate, observe_estimate, request_variance_ok  # noqa: E402


def arm(outcome='completed', requests=150, errors=None, tokens=3_600_000, name='treatment'):
    return {'arm': name, 'outcome': outcome, 'model_requests': requests,
            'error_code_counts': errors if errors is not None else {'program_error': 0},
            'token_totals': {'total_tokens': tokens}}


class AcceptGateTests(unittest.TestCase):
    def setUp(self):
        self.gate = AcceptGate(threshold=0.15)

    def test_improve_and_no_regression_accepts(self):
        out = self.gate.decide(arm(name='control', requests=193, errors={'a': 1}),
                               arm(requests=150, errors={'a': 0}), 'n1', 'n1')
        self.assertEqual(out['decision'], 'accept')
        self.assertEqual(out['reason'], 'primary_metric_met_no_regressions')
        self.assertEqual(out['evidence']['requests_improvement'], 0.2228)

    def test_edge_exactly_15_percent_accepts(self):
        out = self.gate.decide(arm(name='control', requests=100), arm(requests=85),
                               'n1', 'n1')
        self.assertEqual(out['decision'], 'accept')

    def test_just_below_15_percent_rejects(self):
        out = self.gate.decide(arm(name='control', requests=100), arm(requests=86),
                               'n1', 'n1')
        self.assertEqual(out['decision'], 'reject')
        self.assertEqual(out['reason'], 'primary_metric_not_met')

    def test_error_regression_rejects(self):
        out = self.gate.decide(arm(name='control', requests=193, errors={'a': 1}),
                               arm(requests=100, errors={'a': 4}), 'n1', 'n1')
        self.assertEqual(out['decision'], 'reject')
        self.assertEqual(out['reason'], 'errors_worsened:a')

    def test_error_improvement_is_not_regression(self):
        out = self.gate.decide(arm(name='control', requests=193, errors={'a': 3, 'b': 1}),
                               arm(requests=100, errors={'a': 1}), 'n1', 'n1')
        self.assertEqual(out['decision'], 'accept')
        self.assertEqual(out['evidence']['error_code_delta'], {'a': -2, 'b': -1})

    def test_infra_treatment_rejects(self):
        for outcome in ('infra_failure', 'timeout', 'died', 'aborted_budget'):
            out = self.gate.decide(arm(name='control'), arm(outcome=outcome), 'n1', 'n1')
            self.assertEqual(out['decision'], 'reject', outcome)
            self.assertEqual(out['reason'], 'treatment_not_completed:%s' % outcome)

    def test_capped_treatment_rejects(self):
        out = self.gate.decide(arm(name='control'), arm(outcome='cap_reached',
                                                        requests=200), 'n1', 'n1')
        self.assertEqual(out['decision'], 'reject')
        self.assertEqual(out['reason'], 'treatment_not_completed:cap_reached')

    def test_capped_control_rejects(self):
        out = self.gate.decide(arm(name='control', outcome='cap_reached', requests=200),
                               arm(requests=100), 'n1', 'n1')
        self.assertEqual(out['decision'], 'reject')
        self.assertEqual(out['reason'], 'control_not_completed:cap_reached')

    def test_frontier_advanced_alone_accepts(self):
        out = self.gate.decide(arm(name='control', requests=100),
                               arm(requests=100), 'node-a', 'node-b')
        self.assertEqual(out['decision'], 'accept')
        self.assertEqual(out['evidence']['frontier_advanced'], True)

    def test_budget_exceeded_rejects(self):
        out = self.gate.decide(arm(name='control', requests=193), arm(requests=100),
                               'n1', 'n1', budget_ok=False)
        self.assertEqual(out['decision'], 'reject')
        self.assertEqual(out['reason'], 'budget_exceeded')

    def test_no_treatment_metrics_rejects(self):
        out = self.gate.decide(arm(name='control'), None, 'n1', 'n1')
        self.assertEqual(out['decision'], 'reject')
        self.assertEqual(out['reason'], 'no_treatment_metrics')

    def test_non_int_requests_reject_primary(self):
        out = self.gate.decide(arm(name='control', requests=None), arm(requests=100),
                               'n1', 'n1')
        self.assertEqual(out['decision'], 'reject')
        self.assertEqual(out['reason'], 'primary_metric_not_met')

    def test_threshold_is_parameterizable(self):
        gate = AcceptGate(threshold=0.5)
        out = gate.decide(arm(name='control', requests=100), arm(requests=80), 'n1', 'n1')
        self.assertEqual(out['decision'], 'reject')

    def test_extra_not_completed_outcomes(self):
        gate = AcceptGate(extra_not_completed=('furnace_cold',))
        out = gate.decide(arm(name='control'), arm(outcome='furnace_cold'), 'n1', 'n1')
        self.assertEqual(out['reason'], 'treatment_not_completed:furnace_cold')


class ObserveEstimateTests(unittest.TestCase):
    def test_prediction_under_85pct_baseline_would_accept(self):
        entry = {'prediction': {'error_code': 'e', 'error_count_target': 0,
                                'max_requests': 80}}
        out = observe_estimate(entry, {'baseline_requests': 100,
                                       'error_code_counts': {'e': 2}})
        self.assertEqual(out['kind'], 'estimate_no_experiment')
        self.assertEqual(out['would_accept'], True)
        self.assertEqual(out['evidence']['predicted_requests_ratio'], 0.8)

    def test_prediction_at_threshold_edge(self):
        entry = {'prediction': {'error_code': 'e', 'error_count_target': 0,
                                'max_requests': 85}}
        out = observe_estimate(entry, {'baseline_requests': 100,
                                       'error_code_counts': {'e': 2}})
        self.assertEqual(out['would_accept'], True)      # 85 <= 85

    def test_error_target_below_observed_would_accept(self):
        entry = {'prediction': {'error_code': 'e', 'error_count_target': 1,
                                'max_requests': 120}}
        out = observe_estimate(entry, {'baseline_requests': 100,
                                       'error_code_counts': {'e': 2}})
        self.assertEqual(out['would_accept'], True)

    def test_no_signal_would_reject(self):
        entry = {'prediction': {'error_code': 'e', 'error_count_target': 5,
                                'max_requests': 120}}
        out = observe_estimate(entry, {'baseline_requests': 100,
                                       'error_code_counts': {'e': 2}})
        self.assertEqual(out['would_accept'], False)

    def test_unknown_code_no_signal(self):
        entry = {'prediction': {'error_code': 'e', 'error_count_target': 0,
                                'max_requests': 80}}
        out = observe_estimate(entry, {'baseline_requests': 100,
                                       'error_code_counts': {'other': 2}})
        self.assertEqual(out['would_accept'], True)      # requests criterion only


class RequestVarianceTests(unittest.TestCase):
    def test_three_successes_low_variance_ok(self):
        ok, cv = request_variance_ok([100, 102, 98])
        self.assertEqual(ok, True)
        self.assertEqual(cv, 0.0163)

    def test_high_variance_holds(self):
        ok, cv = request_variance_ok([100, 200, 100])
        self.assertEqual(ok, False)

    def test_variance_needs_three_successes(self):
        ok, cv = request_variance_ok([100, 102])
        self.assertEqual(ok, False)
        self.assertIsNone(cv)

    def test_nonpositive_filtered(self):
        ok, cv = request_variance_ok([100, 0, -5, 100, 100])
        self.assertEqual(ok, True)


if __name__ == '__main__':
    unittest.main()
