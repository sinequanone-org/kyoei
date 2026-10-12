"""P1.7 step 4: one concurrent-throughput harness for every arm.

The contract's concurrent_throughput rule, with the operational choices it leaves open
frozen in research/experiments/p1-7-throughput/spec.json. Each cell builds a fresh
fixture with its arm's own driver (the e01-e18 prefix), enrolls one load actor per
client at C, and starts one worker process per actor. Every worker signs with its arm's
participant client library, warms up, waits at a barrier, then runs its measured
operations. B sits behind a byte-level proxy that waits the cell's issuer delay before
forwarding B's first response byte to any other institution. Smoke runs are diagnostic;
a measured Kyoei run refuses to start without a measured reference report under the
same spec.
"""
import argparse
import hashlib
import json
import math
import multiprocessing
import os
from pathlib import Path
import platform
import resource
import secrets
import shutil
import socket
import statistics
import subprocess
import sys
import tempfile
import threading
import time

from scripts.priority_one import EXPECTED_DIGEST, ROOT

SPEC = 'research/experiments/p1-7-throughput/spec.json'
ARMS = ('reference', 'kyoei-documents', 'kyoei-git')
WORKLOADS = ('retrieval-only', 'mixed')
CYCLE = ('retrieve', 'local-draft', 'retrieve', 'shared-draft-CAS')
ACTORS, DELAYS_MS, REPETITIONS = (1, 3, 9, 27), (0, 250), 5
WARMUP, MEASURED, TIMEOUT_MS = 5, 20, 5000
GROUP, RELEASE_CHUNK = 14, 16
# What load actors retrieve: B documents with no inputs, one per release of at most 16 actors. Kyoei binds B's
# release of b.result.v1 to the recipients of the A release B received (workspace_capture._release_terms), and a
# Kyoei recipient node keeps one recipient list per received artifact (workspace_capture._grants), so a second
# release of one artifact to other people at C for the same purpose is not honoured there. Both are recorded
# findings; one target per release keeps them out of the throughput cells, the same way in every arm.
TARGET, TARGET_TEXT = 'b.load.result', 'Aggregate released for the load cells; synthetic and unassessed.'


def target(index):
    return f'{TARGET}.{index // RELEASE_CHUNK + 1}'
PURPOSE = 'p1-investigation'
READY_SECONDS, RUN_SECONDS = 1200, 1800
# Fixture setup is outside the measured window; a setup refused under a host load spike is rebuilt fresh, at most
# this many times per cell and the same for every arm, and each failed attempt is recorded in the cell.
FIXTURE_ATTEMPTS = 3
CODE = ('scripts/p1_7_throughput.py', 'scripts/reference_deployment.py', 'scripts/reference_deployment_diagnostic.py',
        'scripts/reference_capture.py', 'scripts/reference_repair.py', 'scripts/reference_shared_draft.py',
        'scripts/reference_source.py', 'scripts/lifecycle_server.py', 'scripts/institution_server.py',
        'scripts/institution_identity.py', 'scripts/lifecycle_store.py', 'scripts/workspace_capture.py',
        'scripts/shared_draft.py', 'scripts/workspace_client.py', 'scripts/workspace_driver.py',
        'scripts/workspace_diagnostic.py', 'scripts/pq_crypto.py', 'scripts/git_source.py')


def load_actors(count):
    return [f'c.load{index:02d}' for index in range(1, count + 1)]


def groups(actors):
    """Draft groups of at most GROUP load actors; with a.lead each draft stays within 16 participants."""
    return [actors[start:start + GROUP] for start in range(0, len(actors), GROUP)]


def sequence(workload, count):
    if workload == 'retrieval-only':
        return ['retrieve'] * count
    if workload == 'mixed':
        return [CYCLE[index % len(CYCLE)] for index in range(count)]
    raise ValueError('unknown workload')


def nearest_rank(values, share):
    """Nearest-rank percentile: the ceil(share * n)-th smallest observation, None when empty."""
    if not values:
        return None
    ordered = sorted(values)
    return ordered[max(1, math.ceil(share * len(ordered))) - 1]


def cputime(text):
    """Seconds from ps's time column: [[days-]hours:]minutes:seconds[.fraction]."""
    days, _, rest = text.strip().rpartition('-')
    seconds = 0.0
    for part in rest.split(':'):
        seconds = seconds * 60 + float(part)
    return seconds + (int(days) * 86400 if days else 0)


def sample(pids):
    """Per-pid cumulative CPU seconds and current RSS in KiB, from one ps call."""
    if not pids:
        return {}
    done = subprocess.run(['ps', '-o', 'pid=,time=,rss=', '-p', ','.join(str(pid) for pid in pids)],
                          capture_output=True, text=True, timeout=30)
    found = {}
    for line in done.stdout.splitlines():
        parts = line.split()
        if len(parts) == 3:
            found[int(parts[0])] = dict(cpu=cputime(parts[1]), rss_kib=int(parts[2]))
    return found


