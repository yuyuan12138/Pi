"""Unit tests for LoopState (checkpoint/resume primitives) and TwoStrikes."""
import json
import sys
import tempfile
import unittest
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[1] / 'src'))

from rsi_loop.state import (LoopState, TwoStrikes,                # noqa: E402
                            repair_consecutive_counters)


class LoopStateTests(unittest.TestCase):
    def setUp(self):
        self._tmp = tempfile.TemporaryDirectory()
        self.path = Path(self._tmp.name) / 'state' / 's.json'

    def tearDown(self):
        self._tmp.cleanup()

    def test_checkpoint_after_every_step(self):
        state = LoopState(self.path, budget_cap=100)
        state.checkpoint('sense', sense={'ledger': {}})
        self.assertEqual(state.data['cycle']['phase'], 'sense')
        state.checkpoint('propose', raw_proposals=[1])
        self.assertEqual(state.data['cycle']['phase'], 'propose')
        self.assertEqual(state.data['cycle']['sense'], {'ledger': {}})
        stored = json.loads(self.path.read_text())
        self.assertEqual(stored['cycle']['phase'], 'propose')

    def test_finish_cycle_rolls_counters_and_day(self):
        state = LoopState(self.path, max_cycles_per_day=2)
        state.data['counters']['cycles_today'] = 2
        state.data['counters']['day'] = '2000-01-01'
        state.finish_cycle({'id': 'c1'})
        c = state.data['counters']
        self.assertEqual(c['cycles_today'], 1)             # new day -> reset then bump
        self.assertEqual(c['cycles_completed'], 1)
        self.assertIsNone(state.data['cycle'])
        self.assertEqual(state.data['cycles'][-1]['id'], 'c1')

    def test_daily_cap_reached(self):
        state = LoopState(self.path, max_cycles_per_day=2)
        state.data['counters']['cycles_today'] = 2
        self.assertEqual(state.daily_cap_reached(), True)
        state.data['counters']['day'] = '2000-01-01'
        self.assertEqual(state.daily_cap_reached(), False)

    def test_budget_ok(self):
        state = LoopState(self.path, budget_cap=100)
        state.data['budget']['spent'] = 99
        self.assertEqual(state.budget_ok(), True)
        state.data['budget']['spent'] = 100
        self.assertEqual(state.budget_ok(), False)
        state.data['budget']['token_cap'] = None
        self.assertEqual(state.budget_ok(), True)

    def test_atomic_save_is_0600_and_leaves_no_tmp(self):
        state = LoopState(self.path)
        state.save()
        import os
        self.assertEqual(os.stat(self.path).st_mode & 0o777, 0o600)
        self.assertEqual(list(self.path.parent.glob('*.tmp')), [])

    def test_load_repairs_stale_streak_counters(self):
        # c022-c033 defect class: counters stuck at 4 across accepts
        stale = LoopState(self.path)
        stale.data['counters']['consecutive_failures'] = 4
        stale.data['cycles'] = [{'accepted': True}, {'accepted': True}]
        stale.save()
        loaded = LoopState.load(self.path)
        self.assertEqual(loaded.data['counters']['consecutive_failures'], 0)
        self.assertEqual(loaded.data['counters']['consecutive_successes'], 2)
        self.assertIn('counter_repair', loaded.data)

    def test_load_ignores_corrupt_file(self):
        self.path.parent.mkdir(parents=True, exist_ok=True)
        self.path.write_text('{corrupt')
        loaded = LoopState.load(self.path)
        self.assertEqual(loaded.data['status'], 'running')

    def test_load_keeps_version_mismatch_dropped(self):
        self.path.parent.mkdir(parents=True, exist_ok=True)
        self.path.write_text(json.dumps({'version': 99, 'status': 'bogus'}))
        loaded = LoopState.load(self.path)
        self.assertEqual(loaded.data['status'], 'running')

    def test_extra_payload_roundtrip(self):
        state = LoopState(self.path, extra={'ladder': {'node': 'x'}})
        state.save()
        loaded = LoopState.load(self.path)
        self.assertEqual(loaded.data['extra'], {'ladder': {'node': 'x'}})


class RepairCountersTests(unittest.TestCase):
    def test_pure_no_cycles_repair_stale_to_zero(self):
        # no history: any stale streak is wrong and self-corrects to 0
        counters = {'consecutive_failures': 3, 'consecutive_successes': 0}
        record = repair_consecutive_counters(counters, [])
        self.assertEqual(record['consecutive_failures'], [3, 0])
        self.assertEqual(counters['consecutive_failures'], 0)

    def test_trailing_reject_streak(self):
        counters = {'consecutive_failures': 0, 'consecutive_successes': 2}
        record = repair_consecutive_counters(
            counters, [{'accepted': True}, {'accepted': False}, {'accepted': False}])
        self.assertEqual(record['consecutive_failures'], [0, 2])
        self.assertEqual(record['consecutive_successes'], [2, 0])

    def test_no_change_returns_none(self):
        counters = {'consecutive_failures': 2, 'consecutive_successes': 0}
        self.assertIsNone(repair_consecutive_counters(
            counters, [{'accepted': True}, {'accepted': False}, {'accepted': False}]))


class TwoStrikesTests(unittest.TestCase):
    def test_two_consecutive_infra_trip(self):
        strikes = TwoStrikes(2)
        self.assertEqual(strikes.record(True), False)
        self.assertEqual(strikes.record(True), True)

    def test_model_success_resets(self):
        strikes = TwoStrikes(2)
        strikes.record(True)
        strikes.record(False)
        self.assertEqual(strikes.consecutive, 0)
        self.assertEqual(strikes.record(True), False)


if __name__ == '__main__':
    unittest.main()
