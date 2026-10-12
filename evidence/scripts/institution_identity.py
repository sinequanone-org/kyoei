"""Institution-signed actor identity for Priority 1 nodes (P1.1, enabling).

A node signs its own actors' credentials with the institution key held in its
custody. Every write is a request naming actor, node, operation and expiry, signed
with the actor's current key, so one identity covers contribution, delegation,
release and withdrawal. A peer's actor is checked against a credential its home node
serves. Peer fetches run with the write lock released and are then checked inside the
request's transaction, so a slow peer delays only the requests that need it. Signatures authenticate keys and requests; they establish
neither expertise nor legal authority, and one operator still runs every node.
"""
from contextlib import contextmanager
import json
import threading

from cryptography.exceptions import InvalidSignature
from scripts.pq_crypto import VerifyingKey, PUBLIC_HEX, SIGNATURE_HEX

from scripts.actor_request import REQUEST, REQUEST_FIELDS, sign_request
from scripts.context_shards import digest, hash_value, identifier, integer
from scripts.contributions import ContributionStore, validate_document
from scripts.research_evidence import canonical
from scripts.review_verdict import MAX_BYTES, MAX_TIME, ReviewStore, bounded_list
from scripts.task_data import require

CREDENTIAL = 'kyoei-actor-credential-ml-dsa-65-v1'
KINDS = ('human', 'agent')
DELEGABLE = ('derive', 'retrieve')
MAX_WINDOW = 300
REQUEST_BYTES = MAX_BYTES + 16384
# A request reruns after each peer fetch. Rounds that fetch something new are bounded by what the largest
# accepted request can need (16 recipients' credentials, the actor's, status batches); rounds that only
# refetch keys already fetched are bounded separately.
FETCH_ROUNDS, FETCH_PROGRESS = 8, 64
CREDENTIAL_FIELDS = ('domain', 'deployment', 'institution', 'institution_version', 'actor', 'kind',
                     'public', 'key_version', 'sequence', 'issued', 'valid_until', 'expires', 'revoked')
# Operation: (required arguments, optional arguments).
OPERATIONS = dict(
    trust=(('institution', 'public', 'version', 'expires'), ()),
    enroll=(('actor', 'kind', 'public', 'expires'), ()),
    rotate=(('actor', 'public'), ()),
    revoke=(('actor',), ()),
    accept=(('agreement', 'version', 'terms', 'purpose', 'expires'), ()),
    delegate=(('agent', 'actions', 'resources', 'purpose', 'budget', 'expires'), ()),
    undelegate=(('delegation',), ()),
    publish=(('document', 'purpose', 'recipients', 'expires'),
             ('previous', 'replacement_reason', 'delegation')),
    supersede=(('artifact', 'replacement', 'reason'), ()),
    acknowledge=(('artifact', 'notice', 'purpose'), ()),
    release=(('artifact', 'recipients', 'purpose', 'expires', 'agreement'), ()),
    withdraw=(('artifact',), ()),
    retrieve=(('artifact', 'purpose'), ('delegation',)),
    corrections=(('artifact', 'purpose'), ()),
    checked_read=(('artifact', 'purpose'), ()),
)
READS = ('retrieve', 'corrections', 'checked_read')
WRITES = tuple(name for name in OPERATIONS if name not in READS)
ADMINISTRATIVE = ('trust', 'enroll', 'rotate', 'revoke', 'accept', 'release')
DELEGATED = ('publish', 'retrieve')
TABLES = (
    '''CREATE TABLE institution_node (id INTEGER PRIMARY KEY CHECK(id=1), deployment TEXT NOT NULL,
        institution TEXT NOT NULL, administrator TEXT NOT NULL, max_age INTEGER NOT NULL)''',
    '''CREATE TABLE institution_keys (institution TEXT PRIMARY KEY, version INTEGER NOT NULL,
        public BLOB NOT NULL, expires INTEGER NOT NULL, revoked INTEGER NOT NULL)''',
    '''CREATE TABLE actor_credentials (actor TEXT PRIMARY KEY, sequence INTEGER NOT NULL,
        envelope BLOB NOT NULL)''',
    '''CREATE TABLE agreements (agreement TEXT PRIMARY KEY, body BLOB NOT NULL,
        accepted_by TEXT NOT NULL, accepted INTEGER NOT NULL)''',
    'CREATE TABLE delegations (id TEXT PRIMARY KEY, body BLOB NOT NULL, revoked INTEGER NOT NULL)',
    '''CREATE TABLE releases (artifact TEXT NOT NULL REFERENCES nodes(digest), recipient TEXT NOT NULL,
        purpose TEXT NOT NULL, body BLOB NOT NULL, PRIMARY KEY(artifact, recipient, purpose))''',
    '''CREATE TABLE request_receipts (request TEXT PRIMARY KEY, actor TEXT NOT NULL,
        operation TEXT NOT NULL, delegation TEXT, result BLOB NOT NULL, at INTEGER NOT NULL)''',
)