class Pipe:
    """A byte-level proxy in front of one socket: waits `delay` seconds before B's first response byte.

    It parses nothing, so it fronts both arms' framings alike, and counts the connections
    and bytes it carried since the last reset. One connection carries one request in both arms.
    """

    def __init__(self, path, target):
        self.path, self.target, self.delay = path, target, 0.0
        self.stop, self.lock, self.threads = threading.Event(), threading.Lock(), []
        self.connections = self.sent = self.received = 0
        self.listener = socket.socket(socket.AF_UNIX, socket.SOCK_STREAM)
        self.listener.bind(path)
        self.listener.listen(256)
        self.listener.settimeout(0.2)
        self.thread = threading.Thread(target=self._listen, daemon=True)
        self.thread.start()

    def reset(self):
        with self.lock:
            counts = dict(connections=self.connections, request_bytes=self.sent, response_bytes=self.received)
            self.connections = self.sent = self.received = 0
        return counts

    def _count(self, name, amount):
        with self.lock:
            setattr(self, name, getattr(self, name) + amount)

    def _pump(self, source, sink, name, first_delay):
        delayed = first_delay is None
        try:
            while True:
                chunk = source.recv(65536)
                if not chunk:
                    break
                if not delayed:
                    time.sleep(first_delay)
                    delayed = True
                sink.sendall(chunk)
                self._count(name, len(chunk))
        except OSError:
            pass
        finally:
            for end in (sink,):
                try:
                    end.shutdown(socket.SHUT_WR)
                except OSError:
                    pass

    def _forward(self, client):
        upstream = socket.socket(socket.AF_UNIX, socket.SOCK_STREAM)
        try:
            upstream.connect(self.target)
        except OSError:
            client.close()
            upstream.close()
            return
        self._count('connections', 1)
        delay = self.delay
        out = threading.Thread(target=self._pump, args=(client, upstream, 'sent', None), daemon=True)
        out.start()
        self._pump(upstream, client, 'received', delay)
        out.join()
        client.close()
        upstream.close()

    def _listen(self):
        while not self.stop.is_set():
            try:
                client, _ = self.listener.accept()
            except socket.timeout:
                continue
            except OSError:
                break
            worker = threading.Thread(target=self._forward, args=(client,), daemon=True)
            worker.start()
            self.threads = [thread for thread in self.threads if thread.is_alive()] + [worker]

    def close(self):
        self.stop.set()
        self.thread.join()
        self.listener.close()
        for worker in self.threads:
            worker.join(timeout=10)


def _texts(actor, count, kind):
    return [f'{kind} {index} by {actor}: synthetic load text, unassessed.' for index in range(count)]


# ---------------------------------------------------------------------------------------------- reference arm

