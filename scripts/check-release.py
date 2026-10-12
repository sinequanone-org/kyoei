import argparse
import hashlib
import json
import posixpath
import re
import shutil
import subprocess
import tempfile
from pathlib import Path, PurePosixPath
from urllib.parse import unquote, urlsplit


MAX_BYTES = 32 * 1024 * 1024
CREDENTIAL = re.compile(
    r'-----BEGIN (?:RSA |EC |OPENSSH |DSA |ENCRYPTED )?PRIVATE KEY-----'
    r'|\b(?:gh[pousr]_[A-Za-z0-9]{30,}|github_pat_[A-Za-z0-9_]{40,})'
    r'|\b(?:AKIA|ASIA)[A-Z0-9]{16}\b'
    r'|\b(?:art_v1_|adm_|ns_)[A-Za-z0-9_-]{20,}'
    r'|\bBearer[ \t]+[A-Za-z0-9_.+/=-]{24,}'
    r'|\b(?:sk_live_|rk_live_)[A-Za-z0-9]{20,}'
    r'|["\']?(?:password|api[_-]?key|admin[_-]?token|client[_-]?secret)["\']?\s*[:=]\s*["\'][A-Za-z0-9_+/=-]{24,}["\']',
    re.I,
)
HOME_PATH = re.compile(r'(?:/Users/|/home/)[A-Za-z0-9_.-]+/|[A-Za-z]:\\Users\\[^\\\s]+\\')
MARKER = re.compile(r'\b(?:TODO|FIXME|TO-CONFIRM|PENDING-CUT)\b')
AGENT = re.compile(r'\b(?:claude|cursor|codex|copilot|chatgpt|opencode|agent|bot)\b', re.I)
FORBIDDEN = {'.env', '.dev.vars', '.DS_Store', 'id_rsa', 'id_ed25519'}
FORBIDDEN_DIRS = {'node_modules', '.wrangler', '.ssh', '__pycache__', '.venv', '.git'}


def path_findings(name, mode):
    path = PurePosixPath(name)
    problems = []
    if path.is_absolute() or '..' in path.parts or '\\' in name or any(ord(c) < 32 for c in name):
        problems.append('unsafe path')
    if mode not in {'100644', '100755'}:
        problems.append('non-regular file')
    if path.name in FORBIDDEN or path.name.startswith('.env.') or any(p in FORBIDDEN_DIRS for p in path.parts):
        problems.append('runtime or credential artifact')
    if path.suffix in {'.pem', '.key', '.p12', '.pfx', '.sqlite', '.sqlite3', '.db', '.pyc', '.zip', '.gz', '.tgz'}:
        problems.append('unreviewed binary or archive')
    if path.parts[:1] == ('runs',) and ('state' in path.parts or path.name == 'current'):
        problems.append('runtime state')
    return problems


def content_findings(name, data):
    text = data.decode('utf-8', errors='replace')
    problems = []
    if CREDENTIAL.search(text):
        problems.append('credential pattern')
    if HOME_PATH.search(text):
        problems.append('absolute home path')
    if name.lower().endswith(('.md', '.rst', '.txt')) and MARKER.search(text):
        problems.append('unresolved document marker')
    return problems


def link_findings(name, text, names):
    problems = []
    links = re.findall(r'!?\[[^\]\n]*\]\(([^\n)]+)\)', text)
    links += re.findall(r'^\s*\[[^\]]+\]:\s*(\S+)', text, re.M)
    for raw in links:
        target = raw.strip()
        if target.startswith('<') and '>' in target:
            target = target[1:target.index('>')]
        else:
            target = target.split()[0] if target else ''
        url = urlsplit(target)
        if url.scheme or url.netloc or not url.path:
            continue
        decoded = unquote(url.path)
        joined = posixpath.normpath(posixpath.join(posixpath.dirname(name), decoded))
        if decoded.startswith('/') or joined == '..' or joined.startswith('../'):
            problems.append('relative link escapes release')
        elif joined not in names and not any(p.startswith(joined.rstrip('/') + '/') for p in names):
            problems.append('missing relative link target')
    return sorted(set(problems))


def metadata_findings(text):
    problems = []
    header, _, body = text.partition('\n\n')
    if any(AGENT.search(line) for line in header.splitlines() if line.startswith(('author ', 'committer ', 'tagger '))):
        problems.append('agent commit identity')
    if re.search(r'^(?:Co-authored-by|Claude-Session|Cursor-Session|Agent):', body, re.I | re.M):
        problems.append('unapproved commit trailer')
    return problems