def institution_of(actor):
    identifier(actor)
    institution, _, name = actor.partition('.')
    require(institution and name and '.' not in name, 'invalid actor')
    return institution


class Fetch(Exception):
    """Peer fetches a request needs before it can decide; never a refusal."""

    def __init__(self, wanted):
        super().__init__('peer fetch required')
        self.wanted = wanted


def _hex(value, length, message):
    require(type(value) is str and len(value) == length and
            all(c in '0123456789abcdef' for c in value), message)


# Signatures already verified in the current handle() call on this thread. A request that
# reruns after a peer fetch does not verify them again; nothing outlives the call.
_verified = threading.local()


def _verify(public, signature, body, message):
    _hex(signature, SIGNATURE_HEX, message)
    seen = getattr(_verified, 'seen', None)
    data = canonical(body)
    key = digest(dict(public=bytes(public).hex(), signature=signature, body=data.hex())) if seen is not None else None
    if key is not None and key in seen:
        return
    try:
        VerifyingKey.from_public_bytes(public).verify(bytes.fromhex(signature), data)
    except (InvalidSignature, ValueError) as exc:
        raise ValueError(message) from exc
    if key is not None:
        seen.add(key)


def sign_credential(private_key, *, deployment, institution, institution_version, actor, kind,
                    public, key_version, sequence, issued, valid_until, expires, revoked=False):
    body = dict(domain=CREDENTIAL, deployment=deployment, institution=institution,
                institution_version=institution_version, actor=actor, kind=kind, public=public,
                key_version=key_version, sequence=sequence, issued=issued,
                valid_until=valid_until, expires=expires, revoked=revoked)
    return dict(body=body, signature=private_key.sign(canonical(body)).hex())


