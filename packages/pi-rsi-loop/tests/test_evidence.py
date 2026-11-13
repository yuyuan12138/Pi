"""Theme C3 evidence auto-plumbing tests.

Covers: evidence record completeness (fabricated fixture arms), honest
degradation, boundedness (code/string/dict caps), engine integration (live /
observe / no-proposal / experiment-failed / infra paths), results-envelope
write-back (additive, terminal-only, mode-preserving), old-results
back-compat via the loader, resume-path evidence, and the --evidence
read-back (read_evidence + CLI, including old state files).
"""
import io
import json
import contextlib
import sys
import tempfile
import unittest
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[1] / 'src'))

from rsi_loop.engine import RsiLoopEngine                  # noqa: E402
from rsi_loop.evidence import (EVIDENCE_SCHEMA, EvidenceReadError,  # noqa: E402
                               arm_summary, bounded_error_codes,
                               build_cycle_evidence, proposer_provenance,
                               persist_evidence_envelope, read_evidence)
from rsi_loop.errors import ProposerUnavailable            # noqa: E402
from rsi_loop.filter import entry_from_raw                 # noqa: E402
from rsi_loop.ports import (AcceptGate, ExperimentRunner, LedgerSource,  # noqa: E402
                            Proposer, RecordingApplier, SaturationCurriculum)
from rsi_loop.proposer import HttpProposer                 # noqa: E402
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


def entry_fixture(cycle_id='cX'):
    e = entry_from_raw(raw_hyp(), cycle_id, 1)
    e.pop('_change_keys', None)
    return e


def terminal_doc(evidence=None):
    doc = {'verdict': {'result': 'treatment_favors'}, 'finished_at': utcnow(),
           'results': {'control': metrics('control'),
                       'treatment': metrics('treatment', requests=80, tokens=3_200_000)}}
    if evidence is not None:
        doc['evidence'] = evidence
    return doc


def write_results(auto_dir, doc):
    auto_dir = Path(auto_dir)
    auto_dir.mkdir(parents=True, exist_ok=True)
    (auto_dir / 'results.json').write_text(json.dumps(doc))
    return auto_dir


# ---------------------------------------------------------------- builder ---

