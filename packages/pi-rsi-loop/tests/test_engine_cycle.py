"""Engine cycle tests: stubbed ports, framework features only.

Covers: full cycle accept path, mode gating (observe/live), observe-window
pause, budget caps + remaining-budget forwarding, two-strikes infra breaker,
crash-resume from every checkpointed phase (never relaunch; terminal-only),
rejection memory, scope routing, curriculum transition.
"""
import json
import sys
import tempfile
import unittest
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[1] / 'src'))

from rsi_loop.engine import RsiLoopEngine                  # noqa: E402
from rsi_loop.errors import ProposerUnavailable            # noqa: E402
from rsi_loop.filter import validate_entry_generic         # noqa: E402
from rsi_loop.ports import (AcceptGate, LedgerSource,      # noqa: E402
                            Proposer, RecordingApplier,
                            SaturationCurriculum, ExperimentRunner)
from rsi_loop.results import load_terminal_results         # noqa: E402
from rsi_loop.state import LoopState, utcnow               # noqa: E402


def metrics(arm_name, outcome='completed', requests=100, errors=None, tokens=4_000_000):
    return {'arm': arm_name, 'outcome': outcome, 'model_requests': requests,
            'error_code_counts': errors if errors is not None else {'program_error': 2},
            'token_totals': {'total_tokens': tokens}}


def raw_hyp():
    return {'id': 'H1', 'description': 'Fix the toy error.', 'falsifiable': True,
            'change': {'file': 'toy/skills.json', 'action': 'modify',
                       'name': 'my_skill',
                       'skill': {'name': 'my_skill', 'when': 'when x', 'source': '/* r */'},
                       'deactivate': []},
            'prediction': {'error_code': 'program_error', 'error_count_target': 0,
                           'max_requests': 80},
            'evidence': ['e1']}


def entry_fixture():
    from rsi_loop.filter import entry_from_raw
    e = entry_from_raw(raw_hyp(), 'cX', 1)
    e.pop('_change_keys')
    return e


class StubLedger(LedgerSource):
    def __init__(self, next_before='node-1', next_after=None, error_codes=None):
        self.next_before = next_before
        self._next_after = next_after
        self.error_codes = error_codes or {'program_error': 2}
        self.sense_calls, self.post_calls = [], []

    def sense(self, cycle_id):
        self.sense_calls.append(cycle_id)
        return {'ledger': {'newest_run': 'run-1',
                           'error_code_counts': dict(self.error_codes),
                           'baseline_requests': 100},
                'frontier': {'stub': True}, 'next_before': self.next_before}

    def post_experiment(self, cycle_id):
        self.post_calls.append(cycle_id)
        return {'next_after': self._next_after} if self._next_after is not None else None


class StubProposer(Proposer):
    def __init__(self, hypotheses=None, total_tokens=1500, fail=False):
        self.hypotheses = hypotheses if hypotheses is not None else [raw_hyp()]
        self.last_usage = {'prompt_tokens': 1200, 'completion_tokens': 300,
                           'total_tokens': total_tokens}
        self.fail = fail
        self.received_rejections = []

    def propose(self, ledger, frontier, node, *, rejections=None, raw_sink=None,
                extra_context=None):
        if self.fail:
            raise ProposerUnavailable('endpoint unreachable (stub)')
        self.received_rejections.append(list(rejections or []))
        doc = {'hypotheses': json.loads(json.dumps(self.hypotheses))}
        raw = json.dumps(doc)
        if raw_sink is not None:
            raw_sink(0, raw)
        return raw, doc


