"""Unit tests for the terminal-only results loader (crash-resume rule)."""
import json
import sys
import tempfile
import unittest
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[1] / 'src'))

from rsi_loop.results import (arm_tokens, is_completed_outcome,     # noqa: E402
                              load_terminal_results)


def terminal_doc():
    return {'verdict': {'result': 'treatment_favors'}, 'finished_at': '2026-11-13T00:00:00Z',
            'results': {'control': {'arm': 'control', 'outcome': 'completed',
                                    'model_requests': 100},
                        'treatment': {'arm': 'treatment', 'outcome': 'completed',
                                      'model_requests': 80}}}


class LoadTerminalResultsTests(unittest.TestCase):
    def setUp(self):
        self._tmp = tempfile.TemporaryDirectory()
        self.dir = Path(self._tmp.name)

    def tearDown(self):
        self._tmp.cleanup()

    def _write(self, doc, name='results.json'):
        (self.dir / name).write_text(json.dumps(doc))

    def test_ok_path(self):
        self._write(terminal_doc())
        out = load_terminal_results(self.dir)
        self.assertEqual(out['ok'], True)
        self.assertEqual(out['verdict'], {'result': 'treatment_favors'})
        self.assertEqual(out['results']['treatment']['model_requests'], 80)
        self.assertEqual(out['finished_at'], '2026-11-13T00:00:00Z')
        self.assertEqual(out['diagnostics']['terminal_verdict_present'], True)

    def test_missing_file_fails_with_path(self):
        out = load_terminal_results(self.dir)
        self.assertEqual(out['ok'], False)
        self.assertIn('FileNotFoundError', out['diagnostics']['error'])
        self.assertEqual(out['diagnostics']['path'], str(self.dir / 'results.json'))

    def test_intermediate_no_verdict_rejected(self):
        # the c005 bug class: per-arm intermediate write without the verdict
        self._write({'results': {'control': {}, 'treatment': {}}})
        out = load_terminal_results(self.dir)
        self.assertEqual(out['ok'], False)
        self.assertEqual(out['diagnostics']['error'],
                         'results_unterminal_no_verdict (intermediate per-arm write)')

    def test_results_key_missing_rejected(self):
        self._write({'verdict': {}})
        out = load_terminal_results(self.dir)
        self.assertEqual(out['ok'], False)
        self.assertEqual(out['diagnostics']['error'], 'results_key_missing_or_not_a_dict')

    def test_treatment_missing_rejected(self):
        doc = terminal_doc()
        del doc['results']['treatment']
        self._write(doc)
        out = load_terminal_results(self.dir)
        self.assertEqual(out['ok'], False)
        self.assertEqual(out['diagnostics']['error'], 'treatment_key_missing_from_results')

    def test_corrupt_json_rejected(self):
        (self.dir / 'results.json').write_text('{not json')
        out = load_terminal_results(self.dir)
        self.assertEqual(out['ok'], False)
        self.assertIn('JSONDecodeError', out['diagnostics']['error'])

    def test_non_object_rejected(self):
        self._write([1, 2])
        out = load_terminal_results(self.dir)
        self.assertEqual(out['ok'], False)
        self.assertEqual(out['diagnostics']['error'], 'results_json_not_an_object')

    def test_custom_terminal_key(self):
        doc = terminal_doc()
        doc['final'] = doc.pop('verdict')
        self._write(doc)
        out = load_terminal_results(self.dir, terminal_key='final')
        self.assertEqual(out['ok'], True)


class ArmHelpersTests(unittest.TestCase):
    def test_arm_tokens(self):
        self.assertEqual(arm_tokens({'token_totals': {'total_tokens': 5}}), 5)
        self.assertEqual(arm_tokens({'token_totals': {}}), 0)
        self.assertEqual(arm_tokens(None), 0)
        self.assertEqual(arm_tokens({'token_totals': {'total_tokens': -1}}), 0)

    def test_is_completed_outcome(self):
        self.assertEqual(is_completed_outcome({'outcome': 'completed'}), True)
        self.assertEqual(is_completed_outcome({'outcome': 'model_failed'}), True)
        self.assertEqual(is_completed_outcome({'outcome': 'cap_reached'}), False)
        self.assertEqual(is_completed_outcome({'outcome': 'infra_failure'}), False)
        self.assertEqual(is_completed_outcome({'outcome': 'timeout'}), False)
        self.assertEqual(is_completed_outcome(None), False)
        self.assertEqual(is_completed_outcome({'outcome': 'weird'},
                                              extra_not_completed=('weird',)), False)


if __name__ == '__main__':
    unittest.main()