class ReferenceArm:
    """The reference deployment, built by its own diagnostic operator with the load actors added at setup."""

    name = 'reference'

    def __init__(self, work, source_mode='git'):
        from scripts import reference_deployment_diagnostic as rdd
        self.rdd, self.work, self.source_mode = rdd, Path(work), source_mode
        self.op, self.pipes = None, []

    def build(self, count):
        rdd = self.rdd
        from scripts.pq_crypto import SigningKey
        from scripts.reference_deployment import Client
        scenario = json.loads((ROOT / rdd.SCENARIO).read_text())
        root = self.work / 'reference'
        root.mkdir(mode=0o700)
        op = self.op = rdd.Operator(root, scenario, self.source_mode)
        actors = load_actors(count)
        for actor in actors:
            op.actors[actor] = 'human'
            op.keys[actor] = SigningKey.generate()
            op.clients[actor] = Client(op.sockets['c']['client'], deployment=rdd.DEPLOYMENT, actor=actor,
                                       key=op.keys[actor], clock=lambda: op.now)
        # A and C reach B's peer socket only through the proxy; B binds the real one.
        proxied = str(root / 'bp.peer')
        self.pipes = [Pipe(proxied, op.sockets['b']['peer'])]
        for institution, administrator in rdd.ADMINISTRATORS.items():
            sockets = {key: dict(value) for key, value in op.sockets.items()}
            if institution != 'b':
                sockets['b']['peer'] = proxied
            op.nodes[institution] = rdd.Process(root, institution, dict(at=op.now, node=dict(
                deployment=rdd.DEPLOYMENT, administrator=administrator, administrator_public=op.public(administrator),
                enrolled_until=rdd.ENROLLED, purpose=rdd.PURPOSE, expires=rdd.EXPIRES, sockets=sockets)))
        pins = {institution: node.public for institution, node in op.nodes.items()}
        rdd.configure(op, pins)
        rdd.foundation(op, scenario)
        self._prefix(op)
        for start in range(0, count, RELEASE_CHUNK):
            alias = target(start)
            op.publish('setup', 'b.steward', alias, dict(title=alias, body=TARGET_TEXT), expires=rdd.LONG)
            op.release('setup', 'b.steward', alias, actors[start:start + RELEASE_CHUNK])
        drafts = self._drafts(op, actors)
        failed = [item['label'] for item in op.trace if not item['held']]
        if failed:
            raise RuntimeError('reference fixture: unexpected outcomes at ' + ', '.join(failed[:8]))
        plans = []
        for index, actor in enumerate(actors):
            plans.append(dict(arm=self.name, actor=actor, key=op.keys[actor].private_bytes_raw().hex(),
                              client=op.sockets['c']['client'], deployment=rdd.DEPLOYMENT, now=op.now,
                              artifact=op.ids[target(index)], draft=drafts[index // GROUP],
                              source=self.source_mode,
                              expires=rdd.LONG))
        return plans

    def _prefix(self, op):
        """e15-e18 exactly as rdd.lifecycle runs them; the rest of the lifecycle is not part of the fixture."""
        rdd = self.rdd
        op.at(op.events['e15']['at'])
        op.release('e15', 'a.lead', 'a.question', ['b.researcher', 'c.specialist'])
        op.release('e15', 'c.specialist', 'c.reproduction', ['a.lead', 'b.researcher'])
        op.release('e15', 'a.lead', 'a.challenge', ['b.researcher', 'c.specialist'])
        context = op.context('e15', 'a.lead', 'e15:gather')
        for alias, owner in (('b.result.v1', 'b'), ('c.reproduction', 'c')):
            op.read('e15', 'a.lead', context, alias, owner)
        rdd.joint(op, 'v1', [('a.question', 'a'), ('a.method', 'a'), ('b.result.v1', 'b'), ('c.analysis.v1', 'c'),
                             ('a.challenge', 'a'), ('c.reproduction', 'c')], 'e15', 'e16')
        op.at(op.events['e17']['at'])
        op.publish('e17', 'c.specialist', 'c.unrelated', rdd.body(op, 'c.unrelated'), expires=rdd.LONG)
        op.at(op.events['e18']['at'])
        op.use('e18', 'c.specialist', 'joint.output.v1', 'a')
        op.use('e18', 'c.specialist', 'c.unrelated')

    def _drafts(self, op, actors):
        from scripts.reference_shared_draft import ZERO, draft_id
        drafts = []
        for number, group in enumerate(groups(actors), 1):
            terms = dict(name=f'load-{number}', participants=sorted(['a.lead', *group]), purpose=self.rdd.PURPOSE,
                         expires=self.rdd.EXPIRES)
            draft = draft_id('a', 'a.lead', terms)
            op.draft('setup', f'setup:load-draft-{number}', 'a.lead', draft, 'open', terms)
            base = (op.draft('setup', f'setup:load-head-{number}', 'a.lead', draft, 'head', {}) or {}).get('head', ZERO)
            op.draft('setup', f'setup:load-revise-{number}', 'a.lead', draft, 'revise',
                     dict(base=base, document=dict(text=f'Load draft {number}.'), inputs=[]))
            drafts.append(draft)
        return drafts

    def prepare(self, plan, kinds):
        """Untimed: the participant's Git commits for its local drafts, written before the barrier."""
        texts = _texts(plan['actor'], kinds.count('local-draft'), 'local draft')
        values = [dict(title=f"load.{plan['actor']}.{index}", body=text) for index, text in enumerate(texts)]
        claims = []
        for index, value in enumerate(values):
            if self.source_mode == 'documents':
                claims.append(None)
                continue
            from scripts.research_evidence import canonical
            path = 'load-%s-%04d.json' % (plan['actor'].replace('.', '-'), index)
            commit = self.rdd.commit_loose(str(self.op.root / 'c' / 'source.git'), path, canonical(value))
            claims.append(dict(kind='git', repository=self.rdd.REPOSITORY % ('c', 'c'), commit=commit, path=path))
        return dict(plan, values=values, claims=claims)

    def pids(self):
        return [node.process.pid for node in self.op.nodes.values()] if self.op else []

    def close(self):
        try:
            if self.op is not None:
                self.op.close()
        finally:
            for pipe in self.pipes:
                pipe.close()


class ReferenceActor:
    def __init__(self, plan):
        from scripts.pq_crypto import SigningKey
        from scripts.reference_capture import request as capture_request
        from scripts.reference_deployment import Client, request as deployment_request
        from scripts.reference_local_first import Refusal
        from scripts.reference_shared_draft import request as draft_request
        from scripts.research_evidence import canonical
        self.plan, self.refusal, self.canonical = plan, Refusal, canonical
        self.capture_request, self.deployment_request, self.draft_request = (capture_request, deployment_request,
                                                                              draft_request)
        self.key = SigningKey.from_private_bytes(bytes.fromhex(plan['key']))
        self.client = Client(plan['client'], deployment=plan['deployment'], actor=plan['actor'], key=self.key,
                             clock=lambda: plan['now'])
        self.values, self.claims, self.revisions = list(plan['values']), list(plan['claims']), 0

    def open(self):
        name = 'load-' + secrets.token_hex(8)
        self.client.send('capture', self.client.sign(self.capture_request, 'open', context=name, purpose=PURPOSE,
                                                     delegation=None))
        return name

    def retrieve(self, context):
        self.client.send('capture', self.client.sign(self.capture_request, 'read', context=context,
                                                     artifact=self.plan['artifact'], owner='b', authorization=None))

    def local_draft(self, context):
        value, claim = self.values.pop(0), self.claims.pop(0)
        if claim is None:
            claim = dict(kind='document', sha256=hashlib.sha256(self.canonical(value)).hexdigest())
        envelope = self.capture_request(self.key, deployment=self.plan['deployment'], actor=self.plan['actor'],
                                        operation='publish', issued=self.plan['now'],
                                        arguments=dict(context=context, value=value, expires=self.plan['expires'],
                                                       readers=[], authorization=None))
        self.client.deployment_request('publish', envelope=envelope, source=claim, private=False)

    def _draft(self, operation, arguments):
        inner = self.draft_request(self.key, deployment=self.plan['deployment'], actor=self.plan['actor'],
                                   artifact=self.plan['draft'], operation=operation, arguments=arguments,
                                   issued=self.plan['now'])
        return self.client.deployment_request('draft', host='a', envelope=inner)

    def cas(self):
        self.revisions += 1
        head = self._draft('head', {})['head']
        text = f"Revision {self.revisions} by {self.plan['actor']} {secrets.token_hex(4)}."
        self._draft('revise', dict(base=head, document=dict(text=text), inputs=[]))

    def outcome(self, exc):
        return exc.code if isinstance(exc, self.refusal) else None


# ---------------------------------------------------------------------------------------------- Kyoei arms

class KyoeiArm:
    """Three lifecycle nodes driven through e01-e18 by the P1.5 driver, then the load actors."""

    def __init__(self, work, source):
        from scripts import workspace_diagnostic as base
        self.base, self.work, self.source, self.name = base, Path(work), source, 'kyoei-' + source
        self.processes, self.pipes, self.controls, self.sources, self.setup = {}, [], {}, None, None

    def _start(self, institution, administrator_public, public_socket, peers):
        base = self.base
        directory = self.work / 'nodes' / institution
        config = dict(deployment=base.DEPLOYMENT, peer=institution, host=f'node.{institution}',
                      scope={'reviewer': 'institution-credential-key'}, administrator=base.ADMINISTRATORS[institution],
                      administrator_public=administrator_public, key_expires=base.KEY_EXPIRES, max_age=base.MAX_AGE,
                      database=str(directory / 'node.sqlite'), custody=str(directory / 'custody'),
                      public_socket=public_socket, control_socket=self.controls[institution], peers=peers,
                      simulation=True, create_custody=True, now=base.START)
        path = directory / 'config.json'
        base._private(path, json.dumps(config, sort_keys=True).encode())
        with open(self.work / 'logs' / f'{institution}.err', 'wb') as log:
            return subprocess.Popen([sys.executable, '-m', 'scripts.lifecycle_server', '--config', str(path)],
                                    cwd=ROOT, stdin=subprocess.DEVNULL, stdout=subprocess.PIPE, stderr=log)

    def build(self, count):
        from scripts.context_shards import digest
        from scripts.node_wire import call
        from scripts.priority_one import BASE, verify
        from scripts.task_data import require
        from scripts.workspace_client import Workspace
        base, work = self.base, self.work
        verify()
        scenario = json.loads((ROOT / BASE / 'scenario.json').read_text())
        actors = {actor['id']: actor['kind'] for actor in scenario['actors']}
        for name in ('nodes', 's', 'homes', 'inbox', 'logs'):
            (work / name).mkdir(mode=0o700)
        for institution in base.ADMINISTRATORS:
            (work / 'nodes' / institution).mkdir(mode=0o700)
            (work / 'inbox' / institution).mkdir(mode=0o700)
        real = {institution: str(work / 's' / (institution + '.pub')) for institution in base.ADMINISTRATORS}
        self.controls = {institution: str(work / 's' / (institution + '.ctl')) for institution in base.ADMINISTRATORS}
        # Every path to B but B's own runs through the proxy pair (public socket and status socket).
        nodes = dict(real, b=str(work / 's' / 'bp.pub'))
        self.pipes = [Pipe(nodes['b'], real['b']), Pipe(nodes['b'] + '.s', real['b'] + '.s')]
        rows = json.dumps(scenario['private_tables']['b.table.v1'], sort_keys=True)
        changed = json.dumps(scenario['private_tables']['b.table.v2'], sort_keys=True)
        self.sources = base._Sources(work, self.source, actors, rows, changed)
        note = work / 'inbox' / 'a' / base.NOTE_LABEL
        base._private(note, base.NOTE.encode())
        publics = {node: base._administrator(work, actor, nodes) for node, actor in base.ADMINISTRATORS.items()}
        keys = {}
        for institution in base.ADMINISTRATORS:
            peers = {peer: path for peer, path in nodes.items() if peer != institution}
            self.processes[institution] = self._start(institution, publics[institution], real[institution], peers)
        for institution, process in self.processes.items():
            ready = base._Lines(process.stdout, time.monotonic() + 60).next()
            require(ready.get('ready') is True, 'node did not start')
            keys[institution] = ready['public']
        agreement = scenario['agreement']
        setup = dict(root=str(ROOT), run=str(work), deployment=base.DEPLOYMENT, nodes=nodes, institution_keys=keys,
                     administrators=base.ADMINISTRATORS, actors=actors,
                     homes={actor: str(work / 'homes' / actor) for actor in actors}, purpose=scenario['purpose'],
                     agreement=dict(agreement=base.AGREEMENT, version=agreement['version'], terms=digest(agreement),
                                    expires=agreement['expires']),
                     key_expires=base.KEY_EXPIRES, enrolled_until=base.ENROLLED_UNTIL,
                     content={node['id']: node['content'] for node in scenario['nodes']},
                     events={event['id']: {name: event[name] for name in ('at', 'actor', 'expected')}
                             for event in scenario['events']},
                     start=base.START, probe=base.PROBE, expired=base.EXPIRED, source=self.source,
                     inputs=dict(table=self.sources.table_input, note=dict(label=base.NOTE_LABEL, path=str(note))),
                     drafts=True)
        if self.source == 'git':
            setup['git'] = self.sources.git
        self.setup = setup
        output, code, guard, _clock = base._drive(work, setup, self.controls, time.monotonic() + 1800,
                                                  self.sources.answer)
        require(code == 0 and 'error' not in output, f"driver: {output.get('error')}; {guard[-300:]}")
        wrong = [item['label'] for item in output['transcript'] if item['expected'] != item['outcome']]
        require(not wrong, 'kyoei fixture: unexpected outcomes at ' + ', '.join(wrong[:8]))
        aliases = output['aliases']
        load = load_actors(count)
        steward = Workspace(work / 'homes' / 'b.steward', simulation=True)
        administrator = Workspace(work / 'homes' / 'c.specialist', simulation=True)
        lead = Workspace(work / 'homes' / 'a.lead', simulation=True)
        for actor in load:
            home = Workspace.create(work / 'homes' / actor, deployment=base.DEPLOYMENT, actor=actor, nodes=nodes,
                                    simulation=True)
            administrator.act('enroll', dict(actor=actor, kind='human', public=home.profile['public'],
                                             expires=base.ENROLLED_UNTIL))
        terms = dict(purpose=scenario['purpose'], expires=agreement['expires'], agreement=base.AGREEMENT)
        targets = {}
        for start in range(0, count, RELEASE_CHUNK):
            context = steward.act('open', dict(purpose=PURPOSE, name=secrets.token_hex(8)))
            targets[target(start)] = steward.act('publish', dict(
                document=_document(TARGET_TEXT, target(start)), purpose=PURPOSE, recipients=['b.steward'],
                expires=agreement['expires'], context=context))
            steward.act('release', dict(artifact=targets[target(start)],
                                        recipients=sorted(load[start:start + RELEASE_CHUNK]), delegates=False, **terms))
        drafts = []
        for number, group in enumerate(groups(load), 1):
            draft = lead.act('draft_open', dict(name=f'load-{number}', participants=sorted({'a.lead', *group}), **terms))
            lead.act('draft_revise', dict(draft=draft, base=draft, document=_document(f'Load draft {number}.')))
            drafts.append(draft)
        now = call(nodes['c'], dict(op='time'))['result']
        return [dict(arm=self.name, actor=actor, home=str(work / 'homes' / actor), now=now,
                     artifact=targets[target(index)], draft=drafts[index // GROUP], source=self.source,
                     expires=agreement['expires'], git=self.sources.git.get('c'))
                for index, actor in enumerate(load)]

    def prepare(self, plan, kinds):
        """Untimed: the participant's own Git commits, made before the barrier as Git work outside Kyoei."""
        texts = _texts(plan['actor'], kinds.count('local-draft'), 'local draft')
        commits = []
        for index, text in enumerate(texts):
            if self.source == 'documents':
                commits.append(None)
                continue
            from scripts import git_fixture
            path = 'contributions/load-%s-%04d.md' % (plan['actor'].replace('.', '-'), index)
            commit = git_fixture.commit(self.sources.worktree('c'), {path: text.encode()}, 'Add ' + path,
                                        home=self.sources.home, actor=plan['actor'])
            commits.append(dict(commit=commit, path=path))
        return dict(plan, texts=texts, commits=commits)

    def pids(self):
        return [process.pid for process in self.processes.values()]

    def close(self):
        from scripts.node_wire import call
        try:
            for institution, process in self.processes.items():
                try:
                    call(self.controls[institution], dict(op='stop'))
                except (OSError, ValueError):
                    pass
                try:
                    process.wait(60)
                except subprocess.TimeoutExpired:
                    process.kill()
                    process.wait()
                process.stdout.close()
        finally:
            for pipe in self.pipes:
                pipe.close()


def _document(text, title='load.draft'):
    return dict(contribution_type='analysis', title=title, body=text, uncertainty='Synthetic load; unassessed.',
                evidence=[], attachments=[])


class KyoeiActor:
    def __init__(self, plan):
        from scripts.workspace_client import Refused, Workspace

        class Clocked(Workspace):
            """The participant client with the harness's simulated clock, as the reference client takes it."""

            def now(self, institution):
                return plan['now']

        self.plan, self.refusal = plan, Refused
        self.workspace = Clocked(plan['home'], simulation=True)
        self.texts, self.commits, self.revisions, self.published = list(plan['texts']), list(plan['commits']), 0, 0

    def open(self):
        return self.workspace.act('open', dict(purpose=PURPOSE, name=secrets.token_hex(8)))

    def retrieve(self, context):
        self.workspace.owner_read(context, 'b', self.plan['artifact'], PURPOSE)

    def local_draft(self, context):
        from scripts.git_source import locator, read_file
        from scripts.workspace_client import MAX_FILE
        text, committed = self.texts.pop(0), self.commits.pop(0)
        self.published += 1
        arguments = dict(purpose=PURPOSE, recipients=[self.plan['actor']], expires=self.plan['expires'],
                         context=context)
        if committed is not None:
            git = self.plan['git']
            raw, found = read_file(git['git_dir'], committed['commit'], committed['path'], limit=MAX_FILE)
            text = raw.decode('utf-8')
            arguments['source'] = locator(git['repository'], committed['commit'], tree=found['tree'],
                                          file=committed['path'], blob=found['blob'], mode=found['mode'])
        arguments['document'] = _document(text, f"load.{self.plan['actor']}.{self.published}")
        self.workspace.act('publish', arguments)

    def cas(self):
        self.revisions += 1
        draft = self.plan['draft']
        head = self.workspace.act('draft_head', dict(draft=draft), institution='a')['head']
        text = f"Revision {self.revisions} by {self.plan['actor']} {secrets.token_hex(4)}."
        self.workspace.act('draft_revise', dict(draft=draft, base=head, document=_document(text)), institution='a')

    def outcome(self, exc):
        return exc.code.partition(':')[0] if isinstance(exc, self.refusal) else None


# ---------------------------------------------------------------------------------------------- one cell

def _attempt(actor, kind, contexts):
    started = time.perf_counter_ns()
    try:
        if kind == 'retrieve':
            actor.retrieve(contexts.pop(0))
        elif kind == 'local-draft':
            actor.local_draft(contexts.pop(0))
        else:
            actor.cas()
        outcome = 'allowed'
    except Exception as exc:  # every outcome is recorded; none is retried or dropped
        outcome = actor.outcome(exc) or 'client-' + type(exc).__name__
    return dict(kind=kind, outcome=outcome, started_ns=started, done_ns=time.perf_counter_ns())


def worker(plan, workload, warmup, measured, barrier, queue):
    """One participant process: its own client, its contexts, warm-up, the barrier, then measured operations."""
    try:
        actor = ReferenceActor(plan) if plan['arm'] == 'reference' else KyoeiActor(plan)
        kinds = sequence(workload, warmup + measured)
        contexts = [actor.open() for kind in kinds if kind != 'shared-draft-CAS']
        warm = [_attempt(actor, kind, contexts) for kind in kinds[:warmup]]
        queue.put(('ready', plan['actor'], None))
        barrier.wait(timeout=READY_SECONDS)
        before = resource.getrusage(resource.RUSAGE_SELF)
        records = [_attempt(actor, kind, contexts) for kind in kinds[warmup:]]
        after = resource.getrusage(resource.RUSAGE_SELF)
        queue.put(('done', plan['actor'], dict(
            records=records, warmup=[item['outcome'] for item in warm],
            cpu_seconds=round(after.ru_utime + after.ru_stime - before.ru_utime - before.ru_stime, 6),
            maxrss=after.ru_maxrss)))
    except Exception as exc:
        try:
            barrier.abort()
        except Exception:
            pass
        queue.put(('error', plan['actor'], f'{type(exc).__name__}: {exc}'[:300]))


def summarize(records, wall_ns, timeout_ms=TIMEOUT_MS):
    """The contract's cell values from every measured record; nothing is dropped."""
    limit = timeout_ms * 1_000_000
    classified = []
    for item in records:
        latency = item['done_ns'] - item['started_ns']
        outcome = 'timeout' if latency > limit else item['outcome']
        classified.append((item['kind'], outcome, latency))
    successful = [latency for _, outcome, latency in classified if outcome == 'allowed']
    outcomes = {}
    for kind, outcome, _ in classified:
        outcomes.setdefault(kind, {}).setdefault(outcome, 0)
        outcomes[kind][outcome] += 1
    seconds = wall_ns / 1e9 if wall_ns > 0 else None
    per_kind = {}
    for kind in sorted({kind for kind, _, _ in classified}):
        mine = [(outcome, latency) for k, outcome, latency in classified if k == kind]
        good = [latency for outcome, latency in mine if outcome == 'allowed']
        per_kind[kind] = dict(attempted=len(mine), successful=len(good),
                              p50_ns=nearest_rank(good, 0.50), p95_ns=nearest_rank(good, 0.95))
    return dict(
        wall_ns=wall_ns, attempted=len(classified), successful=len(successful),
        successful_per_second=round(len(successful) / seconds, 4) if seconds else None,
        attempted_per_second=round(len(classified) / seconds, 4) if seconds else None,
        conflicts=sum(outcome == 'stale-base' for _, outcome, _ in classified),
        timeouts=sum(outcome == 'timeout' for _, outcome, _ in classified),
        errors=sum(outcome not in ('allowed', 'stale-base', 'timeout') for _, outcome, _ in classified),
        latency_all_ns=dict(p50=nearest_rank([lat for *_, lat in classified], 0.50),
                            p95=nearest_rank([lat for *_, lat in classified], 0.95)),
        latency_successful_ns=dict(p50=nearest_rank(successful, 0.50), p95=nearest_rank(successful, 0.95)),
        outcomes=outcomes, per_kind=per_kind)


def arm_for(name, work):
    if name == 'reference':
        return ReferenceArm(work, 'git')
    if name in ('kyoei-documents', 'kyoei-git'):
        return KyoeiArm(work, name.split('-', 1)[1])
    raise ValueError('unknown arm')


class FixtureError(RuntimeError):
    """The cell's fixture could not be built; nothing was measured."""


def cell(arm_name, workload, actors, delay_ms, *, warmup=WARMUP, measured=MEASURED, timeout_ms=TIMEOUT_MS):
    """One cell on a fresh fixture in a new directory; the fixture is discarded afterwards."""
    started = time.perf_counter()
    with tempfile.TemporaryDirectory(prefix='p17t-', dir='/tmp') as work:
        os.chmod(work, 0o700)
        arm = arm_for(arm_name, work)
        processes = []
        try:
            try:
                plans = arm.build(actors)
            except Exception as exc:
                raise FixtureError(f'{type(exc).__name__}: {str(exc)[:300]}') from exc
            kinds = sequence(workload, warmup + measured)
            plans = [arm.prepare(plan, kinds) for plan in plans]
            built = time.perf_counter() - started
            for pipe in arm.pipes:
                pipe.delay = delay_ms / 1000
            context = multiprocessing.get_context('spawn')
            barrier, queue = context.Barrier(actors + 1), context.Queue()
            processes = [context.Process(target=worker, args=(plan, workload, warmup, measured, barrier, queue))
                         for plan in plans]
            for process in processes:
                process.start()
            ready, errors = 0, []
            deadline = time.monotonic() + READY_SECONDS
            while ready < actors and not errors:
                kind, actor, value = queue.get(timeout=max(1, deadline - time.monotonic()))
                if kind == 'ready':
                    ready += 1
                else:
                    errors.append(f'{actor}: {value}')
            if errors:
                raise RuntimeError('worker failed before the barrier: ' + '; '.join(errors))
            for pipe in arm.pipes:
                pipe.reset()
            pids = arm.pids()
            nodes_before = sample(pids)
            load = os.getloadavg()
            barrier.wait(timeout=READY_SECONDS)
            start_ns = time.perf_counter_ns()
            results, deadline = {}, time.monotonic() + RUN_SECONDS
            while len(results) < actors:
                kind, actor, value = queue.get(timeout=max(1, deadline - time.monotonic()))
                if kind != 'done':
                    raise RuntimeError(f'worker {actor} failed: {value}')
                results[actor] = value
            nodes_after = sample(pids)
            issuer = [pipe.reset() for pipe in arm.pipes]
            records = [record for value in results.values() for record in value['records']]
            end_ns = max(record['done_ns'] for record in records)
            report = summarize(records, end_ns - start_ns, timeout_ms)
            report['refusals_by_actor'] = {actor: tally for actor, tally in sorted(
                (actor, _tally(item['outcome'] for item in value['records'] if item['outcome'] != 'allowed'))
                for actor, value in results.items()) if tally}
            report.update(
                arm=arm_name, workload=workload, actors=actors, issuer_delay_ms=delay_ms, warmup=warmup,
                measured=measured, fixture_seconds=round(built, 3), cell_seconds=round(time.perf_counter() - started, 3),
                warmup_outcomes=_tally(outcome for value in results.values() for outcome in value['warmup']),
                worker_cpu_seconds=round(sum(value['cpu_seconds'] for value in results.values()), 6),
                worker_maxrss=dict(max=max(value['maxrss'] for value in results.values()),
                                   unit='bytes' if sys.platform == 'darwin' else 'KiB', method='getrusage ru_maxrss'),
                node_cpu_seconds=round(sum(nodes_after[pid]['cpu'] - nodes_before[pid]['cpu']
                                           for pid in pids if pid in nodes_after and pid in nodes_before), 3),
                node_rss_kib=dict(sum=sum(nodes_after[pid]['rss_kib'] for pid in pids if pid in nodes_after),
                                  method='ps rss at end of window, not a peak'),
                issuer=dict(connections=sum(item['connections'] for item in issuer),
                            request_bytes=sum(item['request_bytes'] for item in issuer),
                            response_bytes=sum(item['response_bytes'] for item in issuer)),
                load_average_at_start=[round(value, 2) for value in load],
                load_average_at_end=[round(value, 2) for value in os.getloadavg()])
            return report
        finally:
            for process in processes:
                process.join(timeout=30)
                if process.is_alive():
                    process.terminate()
                    process.join(10)
            arm.close()


def _tally(values):
    found = {}
    for value in values:
        found[value] = found.get(value, 0) + 1
    return found


# ---------------------------------------------------------------------------------------------- runs

def spec_digest():
    return hashlib.sha256((ROOT / SPEC).read_bytes()).hexdigest()


def frozen_digest():
    return (ROOT / SPEC).with_suffix('.sha256').read_text().split()[0]


def sources():
    return {path: hashlib.sha256((ROOT / path).read_bytes()).hexdigest() for path in CODE}


def check_order(arm, measured, reference):
    """A measured Kyoei run starts only after a complete measured reference run under the same spec."""
    if not measured:
        return
    if spec_digest() != frozen_digest():
        raise ValueError('the throughput spec differs from its frozen digest')
    if arm == 'reference':
        return
    if reference is None:
        raise ValueError('a measured Kyoei run needs the measured reference report first')
    report = json.loads(Path(reference).read_text())
    expected = {(workload, actors, delay) for workload in WORKLOADS for actors in ACTORS for delay in DELAYS_MS}
    found = {(item['workload'], item['actors'], item['issuer_delay_ms']) for item in report.get('cells', [])}
    if (report.get('arm') != 'reference' or report.get('measured') is not True or
            report.get('spec_digest') != frozen_digest() or report.get('repetitions') != REPETITIONS or
            not expected <= found):
        raise ValueError('the reference report is not a complete measured run under this spec')


def medians(cells):
    grouped = {}
    for item in cells:
        grouped.setdefault((item['workload'], item['actors'], item['issuer_delay_ms']), []).append(item)
    summary = []
    for (workload, actors, delay), items in sorted(grouped.items()):
        values = [item['successful_per_second'] for item in items]
        p95 = [item['latency_successful_ns']['p95'] for item in items]
        summary.append(dict(workload=workload, actors=actors, issuer_delay_ms=delay, repetitions=len(items),
                            successful_per_second=values,
                            median_successful_per_second=statistics.median(values) if None not in values else None,
                            median_successful_p95_ns=statistics.median(p95) if None not in p95 else None,
                            conflicts=[item['conflicts'] for item in items],
                            errors=[item['errors'] for item in items], timeouts=[item['timeouts'] for item in items]))
    return summary


def run(arm, *, measured, repetitions, workloads, actors, delays, reference=None, warmup=WARMUP,
        operations=MEASURED, progress=None):
    check_order(arm, measured, reference)
    if measured and (repetitions, tuple(workloads), tuple(actors), tuple(delays), warmup, operations) != (
            REPETITIONS, WORKLOADS, ACTORS, DELAYS_MS, WARMUP, MEASURED):
        raise ValueError('a measured run uses the frozen cell set')
    started, cells = time.strftime('%Y-%m-%dT%H:%M:%S%z'), []
    for repetition in range(1, repetitions + 1):
        for workload in workloads:
            for delay in delays:
                for count in actors:
                    failures = []
                    while True:
                        try:
                            result = cell(arm, workload, count, delay, warmup=warmup, measured=operations)
                            break
                        except FixtureError as exc:
                            failures.append(dict(error=str(exc), load_average=[round(value, 2)
                                                                                for value in os.getloadavg()]))
                            if len(failures) >= FIXTURE_ATTEMPTS:
                                raise
                    result['fixture_attempts'] = len(failures) + 1
                    result['fixture_failures'] = failures
                    result['repetition'] = repetition
                    cells.append(result)
                    if progress:
                        progress(result)
    return dict(kind='p1-7-throughput-run', arm=arm, measured=measured, diagnostic=not measured,
                enters_a_measure=measured, spec=SPEC, spec_digest=spec_digest(), contract_digest=EXPECTED_DIGEST,
                reference_report=reference, repetitions=repetitions, started=started,
                finished=time.strftime('%Y-%m-%dT%H:%M:%S%z'), sources=sources(),
                environment=dict(python=platform.python_version(), platform=platform.platform(),
                                 cpus=os.cpu_count()),
                summary=medians(cells), cells=cells)


def main():
    parser = argparse.ArgumentParser(description='P1.7 step 4: the shared concurrent-throughput harness.')
    parser.add_argument('--arm', choices=ARMS, required=True)
    parser.add_argument('--output', type=Path, required=True)
    parser.add_argument('--measured', action='store_true', help='the frozen cell set; enters the measure')
    parser.add_argument('--reference', help='measured reference report (required for a measured Kyoei run)')
    parser.add_argument('--repetitions', type=int, default=1)
    parser.add_argument('--workload', choices=WORKLOADS, action='append')
    parser.add_argument('--actors', type=int, choices=ACTORS, action='append')
    parser.add_argument('--delay', type=int, choices=DELAYS_MS, action='append')
    parser.add_argument('--warmup', type=int, default=WARMUP)
    parser.add_argument('--operations', type=int, default=MEASURED)
    args = parser.parse_args()
    if shutil.which('ps') is None:
        parser.error('ps is required for node CPU sampling')

    def progress(item):
        print(json.dumps(dict(repetition=item['repetition'], workload=item['workload'], actors=item['actors'],
                              delay=item['issuer_delay_ms'], per_second=item['successful_per_second'],
                              errors=item['errors'], conflicts=item['conflicts'], timeouts=item['timeouts'],
                              fixture=item['fixture_seconds'])), flush=True)
    report = run(args.arm, measured=args.measured, repetitions=REPETITIONS if args.measured else args.repetitions,
                 workloads=args.workload or list(WORKLOADS), actors=args.actors or list(ACTORS),
                 delays=args.delay or list(DELAYS_MS), reference=args.reference, warmup=args.warmup,
                 operations=args.operations, progress=progress)
    args.output.parent.mkdir(parents=True, exist_ok=True)
    args.output.write_text(json.dumps(report, indent=1, sort_keys=True) + '\n')
    return 0


if __name__ == '__main__':
    raise SystemExit(main())