class StubRunner(ExperimentRunner):
    """Deterministic stub: returns a fixture exp_out; optionally writes a
    terminal results.json (for resume tests) or fails/raises."""

    def __init__(self, workspace=None, control_requests=100, treatment_requests=80,
                 treatment_errors=None, fail_reason=None, raise_error=None,
                 write_results=False):
        self.workspace = workspace
        self.control_requests = control_requests
        self.treatment_requests = treatment_requests
        self.treatment_errors = treatment_errors
        self.fail_reason = fail_reason
        self.raise_error = raise_error
        self.write_results = write_results
        self.calls = []

    def __call__(self, entry, proposals_path, remaining_budget, cycle_id):
        self.calls.append({'cycle': cycle_id, 'hypothesis': entry['id'],
                           'remaining_budget': remaining_budget})
        if self.raise_error is not None:
            raise self.raise_error
        if self.fail_reason is not None:
            return {'ok': False, 'reason': self.fail_reason, 'auto_dir': None}
        doc = {'control': metrics('control', requests=self.control_requests),
               'treatment': metrics('treatment', requests=self.treatment_requests,
                                    errors=self.treatment_errors, tokens=3_200_000),
               'verdict': {'result': 'treatment_favors'}}
        auto_dir = None
        if self.write_results:
            auto_dir = Path(self.workspace) / 'experiments' / ('auto-%s' % cycle_id)
            auto_dir.mkdir(parents=True, exist_ok=True)
            (auto_dir / 'results.json').write_text(json.dumps(
                {'verdict': {'result': 'treatment_favors'},
                 'finished_at': utcnow(), 'results': doc}))
        return {'ok': True, 'auto_dir': str(auto_dir) if auto_dir else None,
                'results': doc}


def no_strict_validator(entry):
    return []


def build_engine(tmp, *, mode='live', observe_window=0, budget_cap=None,
                 max_cycles_per_day=6, ledger=None, proposer=None, runner=None,
                 runners=None, applier_calls=None, next_node=None):
    ledger = ledger or StubLedger()
    proposer = proposer or StubProposer()
    runner = runner or StubRunner()
    state = LoopState(Path(tmp) / 'state.json', mode=mode, budget_cap=budget_cap,
                      max_cycles_per_day=max_cycles_per_day, initial_node='node-1')
    applier = RecordingApplier(would_write='toy/skills.json')
    engine = RsiLoopEngine(state, ledger, proposer, runner,
                           gate=AcceptGate(threshold=0.15), applier=applier,
                           curriculum=SaturationCurriculum(
                               next_node_fn=(lambda s: next_node) if next_node else None),
                           observe_window=observe_window, dry=True,
                           reports_dir=Path(tmp) / 'reports',
                           proposals_dir=Path(tmp) / 'proposals',
                           entry_validator=no_strict_validator,
                           runners=runners)
    return engine, applier