class EvidenceBuilderTests(unittest.TestCase):
    def test_full_record_shape(self):
        gate = {'decision': 'accept', 'reason': 'primary_metric_met_no_regressions',
                'inputs': {'next_before': 'node-1', 'next_after': 'node-2',
                           'budget_ok': True},
                'evidence': {'requests_improved': True, 'requests_improvement': 0.2,
                             'error_code_delta': {'program_error': -2}}}
        evidence = build_cycle_evidence(
            'c001-20261113T000000Z', provenance={'model': 'glm-5.3', 'proposer': 'HttpProposer',
                                                 'prompt_hash': 'a' * 64},
            hypothesis={'id': 'C001H1', 'raw_id': 'H1', 'scope': 'hot',
                        'prediction': {'error_code': 'program_error',
                                       'error_count_target': 0, 'max_requests': 80}},
            control=metrics('control'),
            treatment=metrics('treatment', requests=80, tokens=3_200_000,
                              errors={'program_error': 0}),
            verdict={'result': 'treatment_favors'}, auto_dir='/tmp/auto-c001',
            runner_ok=True, runner_reason=None, gate=gate,
            apply={'applied': True, 'commit': 'abc1234', 'revert_procedure': 'git revert abc1234'},
            revert={'commit': 'abc1234', 'file': 'skills.json', 'cycle': 'c001-20261113T000000Z'},
            mode='live', node='node-1', budget_spent=7_201_500, budget_cap=10_000_000)
        self.assertEqual(evidence['schema'], EVIDENCE_SCHEMA)
        self.assertEqual(evidence['cycle_id'], 'c001-20261113T000000Z')
        self.assertEqual(evidence['mode'], 'live')
        self.assertEqual(evidence['node'], 'node-1')
        self.assertEqual(evidence['observe'], False)
        self.assertEqual(evidence['budget'], {'spent': 7_201_500, 'cap': 10_000_000})
        self.assertEqual(evidence['provenance']['model'], 'glm-5.3')
        self.assertEqual(evidence['provenance']['prompt_hash'], 'a' * 64)
        self.assertEqual(evidence['hypothesis']['id'], 'C001H1')
        exp = evidence['experiment']
        self.assertEqual(exp['ok'], True)
        self.assertEqual(exp['auto_dir'], '/tmp/auto-c001')
        self.assertEqual(exp['verdict'], {'result': 'treatment_favors'})
        self.assertEqual(exp['arms']['treatment']['model_requests'], 80)
        self.assertEqual(exp['arms']['treatment']['total_tokens'], 3_200_000)
        self.assertEqual(exp['arms']['control']['error_code_counts'], {'program_error': 2})
        self.assertEqual(exp['error_code_delta'], {'program_error': -2})
        self.assertEqual(exp['tokens'], {'control': 4_000_000, 'treatment': 3_200_000,
                                         'total': 7_200_000})
        self.assertEqual(evidence['gate']['decision'], 'accept')
        self.assertEqual(evidence['gate']['inputs']['next_before'], 'node-1')
        self.assertEqual(evidence['gate']['inputs']['budget_ok'], True)
        self.assertEqual(evidence['gate']['evidence']['requests_improvement'], 0.2)
        self.assertEqual(evidence['apply']['applied'], True)
        self.assertEqual(evidence['apply']['commit'], 'abc1234')
        self.assertEqual(evidence['apply']['revert_commit'], 'abc1234')
        # record must be JSON-able end to end (tooling reads it as JSON)
        json.dumps(evidence)

    def test_honest_degradation_empty_inputs(self):
        evidence = build_cycle_evidence('c001')
        self.assertEqual(evidence['experiment'], None)
        self.assertEqual(evidence['gate'], None)
        self.assertEqual(evidence['apply'], None)
        self.assertEqual(evidence['provenance'], None)
        self.assertEqual(evidence['hypothesis'], None)
        self.assertIn('schema', evidence)
        json.dumps(evidence)

    def test_observe_has_no_experiment_section(self):
        evidence = build_cycle_evidence('c001', gate={'decision': 'would_accept',
                                                      'reason': 'observe_mode_estimate',
                                                      'evidence': {}},
                                        observe=True, mode='observe')
        self.assertEqual(evidence['experiment'], None)
        self.assertEqual(evidence['observe'], True)
        self.assertEqual(evidence['gate']['decision'], 'would_accept')

    def test_error_codes_capped_with_omitted_count(self):
        counts = {'c%02d' % i: i for i in range(25)}
        capped, omitted = bounded_error_codes(counts)
        self.assertEqual(len(capped), 20)
        self.assertEqual(omitted, 5)
        self.assertEqual(capped['c24'], 24)          # highest counts kept
        self.assertNotIn('c00', capped)
        # small dicts pass through untouched
        self.assertEqual(bounded_error_codes({'a': 1}), ({'a': 1}, 0))

    def test_delta_capped_like_arm_counts(self):
        control = {'error_code_counts': {'c%02d' % i: i for i in range(25)}}
        treatment = {'error_code_counts': {'c%02d' % i: i + 1 for i in range(25)}}
        evidence = build_cycle_evidence('c001', control=control, treatment=treatment,
                                        runner_ok=True)
        delta = evidence['experiment']['error_code_delta']
        self.assertEqual(len([k for k in delta if k != 'error_code_delta_omitted']), 20)
        self.assertEqual(delta['error_code_delta_omitted'], 5)
        self.assertEqual(delta['c00'], 1)                # true delta, not fabricated

    def test_long_strings_truncated(self):
        evidence = build_cycle_evidence('c001', runner_ok=True,
                                        verdict={'note': 'x' * 1000},
                                        gate={'decision': 'reject', 'reason': 'y' * 900,
                                              'evidence': {'z': 'w' * 1000}})
        self.assertEqual(len(evidence['experiment']['verdict']['note']), 400 + len('...[+600 chars]'))
        self.assertTrue(evidence['experiment']['verdict']['note'].endswith('...[+600 chars]'))
        self.assertEqual(len(evidence['gate']['reason']), 900)   # reason kept verbatim
        self.assertTrue(evidence['gate']['evidence']['z'].startswith('w' * 10))

    def test_arm_summary_scorer_output_passthrough(self):
        arm = metrics('treatment', requests=80)
        arm['scorer_output'] = {'score': 0.9, 'notes': 'fine'}
        arm['verdict_result'] = 'treatment_favors'
        summary = arm_summary(arm, 'treatment')
        self.assertEqual(summary['scorer_output'], {'score': 0.9, 'notes': 'fine'})
        self.assertEqual(summary['verdict_result'], 'treatment_favors')
        self.assertEqual(arm_summary(None, 'control'), None)
        self.assertEqual(arm_summary({'token_totals': 'junk'}, 'control')['total_tokens'], 0)

    def test_malformed_counts_degrade_not_crash(self):
        control = {'error_code_counts': {'program_error': 'not-a-number'}}
        treatment = {'error_code_counts': {'program_error': 3}}
        evidence = build_cycle_evidence('c001', control=control, treatment=treatment,
                                        runner_ok=True)
        self.assertEqual(evidence['experiment']['error_code_delta'], None)
        self.assertEqual(evidence['experiment']['arms']['control']['error_code_counts'],
                         {'program_error': 'not-a-number'})

    def test_revert_commit_only_for_matching_cycle(self):
        apply = {'applied': True, 'commit': 'abc'}
        revert = {'commit': 'abc', 'cycle': 'cOTHER'}
        evidence = build_cycle_evidence('c001', apply=apply, revert=revert)
        self.assertNotIn('revert_commit', evidence['apply'])
        evidence = build_cycle_evidence('cOTHER', apply=apply, revert=revert)
        self.assertEqual(evidence['apply']['revert_commit'], 'abc')

    def test_provenance_fallback_for_plain_proposer(self):
        class BareProposer:
            pass
        provenance = proposer_provenance(BareProposer())
        self.assertEqual(provenance, {'model': None, 'proposer': 'BareProposer',
                                      'prompt_hash': None})


