#!/usr/bin/env python3
"""Toy second consumer of the generic RSI loop (Theme C2 acceptance).

A minimal, fully deterministic adapter proving the package contract end to
end with a non-MC project shape:

    FixtureLedgerSource   toy error ledger from fixture_ledger.json
    ScriptedProposer      deterministic hypotheses (no LLM, no network);
                          records the rejection memory it receives
    ToyValidator          project scope rule: only toy/skills.json
    DeterministicScorer   toy A/B "scorer": writes a canonical TERMINAL
                          results.json into the workspace and returns it
    AcceptGate(0.15)      the framework's pinned criteria, unchanged
    RecordingApplier      no-op apply: records would_write, writes NOTHING
    SaturationCurriculum  framework default (toy ladder: toy-node-1 -> 2)

The dry-run invocation below completes ONE full loop iteration
(SENSE -> PROPOSE -> FILTER -> EXPERIMENT -> GATE -> APPLY -> CURRICULUM)
in dry-run posture — observe semantics with zero side effects outside its
workspace: no LLM call, no network, no external process, no file outside
the workspace, no live write of any kind.
"""
import json
import sys
import tempfile
from pathlib import Path

_PKG_SRC = Path(__file__).resolve().parents[2] / 'src'
if str(_PKG_SRC) not in sys.path:
    sys.path.insert(0, str(_PKG_SRC))

from rsi_loop.engine import RsiLoopEngine                    # noqa: E402
from rsi_loop.filter import validate_entry_generic           # noqa: E402
from rsi_loop.ports import (AcceptGate, LedgerSource,        # noqa: E402
                            RecordingApplier, SaturationCurriculum,
                            Proposer, ExperimentRunner)
from rsi_loop.results import load_terminal_results           # noqa: E402
from rsi_loop.state import EXIT_CODES, LoopState, utcnow     # noqa: E402

HERE = Path(__file__).resolve().parent
FIXTURE_LEDGER = HERE / 'fixture_ledger.json'

FIXTURE_HYPOTHESES = [{
    'id': 'H1',
    'description': 'Toy fix: bound toy_action retries so program_error cannot loop.',
    'falsifiable': True,
    'change': {'file': 'toy/skills.json', 'action': 'modify',
               'name': 'toy_action_retry_bound',
               'skill': {'name': 'toy_action_retry_bound',
                         'when': 'when toy_action has failed twice in a row',
                         'source': '/* stop after two retries; finish instead */'},
               'deactivate': []},
    'prediction': {'error_code': 'program_error', 'error_count_target': 0,
                   'max_requests': 80},
    'novelty': 'fixture: bounds retries instead of widening the wait window',
    'evidence': ['fixture: program_error x2 in the toy ledger']}]


class FixtureLedgerSource(LedgerSource):
    """SENSE port: reads the toy ledger fixture; static frontier."""

    def __init__(self, fixture_path=FIXTURE_LEDGER):
        self.fixture_path = Path(fixture_path)
        self.sense_calls = []

    def sense(self, cycle_id):
        self.sense_calls.append(cycle_id)
        doc = json.loads(self.fixture_path.read_text())
        return {'ledger': doc['ledger'], 'frontier': doc.get('frontier'),
                'next_before': doc.get('next_before')}
    # post_experiment: inherited default (None) -> static frontier, so the
    # gate decides on the requests-improvement criterion.


class ScriptedProposer(Proposer):
    """PROPOSE port: deterministic fixture hypotheses; records the rejection
    memory the engine feeds it (novelty pressure, demonstrably flowing)."""

    def __init__(self, hypotheses=None, total_tokens=1500):
        self.hypotheses = hypotheses or FIXTURE_HYPOTHESES
        self.seen_rejections = []
        self.last_usage = {'prompt_tokens': 1200, 'completion_tokens': 300,
                           'total_tokens': total_tokens}

    def propose(self, ledger, frontier, node, *, rejections=None, raw_sink=None,
                extra_context=None):
        self.seen_rejections.append(list(rejections or []))
        doc = {'hypotheses': json.loads(json.dumps(self.hypotheses))}
        raw = json.dumps(doc, ensure_ascii=True)
        if raw_sink is not None:
            raw_sink(0, raw)
        return raw, doc


def toy_validator(entry):
    """Adapter scope rule: toy changes may only touch toy/skills.json and
    this consumer has no cold lane."""
    problems = []
    if entry.get('target_file') != 'toy/skills.json':
        problems.append('unknown_target_file:%r' % (entry.get('target_file'),))
    if entry.get('action') == 'patch':
        problems.append('cold_scope_not_supported_by_toy_consumer')
    return problems


