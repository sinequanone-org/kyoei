import argparse
import hashlib
import json
import re
import sys
from collections import Counter
from pathlib import Path


class BindingError(Exception):
    pass


def sha256(data):
    return hashlib.sha256(data).hexdigest()


HEX64 = re.compile(r'^[0-9a-f]{64}$')


def bindings(evidence):
    """Path/digest pairs inside the copied evidence. 'ok' and 'stale' cover
    bound files inside the cut; 'outside' counts bound files not published."""
    out = Counter()
    stale = []
    target = evidence.parent
    snapshots = {}
    used = set()
    registry = evidence / 'binding-snapshots.json'

    def within_evidence(ref):
        if not isinstance(ref, str) or not ref or Path(ref).is_absolute() or '..' in Path(ref).parts:
            raise BindingError('invalid snapshot path')
        candidate = evidence / ref
        if not candidate.is_file() or candidate.is_symlink() or evidence.resolve() not in candidate.resolve().parents:
            raise BindingError('snapshot file missing or outside evidence: ' + ref)
        return candidate

    if registry.is_symlink():
        raise BindingError('binding registry is a symlink')
    if registry.exists():
        entries = json.loads(registry.read_text())
        if not isinstance(entries, list):
            raise BindingError('binding snapshots must be a list')
        for entry in entries:
            fields = {'origin', 'origin_sha256', 'path', 'sha256', 'snapshot'}
            if not isinstance(entry, dict) or set(entry) != fields or not all(isinstance(v, str) for v in entry.values()):
                raise BindingError('invalid binding snapshot entry')
            if not HEX64.fullmatch(entry['origin_sha256']) or not HEX64.fullmatch(entry['sha256']):
                raise BindingError('invalid binding snapshot digest')
            origin = within_evidence(entry['origin'])
            snapshot = within_evidence(entry['snapshot'])
            if sha256(origin.read_bytes()) != entry['origin_sha256'] or sha256(snapshot.read_bytes()) != entry['sha256']:
                raise BindingError('binding snapshot digest differs: ' + entry['origin'])
            key = (entry['origin'], entry['path'], entry['sha256'])
            if key in snapshots:
                raise BindingError('duplicate binding snapshot: ' + entry['origin'])
            snapshots[key] = snapshot

    def resolve(ref, origin):
        if Path(ref).is_absolute() or '..' in Path(ref).parts:
            raise BindingError('binding path must stay inside evidence')
        for candidate in (evidence / ref, origin.parent / ref):
            if candidate.is_file():
                if candidate.is_symlink() or evidence.resolve() not in candidate.resolve().parents:
                    raise BindingError('bound file is outside evidence or a symlink')
                return candidate
        return None

    def note(ref, digest, origin):
        if not isinstance(ref, str) or not HEX64.match(str(digest)) or '/' not in ref and '.' not in ref:
            return
        bound = resolve(ref, origin)
        key = (origin.relative_to(evidence).as_posix(), ref, digest)
        snapshot = snapshots.get(key)
        if snapshot is not None:
            if bound is not None and sha256(bound.read_bytes()) == digest:
                raise BindingError('unneeded binding snapshot: ' + key[0])
            used.add(key)
            out['archived'] += 1
            bound = snapshot
        if bound is None:
            out['outside'] += 1
        elif sha256(bound.read_bytes()) == digest:
            out['ok'] += 1
        else:
            out['stale'] += 1
            stale.append('%s -> %s' % (origin.relative_to(target).as_posix(), ref))

    def walk(value, origin):
        if isinstance(value, dict):
            if isinstance(value.get('path'), str) and isinstance(value.get('sha256'), str):
                note(value['path'], value['sha256'], origin)
            for key, item in value.items():
                if isinstance(item, str):
                    note(key, item, origin)
                elif isinstance(item, dict) and isinstance(item.get('sha256'), str):
                    note(key, item['sha256'], origin)
                walk(item, origin)
        elif isinstance(value, list):
            for item in value:
                walk(item, origin)

    for path in sorted(evidence.rglob('*')):
        if path == registry:
            continue
        if path.suffix in ('.json', '.sha256') and path.is_symlink():
            raise BindingError('evidence record is a symlink')
        if path.suffix == '.json':
            walk(json.loads(path.read_text()), path)
        elif path.suffix == '.sha256':
            note(path.with_suffix('.json').name, path.read_text().split()[0], path)
    if set(snapshots) != used:
        raise BindingError('unused binding snapshot')
    return dict(out), stale


def main(argv=None):
    parser = argparse.ArgumentParser(description='Verify published evidence digests and archived bindings.')
    parser.add_argument('--evidence', type=Path, default=Path(__file__).resolve().parent)
    args = parser.parse_args(argv)
    try:
        counts, stale = bindings(args.evidence.resolve())
        if not counts.get('ok'):
            raise BindingError('no verified evidence bindings')
        print(json.dumps({'bindings': counts, 'stale_bindings': stale}, indent=2))
        return 2 if stale else 0
    except (BindingError, OSError, ValueError, IndexError) as error:
        print('error: ' + str(error), file=sys.stderr)
        return 2


if __name__ == '__main__':
    sys.exit(main())
