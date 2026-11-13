"""C2 acceptance tests: the toy second consumer completes ONE full loop
iteration in dry-run with ZERO side effects.

No network, no LLM, no external process; every artifact stays inside the
per-test workspace. Both postures are exercised:
- dry-run full path (observe semantics, stubbed scorer, no-op applier):
  SENSE -> PROPOSE -> FILTER -> EXPERIMENT -> GATE -> APPLY(no-op) -> CURRICULUM;
- observe posture: estimate-only gate, the scorer is never called.
"""
import json
import sys
import tempfile
import unittest
from pathlib import Path

HERE = Path(__file__).resolve().parent
sys.path.insert(0, str(HERE))

import toy_consumer                                        # noqa: E402
from rsi_loop.filter import validate_entry_generic         # noqa: E402


class ToyDryRunTests(unittest.TestCase):
    def setUp(self):
        self._tmp = tempfile.TemporaryDirectory(prefix='rsi-loop-toy-test-')
        self.workspace = Path(self._tmp.name) / 'workspace'
        self.workspace.mkdir()
        self._parent_snapshot = sorted(p.name for p in Path(self._tmp.name).iterdir())

    def tearDown(self):
        # zero side effects: nothing appeared next to the workspace
        after = sorted(p.name for p in Path(self._tmp.name).iterdir())
        self.assertEqual(after, self._parent_snapshot)
        self._tmp.cleanup()

    # -- the C2 acceptance: one full dry-run iteration ----------------------
    def test_full_dry_run_iteration_accepts_with_zero_side_effects(self):
        engine, exit_code, state = toy_consumer.run_one_cycle(self.workspace)
        # loop ran exactly one cycle to a clean completion
        self.assertEqual(exit_code, 7)                     # EXIT_CYCLES_DONE
        self.assertEqual(state.data['status'], 'cycles_done')
        self.assertEqual(state.data['counters']['cycles_completed'], 1)
        self.assertEqual(state.data['counters']['accepted'], 1)
        # every stage ran
        self.assertEqual(len(engine.ledger_source.sense_calls), 1)
        self.assertEqual(len(engine.runner.calls), 1)      # deterministic scorer ran
        self.assertEqual(len(engine.applier.calls), 1)     # no-op applier was reached
        # gate: pinned criteria on the deterministic scorer's metrics
        record = state.data['cycles'][-1]
        self.assertEqual(record['gate']['decision'], 'accept')
        self.assertEqual(record['gate']['reason'], 'primary_metric_met_no_regressions')
        self.assertEqual(record['gate']['evidence']['requests_improvement'], 0.2)
        self.assertEqual(record['gate']['evidence']['requests_improved'], True)
        self.assertEqual(record['gate']['evidence']['error_code_delta'],
                         {'program_error': -2})
        # apply was a no-op: nothing written, would_write recorded, no revert
        self.assertEqual(record['apply']['applied'], False)
        self.assertEqual(record['apply']['noop'], True)
        self.assertFalse((self.workspace / 'toy' / 'skills.json').exists())
        self.assertIsNone(state.data['revert'])
        # results.json is terminal and inside the workspace
        auto_dir = Path(engine.runner.calls[0] and self.workspace / 'experiments')
        results = list(auto_dir.glob('auto-*/results.json'))
        self.assertEqual(len(results), 1)
        doc = json.loads(results[0].read_text())
        self.assertIn('verdict', doc)                      # terminal marker
        # budget accounted from the canonical token_totals (4.0M + 3.2M)
        self.assertEqual(state.data['budget']['spent'], 7_200_000)
        # state + reports + proposals live inside the workspace
        self.assertTrue((self.workspace / 'state' / 'closed_loop_state.json').is_file())
        self.assertTrue((self.workspace / 'reports').is_dir())
        self.assertTrue((self.workspace / 'proposals').is_dir())
        # the accepted entry passed the toy scope validator
        self.assertEqual(record['hypothesis'], 'C001H1')
        self.assertEqual(record['node'], 'toy-node-1')
        # curriculum: single accept does not advance (needs 3 + low variance)
        self.assertEqual(record['curriculum']['transition'], 'none')

    def test_dry_run_cli_reports_json_summary(self):
        exit_code = toy_consumer.main(['--workspace', str(self.workspace)])
        self.assertEqual(exit_code, 7)

    # -- observe posture: estimate-only, scorer never called ----------------
    def test_observe_mode_zero_experiment_zero_apply(self):
        engine, exit_code, state = toy_consumer.run_one_cycle(
            self.workspace, mode='observe', observe_window=1)
        self.assertEqual(exit_code, 6)                     # EXIT_OBSERVE_DONE
        self.assertEqual(state.data['status'], 'observe_window_done')
        self.assertEqual(len(engine.ledger_source.sense_calls), 1)
        self.assertEqual(engine.runner.calls, [])          # no experiment at all
        self.assertEqual(engine.applier.calls, [])         # nothing applied
        self.assertEqual(state.data['counters']['cycles_completed'], 1)
        self.assertEqual(len(state.data['would_accept']), 1)
        entry = state.data['would_accept'][-1]
        self.assertEqual(entry['decision'], 'would_accept')
        self.assertEqual(entry['reason'], 'observe_mode_estimate')
        self.assertEqual(entry['evidence']['kind'], 'estimate_no_experiment')
        # prediction-based: 80 <= 0.85 * 100
        self.assertEqual(entry['evidence']['would_accept'], True)
        self.assertEqual(entry['evidence']['predicted_requests_ratio'], 0.8)
        self.assertFalse((self.workspace / 'experiments').exists())

    def test_observe_would_reject_when_prediction_fails(self):
        # prediction asks for MORE requests than baseline -> estimate rejects
        proposer = toy_consumer.ScriptedProposer(hypotheses=[{
            'id': 'H1', 'description': 'overspending fixture', 'falsifiable': True,
            'change': {'file': 'toy/skills.json', 'action': 'modify',
                       'name': 'toy_greedy', 'skill': {'name': 'toy_greedy',
                                                       'when': 'when greedy',
                                                       'source': '/* greedy */'},
                       'deactivate': []},
            'prediction': {'error_code': 'program_error',
                           'error_count_target': 5, 'max_requests': 120}}])
        engine, exit_code, state = toy_consumer.run_one_cycle(
            self.workspace, mode='observe', observe_window=1, proposer=proposer)
        self.assertEqual(exit_code, 6)
        entry = state.data['would_accept'][-1]
        self.assertEqual(entry['decision'], 'would_reject')
        self.assertEqual(entry['evidence']['would_accept'], False)

    # -- adapter surface -----------------------------------------------------
    def test_toy_validator_enforces_scope(self):
        problems = toy_consumer.toy_validator({'target_file': 'other/file.json'})
        self.assertEqual(problems, ['unknown_target_file:%r' % 'other/file.json'])
        problems = toy_consumer.toy_validator({'target_file': 'toy/skills.json',
                                               'action': 'patch'})
        self.assertEqual(problems, ['cold_scope_not_supported_by_toy_consumer'])
        self.assertEqual(toy_consumer.toy_validator(
            {'target_file': 'toy/skills.json', 'action': 'modify'}), [])

    def test_generic_plus_adapter_validator_compose(self):
        entry = {'target_file': 'toy/skills.json', 'action': 'modify',
                 'name': 'toy_action_retry_bound', 'skill': {'when': 'w', 'source': 's'},
                 'prediction': {'error_code': 'program_error',
                                'error_count_target': 0, 'max_requests': 80},
                 'falsifiable': True, '_change_keys': ['file', 'action', 'name',
                                                       'skill', 'deactivate']}
        self.assertEqual(validate_entry_generic(entry,
                                                adapter_validator=toy_consumer.toy_validator),
                         [])


if __name__ == '__main__':
    unittest.main()