# ---------------------------------------------------------------- envelope ---

class EnvelopeTests(unittest.TestCase):
    def setUp(self):
        self._tmp = tempfile.TemporaryDirectory()
        self.tmp = Path(self._tmp.name)

    def tearDown(self):
        self._tmp.cleanup()

    def test_persist_adds_evidence_to_terminal_envelope(self):
        auto_dir = write_results(self.tmp / 'auto-c001', terminal_doc())
        evidence = build_cycle_evidence('c001', runner_ok=True)
        path, error = persist_evidence_envelope(auto_dir, evidence)
        self.assertIsNone(error)
        doc = json.loads((auto_dir / 'results.json').read_text())
        self.assertEqual(doc['evidence'], evidence)          # additive key present
        self.assertEqual(doc['verdict'], {'result': 'treatment_favors'})  # untouched
        self.assertIn('control', doc['results'])             # untouched
        loaded = load_terminal_results(auto_dir)             # still terminal, still loads
        self.assertEqual(loaded['ok'], True)
        self.assertEqual(loaded['evidence'], evidence)

    def test_persist_never_touches_non_terminal_envelope(self):
        auto_dir = self.tmp / 'auto-c001'
        auto_dir.mkdir(parents=True)
        intermediate = {'results': {'control': metrics('control')}}   # no verdict
        (auto_dir / 'results.json').write_text(json.dumps(intermediate))
        path, error = persist_evidence_envelope(auto_dir, {'schema': EVIDENCE_SCHEMA})
        self.assertIsNone(path)
        self.assertEqual(error, 'results_not_terminal')
        self.assertEqual(json.loads((auto_dir / 'results.json').read_text()), intermediate)

    def test_persist_skips_missing_and_corrupt(self):
        path, error = persist_evidence_envelope(self.tmp / 'nowhere', {})
        self.assertIsNone(path)
        self.assertTrue(error.startswith('results_json_unreadable'))
        corrupt = self.tmp / 'auto-bad'
        corrupt.mkdir()
        (corrupt / 'results.json').write_text('{not json')
        path, error = persist_evidence_envelope(corrupt, {})
        self.assertIsNone(path)
        self.assertEqual(error, 'results_json_corrupt')

    def test_persist_preserves_file_mode(self):
        auto_dir = write_results(self.tmp / 'auto-c001', terminal_doc())
        (auto_dir / 'results.json').chmod(0o640)
        persist_evidence_envelope(auto_dir, {'schema': EVIDENCE_SCHEMA})
        import stat
        self.assertEqual(stat.S_IMODE((auto_dir / 'results.json').stat().st_mode), 0o640)


