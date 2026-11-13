"""Runtime state: checkpoint after EVERY step; crash = resume, never replay.

Copy-adapted from the MC engine's ClosedLoopState (defect-hardened: stale
streak counters self-repair from the cycle history; atomic 0600 writes).
Adapter-specific payloads (e.g. MC's ladder-curriculum config) live in the
generic ``extra`` dict, never in engine logic.
"""
import datetime
import json
import os
from pathlib import Path


def utcnow():
    return datetime.datetime.now(datetime.timezone.utc).isoformat()


TERMINAL_STATUSES = frozenset({'paused_no_llm', 'paused_infra', 'budget_exhausted',
                               'cycles_done', 'daily_cap', 'observe_window_done',
                               'paused_no_progress', 'stopped'})

# Exit-code vocabulary (stable, part of the adapter contract).
EXIT_OK, EXIT_PAUSED_NO_LLM, EXIT_PAUSED_INFRA = 0, 3, 4
EXIT_BUDGET, EXIT_OBSERVE_DONE, EXIT_CYCLES_DONE = 5, 6, 7
EXIT_PARKED_NO_PROGRESS = 8

EXIT_CODES = {'ok': EXIT_OK, 'paused_no_llm': EXIT_PAUSED_NO_LLM,
              'paused_infra': EXIT_PAUSED_INFRA, 'budget_exhausted': EXIT_BUDGET,
              'observe_window_done': EXIT_OBSERVE_DONE, 'cycles_done': EXIT_CYCLES_DONE,
              'paused_no_progress': EXIT_PARKED_NO_PROGRESS}


def repair_consecutive_counters(counters, cycles):
    """Stale-counter self-repair (c022-c033 defect class): recompute both
    streaks from the recorded cycle history (the trailing run of
    accepts/rejects) and write them back into ``counters``. Returns a repair
    record (old -> new per counter) or None when nothing changed. Pure."""
    if not isinstance(counters, dict):
        return None
    flags = [bool(r.get('accepted')) for r in (cycles or []) if isinstance(r, dict)]
    polarity = flags[-1] if flags else None
    streak = 0
    for flag in reversed(flags):
        if flag != polarity:
            break
        streak += 1
    new_failures = streak if polarity is False else 0
    new_successes = streak if polarity is True else 0
    old = (counters.get('consecutive_failures'), counters.get('consecutive_successes'))
    counters['consecutive_failures'] = new_failures
    counters['consecutive_successes'] = new_successes
    if old == (new_failures, new_successes):
        return None
    return {'consecutive_failures': [old[0], new_failures],
            'consecutive_successes': [old[1], new_successes]}


class TwoStrikes:
    """Two consecutive non-model (infra) failures trip the breaker."""

    def __init__(self, limit=2):
        self.limit = limit
        self.consecutive = 0

    def record(self, is_infra):
        self.consecutive = self.consecutive + 1 if is_infra else 0
        return self.consecutive >= self.limit


class LoopState:
    """Runtime state file, checkpointed after every engine step.

    ``mode``       observe | live (apply authorization lives HERE, recorded
                   with its transition — never implicit)
    ``status``     running | <TERMINAL_STATUSES>
    ``node``       current target + history (curriculum-owned)
    ``extra``      adapter payload (MC: ladder-curriculum config)
    """

    VERSION = 1

    def __init__(self, path, mode='observe', budget_cap=None, max_cycles_per_day=6,
                 initial_node=None, extra=None):
        self.path = Path(path)
        self.data = {
            'version': self.VERSION,
            'mode': mode,
            'status': 'running',
            'node': {'current': initial_node, 'history': []},
            'counters': {'cycles_started': 0, 'cycles_completed': 0,
                         'accepted': 0, 'rejected': 0, 'filtered_out': 0,
                         'consecutive_successes': 0, 'consecutive_failures': 0,
                         'infra_strikes_consecutive': 0,
                         'day': datetime.date.today().isoformat(), 'cycles_today': 0},
            'budget': {'token_cap': budget_cap, 'spent': 0},
            'caps': {'max_cycles_per_day': max_cycles_per_day},
            'would_accept': [],
            'cycle': None,
            'cycles': [],
            'revert': None,
            'live_transition': None,
            'extra': dict(extra or {}),
            'updated_at': utcnow(),
        }

    @classmethod
    def load(cls, path, **kwargs):
        path = Path(path)
        state = cls(path, **kwargs)
        if path.is_file():
            try:
                stored = json.loads(path.read_text())
            except ValueError:
                stored = None
            if isinstance(stored, dict) and stored.get('version') == cls.VERSION:
                # stale-streak self-repair before the next gate decision
                repair = repair_consecutive_counters(stored.get('counters'),
                                                     stored.get('cycles'))
                if repair:
                    stored['counter_repair'] = {'at': utcnow(), **repair}
                state.data = stored
        return state

    def save(self):
        self.data['updated_at'] = utcnow()
        self.path.parent.mkdir(parents=True, exist_ok=True)
        tmp = self.path.with_name(self.path.name + '.tmp')
        tmp.write_text(json.dumps(self.data, indent=2, ensure_ascii=False) + '\n')
        os.chmod(tmp, 0o600)
        os.replace(tmp, self.path)

    def checkpoint(self, phase, **update):
        """Record the in-flight cycle phase + step output, then save."""
        cycle = self.data['cycle'] or {'id': None, 'started_at': utcnow()}
        cycle['phase'] = phase
        cycle.update(update)
        self.data['cycle'] = cycle
        self.save()

    def finish_cycle(self, record):
        c = self.data['counters']
        today = datetime.date.today().isoformat()
        if c['day'] != today:
            c['day'], c['cycles_today'] = today, 0
        c['cycles_today'] += 1
        c['cycles_completed'] += 1
        self.data['cycles'].append(record)
        self.data['cycle'] = None
        self.save()

    def budget_ok(self):
        cap = self.data['budget']['token_cap']
        return cap is None or self.data['budget']['spent'] < cap

    def daily_cap_reached(self):
        c = self.data['counters']
        if c['day'] != datetime.date.today().isoformat():
            return False
        return c['cycles_today'] >= self.data['caps']['max_cycles_per_day']