class FullCycleTests(unittest.TestCase):
    def setUp(self):
        self._tmp = tempfile.TemporaryDirectory()
        self.tmp = self._tmp.name

    def tearDown(self):
        self._tmp.cleanup()

    def test_full_cycle_accepts_applies_and_closes(self):
        engine, applier = build_engine(self.tmp)
        code = engine.run(1)
        self.assertEqual(code, 7)
        self.assertEqual(engine.state.data['status'], 'cycles_done')
        record = engine.state.data['cycles'][-1]
        self.assertEqual(record['gate']['decision'], 'accept')
        self.assertEqual(record['gate']['reason'], 'primary_metric_met_no_regressions')
        self.assertEqual(len(applier.calls), 1)
        self.assertEqual(record['apply']['noop'], True)
        self.assertEqual(record['accepted'], True)
        # budget: proposer 1500 + treatment 3.2M + control 4.0M
        self.assertEqual(engine.state.data['budget']['spent'], 7_201_500)
        self.assertTrue((Path(self.tmp) / 'reports' / ('cycle-%s.md' % record['id']))
                        .is_file())
        self.assertEqual(len(engine.ledger_source.sense_calls), 1)
        # counters: streaks updated once, at the gate
        self.assertEqual(engine.state.data['counters']['consecutive_successes'], 1)
        self.assertEqual(engine.state.data['counters']['consecutive_failures'], 0)

    def test_post_experiment_resense_feeds_frontier_advanced(self):
        ledger = StubLedger(next_after='node-2')
        engine, _ = build_engine(self.tmp, ledger=ledger)
        engine.run(1)
        evidence = engine.state.data['cycles'][-1]['gate']['evidence']
        self.assertEqual(evidence['frontier_advanced'], True)
        self.assertEqual(evidence['next_after'], 'node-2')
        self.assertEqual(len(ledger.post_calls), 1)

    def test_reject_on_flat_metrics_and_rejection_memory_flows(self):
        runner = StubRunner(control_requests=100, treatment_requests=100)
        engine, _ = build_engine(self.tmp, runner=runner)
        engine.run(2)
        record = engine.state.data['cycles'][-1]
        self.assertEqual(record['gate']['decision'], 'reject')
        self.assertEqual(record['gate']['reason'], 'primary_metric_not_met')
        # cycle 2's proposer received cycle 1's accepted hypothesis as a rejection
        self.assertEqual(len(engine.proposer.received_rejections[1]), 1)
        rejection = engine.proposer.received_rejections[1][0]
        self.assertEqual(rejection['reason'], 'primary_metric_not_met')
        self.assertEqual(rejection['summary'], 'Fix the toy error.')
        self.assertEqual(engine.state.data['counters']['consecutive_failures'], 2)

    def test_rejection_memory_capped_at_five(self):
        runner = StubRunner(control_requests=100, treatment_requests=100)
        engine, _ = build_engine(self.tmp, runner=runner, max_cycles_per_day=10)
        engine.run(7)
        self.assertEqual(len(engine.proposer.received_rejections[6]), 5)

    def test_error_regression_rejects(self):
        runner = StubRunner(treatment_errors={'program_error': 3})
        engine, _ = build_engine(self.tmp, runner=runner)
        engine.run(1)
        self.assertEqual(engine.state.data['cycles'][-1]['gate']['reason'],
                         'errors_worsened:program_error')

    def test_saturation_curriculum_advances_after_three_low_variance_accepts(self):
        engine, _ = build_engine(self.tmp, next_node='node-2')
        engine.run(3)
        self.assertEqual(engine.state.data['node']['current'], 'node-2')
        history = engine.state.data['node']['history']
        self.assertEqual(history[-1]['from'], 'node-1')
        self.assertEqual(history[-1]['to'], 'node-2')

    def test_apply_failure_counts_as_reject(self):
        class FailingApplier(RecordingApplier):
            def __call__(self, entry, cycle_id, description, node, *, dry=False):
                return {'applied': False, 'error': 'git commit failed'}

        engine, _ = build_engine(self.tmp)
        engine.applier = FailingApplier()
        engine.run(1)
        record = engine.state.data['cycles'][-1]
        self.assertEqual(record['accepted'], False)
        self.assertEqual(engine.state.data['counters']['consecutive_failures'], 1)

    def test_no_runner_for_scope_is_infra_failure(self):
        def scope_cold(entry):
            entry['scope'] = 'cold'
            return []
        runner = StubRunner()
        engine, _ = build_engine(self.tmp, runner=runner)   # runners: only 'hot'
        engine.entry_validator = scope_cold
        engine.run(1)
        record = engine.state.data['cycles'][-1]
        self.assertEqual(record['gate']['reason'],
                         'experiment_failed:no_runner_for_scope:cold')

    def test_scope_routes_to_dedicated_runner(self):
        def scope_cold(entry):
            entry['scope'] = 'cold'
            return []
        cold_runner = StubRunner()
        engine, _ = build_engine(self.tmp, runners={'cold': cold_runner})
        engine.entry_validator = scope_cold
        engine.run(1)
        self.assertEqual(len(cold_runner.calls), 1)
        self.assertEqual(engine.state.data['cycles'][-1]['gate']['decision'], 'accept')