# ------------------------------------------------------------ engine paths ---

class StubLedger(LedgerSource):
    def sense(self, cycle_id):
        return {'ledger': {'newest_run': 'run-1',
                           'error_code_counts': {'program_error': 2},
                           'baseline_requests': 100},
                'frontier': {'stub': True}, 'next_before': 'node-1'}


class EvidenceProposer(Proposer):
    def __init__(self, hypotheses=None, total_tokens=1500):
        self.hypotheses = hypotheses if hypotheses is not None else [raw_hyp()]
        self.last_usage = {'prompt_tokens': 1200, 'completion_tokens': 300,
                           'total_tokens': total_tokens}
        self.model = 'stub-glm-5.3'
        self.last_prompt_hash = 'b' * 64

    def propose(self, ledger, frontier, node, *, rejections=None, raw_sink=None,
                extra_context=None):
        doc = {'hypotheses': json.loads(json.dumps(self.hypotheses))}
        raw = json.dumps(doc)
        if raw_sink is not None:
            raw_sink(0, raw)
        return raw, doc


class EvidenceRunner(ExperimentRunner):
    def __init__(self, workspace=None, fail_reason=None, raise_error=None,
                 control_requests=100, treatment_requests=80):
        self.workspace = workspace
        self.fail_reason = fail_reason
        self.raise_error = raise_error
        self.control_requests = control_requests
        self.treatment_requests = treatment_requests
        self.calls = []

    def __call__(self, entry, proposals_path, remaining_budget, cycle_id):
        self.calls.append({'cycle': cycle_id})
        if self.raise_error is not None:
            raise self.raise_error
        if self.fail_reason is not None:
            return {'ok': False, 'reason': self.fail_reason, 'auto_dir': None}
        doc = {'control': metrics('control', requests=self.control_requests),
               'treatment': metrics('treatment', requests=self.treatment_requests,
                                    tokens=3_200_000, errors={'program_error': 0}),
               'verdict': {'result': 'treatment_favors'}}
        auto_dir = None
        if self.workspace:
            auto_dir = write_results(Path(self.workspace) / 'experiments'
                                     / ('auto-%s' % cycle_id),
                                     {'verdict': {'result': 'treatment_favors'},
                                      'finished_at': utcnow(), 'results': doc})
        return {'ok': True, 'auto_dir': str(auto_dir) if auto_dir else None,
                'results': doc}


def build_engine(tmp, *, mode='live', observe_window=0, proposer=None, runner=None):
    proposer = proposer or EvidenceProposer()
    runner = runner or EvidenceRunner()
    state = LoopState(Path(tmp) / 'state.json', mode=mode, budget_cap=10_000_000,
                      max_cycles_per_day=6, initial_node='node-1')
    engine = RsiLoopEngine(state, StubLedger(), proposer, runner,
                           gate=AcceptGate(threshold=0.15),
                           applier=RecordingApplier(would_write='toy/skills.json'),
                           curriculum=SaturationCurriculum(), dry=True,
                           observe_window=observe_window,
                           reports_dir=Path(tmp) / 'reports',
                           proposals_dir=Path(tmp) / 'proposals',
                           entry_validator=lambda entry: [])
    return engine


