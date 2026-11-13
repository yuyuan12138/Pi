"""RsiLoopEngine: the eight-stage closed-loop orchestration core.

SENSE -> PROPOSE -> FILTER -> EXPERIMENT -> GATE -> APPLY -> CURRICULUM -> LOOP.

Framework-owned features (extracted from the MC-proven engine, copy-adapted
from closed_loop.py — no imports from remote-agent):
- budget caps (cumulative token cap; per-cycle remaining budget forwarded to
  the runner; daily cycle cap),
- two-strikes infra breaker (two consecutive non-model failures -> pause),
- crash-resume: state checkpointed after EVERY step; an interrupted cycle
  resumes from its artifacts; an experiment is NEVER relaunched — resume
  loads TERMINAL results.json only (rsi_loop.results rule),
- observe-first / live gating: the first N cycles observe (prediction-based
  estimate, no experiment, no apply); apply happens only in live mode with
  the transition recorded in state; observe-window end pauses the loop,
- novelty filter with rejection memory: every gate-rejected cycle's accepted
  hypotheses are fed back to the proposer (capped), so repeats are forbidden
  and the proposer must attack a different failure mode.

Project specifics (ledger formats, scorers, file shapes, git semantics) are
adapter ports — see ADAPTER.md.
"""
import datetime
import json
from pathlib import Path

from .errors import ProposerUnavailable
from .evidence import (build_cycle_evidence, persist_evidence_envelope,
                       proposer_provenance)
from .filter import filter_proposals
from .ports import (AcceptGate, RecordingApplier, SaturationCurriculum,
                    observe_estimate)
from .results import arm_tokens, load_terminal_results
from .state import (EXIT_CODES, TERMINAL_STATUSES, EXIT_OK, EXIT_PAUSED_NO_LLM,
                    EXIT_PAUSED_INFRA, EXIT_BUDGET, EXIT_OBSERVE_DONE,
                    EXIT_CYCLES_DONE, EXIT_PARKED_NO_PROGRESS, utcnow)

RECENT_REJECTIONS_MAX = 5          # anti-repeat memory fed to the proposer
INFRA_REASON_PREFIXES = ('experiment_failed', 'infra_', 'experiment_interrupted')


def emit_decision(decision, **payload):
    """One decision line, always printed (acceptance: 'all decisions printed')."""
    print(json.dumps({'decision': decision, 'at': utcnow(), **payload},
                     ensure_ascii=False), flush=True)