class InstitutionStore(ContributionStore):
    institution_identity = True
    # Request threads share one connection; every use holds self._lock.
    threaded = True
    # Class attributes so a node subclass can add operations without copying authentication.
    OPERATIONS, READS, ADMINISTRATIVE, DELEGATED = OPERATIONS, READS, ADMINISTRATIVE, DELEGATED
    REQUEST_BYTES = REQUEST_BYTES

    def __init__(self, path, *, deployment, institution, private_key, administrator,
                 administrator_public, key_expires, max_age=60, credential_fetch=None, **kwargs):
        identifier(deployment)
        identifier(institution)
        require('.' not in institution and institution_of(administrator) == institution,
                'invalid institution binding')
        _hex(administrator_public, PUBLIC_HEX, 'invalid administrator key')
        integer(max_age, 2, 86400, 'credential age policy')
        integer(key_expires, 1, MAX_TIME, 'institution key expiry')
        require(credential_fetch is None or callable(credential_fetch), 'invalid credential fetcher')
        self.deployment, self.institution, self.administrator = deployment, institution, administrator
        self.max_age, self.credential_fetch = max_age, credential_fetch
        self.private_key = private_key
        self.public = private_key.public_key().public_bytes_raw()
        self._active, self._lock, self._prefetched = False, threading.Lock(), None
        super().__init__(path, **kwargs)
        try:
            with self.transaction() as now:
                self._bootstrap(administrator_public, key_expires, now)
        except BaseException:
            self.close()
            raise

    def _bootstrap(self, administrator_public, key_expires, now):
        policy = (self.deployment, self.institution, self.administrator, self.max_age)
        created = not self.db.execute(
            "SELECT 1 FROM sqlite_master WHERE type='table' AND name='institution_node'").fetchone()
        if created:
            # Operator-trusted attribution was never authenticated; a node does not adopt it.
            require(self.db.execute('SELECT COUNT(*) FROM nodes').fetchone()[0] == 0,
                    'institution node requires an empty store')
            integer(key_expires, now + 1, MAX_TIME, 'institution key expiry')
            for statement in TABLES:
                self.db.execute(statement)
            self.db.execute('INSERT INTO institution_node VALUES (1,?,?,?,?)', policy)
            self.db.execute('INSERT INTO institution_keys VALUES (?,1,?,?,0)',
                            (self.institution, self.public, key_expires))
        row = self.db.execute('SELECT deployment,institution,administrator,max_age FROM institution_node').fetchone()
        require(row == policy, 'institution node mismatch')
        own = self.db.execute('SELECT version,public,expires,revoked FROM institution_keys WHERE institution=?',
                              (self.institution,)).fetchone()
        require(own is not None and own[1] == self.public and not own[3], 'institution key mismatch')
        self.key_version, self.key_expires = own[0], own[2]
        if created:
            self._issue(self.administrator, 'human', administrator_public, 1, 1, self.key_expires, False, now)

    @contextmanager
    def transaction(self):
        # Contribution methods open their own transaction; inside a request they join it.
        if self._active:
            yield self._now
            return
        self._active, self._received, self._fetched = True, {}, {}
        try:
            with super().transaction() as now:
                self._now = now
                yield now
        finally:
            self._active = False

    def _rollback_observations(self, now):
        for actor, envelope in self._received.items():
            try:
                self._accept_credential(envelope, actor, now)
            except ValueError:
                continue

    def _credential_body(self, envelope, actor, now, *, fresh=True):
        require(type(envelope) is dict and set(envelope) == {'body', 'signature'} and
                type(envelope['body']) is dict and set(envelope['body']) == set(CREDENTIAL_FIELDS),
                'invalid-credential')
        body = envelope['body']
        require(body['domain'] == CREDENTIAL and body['deployment'] == self.deployment and
                body['actor'] == actor and body['kind'] in KINDS and type(body['revoked']) is bool,
                'invalid-credential')
        require(body['institution'] == institution_of(actor), 'credential-namespace-mismatch')
        _hex(body['public'], PUBLIC_HEX, 'invalid-credential')
        require(all(type(body[name]) is int and 1 <= body[name] <= MAX_TIME
                    for name in ('institution_version', 'key_version', 'sequence', 'expires')) and
                type(body['issued']) is int and 0 <= body['issued'] <= now and
                type(body['valid_until']) is int and
                body['issued'] < body['valid_until'] <= min(body['issued'] + self.max_age, body['expires']),
                'invalid-credential')
        key = self.db.execute('SELECT version,public,expires,revoked FROM institution_keys WHERE institution=?',
                              (body['institution'],)).fetchone()
        require(key is not None, 'untrusted-institution')
        require(not key[3] and key[0] == body['institution_version'] and now < key[2] and
                (body['institution'] != self.institution or key[1] == self.public), 'inactive-institution-key')
        require(not fresh or now < body['valid_until'], 'stale-credential')
        _verify(key[1], envelope['signature'], body, 'invalid-institution-signature')
        if fresh:
            self._deadline = min(self._deadline, key[2], body['valid_until'])
        return body

    def _issue(self, actor, kind, public, key_version, sequence, expires, revoked, now):
        valid_until = min(now + self.max_age, expires, self.key_expires)
        require(now < valid_until, 'enrollment-expired')
        envelope = sign_credential(self.private_key, deployment=self.deployment, institution=self.institution,
                                   institution_version=self.key_version, actor=actor, kind=kind,
                                   public=public, key_version=key_version, sequence=sequence, issued=now,
                                   valid_until=valid_until, expires=expires, revoked=revoked)
        self.db.execute('INSERT OR REPLACE INTO actor_credentials VALUES (?,?,?)',
                        (actor, sequence, canonical(envelope)))
        self._deadline = min(self._deadline, valid_until)
        return envelope

    def _current(self, actor, now):
        # A stored row counts only with this institution's signature, so an injected row is refused.
        require(institution_of(actor) == self.institution, 'wrong-owner')
        row = self.db.execute('SELECT envelope FROM actor_credentials WHERE actor=?', (actor,)).fetchone()
        require(row is not None, 'unknown-actor')
        body = self._credential_body(json.loads(row[0]), actor, now, fresh=False)
        # Re-sign only when that extends validity: near expiry, reading public status must
        # not cost a signature and a write on every call.
        if (now + self.max_age // 2 >= body['valid_until'] and
                min(now + self.max_age, body['expires'], self.key_expires) > body['valid_until']):
            body = self._issue(actor, body['kind'], body['public'], body['key_version'],
                               body['sequence'] + 1, body['expires'], body['revoked'], now)['body']
        require(now < body['valid_until'], 'enrollment-expired')
        self._deadline = min(self._deadline, body['valid_until'])
        return body

    def credential(self, actor):
        """A home actor's current signed credential: public status that peers fetch."""
        require(institution_of(actor) == self.institution, 'wrong-owner')
        with self._lock, self.transaction() as now:
            self._current(actor, now)
            return json.loads(self.db.execute('SELECT envelope FROM actor_credentials WHERE actor=?',
                                              (actor,)).fetchone()[0])

    def _foreign(self, actor, now):
        institution = institution_of(actor)
        require(institution != self.institution, 'invalid-request')
        require(self.db.execute('SELECT 1 FROM institution_keys WHERE institution=?', (institution,)).fetchone(),
                'untrusted-institution')
        if actor not in self._fetched:
            try:
                require(self.credential_fetch is not None, 'no credential fetcher')
                fetched = self._outside(('credential', institution, actor),
                                        lambda: self.credential_fetch(institution, actor))
            except (OSError, ValueError) as exc:
                raise ValueError('issuer-unavailable') from exc
            try:
                encoded = canonical(fetched)
            except (TypeError, ValueError, RecursionError) as exc:
                raise ValueError('invalid-credential') from exc
            require(type(fetched) is dict and len(encoded) <= MAX_BYTES, 'invalid-credential')
            fetched = json.loads(encoded)
            self._fetched[actor] = self._accept_credential(fetched, actor, now)
            self._received[actor] = fetched
        body = self._fetched[actor]
        self._deadline = min(self._deadline, body['valid_until'])
        return body

    def _accept_credential(self, envelope, actor, now):
        body = self._credential_body(envelope, actor, now)
        encoded = canonical(envelope)
        row = self.db.execute('SELECT sequence,envelope FROM actor_credentials WHERE actor=?', (actor,)).fetchone()
        if row is not None:
            old = json.loads(row[1])['body']
            require((body['sequence'] > row[0] or (body['sequence'] == row[0] and encoded == row[1])) and
                    body['kind'] == old['kind'] and (body['revoked'] or not old['revoked']) and
                    (body['key_version'] > old['key_version'] or
                     (body['key_version'] == old['key_version'] and body['public'] == old['public'])),
                    'credential-rollback')
        self.db.execute('INSERT OR REPLACE INTO actor_credentials VALUES (?,?,?)',
                        (actor, body['sequence'], encoded))
        return body

    def _outside(self, key, fetch, fresh=lambda value: True):
        """A peer fetch's outcome. Inside handle() it was made with the write lock released."""
        if self._prefetched is None:
            return fetch()
        if not self._ready(key, fresh):
            raise Fetch({key: fetch})
        kind, value = self._prefetched[key]
        if kind == 'error':
            raise value
        return value

    def _ready(self, key, fresh=lambda value: True):
        found = self._prefetched.get(key)
        return found is not None and (found[0] == 'error' or fresh(found[1]))

    def handle(self, envelope):
        """The only write path: authenticate a signed request, then authorize and apply it once.

        The request runs whole under the write lock. When it needs a peer's credential or
        status, it rolls back, the fetch runs with the lock released, and the request runs
        again from the start, so every check sees current local state.
        """
        fetched, outer = {}, getattr(_verified, 'seen', None) is None
        if outer:
            _verified.seen = set()
        try:
            idle = progress = 0
            while True:
                with self._lock:
                    self._prefetched = fetched
                    try:
                        return self._handle(envelope)
                    except Fetch as needed:
                        wanted = needed.wanted
                    finally:
                        self._prefetched = None
                if all(key in fetched for key in wanted):
                    idle += 1
                else:
                    progress += 1
                if idle > FETCH_ROUNDS or progress > FETCH_PROGRESS:
                    break
                for key, fetch in wanted.items():
                    try:
                        fetched[key] = ('result', fetch())
                    except (OSError, ValueError) as exc:
                        fetched[key] = ('error', exc)
            raise ValueError('issuer-unavailable')
        finally:
            if outer:
                del _verified.seen

    def _handle(self, envelope):
        require(type(envelope) is dict, 'invalid-request')
        try:
            encoded = canonical(envelope)
        except (TypeError, ValueError, RecursionError) as exc:
            raise ValueError('invalid-request') from exc
        require(len(encoded) <= self.REQUEST_BYTES, 'invalid-request')
        envelope = json.loads(encoded)
        body = envelope.get('body')
        require(set(envelope) == {'body', 'signature'} and type(body) is dict and
                set(body) == set(REQUEST_FIELDS), 'invalid-request')
        require(body['domain'] == REQUEST and body['deployment'] == self.deployment, 'invalid-request')
        require(body['node'] == self.institution, 'wrong-node')
        operation, arguments = body['operation'], body['arguments']
        require(type(operation) is str and operation in self.OPERATIONS and type(arguments) is dict,
                'invalid-request')
        required, optional = self.OPERATIONS[operation]
        require(set(required) <= set(arguments) <= set(required + optional), 'invalid-request')
        require(all(type(body[name]) is int and 0 <= body[name] <= MAX_TIME
                    for name in ('key_version', 'issued', 'expires')), 'invalid-request')
        try:
            home = institution_of(body['actor']) == self.institution
        except ValueError as exc:
            raise ValueError('invalid-request') from exc
        actor, request = body['actor'], digest(body)
        with self.transaction() as now:
            require(body['issued'] <= now and body['issued'] < body['expires'] <= body['issued'] + MAX_WINDOW,
                    'invalid-request')
            require(now < body['expires'], 'expired-request')
            self._deadline = min(self._deadline, body['expires'])
            credential = self._current(actor, now) if home else self._foreign(actor, now)
            require(not credential['revoked'], 'revoked-actor')
            require(credential['key_version'] == body['key_version'], 'stale-actor-key')
            _verify(bytes.fromhex(credential['public']), envelope['signature'], body, 'invalid-actor-signature')
            write = operation not in self.READS
            if write:
                receipt = self.db.execute('SELECT result FROM request_receipts WHERE request=?',
                                          (request,)).fetchone()
                if receipt is not None:
                    return json.loads(receipt[0])
            result = self._dispatch(actor, credential, home, operation, arguments, now)
            if write:
                delegation = arguments.get('delegation') if operation == 'publish' else None
                self.db.execute('INSERT INTO request_receipts VALUES (?,?,?,?,?,?)',
                                (request, actor, operation, delegation, canonical(result), now))
            return result

    def _dispatch(self, actor, credential, home, operation, arguments, now):
        if not home:
            # A peer's actor acts here only by reading what this institution released to it.
            require(operation in self.READS, 'wrong-owner')
            require(operation == 'retrieve' and credential['kind'] == 'human' and
                    'delegation' not in arguments, 'not-authorized')
            return self._released(actor, arguments['artifact'], arguments['purpose'], now)
        agent = credential['kind'] == 'agent'
        require(not agent or operation in self.DELEGATED, 'human-required')
        require(operation not in self.ADMINISTRATIVE or actor == self.administrator, 'administrator-required')
        return getattr(self, '_op_' + operation)(actor, agent, arguments, now)

    def _op_trust(self, actor, agent, a, now):
        identifier(a['institution'])
        require('.' not in a['institution'] and a['institution'] != self.institution, 'invalid institution')
        _hex(a['public'], PUBLIC_HEX, 'invalid institution key')
        integer(a['version'], 1, MAX_TIME, 'institution version')
        integer(a['expires'], now + 1, MAX_TIME, 'institution key expiry')
        old = self.db.execute('SELECT version FROM institution_keys WHERE institution=?',
                              (a['institution'],)).fetchone()
        require(old is None or a['version'] > old[0], 'stale-institution-version')
        self.db.execute('INSERT OR REPLACE INTO institution_keys VALUES (?,?,?,?,0)',
                        (a['institution'], a['version'], bytes.fromhex(a['public']), a['expires']))
        return dict(institution=a['institution'], version=a['version'])

    def _op_enroll(self, actor, agent, a, now):
        require(institution_of(a['actor']) == self.institution, 'wrong-owner')
        require(a['kind'] in KINDS, 'invalid actor kind')
        _hex(a['public'], PUBLIC_HEX, 'invalid actor key')
        integer(a['expires'], now + 1, self.key_expires, 'enrollment expiry')
        require(not self.db.execute('SELECT 1 FROM actor_credentials WHERE actor=?', (a['actor'],)).fetchone(),
                'already-enrolled')
        return self._issue(a['actor'], a['kind'], a['public'], 1, 1, a['expires'], False, now)

    def _op_rotate(self, actor, agent, a, now):
        require(institution_of(a['actor']) == self.institution, 'wrong-owner')
        current = self._current(a['actor'], now)
        require(not current['revoked'], 'revoked-actor')
        _hex(a['public'], PUBLIC_HEX, 'invalid actor key')
        require(a['public'] != current['public'], 'unchanged-key')
        return self._issue(a['actor'], current['kind'], a['public'], current['key_version'] + 1,
                           current['sequence'] + 1, current['expires'], False, now)

    def _op_revoke(self, actor, agent, a, now):
        require(institution_of(a['actor']) == self.institution, 'wrong-owner')
        require(a['actor'] != self.administrator, 'administrator-immutable')
        current = self._current(a['actor'], now)
        return self._issue(a['actor'], current['kind'], current['public'], current['key_version'],
                           current['sequence'] + 1, current['expires'], True, now)

    def _op_accept(self, actor, agent, a, now):
        identifier(a['agreement'])
        identifier(a['purpose'])
        integer(a['version'], 1, MAX_TIME, 'agreement version')
        hash_value(a['terms'])
        integer(a['expires'], now + 1, MAX_TIME, 'agreement expiry')
        terms = {name: a[name] for name in ('agreement', 'version', 'terms', 'purpose', 'expires')}
        old = self.db.execute('SELECT body FROM agreements WHERE agreement=?', (a['agreement'],)).fetchone()
        require(old is None or old[0] == canonical(terms), 'conflicting-agreement')
        self.db.execute('INSERT OR IGNORE INTO agreements VALUES (?,?,?,?)',
                        (a['agreement'], canonical(terms), actor, now))
        return digest(terms)

    def _op_delegate(self, actor, agent, a, now):
        require(institution_of(a['agent']) == self.institution, 'wrong-owner')
        delegate = self._current(a['agent'], now)
        require(delegate['kind'] == 'agent' and not delegate['revoked'], 'agent-required')
        bounded_list(a['actions'], 1, len(DELEGABLE),
                     lambda value: require(value in DELEGABLE, 'invalid delegated action'), 'actions')
        bounded_list(a['resources'], 1, 16, hash_value, 'resources')
        require(a['actions'] == sorted(a['actions']) and a['resources'] == sorted(a['resources']),
                'noncanonical delegation')
        identifier(a['purpose'])
        integer(a['budget'], 1, 64, 'delegation budget')
        principal = self._current(actor, now)
        integer(a['expires'], now + 1, min(principal['expires'], delegate['expires']), 'delegation expiry')
        for resource in a['resources']:
            for party in (actor, a['agent']):
                self._usable(resource, party, a['purpose'], now)
        body = dict(kind='delegation', institution=self.institution, principal=actor, agent=a['agent'],
                    actions=a['actions'], resources=a['resources'], purpose=a['purpose'],
                    budget=a['budget'], issued=now, expires=a['expires'])
        key = digest(body)
        self.db.execute('INSERT OR IGNORE INTO delegations VALUES (?,?,0)', (key, canonical(body)))
        return key

    def _op_undelegate(self, actor, agent, a, now):
        hash_value(a['delegation'])
        row = self.db.execute('SELECT body FROM delegations WHERE id=?', (a['delegation'],)).fetchone()
        require(row is not None, 'unknown-delegation')
        require(actor in (json.loads(row[0])['principal'], self.administrator), 'owner-required')
        self.db.execute('UPDATE delegations SET revoked=1 WHERE id=?', (a['delegation'],))
        return a['delegation']

    def _granted(self, agent, key, now):
        require(key is not None, 'delegation-required')
        hash_value(key)
        row = self.db.execute('SELECT body,revoked FROM delegations WHERE id=?', (key,)).fetchone()
        require(row is not None, 'delegation-required')
        body = json.loads(row[0])
        require(digest(body) == key, 'stored delegation substitution')
        require(body['agent'] == agent, 'delegation-scope')
        require(not row[1] and not self._current(body['principal'], now)['revoked'], 'delegation-revoked')
        self._deadline = min(self._deadline, body['expires'])
        require(now < body['expires'], 'delegation-expired')
        return body

    def _delegation(self, agent, key, action, purpose, inputs, now):
        body = self._granted(agent, key, now)
        require(action in body['actions'] and purpose == body['purpose'] and
                bool(inputs) and set(inputs) <= set(body['resources']), 'delegation-scope')
        for resource in inputs:
            self._usable(resource, body['principal'], purpose, now)
        return body

    def _used(self, delegation):
        # How much of a delegation's budget its derivations have spent.
        return self.db.execute("SELECT COUNT(*) FROM request_receipts WHERE delegation=? AND operation='publish'",
                               (delegation,)).fetchone()[0]

    def _op_publish(self, actor, agent, a, now):
        validate_document(a['document'])
        bounded_list(a['recipients'], 1, 16, identifier, 'recipients')
        for recipient in a['recipients']:
            require(institution_of(recipient) == self.institution, 'release-required')
            require(self.db.execute('SELECT 1 FROM actor_credentials WHERE actor=?', (recipient,)).fetchone(),
                    'unknown-actor')
        if agent:
            require(a.get('previous') is None and a.get('replacement_reason') is None, 'delegation-scope')
            delegation = self._delegation(actor, a.get('delegation'), 'derive', a['purpose'],
                                          a['document']['evidence'], now)
            require(self._used(a['delegation']) < delegation['budget'], 'delegation-budget')
        else:
            require(a.get('delegation') is None, 'invalid-request')
        return ContributionStore.publish(self, a['document'], actor=actor, purpose=a['purpose'],
                                         recipients=a['recipients'], expires=a['expires'],
                                         previous=a.get('previous'), replacement_reason=a.get('replacement_reason'))

    def _op_supersede(self, actor, agent, a, now):
        return ContributionStore.supersede(self, a['artifact'], replacement=a['replacement'], actor=actor,
                                           reason=a['reason'])

    def _op_acknowledge(self, actor, agent, a, now):
        return ContributionStore.acknowledge(self, a['artifact'], notice=a['notice'], recipient=actor,
                                             purpose=a['purpose'])

    def _local(self, key):
        hash_value(key)
        require(self.db.execute('SELECT 1 FROM nodes WHERE digest=?', (key,)).fetchone(), 'unknown-artifact')
        return key

    def _op_release(self, actor, agent, a, now):
        key = self._local(a['artifact'])
        row = self._row(key)
        require(json.loads(row[0]).get('kind') == 'expert-contribution', 'not-releasable')
        identifier(a['purpose'])
        require(a['purpose'] == row[2], 'new-grant-required')
        self._usable(key, actor, a['purpose'], now)
        identifier(a['agreement'])
        terms = self.db.execute('SELECT body FROM agreements WHERE agreement=?', (a['agreement'],)).fetchone()
        terms = json.loads(terms[0]) if terms else None
        require(terms is not None and terms['purpose'] == a['purpose'] and now < terms['expires'],
                'agreement-required')
        integer(a['expires'], now + 1, min(row[4], terms['expires']), 'release expiry')
        bounded_list(a['recipients'], 1, 16, identifier, 'recipients')
        require(a['recipients'] == sorted(a['recipients']), 'noncanonical recipients')
        for recipient in a['recipients']:
            require(institution_of(recipient) != self.institution, 'invalid release recipient')
            credential = self._foreign(recipient, now)
            require(credential['kind'] == 'human' and not credential['revoked'], 'human-required')
        body = dict(kind='release', institution=self.institution, artifact=key, recipients=a['recipients'],
                    purpose=a['purpose'], agreement=a['agreement'], expires=a['expires'],
                    released_by=actor, issued=now, **self._release_terms(key, a, now))
        self.db.executemany('INSERT OR REPLACE INTO releases VALUES (?,?,?,?)',
                            [(key, recipient, a['purpose'], canonical(body)) for recipient in a['recipients']])
        return digest(body)

    def _release_terms(self, key, a, now):
        # A node subclass may add checked terms to a release; P1.1 adds none.
        return {}

    def _op_withdraw(self, actor, agent, a, now):
        key = self._local(a['artifact'])
        require(actor in (self._row(key)[1], self.administrator), 'owner-required')
        self.db.execute('UPDATE nodes SET withdrawn=1 WHERE digest=?', (key,))
        return key

    def _op_retrieve(self, actor, agent, a, now):
        hash_value(a['artifact'])
        if agent:
            self._delegation(actor, a.get('delegation'), 'retrieve', a['purpose'], [a['artifact']], now)
        else:
            require(a.get('delegation') is None, 'invalid-request')
        return ReviewStore.retrieve(self, a['artifact'], recipient=actor, purpose=a['purpose'])

    def _op_corrections(self, actor, agent, a, now):
        return ContributionStore.corrections(self, a['artifact'], recipient=actor, purpose=a['purpose'])

    def _op_checked_read(self, actor, agent, a, now):
        return ContributionStore.checked_read(self, a['artifact'], recipient=actor, purpose=a['purpose'])

    def _released(self, actor, key, purpose, now):
        hash_value(key)
        identifier(purpose)
        rows = self.db.execute('SELECT purpose,body FROM releases WHERE artifact=? AND recipient=?',
                               (key, actor)).fetchall()
        # Unreleased and nonexistent artifacts refuse alike: no existence or lineage oracle.
        require(rows, 'not-authorized')
        release = next((json.loads(body) for scope, body in rows if scope == purpose), None)
        require(release is not None, 'new-grant-required')
        self._deadline = min(self._deadline, release['expires'])
        require(now < release['expires'], 'release-expired')
        self._live(key, now)
        payload = json.loads(self._row(key)[0])
        view = {name: payload[name] for name in ('contribution_type', 'title', 'body', 'uncertainty',
                                                 'attachments', 'authors', 'revision')}
        return dict(view, kind='released-contribution', institution=self.institution, artifact=key,
                    purpose=purpose, release_expires=release['expires'], lineage='withheld')

    def _live(self, key, now):
        todo, seen = [key], set()
        while todo:
            current = todo.pop()
            if current in seen:
                continue
            seen.add(current)
            require(len(seen) <= self.limit, 'dependency bound exceeded')
            row = self._row(current)
            self._deadline = min(self._deadline, row[4])
            require(not row[5], 'withdrawn')
            require(now < row[4], 'expired')
            todo.extend(self._parents(current, json.loads(row[0])))

    def _parents(self, key, payload):
        parents = super()._parents(key, payload)
        if payload.get('kind') == 'expert-contribution':
            previous = [payload['previous']] if payload['previous'] and 'replacement_reason' not in payload else []
            require(parents == sorted(set(payload['evidence'] + previous)), 'dependency register mismatch')
        return parents

    def _signed_only(self, *args, **kwargs):
        require(False, 'signed-request-required')

    register = grant = submit = withdraw = decide = retrieve = publish = supersede = \
        corrections = acknowledge = checked_read = _signed_only