class EngineEvidenceTests(unittest.TestCase):
    def setUp(self):
        self._tmp = tempfile.TemporaryDirectory()
        self.tmp = Path(self._tmp.name)

    def tearDown(self):
        self._tmp.cleanup()

    def test_live_cycle_state_evidence_complete(self):
        runner = EvidenceRunner(workspace=self.tmp)
        engine = build_engine(self.tmp, runner=runner)
        engine.run(1)
        record = engine.state.data['cycles'][-1]
        evidence = record['evidence']
        self.assertEqual(evidence['schema'], EVIDENCE_SCHEMA)
        self.assertEqual(evidence['mode'], 'live')
        self.assertEqual(evidence['provenance']['model'], 'stub-glm-5.3')
        self.assertEqual(evidence['provenance']['prompt_hash'], 'b' * 64)
        self.assertEqual(evidence['provenance']['proposer'], 'EvidenceProposer')
        self.assertEqual(evidence['hypothesis']['id'], record['hypothesis'])
        self.assertEqual(evidence['hypothesis']['prediction']['max_requests'], 80)
        exp = evidence['experiment']
        self.assertEqual(exp['ok'], True)
        self.assertEqual(exp['auto_dir'], runner.calls and str(
            Path(self.tmp) / 'experiments' / ('auto-%s' % record['id'])))
        self.assertEqual(exp['arms']['treatment']['model_requests'], 80)
        self.assertEqual(exp['error_code_delta'], {'program_error': -2})
        self.assertEqual(exp['verdict'], {'result': 'treatment_favors'})
        self.assertEqual(evidence['gate']['decision'], 'accept')
        self.assertEqual(evidence['gate']['inputs'],
                         {'next_before': 'node-1', 'next_after': None,
                          'budget_ok': True})
        self.assertEqual(evidence['gate']['evidence']['requests_improvement'], 0.2)
        self.assertEqual(evidence['apply']['applied'], False)      # RecordingApplier
        self.assertEqual(evidence['apply']['noop'], True)
        self.assertEqual(evidence['budget']['spent'], 7_201_500)

    def test_envelope_writeback_after_live_cycle(self):
        runner = EvidenceRunner(workspace=self.tmp)
        engine = build_engine(self.tmp, runner=runner)
        engine.run(1)
        record = engine.state.data['cycles'][-1]
        auto_dir = Path(self.tmp) / 'experiments' / ('auto-%s' % record['id'])
        doc = json.loads((auto_dir / 'results.json').read_text())
        self.assertEqual(doc['evidence'], record['evidence'])      # same record
        self.assertEqual(doc['verdict'], {'result': 'treatment_favors'})
        # the envelope still loads with the evidence surfaced
        loaded = load_terminal_results(auto_dir)
        self.assertEqual(loaded['evidence']['schema'], EVIDENCE_SCHEMA)

    def test_observe_cycle_evidence(self):
        engine = build_engine(self.tmp, mode='observe', observe_window=1)
        engine.run(1)
        evidence = engine.state.data['cycles'][-1]['evidence']
        self.assertEqual(evidence['observe'], True)
        self.assertEqual(evidence['mode'], 'observe')
        self.assertEqual(evidence['experiment'], None)             # never ran
        self.assertEqual(evidence['apply'], None)                  # never applied
        self.assertEqual(evidence['gate']['decision'], 'would_accept')
        self.assertEqual(evidence['provenance']['model'], 'stub-glm-5.3')

    def test_no_proposals_evidence(self):
        engine = build_engine(self.tmp, proposer=EvidenceProposer(hypotheses=[]))
        engine.run(1)
        evidence = engine.state.data['cycles'][-1]['evidence']
        self.assertEqual(evidence['gate']['reason'], 'no_proposals')
        self.assertEqual(evidence['hypothesis'], None)
        self.assertEqual(evidence['experiment'], None)
        self.assertEqual(evidence['provenance']['proposer'], 'EvidenceProposer')

    def test_experiment_failed_evidence(self):
        engine = build_engine(self.tmp, runner=EvidenceRunner(fail_reason='runner_timeout'))
        engine.run(1)
        evidence = engine.state.data['cycles'][-1]['evidence']
        self.assertEqual(evidence['experiment']['ok'], False)
        self.assertEqual(evidence['experiment']['reason'], 'runner_timeout')
        self.assertEqual(evidence['gate']['decision'], 'reject')
        self.assertEqual(evidence['gate']['reason'],
                         'experiment_failed:runner_timeout')
        self.assertEqual(evidence['apply'], None)

    def test_infra_exception_cycle_has_evidence(self):
        engine = build_engine(self.tmp, runner=EvidenceRunner(raise_error=RuntimeError('boom')))
        engine.run(2)
        record = engine.state.data['cycles'][-1]
        self.assertEqual(record['gate']['reason'], 'infra_exception')
        self.assertEqual(record['evidence']['gate']['reason'], 'infra_exception')
        self.assertEqual(record['evidence']['gate']['evidence']['error'], 'boom')
        self.assertEqual(record['evidence']['cycle_id'], record['id'])


