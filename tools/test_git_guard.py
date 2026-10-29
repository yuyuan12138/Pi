import importlib.util
from pathlib import Path
import subprocess
import tempfile
import unittest

SCRIPT = Path(__file__).with_name('git_guard.py').resolve()
spec = importlib.util.spec_from_file_location('guard', SCRIPT)
guard = importlib.util.module_from_spec(spec)
spec.loader.exec_module(guard)


class GuardTests(unittest.TestCase):
    def test_clean_text(self):
        self.assertIsNone(guard.content_problem('AGENTS.md', b'Review and test before committing.'))

    def test_skills_allowed_runtime_denied(self):
        self.assertIsNone(guard.content_problem('.pi/skills/remote-health/SKILL.md', b'Instructions'))
        self.assertIsNotNone(guard.content_problem('.pi/settings.json', b'{}'))

    def test_private_keys_tokens_and_paths(self):
        for path, text in [('note.md', b'-----BEGIN ' + b'OPENSSH ' + b'PRIVATE KEY-----'),
                           ('note.md', b'123456789:' + b'a' * 35),
                           ('note.md', b'sk-' + b'a' * 30),
                           ('.env', b'A=B'), ('db.sqlite3', b'abc'),
                           ('private/note.md', b'private')]:
            with self.subTest(path=path):
                self.assertIsNotNone(guard.content_problem(path, text))

    def test_size_and_binary(self):
        self.assertIsNotNone(guard.content_problem('large.txt', b'a' * (guard.MAX_BYTES + 1)))
        self.assertIsNotNone(guard.content_problem('file.txt', b'a\0b'))

    def test_guard_checks_staged_blob_not_worktree(self):
        with tempfile.TemporaryDirectory() as tmp:
            def git(*args):
                return subprocess.run(['git', '-C', tmp, *args], check=True, capture_output=True)
            git('init', '-q')
            p = Path(tmp) / 'note.md'
            p.write_bytes(b'sk-' + b'a' * 30)
            git('add', 'note.md')
            p.write_text('Now clean only in the working tree')
            blocked = subprocess.run(['python3', str(SCRIPT)], cwd=tmp, capture_output=True)
            self.assertEqual(blocked.returncode, 1)
            self.assertNotIn(b'sk-' + b'a' * 30, blocked.stderr)
            git('add', 'note.md')
            allowed = subprocess.run(['python3', str(SCRIPT)], cwd=tmp, capture_output=True)
            self.assertEqual(allowed.returncode, 0)


if __name__ == '__main__':
    unittest.main()
