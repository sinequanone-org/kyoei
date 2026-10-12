"""Check reviewed source and evidence bindings without claiming deployment identity."""
import argparse
import hashlib
import json
from pathlib import Path


def file_digest(path):
    return hashlib.sha256(path.read_bytes()).hexdigest()


def check_alignment(manifest, bundle, evidence_root, port_root):
    errors = []
    if manifest.get('schema') != 1 or manifest.get('scope') != 'current-source-review':
        errors.append('alignment scope differs')
    if manifest.get('historical_build_verified') is not False:
        errors.append('historical build has no recorded binding')
    roots = {'paper': bundle, 'evidence': evidence_root, 'port': port_root}
    for group, root in roots.items():
        entries = manifest.get('files', {}).get(group, {})
        if not entries:
            errors.append(group + ': empty inventory')
        for name, expected in entries.items():
            path = Path(name)
            if path.is_absolute() or '..' in path.parts:
                errors.append(group + ': invalid relative path')
                continue
            target = root / path
            if target.is_symlink() or not target.is_file():
                errors.append(group + ': missing regular file: ' + name)
            elif file_digest(target) != expected:
                errors.append(group + ': reviewed bytes changed: ' + name)
    text = ' '.join((bundle / 'paper.md').read_text().split())
    for fragment in manifest.get('paper_fragments', []):
        if ' '.join(fragment.split()) not in text:
            errors.append('paper scope statement changed: ' + fragment)
    if not manifest.get('paper_fragments'):
        errors.append('paper scope statements missing')
    return errors


def locations(bundle):
    if bundle.name == 'paper':
        return bundle.parent / 'evidence', bundle.parent
    root = bundle.parents[2]
    return root, root.parent / 'kyoei-public'


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--port-root', type=Path)
    args = parser.parse_args()
    bundle = Path(__file__).resolve().parent
    evidence, port = locations(bundle)
    manifest = json.loads((bundle / 'alignment.json').read_text())
    errors = check_alignment(manifest, bundle, evidence, args.port_root or port)
    print(json.dumps({'source_review': 'drift' if errors else 'matched',
                      'historical_build_verified': False, 'failures': errors}, indent=2))
    return 1 if errors else 0


if __name__ == '__main__':
    raise SystemExit(main())