class ModeAndWindowTests(unittest.TestCase):
    def setUp(self):
        self._tmp = tempfile.TemporaryDirectory()
        self.tmp = self._tmp.name

    def tearDown(self):
        self._tmp.cleanup()

    def test_observe_mode_every_cycle_estimates_never_applies(self):
        engine, applier = build_engine(self.tmp, mode='observe')
        code = engine.run(2)
        self.assertEqual(code, 7)
        self.assertEqual(len(engine.state.data['would_accept']), 2)
        self.assertEqual(applier.calls, [])
        self.assertEqual(engine.state.data['cycles'][-1]['gate']['decision'],
                         'would_accept')
        self.assertEqual(engine.state.data['cycles'][-1]['observe'], True)
        # no experiment ran: budget only has proposer tokens
        self.assertEqual(engine.state.data['budget']['spent'], 3000)

    def test_observe_window_exhaustion_pauses_in_live_mode(self):
        # documented semantic correction vs MC: the window is an authorization
        # budget in BOTH modes; exhaustion pauses for a human decision.
        engine, applier = build_engine(self.tmp, mode='live', observe_window=2)
        code = engine.run(4)
        self.assertEqual(code, 6)                          # EXIT_OBSERVE_DONE
        self.assertEqual(engine.state.data['status'], 'observe_window_done')
        self.assertEqual(len(engine.state.data['would_accept']), 2)
        self.assertEqual(applier.calls, [])
        self.assertEqual(engine.state.data['counters']['cycles_completed'], 2)

    def test_live_window_pauses_then_reauthorization_applies(self):
        # documented semantic correction vs MC: the observe window is an
        # authorization budget in BOTH modes; exhaustion pauses for a human
        # decision. A subsequent invocation without a window runs live.
        engine, applier = build_engine(self.tmp, mode='live', observe_window=1)
        code = engine.run(3)
        self.assertEqual(code, 6)                          # EXIT_OBSERVE_DONE
        self.assertEqual(len(engine.state.data['would_accept']), 1)
        self.assertEqual(applier.calls, [])
        self.assertEqual(engine.state.data['counters']['cycles_completed'], 1)
        # human re-authorizes: new invocation, no observe window
        engine2, applier2 = build_engine(self.tmp, mode='live', observe_window=0)
        code = engine2.run(2)
        self.assertEqual(code, 7)
        self.assertEqual(len(applier2.calls), 2)
        self.assertEqual(engine2.state.data['cycles'][-1]['accepted'], True)

    def test_live_transition_recorded_in_state(self):
        state = LoopState(Path(self.tmp) / 's.json', mode='observe')
        state.data['mode'] = 'live'
        state.data['live_transition'] = {'authorized_by': 'operator --live flag',
                                         'at': utcnow()}
        state.save()
        loaded = LoopState.load(Path(self.tmp) / 's.json')
        self.assertEqual(loaded.data['mode'], 'live')
        self.assertEqual(loaded.data['live_transition']['authorized_by'],
                         'operator --live flag')


class RailTests(unittest.TestCase):
    def setUp(self):
        self._tmp = tempfile.TemporaryDirectory()
        self.tmp = self._tmp.name

    def tearDown(self):
        self._tmp.cleanup()

    def test_proposer_unavailable_pauses_no_llm(self):
        engine, _ = build_engine(self.tmp, proposer=StubProposer(fail=True))
        code = engine.run(1)
        self.assertEqual(code, 3)                          # EXIT_PAUSED_NO_LLM
        self.assertEqual(engine.state.data['status'], 'paused_no_llm')
        reports = list((Path(self.tmp) / 'reports').glob('paused-paused_no_llm-*.md'))
        self.assertEqual(len(reports), 1)

    def test_budget_exhausted_pauses_before_next_cycle(self):
        engine, _ = build_engine(self.tmp, budget_cap=1000)
        code = engine.run(2)
        self.assertEqual(code, 5)                          # EXIT_BUDGET
        self.assertEqual(engine.state.data['status'], 'budget_exhausted')
        self.assertEqual(engine.state.data['counters']['cycles_completed'], 1)

    def test_remaining_budget_forwarded_to_runner(self):
        engine, _ = build_engine(self.tmp, budget_cap=1_000_000)
        engine.run(1)
        # cap minus the proposer usage already accounted (1500)
        self.assertEqual(engine.runner.calls[0]['remaining_budget'], 998_500)

    def test_daily_cap_pauses(self):
        engine, _ = build_engine(self.tmp, max_cycles_per_day=1)
        code = engine.run(2)
        self.assertEqual(code, 0)                          # EXIT_OK (informational pause)
        self.assertEqual(engine.state.data['status'], 'daily_cap')
        self.assertEqual(engine.state.data['counters']['cycles_completed'], 1)

    def test_two_strikes_infra_breaker(self):
        engine, _ = build_engine(self.tmp,
                                 runner=StubRunner(fail_reason='runner_timeout'))
        code = engine.run(3)
        self.assertEqual(code, 4)                          # EXIT_PAUSED_INFRA
        self.assertEqual(engine.state.data['status'], 'paused_infra')
        self.assertEqual(engine.state.data['counters']['infra_strikes_consecutive'], 2)
        self.assertEqual(engine.state.data['counters']['cycles_completed'], 2)

    def test_model_success_resets_infra_strikes(self):
        # cycle 1 infra-fails, cycle 2 is a model rejection (not infra) -> reset
        runner = StubRunner(fail_reason='runner_timeout')
        engine, _ = build_engine(self.tmp, runner=runner)
        engine.run(1)
        engine.runners['hot'] = StubRunner(control_requests=100, treatment_requests=100)
        engine.run(1)
        self.assertEqual(engine.state.data['counters']['infra_strikes_consecutive'], 0)

    def test_runner_exception_is_infra_strike(self):
        engine, _ = build_engine(self.tmp,
                                 runner=StubRunner(raise_error=RuntimeError('boom')))
        code = engine.run(2)
        self.assertEqual(code, 4)
        self.assertEqual(engine.state.data['cycles'][-1]['gate']['reason'],
                         'infra_exception')

    def test_no_proposals_rejects_cycle(self):
        engine, _ = build_engine(self.tmp, proposer=StubProposer(hypotheses=[]))
        engine.run(1)
        record = engine.state.data['cycles'][-1]
        self.assertEqual(record['gate']['reason'], 'no_proposals')
        self.assertEqual(record['hypothesis'], None)

    def test_all_filtered_rejects_cycle(self):
        engine, _ = build_engine(self.tmp, proposer=StubProposer(
            hypotheses=[{'id': 'H1', 'change': {'file': 'x'}, 'action': 'weird'}]))
        engine.run(1)
        record = engine.state.data['cycles'][-1]
        self.assertEqual(record['gate']['reason'], 'all_proposals_filtered')
        self.assertEqual(engine.state.data['counters']['filtered_out'], 1)