class ResumeEvidenceTests(unittest.TestCase):
    def setUp(self):
        self._tmp = tempfile.TemporaryDirectory()
        self.tmp = Path(self._tmp.name)

    def tearDown(self):
        self._tmp.cleanup()

    def test_resume_from_gate_phase_builds_evidence_from_checkpoint(self):
        engine = build_engine(self.tmp)
        engine.state.data['mode'] = 'live'
        # fixture WITHOUT provenance/verdict (pre-C3 checkpoint shape):
        # evidence degrades honestly, never fabricates
        engine.state.data['cycle'] = {
            'id': 'cR', 'started_at': utcnow(), 'phase': 'gate',
            'gate': {'decision': 'reject', 'reason': 'primary_metric_not_met',
                     'evidence': {}},
            'treatment': metrics('treatment'),
            'accepted': [entry_fixture()]}
        engine.state.save()
        record = engine.resume_inflight()
        evidence = record['evidence']
        self.assertEqual(evidence['gate']['decision'], 'reject')
        self.assertEqual(evidence['gate']['reason'], 'primary_metric_not_met')
        self.assertEqual(evidence['experiment']['arms']['treatment']['model_requests'], 100)
        self.assertEqual(evidence['provenance'], None)
        self.assertEqual(evidence['apply'], None)

    def test_resume_from_curriculum_phase_has_evidence(self):
        engine = build_engine(self.tmp)
        engine.state.data['mode'] = 'live'
        engine.state.data['cycle'] = {
            'id': 'cR', 'started_at': utcnow(), 'phase': 'curriculum',
            'gate': {'decision': 'accept', 'reason': 'primary_metric_met_no_regressions',
                     'evidence': {}},
            'treatment': metrics('treatment'), 'curriculum': {'transition': 'none'},
            'accepted': [entry_fixture()]}
        engine.state.save()
        record = engine.resume_inflight()
        self.assertEqual(record['evidence']['gate']['decision'], 'accept')
        self.assertEqual(record['evidence']['cycle_id'], 'cR')

    def test_resume_with_non_terminal_results_never_writes_envelope(self):
        auto_dir = self.tmp / 'experiments' / 'auto-cR'
        auto_dir.mkdir(parents=True)
        intermediate = {'results': {'control': metrics('control')}}
        (auto_dir / 'results.json').write_text(json.dumps(intermediate))
        engine = build_engine(self.tmp)
        engine.locate_wait_minutes = 0.02
        engine.state.data['mode'] = 'live'
        engine.state.data['cycle'] = {
            'id': 'cR', 'started_at': utcnow(), 'phase': 'experiment_done',
            'hypothesis_id': 'H1', 'auto_dir': str(auto_dir), 'sense': {},
            'accepted': [entry_fixture()], 'rejected': []}
        engine.state.save()
        record = engine.resume_inflight()
        # the non-terminal envelope was NEVER touched, and no evidence key added
        self.assertEqual(json.loads((auto_dir / 'results.json').read_text()), intermediate)
        self.assertEqual(record['gate']['reason'],
                         'experiment_failed:experiment_still_running_no_verdict')