class Scanner:
    def __init__(self, root):
        self.root = root
        self.findings = set()
        self.seen = set()
        self.files = 0
        self.commits = 0

    def git(self, *args):
        result = subprocess.run(['git', '-C', str(self.root), *args], capture_output=True, timeout=60)
        if result.returncode:
            raise RuntimeError('Git read failed')
        return result.stdout

    def add(self, label, reasons):
        if CREDENTIAL.search(label) or HOME_PATH.search(label):
            label = 'redacted-path:' + hashlib.sha256(label.encode()).hexdigest()[:12]
        for reason in reasons:
            self.findings.add((label, reason))

    def content(self, label, name, data):
        key = (name, hashlib.sha256(data).digest())
        if key in self.seen:
            return
        self.seen.add(key)
        self.files += 1
        self.add(label, content_findings(name, data))
        if data.startswith(b'%PDF-') or name.lower().endswith('.pdf'):
            tool = shutil.which('pdftotext')
            if not tool:
                self.add(label, ['PDF text check unavailable: install Poppler'])
                return
            with tempfile.TemporaryDirectory() as directory:
                pdf = Path(directory) / 'input.pdf'
                pdf.write_bytes(data)
                result = subprocess.run([tool, '-enc', 'UTF-8', str(pdf), '-'], capture_output=True, timeout=30)
                if result.returncode or len(result.stdout) > MAX_BYTES:
                    self.add(label, ['PDF text extraction failed'])
                else:
                    self.add(label, content_findings(name + '.txt', result.stdout))

    def worktree(self):
        raw = self.git('ls-files', '--cached', '--others', '--exclude-standard', '-z')
        names = set(raw.decode('utf-8').strip('\0').split('\0')) - {''}
        for name in sorted(names):
            path = self.root / name
            mode = '120000' if path.is_symlink() else '100644'
            self.add(name, path_findings(name, mode))
            if any(parent.is_symlink() for parent in [path, *path.parents] if parent != self.root and parent.is_relative_to(self.root)) or not path.is_file() or not path.resolve().is_relative_to(self.root):
                self.add(name, ['missing or unsafe release file'])
                continue
            if path.stat().st_size > MAX_BYTES:
                self.add(name, ['file exceeds scan size limit'])
                continue
            data = path.read_bytes()
            self.content(name, name, data)
            if name.endswith('.md'):
                self.add(name, link_findings(name, data.decode('utf-8', errors='replace'), names))

    def history(self):
        if self.git('rev-parse', '--is-shallow-repository').strip() == b'true':
            self.add('history', ['shallow history cannot be checked'])
            return
        commits = self.git('rev-list', '--all').decode().splitlines()
        if not commits:
            self.add('history', ['no commits to scan'])
        for commit in commits:
            self.commits += 1
            label = 'commit:' + commit[:12]
            metadata = self.git('cat-file', 'commit', commit)
            self.add(label, metadata_findings(metadata.decode('utf-8', errors='replace')))
            self.add(label, content_findings('commit.txt', metadata))
            rows = self.git('ls-tree', '-rz', '--full-tree', commit).split(b'\0')
            entries = []
            for row in rows:
                if not row:
                    continue
                info, raw_name = row.split(b'\t', 1)
                mode, kind, oid = info.decode().split()
                name = raw_name.decode('utf-8')
                entries.append((mode, kind, oid, name))
            names = {entry[3] for entry in entries}
            for mode, kind, oid, name in entries:
                label = commit[:12] + ':' + name
                self.add(label, path_findings(name, mode))
                if kind != 'blob' or mode not in {'100644', '100755'}:
                    continue
                if int(self.git('cat-file', '-s', oid)) > MAX_BYTES:
                    self.add(label, ['file exceeds scan size limit'])
                    continue
                data = self.git('cat-file', 'blob', oid)
                self.content(label, name, data)
                if name.endswith('.md'):
                    self.add(label, link_findings(name, data.decode('utf-8', errors='replace'), names))
        objects = self.git('for-each-ref', '--format=%(objecttype) %(objectname)').decode().splitlines()
        for entry in objects:
            kind, oid = entry.split()
            if kind == 'tag':
                data = self.git('cat-file', 'tag', oid)
                self.add('tag:' + oid[:12], metadata_findings(data.decode('utf-8', errors='replace')))
                self.add('tag:' + oid[:12], content_findings('tag.txt', data))


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument('--root', type=Path, default=Path(__file__).resolve().parents[1])
    parser.add_argument('--history', action='store_true')
    args = parser.parse_args()
    scanner = Scanner(args.root.resolve())
    try:
        scanner.worktree()
        if args.history:
            scanner.history()
    except (OSError, ValueError, RuntimeError, subprocess.TimeoutExpired):
        scanner.add('scan', ['scan incomplete'])
    print(json.dumps({'verdict': 'fail' if scanner.findings else 'pass', 'unique_file_versions': scanner.files,
                      'commits': scanner.commits, 'findings': [{'path': path, 'reason': reason}
                      for path, reason in sorted(scanner.findings)]}, indent=2))
    return 1 if scanner.findings else 0


if __name__ == '__main__':
    raise SystemExit(main())
