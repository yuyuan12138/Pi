"""Run with python3 -m unittest discover -s tools -p test_delegation_gate.py."""
import subprocess
import sys
import unittest
from pathlib import Path

from delegation_gate import EXCEPTIONS, ROUTES, validate


class RoutingTests(unittest.TestCase):
    def test_default_routes(self):
        for category, owners in ROUTES.items():
            for owner in ("primary", "fork", "subagent"):
                with self.subTest(category=category, owner=owner):
                    self.assertEqual(validate(category, owner)[0], owner in owners)

    def test_exception_scope(self):
        for exception, categories in EXCEPTIONS.items():
            for category in ROUTES:
                for owner in ("primary", "fork", "subagent"):
                    with self.subTest(exception=exception, category=category, owner=owner):
                        self.assertEqual(
                            validate(category, owner, exception)[0],
                            owner == "primary" and category in categories,
                        )

    def test_unknown_inputs(self):
        for args in (("unknown", "primary"), ("testing", "unknown"),
                     ("testing", "primary", "anything")):
            self.assertFalse(validate(*args)[0])

    def test_cli_exit_codes(self):
        script = Path(__file__).with_name("delegation_gate.py")
        cases = [
            (["--category", "implementation", "--owner", "fork"], 0, "ALLOW:"),
            (["--category", "implementation", "--owner", "primary"], 1, "DENY:"),
            (["--category", "testing", "--owner", "primary", "--exception", "trivial-fix"], 0, "ALLOW:"),
            (["--category", "deployment", "--owner", "primary", "--exception", "trivial-fix"], 1, "DENY:"),
            (["--category", "bogus", "--owner", "primary"], 2, "invalid choice"),
            (["--category", "testing", "--owner", "bogus"], 2, "invalid choice"),
            (["--category", "testing", "--owner", "primary", "--exception", "bogus"], 2, "invalid choice"),
            ([], 2, "required"),
        ]
        for args, code, text in cases:
            with self.subTest(args=args):
                result = subprocess.run([sys.executable, str(script), *args],
                                        capture_output=True, text=True, check=False)
                self.assertEqual(result.returncode, code)
                self.assertIn(text, result.stdout + result.stderr)


if __name__ == "__main__":
    unittest.main()
