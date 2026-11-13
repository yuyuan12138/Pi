"""Unit tests for the proposal filter (generic invariants + adapter hook)."""
import sys
import unittest
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[1] / 'src'))

from rsi_loop.filter import (entry_from_raw, filter_proposals,            # noqa: E402
                             validate_entry_generic)


def raw_hyp(**overrides):
    base = {'id': 'H1', 'description': 'd', 'falsifiable': True,
            'change': {'file': 'toy/skills.json', 'action': 'modify',
                       'name': 'my_skill',
                       'skill': {'name': 'my_skill', 'when': 'when x',
                                 'source': '/* r */'},
                       'deactivate': []},
            'prediction': {'error_code': 'program_error', 'error_count_target': 0,
                           'max_requests': 150},
            'novelty': 'different mechanism',
            'evidence': ['e1']}
    base.update(overrides)
    return base


def strict_validator(entry):
    return [] if entry.get('target_file') == 'toy/skills.json' \
        else ['unknown_target_file:%r' % (entry.get('target_file'),)]


class FilterTests(unittest.TestCase):
    def test_valid_entry_passes(self):
        accepted, rejected = filter_proposals([raw_hyp()], 'c001',
                                              adapter_validator=strict_validator)
        self.assertEqual(len(accepted), 1)
        self.assertEqual(rejected, [])
        self.assertEqual(accepted[0]['target_file'], 'toy/skills.json')
        self.assertEqual(accepted[0]['id'], 'Cc001H1')
        self.assertEqual(accepted[0]['novelty'], 'different mechanism')

    def test_not_a_list(self):
        accepted, rejected = filter_proposals({'hypotheses': []}, 'c001')
        self.assertEqual(accepted, [])
        self.assertEqual(rejected[0]['reason'], 'hypotheses_not_a_list')

    def test_hypothesis_not_an_object(self):
        accepted, rejected = filter_proposals(['nope'], 'c001')
        self.assertEqual(accepted, [])
        self.assertEqual(rejected[0]['reason'], 'hypothesis_not_an_object')

    def test_k_overflow_truncated_and_logged(self):
        hyps = [raw_hyp() for _ in range(5)]
        accepted, rejected = filter_proposals(hyps, 'c001', k_max=3)
        self.assertEqual(len(accepted), 3)
        self.assertEqual(rejected[0]['reason'], 'k_overflow:5>3_truncated')

    def test_unfalsifiable_rejected(self):
        accepted, rejected = filter_proposals([raw_hyp(falsifiable=False)], 'c001')
        self.assertEqual(accepted, [])
        self.assertEqual(rejected[0]['problems'], ['not_falsifiable'])

    def test_unmeasurable_prediction_rejected(self):
        for bad in ({}, {'error_code': 'e'}, {'error_code': 'e', 'error_count_target': 0},
                    {'error_code': 'e', 'error_count_target': 0, 'max_requests': 0},
                    {'error_code': 'e', 'error_count_target': '0', 'max_requests': 5}):
            accepted, rejected = filter_proposals(
                [raw_hyp(prediction=bad)], 'c001')
            self.assertEqual(accepted, [], bad)
            self.assertIn('prediction_not_measurable', rejected[0]['problems'])

    def test_name_invalid_rejected(self):
        accepted, rejected = filter_proposals([raw_hyp(change={'file': 'toy/skills.json',
                                                               'action': 'modify',
                                                               'name': '9bad name'})],
                                              'c001')
        self.assertIn('name_invalid', rejected[0]['problems'])

    def test_action_invalid_rejected(self):
        accepted, rejected = filter_proposals([raw_hyp(change={'file': 'toy/skills.json',
                                                               'action': 'touch',
                                                               'name': 'x'})], 'c001')
        self.assertIn('action_invalid', rejected[0]['problems'])

    def test_unexpected_change_keys_rejected(self):
        change = raw_hyp()['change']
        change['sneaky'] = 1
        accepted, rejected = filter_proposals([raw_hyp(change=change)], 'c001')
        self.assertIn('unexpected_change_keys:[\'sneaky\']', rejected[0]['problems'])

    def test_cold_patch_requires_diff(self):
        accepted, rejected = filter_proposals(
            [raw_hyp(change={'file': 'src.py', 'action': 'patch'})], 'c001')
        self.assertEqual(rejected[0]['problems'], ['cold_diff_missing'])

    def test_cold_patch_with_diff_passes_generic(self):
        accepted, rejected = filter_proposals(
            [raw_hyp(change={'file': 'src.py', 'action': 'patch',
                             'diff': 'diff --git a/src.py b/src.py'})], 'c001')
        self.assertEqual(len(accepted), 1)
        self.assertEqual(accepted[0]['cold_diff'], 'diff --git a/src.py b/src.py')

    def test_adapter_validator_rejects_unknown_scope(self):
        accepted, rejected = filter_proposals(
            [raw_hyp(change={'file': 'elsewhere.json', 'action': 'modify',
                             'name': 'x', 'skill': {'when': 'w', 'source': 's'}})],
            'c001', adapter_validator=strict_validator)
        self.assertEqual(accepted, [])
        self.assertEqual(rejected[0]['problems'],
                         ['unknown_target_file:%r' % 'elsewhere.json'])

    def test_adapter_cannot_weaken_generic_invariants(self):
        accepted, rejected = filter_proposals(
            [raw_hyp(falsifiable=False)], 'c001', adapter_validator=lambda e: [])
        self.assertEqual(accepted, [])
        self.assertIn('not_falsifiable', rejected[0]['problems'])

    def test_custom_change_keys_allowlist(self):
        accepted, _ = filter_proposals(
            [raw_hyp(change={'file': 'f', 'action': 'patch', 'diff': 'd'})],
            'c001', change_keys={'file', 'action', 'diff'})
        self.assertEqual(len(accepted), 1)

    def test_entry_from_raw_keeps_deactivate_and_scope_payload(self):
        entry = entry_from_raw(raw_hyp(), 'c9', 2)
        self.assertEqual(entry['id'], 'Cc9H2')
        self.assertEqual(entry['raw_id'], 'H1')
        self.assertEqual(entry['deactivate'], [])
        self.assertEqual(entry['_change_keys'],
                         ['file', 'action', 'name', 'skill', 'deactivate'])

    def test_skill_object_invalid_for_add(self):
        accepted, rejected = filter_proposals(
            [raw_hyp(change={'file': 'toy/skills.json', 'action': 'add',
                             'name': 'x'})], 'c001')
        self.assertIn('skill_object_invalid', rejected[0]['problems'])


if __name__ == '__main__':
    unittest.main()