class DeterministicScorer(ExperimentRunner):
    """EXPERIMENT port: the toy A/B scorer. Deterministic — no LLM, no
    network, no external process. Writes the canonical TERMINAL results.json
    into the workspace (the crash-resume contract surface) and returns the
    loaded exp_out. Control 100 req / 2 program_errors; treatment 80 req /
    0 program_errors -> a 20% improvement that passes the 15% gate with no
    worsened error code."""

    def __init__(self, workspace, control=None, treatment=None,
                 verdict='treatment_favors'):
        self.workspace = Path(workspace)
        self.control = control or {
            'arm': 'control', 'outcome': 'completed', 'model_requests': 100,
            'error_code_counts': {'program_error': 2, 'action_timeout': 1},
            'token_totals': {'total_tokens': 4_000_000}}
        self.treatment = treatment or {
            'arm': 'treatment', 'outcome': 'completed', 'model_requests': 80,
            'error_code_counts': {'program_error': 0, 'action_timeout': 1},
            'token_totals': {'total_tokens': 3_200_000}}
        self.verdict = verdict
        self.calls = []

    def __call__(self, entry, proposals_path, remaining_budget, cycle_id):
        self.calls.append({'cycle': cycle_id, 'hypothesis': entry['id'],
                           'remaining_budget': remaining_budget})
        auto_dir = self.workspace / 'experiments' / ('auto-%s' % cycle_id)
        auto_dir.mkdir(parents=True, exist_ok=True)
        doc = {'verdict': {'result': self.verdict}, 'finished_at': utcnow(),
               'results': {'control': self.control, 'treatment': self.treatment}}
        (auto_dir / 'results.json').write_text(json.dumps(doc, indent=2) + '\n')
        out = load_terminal_results(auto_dir)
        out['auto_dir'] = str(auto_dir)
        return out
    # load_results: inherited (terminal-only rule) — the resume surface.


def build(workspace, mode='live', observe_window=0, budget_cap=None,
          scorer=None, proposer=None):
    """Assemble the toy consumer's engine in a self-contained workspace.

    mode='live' + applier=RecordingApplier + dry=True is the dry-run posture
    (mirrors MC --dry-run: simulate the live path with stubs, write nothing
    live). mode='observe' + observe_window=N is the observe-first posture
    (estimate-only gate, no experiment at all).
    """
    workspace = Path(workspace)
    state = LoopState(workspace / 'state' / 'closed_loop_state.json', mode=mode,
                      budget_cap=budget_cap, initial_node='toy-node-1')
    if state.data.get('live_transition') is None:
        state.data['live_transition'] = {
            'authorized_by': 'dry-run simulation (stubbed scorer, no-op applier)'
            if mode == 'live' else 'observe mode: estimate-only, no apply',
            'at': utcnow()}
    state.save()
    scorer = scorer or DeterministicScorer(workspace)
    proposer = proposer or ScriptedProposer()
    engine = RsiLoopEngine(
        state, FixtureLedgerSource(), proposer, scorer,
        gate=AcceptGate(threshold=0.15),
        applier=RecordingApplier(would_write=str(workspace / 'toy' / 'skills.json')),
        curriculum=SaturationCurriculum(next_node_fn=lambda s: 'toy-node-2'),
        observe_window=observe_window, dry=True,
        reports_dir=workspace / 'reports',
        proposals_dir=workspace / 'proposals',
        entry_validator=toy_validator)
    return engine


def run_one_cycle(workspace, mode='live', observe_window=0, budget_cap=None,
                  scorer=None, proposer=None):
    """Complete ONE full loop iteration in the given workspace. Returns
    (engine, exit_code, state).

    Observe posture: the engine is budgeted observe_window+1 cycles — the
    extra cycle can never run, because the engine pauses at the top of the
    next iteration (status=observe_window_done, exit code 6) once the
    observation window is exhausted. This mirrors the MC engine's
    '--cycles > --observe' semantics: the observe window is an authorization
    budget, and exceeding it requires a human live-mode decision.
    """
    engine = build(workspace, mode=mode, observe_window=observe_window,
                   budget_cap=budget_cap, scorer=scorer, proposer=proposer)
    cycles = observe_window + 1 if mode == 'observe' else 1
    exit_code = engine.run(cycles)
    return engine, exit_code, engine.state


def main(argv=None):
    """CLI: one dry-run iteration in a fresh (or --workspace) directory.
    Prints the engine's decision lines; the final summary line is valid JSON."""
    import argparse
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--workspace', default=None,
                        help='workspace dir (default: fresh temp dir)')
    parser.add_argument('--observe', action='store_true',
                        help='observe posture: estimate-only gate, no experiment')
    args = parser.parse_args(argv)
    workspace = args.workspace or tempfile.mkdtemp(prefix='rsi-loop-toy-')
    mode = 'observe' if args.observe else 'live'
    engine, exit_code, state = run_one_cycle(workspace, mode=mode,
                                             observe_window=1 if args.observe else 0)
    status = 'would_accept' if (state.data.get('would_accept')) else None
    print(json.dumps({'toy_consumer': 'done', 'workspace': str(workspace),
                      'mode': mode, 'exit_code': exit_code,
                      'exit_meaning': [k for k, v in EXIT_CODES.items()
                                       if v == exit_code],
                      'status': state.data['status'],
                      'cycles_completed': state.data['counters']['cycles_completed'],
                      'accepted': state.data['counters']['accepted'],
                      'gate_decision': (state.data['cycles'][-1]['gate']['decision']
                                        if state.data['cycles'] else status),
                      'applied': bool((state.data['cycles'][-1].get('apply') or {})
                                      .get('applied')) if state.data['cycles'] else False,
                      'budget_spent': state.data['budget']['spent']},
                     ensure_ascii=False))
    return exit_code


if __name__ == '__main__':
    sys.exit(main())