# ---------------------------------------------------------------- read-back ---

class ReadBackTests(unittest.TestCase):
    def setUp(self):
        self._tmp = tempfile.TemporaryDirectory()
        self.tmp = Path(self._tmp.name)

    def tearDown(self):
        self._tmp.cleanup()

    def _run_two_cycles(self):
        engine = build_engine(self.tmp, runner=EvidenceRunner(workspace=self.tmp))
        engine.run(2)
        return engine

    def test_read_evidence_from_state(self):
        self._run_two_cycles()
        payload = read_evidence(self.tmp / 'state.json')
        self.assertEqual(payload['source'], 'state')
        self.assertEqual(len(payload['cycles']), 2)
        first = payload['cycles'][0]
        self.assertEqual(first['gate_decision'], 'accept')
        self.assertEqual(first['evidence']['schema'], EVIDENCE_SCHEMA)
        self.assertEqual(first['evidence']['cycle_id'], first['cycle_id'])

    def test_read_evidence_cycle_filter(self):
        self._run_two_cycles()
        state = json.loads((self.tmp / 'state.json').read_text())
        target = state['cycles'][1]['id']
        payload = read_evidence(self.tmp / 'state.json', cycle_id=target)
        self.assertEqual([c['cycle_id'] for c in payload['cycles']], [target])

    def test_read_evidence_old_state_without_evidence(self):
        # a pre-C3 state file: cycle records carry no 'evidence' key
        (self.tmp / 'old_state.json').write_text(json.dumps(
            {'version': 1, 'cycles': [{'id': 'c001', 'accepted': True,
                                       'observe': False,
                                       'gate': {'decision': 'accept'}}]}))
        payload = read_evidence(self.tmp / 'old_state.json')
        self.assertEqual(payload['cycles'][0]['evidence'], None)   # honest None
        self.assertEqual(payload['cycles'][0]['gate_decision'], 'accept')

    def test_read_evidence_from_envelope(self):
        engine = build_engine(self.tmp, runner=EvidenceRunner(workspace=self.tmp))
        engine.run(1)
        record = engine.state.data['cycles'][-1]
        auto_dir = Path(self.tmp) / 'experiments' / ('auto-%s' % record['id'])
        payload = read_evidence(auto_dir)
        self.assertEqual(payload['source'], 'results_envelope')
        self.assertEqual(payload['evidence'], record['evidence'])
        # same via the results.json file itself
        payload = read_evidence(auto_dir / 'results.json')
        self.assertEqual(payload['evidence'], record['evidence'])

    def test_read_evidence_errors(self):
        with self.assertRaises(FileNotFoundError):
            read_evidence(self.tmp / 'missing.json')
        auto_dir = self.tmp / 'auto-x'
        auto_dir.mkdir()
        (auto_dir / 'results.json').write_text(json.dumps(
            {'results': {'control': {}}}))                         # intermediate
        with self.assertRaises(EvidenceReadError) as caught:
            read_evidence(auto_dir)
        self.assertIn('unterminal', caught.exception.diagnostics['error'])
        (self.tmp / 'not_state.json').write_text(json.dumps({'other': 1}))
        with self.assertRaises(EvidenceReadError):
            read_evidence(self.tmp / 'not_state.json')


