import importlib.util
import subprocess
import tempfile
import unittest
from unittest.mock import patch
from pathlib import Path


class ReleaseScanTests(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        path = Path(__file__).resolve().parents[1] / 'scripts/check-release.py'
        spec = importlib.util.spec_from_file_location('release_scan', path)
        cls.scan = importlib.util.module_from_spec(spec)
        spec.loader.exec_module(cls.scan)

    def test_secret_is_detected_without_value_in_finding(self):
        secret = 'ghp_' + 'a' * 36
        findings = self.scan.content_findings('note.txt', secret.encode())
        self.assertIn('credential pattern', findings)
        self.assertNotIn(secret, str(findings))

    def test_custom_token_and_home_path(self):
        for value in ['art_v1_' + 'a' * 40, '/Users/' + 'example/private/file']:
            self.assertTrue(self.scan.content_findings('note.txt', value.encode()))

    def test_document_placeholder_only(self):
        value = ('TO' + 'DO: finish this').encode()
        self.assertIn('unresolved document marker', self.scan.content_findings('docs/a.md', value))
        self.assertNotIn('unresolved document marker', self.scan.content_findings('src/a.ts', value))

    def test_runtime_path_and_symlink(self):
        self.assertTrue(self.scan.path_findings('runs/local/state/env.json', '100644'))
        self.assertTrue(self.scan.path_findings('link', '120000'))
        self.assertTrue(self.scan.path_findings('../escape', '100644'))
        self.assertFalse(self.scan.path_findings('runs/deployed-1/a.jsonl', '100644'))

    def test_relative_links(self):
        names = {'README.md', 'docs/a.md'}
        self.assertFalse(self.scan.link_findings('README.md', '[read](docs/a.md#first)', names))
        self.assertTrue(self.scan.link_findings('README.md', '[read](missing.md)', names))
        self.assertTrue(self.scan.link_findings('README.md', '[read](../outside.md)', names))

    def test_agent_metadata(self):
        self.assertTrue(self.scan.metadata_findings('author Build Bot <bot@example.org> 1 +0000\n\nInitial'))
        self.assertTrue(self.scan.metadata_findings('author Example Agent <bot@example.org> 1 +0000\n\nCo-authored-by: ' + 'Claude <bot@example.org>'))
        self.assertFalse(self.scan.metadata_findings('author Operator <operator@example.org> 1 +0000\ncommitter Operator <operator@example.org> 1 +0000\n\nInitial release'))

    def test_pdf_text_requires_extractor(self):
        scanner = self.scan.Scanner(Path('.'))
        with patch.object(self.scan.shutil, 'which', return_value=None):
            scanner.content('paper.pdf', 'paper.pdf', b'%PDF-1.7')
        self.assertIn(('paper.pdf', 'PDF text check unavailable: install Poppler'), scanner.findings)

    def test_pdf_decoded_text_is_scanned(self):
        scanner = self.scan.Scanner(Path('.'))
        extracted = ('ghp_' + 'c' * 36).encode()
        result = subprocess.CompletedProcess([], 0, extracted, b'')
        with patch.object(self.scan.shutil, 'which', return_value='/fake/extractor'):
            with patch.object(self.scan.subprocess, 'run', return_value=result):
                scanner.content('paper.pdf', 'paper.pdf', b'%PDF-1.7 compressed content')
        self.assertIn(('paper.pdf', 'credential pattern'), scanner.findings)
        self.assertNotIn(extracted.decode(), str(scanner.findings))

    def test_deleted_secret_is_found_in_history(self):
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            def git(*args):
                return subprocess.run(['git', '-C', directory, *args], check=True, capture_output=True)
            git('init', '-q')
            git('config', 'user.name', 'Operator')
            git('config', 'user.email', 'operator@example.org')
            secret = 'ghp_' + 'b' * 36
            (root / 'old.txt').write_text(secret)
            git('add', 'old.txt')
            git('commit', '-qm', 'Initial')
            git('rm', 'old.txt')
            git('commit', '-qm', 'Remove')
            scanner = self.scan.Scanner(root)
            scanner.history()
            self.assertTrue(any(reason == 'credential pattern' for _, reason in scanner.findings))
            self.assertNotIn(secret, str(scanner.findings))


if __name__ == '__main__':
    unittest.main()