class RsiLoopEngine:
    """One autonomous cycle over the six ports; checkpoints after every step."""

    def __init__(self, state, ledger_source, proposer, runner, gate=None,
                 applier=None, curriculum=None, observe_window=0, dry=False,
                 reports_dir='reports', proposals_dir='proposals', k_max=3,
                 sleep_s=0.0, runners=None, entry_validator=None, change_keys=None):
        self.state = state
        self.ledger_source = ledger_source
        self.proposer = proposer
        self.runner = runner
        self.runners = dict(runners) if runners else {'hot': runner}
        self.gate = gate or AcceptGate()
        self.applier = applier or RecordingApplier()
        self.curriculum_port = curriculum or SaturationCurriculum()
        self.observe_window = observe_window      # cycles of this invocation that observe
        self.observe_total = observe_window
        self.dry = dry
        self.reports_dir = Path(reports_dir)
        self.proposals_dir = Path(proposals_dir)
        self.k_max = k_max
        self.entry_validator = entry_validator
        self.change_keys = change_keys
        self.sleep_s = sleep_s
        self.locate_wait_minutes = None           # operator override for resume poll bound

    # -- step 1: SENSE ------------------------------------------------------
    def sense(self, cycle_id):
        obs = self.ledger_source.sense(cycle_id) or {}
        sense = {'ledger': obs.get('ledger') or {},
                 'frontier': obs.get('frontier'),
                 'ladder_reason': obs.get('reason'),
                 'next_before': obs.get('next_before'),
                 'extra': obs.get('extra') or {}}
        self.state.checkpoint('sense', sense=sense)
        emit_decision('sense', cycle=cycle_id,
                      newest_run=sense['ledger'].get('newest_run'),
                      error_codes=sense['ledger'].get('error_code_counts'),
                      frontier=sense['frontier'], next_before=sense['next_before'])
        return sense

    # -- step 2: PROPOSE ----------------------------------------------------
    def _recent_rejections(self):
        """Anti-repeat memory for the proposer: one entry for EVERY accepted
        hypothesis of each gate-rejected cycle (not only the applied one, so
        unapplied secondary themes are remembered too). Newest last, capped at
        RECENT_REJECTIONS_MAX entries TOTAL. Empty list when nothing was
        rejected — the field is then omitted entirely."""
        rejections = []
        for record in self.state.data.get('cycles') or []:
            gate = record.get('gate') or {}
            if gate.get('decision') != 'reject':
                continue
            details = self._rejected_hypotheses(record)
            if details:
                for detail in details:
                    rejections.append({
                        'cycle': record.get('id'),
                        'hypothesis_id': detail.get('id'),
                        'summary': (detail.get('description') or '')[:160],
                        'reason': gate.get('reason'),
                        'prediction': detail.get('prediction'),
                    })
            else:
                rejections.append({
                    'cycle': record.get('id'),
                    'hypothesis_id': record.get('hypothesis'),
                    'summary': '',
                    'reason': gate.get('reason'),
                    'prediction': None,
                })
        return rejections[-RECENT_REJECTIONS_MAX:]

    def _rejected_hypotheses(self, record):
        """All accepted hypotheses of a rejected cycle, from the proposals
        file written at experiment time; [] when missing/unparseable."""
        path = self.proposals_dir / ('cycle-%s-hypotheses.json' % record.get('id'))
        try:
            doc = json.loads(path.read_text())
        except (OSError, ValueError):
            return []
        accepted = doc.get('accepted') if isinstance(doc, dict) else None
        if not isinstance(accepted, list):
            return []
        return [entry for entry in accepted if isinstance(entry, dict)]

    def propose(self, cycle_id, sense):
        def raw_sink(round_index, raw):
            self.reports_dir.mkdir(parents=True, exist_ok=True)
            (self.reports_dir / ('propose-raw-%s-%d.txt' % (cycle_id, round_index))).write_text(raw)
        extra = {}
        recent_rejections = self._recent_rejections()
        if recent_rejections:
            extra['recent_rejections'] = recent_rejections
        extra_context = dict(sense.get('extra') or {})
        extra_context.update(extra)
        raw_doc = None
        try:
            _raw_text, raw_doc = self.proposer.propose(
                sense['ledger'], sense['frontier'], self.state.data['node']['current'],
                rejections=recent_rejections or None,
                raw_sink=raw_sink, extra_context=extra_context or None)
        except ProposerUnavailable:
            raise
        raw_hyps = raw_doc.get('hypotheses') if isinstance(raw_doc, dict) else None
        usage = getattr(self.proposer, 'last_usage', {}) or {}
        if usage.get('total_tokens'):
            self.state.data['budget']['spent'] += usage['total_tokens']
        # provenance (C3): who proposed this, on which model, from which prompt
        provenance = proposer_provenance(self.proposer)
        self.state.checkpoint('propose', raw_proposals=raw_hyps, proposer_usage=usage,
                              provenance=provenance)
        emit_decision('propose', cycle=cycle_id,
                      raw_count=len(raw_hyps) if isinstance(raw_hyps, list) else 0,
                      usage=usage)
        return raw_hyps

    # -- step 3: FILTER -----------------------------------------------------
    def filter(self, cycle_id, raw_hyps):
        accepted, rejected = filter_proposals(
            raw_hyps, cycle_id, adapter_validator=self.entry_validator,
            k_max=self.k_max, change_keys=self.change_keys) \
            if self.change_keys is not None else \
            filter_proposals(raw_hyps, cycle_id, adapter_validator=self.entry_validator,
                             k_max=self.k_max)
        self.state.data['counters']['filtered_out'] += len(rejected)
        self.state.checkpoint('filter', accepted=accepted, rejected=rejected)
        for rej in rejected:
            emit_decision('filter_reject', cycle=cycle_id, hypothesis=rej.get('id'),
                          reason=rej.get('reason'), problems=rej.get('problems'))
        emit_decision('filter_accepted', cycle=cycle_id,
                      hypotheses=[h['id'] for h in accepted])
        return accepted, rejected

    # -- steps 4-6 ----------------------------------------------------------
    def _runner_for(self, entry):
        scope = entry.get('scope') or 'hot'
        return self.runners.get(scope), scope

    def _write_proposals_file(self, cycle_id, accepted, rejected, scope='hot'):
        proposals_path = self.proposals_dir / ('cycle-%s-hypotheses.json' % cycle_id)
        self.proposals_dir.mkdir(parents=True, exist_ok=True)
        proposals_path.write_text(json.dumps(
            {'run_id': 'rsi-loop-%s' % cycle_id, 'created_at': utcnow(),
             'scope': scope, 'accepted': accepted, 'rejected': rejected},
            indent=2, ensure_ascii=False) + '\n')
        return proposals_path

    def _remaining_budget(self):
        cap = self.state.data['budget']['token_cap']
        if cap is None:
            return None
        return max(0, cap - self.state.data['budget']['spent'])

    def experiment(self, cycle_id, entry, accepted, rejected):
        scope = entry.get('scope') or 'hot'
        proposals_path = self._write_proposals_file(cycle_id, accepted, rejected, scope)
        remaining = self._remaining_budget()
        if remaining is not None and remaining <= 0:
            emit_decision('experiment_skipped_budget', cycle=cycle_id, hypothesis=entry['id'])
            return {'ok': False, 'reason': 'budget_exhausted', 'auto_dir': None}
        self.state.checkpoint('experiment', hypothesis_id=entry['id'],
                              proposals_path=str(proposals_path))
        runner = self._runner_for(entry)[0]
        if runner is None:
            return {'ok': False, 'reason': 'no_runner_for_scope:%s' % scope,
                    'auto_dir': None}
        out = runner(entry, proposals_path, remaining, cycle_id)
        self.state.checkpoint('experiment_done', auto_dir=out.get('auto_dir'),
                              runner_ok=out.get('ok'), runner_reason=out.get('reason'))
        emit_decision('experiment_done', cycle=cycle_id, hypothesis=entry['id'],
                      ok=out.get('ok'), reason=out.get('reason'),
                      auto_dir=out.get('auto_dir'))
        return out

    # -- gate ---------------------------------------------------------------
    def verdict_and_gate(self, cycle_id, entry, exp_out, sense):
        results = (exp_out.get('results') or {}) if exp_out.get('ok') else {}
        control = results.get('control')
        treatment = results.get('treatment')
        # the terminal verdict is hoisted to exp_out level by the canonical
        # loader; stub runners may nest it inside results — accept both.
        verdict = exp_out.get('verdict') or results.get('verdict') or {}
        next_after = None
        if treatment is not None:
            treatment['verdict_result'] = verdict.get('result')
            tokens = arm_tokens(treatment) + arm_tokens(control)
            self.state.data['budget']['spent'] += tokens
            self.state.save()
            next_after = self._post_experiment_next(cycle_id)
        budget_ok = self.state.budget_ok()
        gate = self.gate.decide(control, treatment, sense.get('next_before'),
                                next_after, budget_ok=budget_ok)
        # gate INPUTS (C3 evidence): exactly what the gate saw, recorded with
        # the decision so the acceptance chain is inspectable end to end.
        gate['inputs'] = {'next_before': sense.get('next_before'),
                          'next_after': next_after, 'budget_ok': budget_ok}
        # fail loudly, never silently 'no metrics': always record WHAT the gate
        # read (exact source path + keys) so the evidence chain is inspectable.
        diagnostics = exp_out.get('diagnostics') or \
            {'path': str(Path(exp_out.get('auto_dir')) / 'results.json')
             if exp_out.get('auto_dir') else None,
             'source': 'runner_output'}
        gate['evidence']['metrics_read'] = diagnostics
        if treatment is None and verdict:
            gate['evidence']['driver_verdict'] = verdict.get('result')
        self.state.checkpoint('gate', gate=gate, control=control, treatment=treatment,
                              verdict=verdict)
        emit_decision('gate', cycle=cycle_id, hypothesis=entry['id'],
                      gate_decision=gate['decision'], reason=gate['reason'],
                      evidence=gate['evidence'])
        return gate, control, treatment

    def _post_experiment_next(self, cycle_id):
        """Post-experiment SENSE refresh (frontier-advanced criterion)."""
        try:
            post = self.ledger_source.post_experiment(cycle_id)
        except Exception as error:                              # noqa: BLE001
            emit_decision('post_experiment_sense_failed', cycle=cycle_id,
                          error=str(error)[:200])
            return None
        if isinstance(post, dict):
            return post.get('next_after')
        return None

    # -- apply --------------------------------------------------------------
    def apply(self, cycle_id, entry, gate):
        if self.state.data['mode'] != 'live':
            emit_decision('apply_skipped_not_live', cycle=cycle_id,
                          mode=self.state.data['mode'])
            return {'applied': False, 'reason': 'mode_%s' % self.state.data['mode']}
        try:
            result = self.applier(entry, cycle_id, entry.get('description'),
                                  self.state.data['node']['current'], dry=self.dry)
        except (RuntimeError, SystemExit, OSError) as error:
            emit_decision('apply_failed', cycle=cycle_id, error=str(error)[:300])
            return {'applied': False, 'error': str(error)[:300]}
        if result.get('applied'):
            self.state.data['revert'] = {
                'commit': result.get('commit'),
                'file': entry.get('target_file'),
                'procedure': result.get('revert_procedure'),
                'recorded_at': utcnow(), 'cycle': cycle_id}
            self.state.save()
        emit_decision('apply', cycle=cycle_id, hypothesis=entry['id'],
                      mode=self.state.data['mode'],
                      **{k: v for k, v in result.items()
                         if k not in ('revert_procedure', 'hypothesis', 'cycle', 'mode')})
        return result

    # -- step 7: CURRICULUM -------------------------------------------------
    def curriculum(self, cycle_id, accepted_now, treatment):
        transition = self.curriculum_port.update(cycle_id, accepted_now, treatment, self.state)
        self.state.checkpoint('curriculum', curriculum=transition)
        emit_decision('curriculum', cycle=cycle_id, **{
            k: v for k, v in transition.items() if isinstance(v, (str, int, float, bool))})
        return transition

    # -- pause / reports ----------------------------------------------------
    def pause(self, status, reason, cycle_id=None):
        self.state.data['status'] = status
        self.state.save()
        self.reports_dir.mkdir(parents=True, exist_ok=True)
        stamp = datetime.datetime.now(datetime.timezone.utc).strftime('%Y%m%dT%H%M%SZ')
        report = self.reports_dir / ('paused-%s-%s.md' % (status, stamp))
        report.write_text('# RSI loop paused: %s\n\n- reason: %s\n- cycle: %s\n'
                          '- state: %s\n' % (status, reason, cycle_id, self.state.path) + '\n')
        emit_decision('paused', status=status, reason=str(reason)[:300], report=str(report))

    def write_cycle_report(self, record):
        self.reports_dir.mkdir(parents=True, exist_ok=True)
        path = self.reports_dir / ('cycle-%s.md' % record['id'])
        gate = record['gate']
        lines = ['# RSI loop cycle %s' % record['id'], '',
                 '- at: %s' % record['at'],
                 '- node: %s' % record['node'],
                 '- hypothesis: %s' % record['hypothesis'],
                 '- gate: **%s** (%s)' % (gate['decision'], gate['reason']),
                 '- accepted: %s%s' % (record['accepted'],
                                       ' (observe-mode, nothing applied)' if record['observe'] else ''),
                 '- treatment requests: %s' % record['treatment_requests'],
                 '- budget spent: %s / %s' % (record['budget_spent'],
                                              self.state.data['budget']['token_cap']),
                 '- curriculum: %s' % json.dumps(record['curriculum'], ensure_ascii=False),
                 '', '## Gate evidence', '',
                 '```json', json.dumps(gate.get('evidence'), indent=2, ensure_ascii=False),
                 '```', '']
        path.write_text('\n'.join(lines))

    # -- evidence (C3) ------------------------------------------------------
    def _build_evidence(self, cycle_id, entry, gate, treatment, apply_result,
                        observe=False):
        """Auto-collect the cycle's evidence record from the in-flight
        checkpoint + close-time arguments. Honest degradation: fields the
        crashed/skipped stages never produced stay None (resume paths
        included) — the evidence chain is never fabricated."""
        inflight = self.state.data.get('cycle') or {}
        hypothesis = None
        if entry:
            hypothesis = {'id': entry.get('id'), 'raw_id': entry.get('raw_id'),
                          'scope': entry.get('scope'),
                          'prediction': entry.get('prediction')}
        return build_cycle_evidence(
            cycle_id, provenance=inflight.get('provenance'),
            hypothesis=hypothesis,
            control=inflight.get('control'),
            treatment=treatment if treatment is not None else inflight.get('treatment'),
            verdict=inflight.get('verdict'),
            auto_dir=inflight.get('auto_dir'),
            runner_ok=inflight.get('runner_ok'),
            runner_reason=inflight.get('runner_reason'),
            gate=gate, apply=apply_result, revert=self.state.data.get('revert'),
            observe=observe, mode=self.state.data.get('mode'),
            node=(self.state.data.get('node') or {}).get('current'),
            budget_spent=self.state.data['budget']['spent'],
            budget_cap=self.state.data['budget'].get('token_cap'))

    def _persist_envelope(self, cycle_id, evidence, observe=False):
        """Write the evidence into the cycle's results envelope (terminal
        only). Emits one decision line either way; never raises."""
        if observe:
            return None
        auto_dir = (self.state.data.get('cycle') or {}).get('auto_dir')
        if not auto_dir:
            return None
        path, error = persist_evidence_envelope(auto_dir, evidence)
        if path is not None:
            emit_decision('evidence_envelope_written', cycle=cycle_id, path=str(path))
        else:
            emit_decision('evidence_envelope_skipped', cycle=cycle_id,
                          auto_dir=str(auto_dir), reason=error)
        return path

    # -- one full cycle -----------------------------------------------------
    def run_cycle(self, cycle_id):
        self.state.data['cycle'] = {'id': cycle_id, 'started_at': utcnow(), 'phase': 'sense'}
        self.state.data['counters']['cycles_started'] += 1
        self.state.save()

        sense = self.sense(cycle_id)
        raw_hyps = self.propose(cycle_id, sense)
        if not isinstance(raw_hyps, list) or not raw_hyps:
            return self._close_cycle(cycle_id, None,
                                     {'decision': 'reject', 'reason': 'no_proposals',
                                      'evidence': {}}, False, None)
        accepted, rejected = self.filter(cycle_id, raw_hyps)
        if not accepted:
            return self._close_cycle(cycle_id, None,
                                     {'decision': 'reject', 'reason': 'all_proposals_filtered',
                                      'evidence': {'rejected': rejected}}, False, None)

        entry = accepted[0]
        if self.state.data['mode'] != 'live' or self.observe_window > 0:
            # Observe window = authorization budget: it decrements on EVERY
            # observe-path cycle. (Documented delta from MC: there the
            # decrement required mode=='live' while the pause required
            # mode!='live', so the promised observe_window_done pause was
            # nearly unreachable. Here the window exhausts -> the loop
            # pauses for an explicit human decision, in either mode.)
            if self.observe_window > 0:
                self.observe_window -= 1
            estimate = observe_estimate(entry, sense['ledger'],
                                        threshold=getattr(self.gate, 'threshold', 0.15))
            gate = {'decision': 'would_accept' if estimate['would_accept'] else 'would_reject',
                    'reason': 'observe_mode_estimate',
                    'evidence': {**estimate['evidence'],
                                 'would_accept': estimate['would_accept'],
                                 'kind': estimate['kind'],
                                 'scope': entry.get('scope') or 'hot'}}
            self.state.data['would_accept'].append(
                {'cycle': cycle_id, 'hypothesis': entry['id'], **gate, 'at': utcnow()})
            self.state.checkpoint('gate', gate=gate)
            emit_decision('observe_estimate', cycle=cycle_id, hypothesis=entry['id'],
                          would_accept=estimate['would_accept'],
                          evidence=estimate['evidence'])
            return self._close_cycle(cycle_id, entry, gate, False, None, observe=True)

        exp_out = self.experiment(cycle_id, entry, accepted, rejected)
        if not exp_out.get('ok'):
            gate = {'decision': 'reject',
                    'reason': 'experiment_failed:%s' % exp_out.get('reason'),
                    'evidence': {'auto_dir': exp_out.get('auto_dir')}}
            self.state.checkpoint('gate', gate=gate)
            emit_decision('gate', cycle=cycle_id, hypothesis=entry['id'],
                          gate_decision=gate['decision'], reason=gate['reason'],
                          evidence=gate['evidence'])
            return self._close_cycle(cycle_id, entry, gate, False, None)
        gate, control, treatment = self.verdict_and_gate(cycle_id, entry, exp_out, sense)
        return self._close_cycle(cycle_id, entry, gate, gate['decision'] == 'accept',
                                 treatment)

    def _close_cycle(self, cycle_id, entry, gate, accepted_now, treatment,
                     observe=False):
        apply_result = None
        if accepted_now and entry is not None and not observe:
            apply_result = self.apply(cycle_id, entry, gate)
            if apply_result.get('error'):
                accepted_now = False                        # apply failure is not an accept
        # streak counters update at the GATE decision, once, for every path
        # (c022-c033 stale-counter defect class: exactly one update site).
        c = self.state.data['counters']
        if accepted_now:
            c['consecutive_successes'] += 1
            c['consecutive_failures'] = 0
        else:
            c['consecutive_failures'] += 1
            c['consecutive_successes'] = 0
        transition = self.curriculum(cycle_id, accepted_now, treatment)
        evidence = self._build_evidence(cycle_id, entry, gate, treatment,
                                        apply_result, observe)
        record = {'id': cycle_id, 'at': utcnow(),
                  'hypothesis': entry['id'] if entry else None,
                  'gate': gate, 'accepted': accepted_now, 'observe': observe,
                  'treatment_requests': (treatment or {}).get('model_requests'),
                  'apply': apply_result, 'curriculum': transition,
                  'evidence': evidence,
                  'node': self.state.data['node']['current'],
                  'budget_spent': self.state.data['budget']['spent']}
        c = self.state.data['counters']
        c['accepted' if accepted_now else 'rejected'] += 1
        self._persist_envelope(cycle_id, evidence, observe)
        self.state.finish_cycle(record)
        self.write_cycle_report(record)
        emit_decision('cycle_closed', cycle=cycle_id, accepted=accepted_now,
                      observe=observe, node=record['node'],
                      transition=transition.get('transition'),
                      budget_spent=record['budget_spent'])
        return record

    # -- resume support -----------------------------------------------------
    def resume_inflight(self):
        """crash = resume, never replay: an interrupted cycle continues from
        its checkpointed artifacts. The experiment is NEVER relaunched —
        resume reads TERMINAL results only (runner.load_results)."""
        cycle = self.state.data['cycle']
        if not cycle or not cycle.get('id'):
            return None
        cycle_id = cycle['id']
        phase = cycle.get('phase')
        emit_decision('resume', cycle=cycle_id, phase=phase)
        sense = cycle.get('sense') or {}
        accepted = cycle.get('accepted')
        rejected = cycle.get('rejected') or []
        entry = (accepted or [None])[0]

        if phase in ('sense', 'propose', 'filter'):
            if not accepted:                       # recompute pure filter from stored raw
                accepted, rejected = filter_proposals(
                    cycle.get('raw_proposals') or [], cycle_id,
                    adapter_validator=self.entry_validator, k_max=self.k_max)
                self.state.checkpoint('filter', accepted=accepted, rejected=rejected)
            if not accepted:
                return self._close_cycle(cycle_id, None,
                                         {'decision': 'reject', 'reason': 'all_proposals_filtered',
                                          'evidence': {'rejected': rejected}}, False, None)
            entry = accepted[0]                    # rebind after recompute (entry may have been None)
            exp_out = self.experiment(cycle_id, entry, accepted, rejected)  # fresh start, not a replay
            if not exp_out.get('ok'):
                gate = {'decision': 'reject',
                        'reason': 'experiment_failed:%s' % exp_out.get('reason'),
                        'evidence': {'auto_dir': exp_out.get('auto_dir')}}
                return self._close_cycle(cycle_id, entry, gate, False, None)
            gate, control, treatment = self.verdict_and_gate(cycle_id, entry, exp_out, sense)
            return self._close_cycle(cycle_id, entry, gate, gate['decision'] == 'accept', treatment)

        if phase in ('experiment', 'experiment_done'):
            exp_out = self._locate_experiment_results(cycle)     # never relaunch
            if not exp_out.get('ok'):
                gate = {'decision': 'reject',
                        'reason': 'experiment_failed:%s' % exp_out.get('reason'),
                        'evidence': {'auto_dir': exp_out.get('auto_dir')}}
                self.state.checkpoint('gate', gate=gate)
                return self._close_cycle(cycle_id, entry, gate, False, None)
            gate, control, treatment = self.verdict_and_gate(cycle_id, entry, exp_out, sense)
            return self._close_cycle(cycle_id, entry, gate, gate['decision'] == 'accept', treatment)

        if phase == 'gate':
            gate = cycle.get('gate') or {'decision': 'reject', 'reason': 'gate_checkpoint_lost',
                                         'evidence': {}}
            return self._close_cycle(cycle_id, entry, gate, gate['decision'] == 'accept',
                                     cycle.get('treatment'))

        if phase == 'curriculum':
            # curriculum was already applied and checkpointed; finish the record only
            gate = cycle.get('gate') or {}
            evidence = self._build_evidence(cycle_id, entry, gate,
                                            cycle.get('treatment'), None)
            record = {'id': cycle_id, 'at': utcnow(),
                      'hypothesis': entry['id'] if entry else None,
                      'gate': gate, 'accepted': bool(entry),
                      'observe': False,
                      'treatment_requests': (cycle.get('treatment') or {}).get('model_requests'),
                      'apply': None, 'curriculum': cycle.get('curriculum') or {},
                      'evidence': evidence,
                      'node': self.state.data['node']['current'],
                      'budget_spent': self.state.data['budget']['spent']}
            self._persist_envelope(cycle_id, evidence)
            self.state.finish_cycle(record)
            self.write_cycle_report(record)
            emit_decision('cycle_closed', cycle=cycle_id, accepted=record['accepted'],
                          observe=False, node=record['node'], resume_finish=True)
            return record

        self.state.data['cycle'] = None                          # unknown phase: drop, never replay
        self.state.save()
        return None

    def _locate_experiment_results(self, cycle):
        """crash = resume, never replay: find the results of an already-launched
        experiment. NEVER relaunches; unlocatable results count infra once.
        Only a TERMINAL results.json may be gated on; if the file is
        intermediate the detached driver may still be running — poll bounded,
        then fail LOUDLY with the exact path + keys attempted."""
        auto_dir = cycle.get('auto_dir')
        if not auto_dir or not (Path(auto_dir) / 'results.json').is_file():
            return {'ok': False, 'reason': 'results_unlocatable_after_crash',
                    'auto_dir': auto_dir,
                    'diagnostics': {'path': str(Path(auto_dir) / 'results.json')
                                    if auto_dir else None,
                                    'error': 'results.json not found'}}
        loaded = load_terminal_results(auto_dir)
        if loaded['ok']:
            return self._runner_exp_out(auto_dir, loaded)
        deadline_end = datetime.datetime.now(datetime.timezone.utc).timestamp() \
            + self._locate_wait_s()
        while datetime.datetime.now(datetime.timezone.utc).timestamp() < deadline_end:
            remaining = max(0.0, deadline_end
                            - datetime.datetime.now(datetime.timezone.utc).timestamp())
            time_sleep = min(15.0, max(0.5, remaining))
            import time as _time
            _time.sleep(time_sleep)
            loaded = load_terminal_results(auto_dir)
            if loaded['ok']:
                emit_decision('experiment_results_completed_after_wait',
                              auto_dir=str(auto_dir))
                return self._runner_exp_out(auto_dir, loaded)
        return {'ok': False, 'reason': 'experiment_still_running_no_verdict',
                'auto_dir': auto_dir, 'diagnostics': loaded['diagnostics']}

    @staticmethod
    def _runner_exp_out(auto_dir, loaded):
        out = {'ok': True, 'auto_dir': str(auto_dir), 'results': loaded['results'],
               'verdict': loaded['verdict'], 'finished_at': loaded['finished_at'],
               'diagnostics': loaded['diagnostics']}
        doc = loaded.get('doc') or {}
        for key in ('cold_gate', 'cold_change'):
            if isinstance(doc.get(key), dict):
                out[key] = doc[key]
        return out

    def _locate_wait_s(self):
        """Bounded wait for a detached driver's terminal verdict (defaults to
        the runner's supervise window — the same bound the non-resume path
        already uses)."""
        minutes = self.locate_wait_minutes
        if minutes is None:
            minutes = getattr(self.runner, 'supervise_minutes', None) or 240
        return float(minutes) * 60.0

    # -- main loop ----------------------------------------------------------
    def run(self, max_cycles):
        import os
        import time
        self.state.data['status'] = 'running'
        self.state.save()
        # Operator override for the crash-resume poll bound (minutes). Default
        # is the runner's supervise window; a shorter bound is only honest when
        # the operator has verified no orphaned experiment process is alive.
        resume_wait = os.environ.get('RSI_LOOP_RESUME_WAIT_MINUTES')
        if resume_wait:
            try:
                self.locate_wait_minutes = float(resume_wait)
            except ValueError:
                emit_decision('resume_wait_override_ignored', value=resume_wait[:16])
        resumed = self.resume_inflight()
        if resumed is not None:
            emit_decision('resume_completed', cycle=resumed.get('id'))
            max_cycles = max(0, max_cycles - 1)
        from .state import TwoStrikes
        strikes = TwoStrikes(2)
        strikes.consecutive = self.state.data['counters']['infra_strikes_consecutive']
        exit_code = EXIT_OK
        done = 0
        while done < max_cycles:
            if self.state.data['status'] in TERMINAL_STATUSES - {'running'}:
                break
            if self.state.daily_cap_reached():
                self.pause('daily_cap', 'max cycles/day reached (%d)'
                           % self.state.data['caps']['max_cycles_per_day'])
                break
            if not self.state.budget_ok():
                self.pause('budget_exhausted',
                           'token budget spent %d >= cap %s'
                           % (self.state.data['budget']['spent'],
                              self.state.data['budget']['token_cap']))
                exit_code = EXIT_BUDGET
                break
            observing = self.state.data['mode'] != 'live' or self.observe_window > 0
            if self.observe_total > 0 and self.observe_window <= 0:
                self.pause('observe_window_done',
                           'observe window complete; re-authorization required to continue '
                           '(extend the window or authorize live mode)')
                exit_code = EXIT_OBSERVE_DONE
                break
            cycle_seq = self.state.data['counters']['cycles_started'] + 1
            cycle_id = 'c%03d-%s' % (cycle_seq,
                                     datetime.datetime.now(datetime.timezone.utc)
                                     .strftime('%Y%m%dT%H%M%S'))
            try:
                record = self.run_cycle(cycle_id)
            except ProposerUnavailable as error:
                self.pause('paused_no_llm', str(error), cycle_id)
                exit_code = EXIT_PAUSED_NO_LLM
                break
            except Exception as error:                          # noqa: BLE001 - infra strike
                emit_decision('cycle_infra_failure', cycle=cycle_id,
                              error='%s: %s' % (type(error).__name__, str(error)[:300]))
                infra_gate = {'decision': 'reject', 'reason': 'infra_exception',
                              'evidence': {'error': str(error)[:300]}}
                record = {'id': cycle_id, 'accepted': False,
                          'gate': infra_gate,
                          'evidence': self._build_evidence(cycle_id, None, infra_gate,
                                                           None, None)}
                self.state.data['cycles'].append(record)
                self.state.data['counters']['consecutive_failures'] += 1
                self.state.data['counters']['consecutive_successes'] = 0
                self.state.data['cycle'] = None
                self.state.save()
            infra = (not record.get('accepted')) and record.get('gate', {}).get(
                'reason', '').startswith(INFRA_REASON_PREFIXES)
            strikes.record(infra)
            self.state.data['counters']['infra_strikes_consecutive'] = strikes.consecutive
            self.state.save()
            if strikes.consecutive >= 2:
                self.pause('paused_infra', 'two consecutive infra failures')
                exit_code = EXIT_PAUSED_INFRA
                break
            done += 1
            if self.sleep_s:
                time.sleep(self.sleep_s)
        if self.state.data['status'] in ('paused_no_llm', 'paused_infra',
                                         'paused_no_progress'):
            exit_code = {'paused_no_llm': EXIT_PAUSED_NO_LLM,
                         'paused_infra': EXIT_PAUSED_INFRA,
                         'paused_no_progress': EXIT_PARKED_NO_PROGRESS}[
                             self.state.data['status']]
        if self.state.data['status'] == 'running':
            self.state.data['status'] = 'cycles_done'
            self.state.save()
            exit_code = exit_code or EXIT_CYCLES_DONE
        return exit_code


__all__ = ['RsiLoopEngine', 'emit_decision', 'EXIT_CODES', 'RECENT_REJECTIONS_MAX']