class CliTests(unittest.TestCase):
    def setUp(self):
        self._tmp = tempfile.TemporaryDirectory()
        self.tmp = Path(self._tmp.name)

    def tearDown(self):
        self._tmp.cleanup()

    def test_cli_state_ok(self):
        from rsi_loop import cli
        engine = build_engine(self.tmp, runner=EvidenceRunner(workspace=self.tmp))
        engine.run(1)
        buffer = io.StringIO()
        with contextlib.redirect_stdout(buffer):
            code = cli.main(['--evidence', str(self.tmp / 'state.json')])
        self.assertEqual(code, 0)
        payload = json.loads(buffer.getvalue())
        self.assertEqual(payload['cycles'][0]['evidence']['gate']['decision'], 'accept')

    def test_cli_missing_path_exit_2(self):
        from rsi_loop import cli
        code = cli.main(['--evidence', str(self.tmp / 'nope.json')])
        self.assertEqual(code, 2)

    def test_cli_non_terminal_exit_3(self):
        from rsi_loop import cli
        auto_dir = self.tmp / 'auto-x'
        auto_dir.mkdir()
        (auto_dir / 'results.json').write_text(json.dumps({'results': {}}))
        code = cli.main(['--evidence', str(auto_dir)])
        self.assertEqual(code, 3)

    def test_cli_requires_evidence_flag(self):
        from rsi_loop import cli
        with self.assertRaises(SystemExit) as caught:
            cli.main([])
        self.assertEqual(caught.exception.code, 2)


# ---------------------------------------------------------- prompt hash ------

class PromptHashTests(unittest.TestCase):
    @staticmethod
    def _make_proposer(responses):
        calls = []

        def transport(body, timeout):
            calls.append(json.loads(body))
            payload = responses[min(len(calls) - 1, len(responses) - 1)]
            return 200, json.dumps({
                'choices': [{'message': {'content': payload}}],
                'usage': {'prompt_tokens': 10, 'completion_tokens': 5,
                          'total_tokens': 15}}).encode()

        proposer = HttpProposer(
            messages_builder=lambda *a, **k: [{'role': 'user', 'content': 'prompt'}],
            base_url='http://127.0.0.1:9', api_key='k', transport=transport,
            retries=0)
        return proposer, calls

    def test_http_proposer_records_prompt_hash(self):
        doc = json.dumps({'hypotheses': [raw_hyp()]})
        proposer, calls = self._make_proposer([doc])
        _raw, parsed = proposer.propose({}, None, 'node-1')
        self.assertEqual(list(parsed['hypotheses'][0].keys()), list(raw_hyp().keys()))
        self.assertEqual(proposer.last_prompt_hash,
                         HttpProposer.prompt_hash(calls[0]['messages']))
        self.assertRegex(proposer.last_prompt_hash, r'^[0-9a-f]{64}$')

    def test_prompt_hash_tracks_repair_round(self):
        doc = json.dumps({'hypotheses': [raw_hyp()]})
        proposer, calls = self._make_proposer(['not json {', doc])
        proposer.propose({}, None, 'node-1')
        self.assertEqual(len(calls), 2)                    # one repair round
        self.assertEqual(proposer.last_prompt_hash,
                         HttpProposer.prompt_hash(calls[1]['messages']))
        self.assertNotEqual(HttpProposer.prompt_hash(calls[0]['messages']),
                            proposer.last_prompt_hash)


# ---------------------------------------------------- toy consumer (C2 tie) --

class ToyConsumerEvidenceTests(unittest.TestCase):
    def test_toy_consumer_envelope_carries_evidence(self):
        HERE = Path(__file__).resolve().parent / 'dry_run'
        sys.path.insert(0, str(HERE))
        import toy_consumer
        with tempfile.TemporaryDirectory(prefix='rsi-loop-toy-ev-') as workspace:
            Path(workspace).mkdir(exist_ok=True)
            engine, exit_code, state = toy_consumer.run_one_cycle(workspace)
            self.assertEqual(exit_code, 7)
            record = state.data['cycles'][-1]
            self.assertEqual(record['evidence']['gate']['decision'], 'accept')
            self.assertEqual(record['evidence']['schema'], EVIDENCE_SCHEMA)
            auto_dir = Path(workspace) / 'experiments' / ('auto-%s' % record['id'])
            payload = read_evidence(auto_dir)
            self.assertEqual(payload['evidence'], record['evidence'])


if __name__ == '__main__':
    unittest.main()