class ResumeTests(unittest.TestCase):
    """crash = resume, never replay (terminal results.json only)."""

    def setUp(self):
        self._tmp = tempfile.TemporaryDirectory()
        self.tmp = Path(self._tmp.name)

    def tearDown(self):
        self._tmp.cleanup()

    def _write_terminal_results(self, cycle_id='cR'):
        auto_dir = self.tmp / 'experiments' / ('auto-%s' % cycle_id)
        auto_dir.mkdir(parents=True, exist_ok=True)
        (auto_dir / 'results.json').write_text(json.dumps(
            {'verdict': {'result': 'treatment_favors'}, 'finished_at': utcnow(),
             'results': {'control': metrics('control'),
                         'treatment': metrics('treatment', requests=80,
                                              tokens=3_200_000)}}))
        return auto_dir

    def test_resume_from_experiment_phase_never_relaunches(self):
        auto_dir = self._write_terminal_results()
        engine, applier = build_engine(str(self.tmp))
        engine.state.data['mode'] = 'live'
        engine.state.data['cycle'] = {
            'id': 'cR', 'started_at': utcnow(), 'phase': 'experiment_done',
            'hypothesis_id': 'H1', 'auto_dir': str(auto_dir),
            'sense': {'ledger': {'baseline_requests': 100,
                                 'error_code_counts': {'program_error': 2}},
                      'next_before': 'node-1'},
            'accepted': [entry_fixture()], 'rejected': []}
        engine.state.save()
        record = engine.resume_inflight()
        self.assertEqual(engine.runner.calls, [])          # NEVER relaunched
        self.assertEqual(record['accepted'], True)
        self.assertEqual(record['gate']['decision'], 'accept')
        self.assertEqual(record['apply']['noop'], True)

    def test_resume_with_intermediate_results_fails_loudly_after_bounded_wait(self):
        auto_dir = self.tmp / 'experiments' / 'auto-cR'
        auto_dir.mkdir(parents=True, exist_ok=True)
        (auto_dir / 'results.json').write_text(json.dumps(   # intermediate write
            {'results': {'control': metrics('control')}}))
        engine, _ = build_engine(str(self.tmp))
        engine.locate_wait_minutes = 0.02                  # 1.2s bounded poll
        engine.state.data['mode'] = 'live'
        engine.state.data['cycle'] = {
            'id': 'cR', 'started_at': utcnow(), 'phase': 'experiment',
            'hypothesis_id': 'H1', 'auto_dir': str(auto_dir),
            'sense': {'ledger': {}, 'next_before': 'node-1'},
            'accepted': [entry_fixture()], 'rejected': []}
        engine.state.save()
        record = engine.resume_inflight()
        self.assertEqual(engine.runner.calls, [])          # never relaunched
        self.assertEqual(record['gate']['reason'],
                         'experiment_failed:experiment_still_running_no_verdict')
        self.assertEqual(engine.state.data['status'], 'running')  # not paused: infra strike path

    def test_resume_with_missing_results_counts_infra_once(self):
        engine, _ = build_engine(str(self.tmp))
        engine.state.data['mode'] = 'live'
        engine.state.data['cycle'] = {
            'id': 'cR', 'started_at': utcnow(), 'phase': 'experiment_done',
            'hypothesis_id': 'H1', 'auto_dir': str(self.tmp / 'nowhere'),
            'sense': {}, 'accepted': [entry_fixture()], 'rejected': []}
        engine.state.save()
        record = engine.resume_inflight()
        self.assertEqual(record['gate']['reason'],
                         'experiment_failed:results_unlocatable_after_crash')

    def test_resume_from_propose_phase_recomputes_filter(self):
        engine, _ = build_engine(str(self.tmp))
        engine.state.data['mode'] = 'live'
        engine.state.data['cycle'] = {
            'id': 'cR', 'started_at': utcnow(), 'phase': 'propose',
            'sense': {'ledger': {'baseline_requests': 100}, 'next_before': 'node-1'},
            'raw_proposals': [raw_hyp()]}
        engine.state.save()
        record = engine.resume_inflight()
        self.assertEqual(engine.runner.calls[-1]['cycle'], 'cR')  # fresh start
        self.assertEqual(record['accepted'], True)
        self.assertEqual(engine.state.data['counters']['cycles_completed'], 1)

    def test_resume_from_gate_phase_closes_with_recorded_gate(self):
        engine, _ = build_engine(str(self.tmp))
        engine.state.data['mode'] = 'live'
        engine.state.data['cycle'] = {
            'id': 'cR', 'started_at': utcnow(), 'phase': 'gate',
            'gate': {'decision': 'reject', 'reason': 'primary_metric_not_met',
                     'evidence': {}},
            'treatment': metrics('treatment'),
            'accepted': [entry_fixture()]}
        engine.state.save()
        record = engine.resume_inflight()
        self.assertEqual(record['gate']['reason'], 'primary_metric_not_met')
        self.assertEqual(engine.runner.calls, [])

    def test_resume_from_curriculum_phase_finishes_record(self):
        engine, _ = build_engine(str(self.tmp))
        engine.state.data['cycle'] = {
            'id': 'cR', 'started_at': utcnow(), 'phase': 'curriculum',
            'gate': {'decision': 'accept', 'reason': 'primary_metric_met_no_regressions',
                     'evidence': {}},
            'treatment': metrics('treatment'), 'curriculum': {'transition': 'none'},
            'accepted': [entry_fixture()]}
        engine.state.save()
        record = engine.resume_inflight()
        self.assertEqual(record['id'], 'cR')
        self.assertEqual(engine.state.data['counters']['cycles_completed'], 1)

    def test_resume_unknown_phase_dropped_never_replayed(self):
        engine, _ = build_engine(str(self.tmp))
        engine.state.data['cycle'] = {'id': 'cR', 'started_at': utcnow(),
                                      'phase': 'mystery'}
        engine.state.save()
        self.assertIsNone(engine.resume_inflight())
        self.assertIsNone(engine.state.data['cycle'])

    def test_run_resumes_then_completes_next_cycle(self):
        auto_dir = self._write_terminal_results('c001')
        engine, _ = build_engine(str(self.tmp))
        engine.state.data['mode'] = 'live'
        engine.state.data['counters']['cycles_started'] = 1
        engine.state.data['cycle'] = {
            'id': 'c001', 'started_at': utcnow(), 'phase': 'experiment_done',
            'hypothesis_id': 'H1', 'auto_dir': str(auto_dir),
            'sense': {'ledger': {'baseline_requests': 100}, 'next_before': 'node-1'},
            'accepted': [entry_fixture()], 'rejected': []}
        engine.state.save()
        code = engine.run(2)
        self.assertEqual(code, 7)
        # the RESUME never relaunched c001; only the new cycle c002 ran
        self.assertEqual(len(engine.runner.calls), 1)
        self.assertTrue(engine.runner.calls[0]['cycle'].startswith('c002'))
        self.assertEqual(len(engine.state.data['cycles']), 2)
        self.assertEqual(engine.state.data['cycles'][0]['id'], 'c001')
        self.assertEqual(engine.state.data['cycles'][0]['accepted'], True)


if __name__ == '__main__':
    unittest.main()
