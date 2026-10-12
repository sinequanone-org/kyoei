"""Research-repair records on one institution node (Priority 4, step 4.1).

A node holds only its own claims, derived claims and joint sections. Each artifact
version names its inputs and how it relates to each one. Reliance on another
institution's artifact is told to that institution only (a `rely` event), so the
owner knows whom to tell when its artifact is challenged or blocked.

A challenge marks every relying version for reassessment and blocks nothing. A
withdrawal blocks every version that still relies on the withdrawn result. Both
spread along declared reliance only: inside the node directly, to another
institution as a signed event sent to that institution only. Events wait in the
`research_outbox` table, so a refused request queues nothing. The caller sends them
with `research_relay`.

An unknown artifact is never usable. Notices are built when read, so a dissent
recorded later shows in every notice on that result.
"""
import json
import re

from scripts.context_shards import hash_value, identifier
from scripts.continuation_store import ContinuationStore
from scripts.institution_identity import institution_of
from scripts.task_data import require

TABLES = (
    '''CREATE TABLE IF NOT EXISTS research_artifacts (
        artifact TEXT NOT NULL, version INTEGER NOT NULL, kind TEXT NOT NULL,
        purpose TEXT NOT NULL, author TEXT NOT NULL, proposer TEXT NOT NULL,
        state TEXT NOT NULL, cited_result TEXT, reliance INTEGER NOT NULL,
        relation TEXT, label TEXT, evidence TEXT, signers TEXT, rationale TEXT,
        PRIMARY KEY (artifact, version))''',
    '''CREATE TABLE IF NOT EXISTS research_inputs (
        artifact TEXT NOT NULL, version INTEGER NOT NULL, input TEXT NOT NULL,
        input_version INTEGER NOT NULL, owner TEXT NOT NULL, relation TEXT NOT NULL,
        PRIMARY KEY (artifact, version, input))''',
    '''CREATE TABLE IF NOT EXISTS research_dependents (
        artifact TEXT NOT NULL, version INTEGER NOT NULL, institution TEXT NOT NULL,
        PRIMARY KEY (artifact, version, institution))''',
    '''CREATE TABLE IF NOT EXISTS research_signoffs (
        artifact TEXT NOT NULL, version INTEGER NOT NULL, institution TEXT NOT NULL,
        actor TEXT NOT NULL, PRIMARY KEY (artifact, version, institution))''',
    '''CREATE TABLE IF NOT EXISTS research_challenges (
        challenge TEXT PRIMARY KEY, cited_result TEXT NOT NULL, banner TEXT NOT NULL,
        purpose TEXT NOT NULL, recorded_by TEXT NOT NULL)''',
    '''CREATE TABLE IF NOT EXISTS research_marks (
        artifact TEXT NOT NULL, version INTEGER NOT NULL, challenge TEXT NOT NULL,
        via_owner TEXT NOT NULL, via_passage TEXT NOT NULL,
        PRIMARY KEY (artifact, version, challenge))''',
    '''CREATE TABLE IF NOT EXISTS research_blocks (
        artifact TEXT NOT NULL, version INTEGER NOT NULL, cited_result TEXT NOT NULL,
        PRIMARY KEY (artifact, version))''',
    '''CREATE TABLE IF NOT EXISTS research_withdrawn (cited_result TEXT PRIMARY KEY, purpose TEXT NOT NULL)''',
    '''CREATE TABLE IF NOT EXISTS research_dissents (
        cited_result TEXT NOT NULL, institution TEXT NOT NULL, actor TEXT NOT NULL,
        details TEXT NOT NULL, PRIMARY KEY (cited_result, institution, actor))''',
    '''CREATE TABLE IF NOT EXISTS research_inbox (
        event TEXT PRIMARY KEY, issuer TEXT NOT NULL, kind TEXT NOT NULL, subject TEXT NOT NULL)''',
    '''CREATE TABLE IF NOT EXISTS research_outbox (
        sequence INTEGER PRIMARY KEY AUTOINCREMENT, recipient TEXT NOT NULL, envelope TEXT NOT NULL,
        claimed INTEGER NOT NULL DEFAULT 0)''',
    '''CREATE TABLE IF NOT EXISTS research_send_failures (
        sequence INTEGER PRIMARY KEY, recipient TEXT NOT NULL, kind TEXT NOT NULL, error TEXT NOT NULL)''',
)

VERSIONED = re.compile(r'([a-zA-Z0-9_.-]{1,100}):v([1-9][0-9]{0,5})')
EVIDENCE = ('citing_work_version', 'passage_position', 'passage_sha256', 'label_source')
RELIANCE = ('builds-on', 'reproduces', 'supersedes')
RELATIONS = RELIANCE + ('cites',)
LABELS = ('depends', 'does-not-depend')
NO_VERSION = 'version not recorded'
CLAIM_REPAIRS = ['reassess', 'replace', 'withdraw', 'dissent']
DERIVED_REPAIRS = ['rebase', 'reassess', 'withdraw', 'dissent']


def parse_key(value):
    """`id:vN` to (id, N)."""
    match = type(value) is str and VERSIONED.fullmatch(value)
    require(bool(match), 'invalid artifact version')
    return match.group(1), int(match.group(2))


def _text(value, limit):
    require(type(value) is str and 1 <= len(value) <= limit, 'invalid text')
    return value


class ResearchRepairStore(ContinuationStore):
    """An institution's research claims, the reliance it declared, and its repair state."""

    OPERATIONS = dict(
        ContinuationStore.OPERATIONS,
        research_claim=(('claim_id', 'unit_id', 'cited_result', 'evidence', 'relation', 'label', 'purpose'), ()),
        research_confirm=(('claim_id',), ()),
        research_derived=(('derived_id', 'inputs', 'owners', 'purpose'), ()),
        research_section=(('section_id', 'inputs', 'owners', 'signers', 'purpose'), ()),
        research_signoff=(('section_id', 'version', 'owner'), ()),
        research_challenge=(('challenge_id', 'cited_result', 'banner', 'purpose'), ()),
        research_dissent=(('cited_result', 'details', 'purpose'), ()),
        research_withdraw=(('cited_result', 'purpose'), ()),
        research_replace=(('claim_id', 'new_source'), ()),
        research_rebase=(('derived_id', 'inputs', 'owners'), ()),
        research_reassess=(('derived_id', 'input', 'relation', 'rationale_sha256'), ()),
        research_revise_section=(('section_id', 'inputs', 'owners'), ()),
        research_retract=(('artifact_id',), ()),
        research_notices=(('purpose',), ()),
        research_status=(('artifact_key',), ()),
        research_audit=((), ()),
    )
    READS = ContinuationStore.READS + ('research_notices', 'research_status', 'research_audit')
    ADMINISTRATIVE = ContinuationStore.ADMINISTRATIVE + ('research_signoff', 'research_audit')
    # An agent may propose a claim. Confirming, repairing and signing off stay with people.
    DELEGATED = ContinuationStore.DELEGATED + ('research_claim', 'research_notices', 'research_status')

    def __init__(self, *args, **kwargs):
        super().__init__(*args, **kwargs)
        self.peer_urls = {}
        for statement in TABLES:
            self.db.execute(statement)

    # ------------------------------------------------------------------------------------------ helpers

    def _agreed(self, purpose, now):
        identifier(purpose)
        self._agreement(purpose, now)
        return purpose

    def _research_current(self, artifact):
        return self.db.execute(
            "SELECT version FROM research_artifacts WHERE artifact=? AND state='active' "
            'ORDER BY version DESC LIMIT 1', (artifact,)).fetchone()

    def _record(self, artifact, version):
        row = self.db.execute(
            'SELECT kind,purpose,author,state,cited_result,reliance,evidence,signers FROM research_artifacts '
            'WHERE artifact=? AND version=?', (artifact, version)).fetchone()
        require(row is not None, 'unknown-artifact')
        return dict(kind=row[0], purpose=row[1], author=row[2], state=row[3], cited_result=row[4],
                    reliance=bool(row[5]), evidence=json.loads(row[6]) if row[6] else None,
                    signers=json.loads(row[7]) if row[7] else None)

    def _research_owned(self, artifact, kind, actor):
        """The active version of a local artifact this actor's institution owns."""
        identifier(artifact)
        row = self._research_current(artifact)
        require(row is not None, 'unknown-artifact')
        record = self._record(artifact, row[0])
        require(record['kind'] == kind, 'unknown-artifact')
        require(institution_of(actor) == self.institution, 'wrong-owner')
        return row[0], record

    def _outbox(self, recipient, kind, purpose, payload, now):
        from scripts.research_relay import EVENT, sign_event
        body = dict(domain=EVENT, deployment=self.deployment, issuer=self.institution, kind=kind,
                    purpose=purpose, payload=payload, issued=int(now), expires=int(now) + 60)
        self.db.execute('INSERT INTO research_outbox (recipient, envelope) VALUES (?,?)',
                        (recipient, json.dumps(sign_event(self.private_key, body))))

    def _peers(self):
        return [row[0] for row in self.db.execute(
            'SELECT institution FROM institution_keys WHERE institution<>? AND revoked=0 ORDER BY institution',
            (self.institution,))]

    def _broadcast(self, kind, purpose, payload, now):
        for peer in self._peers():
            self._outbox(peer, kind, purpose, payload, now)

    def claim_events(self):
        """Take the unsent events, oldest first, so a second sender in another thread skips them."""
        with self._lock, self.transaction():
            rows = self.db.execute('SELECT sequence,recipient,envelope FROM research_outbox WHERE claimed=0 '
                                   'ORDER BY sequence').fetchall()
            self.db.execute('UPDATE research_outbox SET claimed=1 WHERE claimed=0')
        return [(row[0], row[1], json.loads(row[2])) for row in rows]

    def sent(self, sequence):
        with self._lock, self.transaction():
            self.db.execute('DELETE FROM research_outbox WHERE sequence=?', (sequence,))

    def refused_by_peer(self, sequence, recipient, kind, error):
        """The recipient refused the event. It is kept as a failure, never retried, never hidden."""
        with self._lock, self.transaction():
            self.db.execute('DELETE FROM research_outbox WHERE sequence=?', (sequence,))
            self.db.execute('INSERT OR REPLACE INTO research_send_failures VALUES (?,?,?,?)',
                            (sequence, recipient, kind, error[:120]))

    def unsent(self, sequence):
        """The recipient was unreachable: the event waits for the next send."""
        with self._lock, self.transaction():
            self.db.execute('UPDATE research_outbox SET claimed=0 WHERE sequence=?', (sequence,))

    def _inputs(self, inputs, owners, purpose):
        """Versioned inputs. A local input must exist in this purpose; a foreign one names its owner."""
        require(type(inputs) is list and 1 <= len(inputs) <= 64, 'invalid inputs')
        require(type(owners) is dict and len(owners) <= 64, 'invalid inputs')
        parsed, seen = [], set()
        for value in inputs:
            artifact, version = parse_key(value)
            require(artifact not in seen, 'invalid inputs')
            seen.add(artifact)
            owner = owners.get(artifact, self.institution)
            identifier(owner)
            if owner == self.institution:
                record = self._record(artifact, version)
                require(record['purpose'] == purpose and record['state'] in ('active', 'superseded'), 'not-authorized')
            else:
                require(owner in self._peers(), 'untrusted-institution')
            parsed.append((artifact, version, owner))
        require(set(owners) <= seen, 'invalid inputs')
        return parsed

    def _store_inputs(self, artifact, version, inputs, relations, purpose, now):
        for input_id, input_version, owner in inputs:
            relation = relations.get(input_id, 'builds-on')
            self.db.execute('INSERT INTO research_inputs VALUES (?,?,?,?,?,?)',
                            (artifact, version, input_id, input_version, owner, relation))
            if relation not in RELIANCE:
                continue
            if owner == self.institution:
                self.db.execute('INSERT OR IGNORE INTO research_dependents VALUES (?,?,?)',
                                (input_id, input_version, self.institution))
            else:
                self._outbox(owner, 'rely', purpose, dict(artifact=input_id, version=input_version), now)

    def _research_insert(self, artifact, version, kind, purpose, actor, state, *, cited=None, reliance=False,
                relation=None, label=None, evidence=None, signers=None, rationale=None, proposer=None):
        self.db.execute('INSERT INTO research_artifacts VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?)',
                        (artifact, version, kind, purpose, actor, proposer or actor, state, cited,
                         int(reliance), relation, label, json.dumps(evidence) if evidence is not None else None,
                         json.dumps(signers) if signers is not None else None, rationale))

    def _supersede(self, artifact, version):
        self.db.execute("UPDATE research_artifacts SET state='superseded' WHERE artifact=? AND version=?",
                        (artifact, version))

    # ------------------------------------------------------------------------------- spreading a state

    def _relying(self, artifact, version):
        """Local versions that rely on this input version."""
        return self.db.execute(
            'SELECT artifact,version FROM research_inputs WHERE input=? AND input_version=? AND relation IN (?,?,?) '
            'ORDER BY artifact,version', (artifact, version, *RELIANCE)).fetchall()

    def _mark(self, artifact, version, challenge, owner, passage, now):
        if self.db.execute('SELECT 1 FROM research_marks WHERE artifact=? AND version=? AND challenge=?',
                           (artifact, version, challenge)).fetchone():
            return
        self.db.execute('INSERT INTO research_marks VALUES (?,?,?,?,?)', (artifact, version, challenge, owner, passage))
        cited, banner = self.db.execute('SELECT cited_result,banner FROM research_challenges WHERE challenge=?',
                                        (challenge,)).fetchone()
        self._spread('affected', artifact, version, dict(
            challenge_id=challenge, cited_result=cited, banner=banner, passage_sha256=passage), now)
        for dependent, dependent_version in self._relying(artifact, version):
            self._mark(dependent, dependent_version, challenge, self.institution, passage, now)

    def _block(self, artifact, version, cited, now):
        if self.db.execute('SELECT 1 FROM research_blocks WHERE artifact=? AND version=?',
                           (artifact, version)).fetchone():
            return
        self.db.execute('INSERT INTO research_blocks VALUES (?,?,?)', (artifact, version, cited))
        self._spread('blocked', artifact, version, dict(cited_result=cited), now)
        for dependent, dependent_version in self._relying(artifact, version):
            self._block(dependent, dependent_version, cited, now)

    def _spread(self, kind, artifact, version, extra, now):
        """Tell each other institution that declared reliance on this version, and no one else."""
        purpose = self._record(artifact, version)['purpose']
        for (institution,) in self.db.execute(
                'SELECT institution FROM research_dependents WHERE artifact=? AND version=? AND institution<>? '
                'ORDER BY institution', (artifact, version, self.institution)).fetchall():
            self._outbox(institution, kind, purpose, dict(extra, artifact=artifact, version=version), now)

    def _known(self, challenge, cited, banner, purpose, by):
        row = self.db.execute('SELECT cited_result,banner,purpose FROM research_challenges WHERE challenge=?',
                              (challenge,)).fetchone()
        if row is None:
            self.db.execute('INSERT INTO research_challenges VALUES (?,?,?,?,?)', (challenge, cited, banner, purpose, by))
        else:
            require(row == (cited, banner, purpose), 'challenge-conflict')

    def _challenge(self, challenge, cited, banner, purpose, by, now):
        # A peer's `affected` event can arrive before the challenge itself, so marking always runs.
        self._known(challenge, cited, banner, purpose, by)
        for artifact, version, evidence in self.db.execute(
                "SELECT artifact,version,evidence FROM research_artifacts WHERE kind='claim' AND cited_result=? "
                "AND reliance=1 AND purpose=? AND state<>'proposed' ORDER BY artifact,version",
                (cited, purpose)).fetchall():
            self._mark(artifact, version, challenge, self.institution, json.loads(evidence)['passage_sha256'], now)

    def _withdraw(self, cited, purpose, now):
        if self.db.execute('SELECT 1 FROM research_withdrawn WHERE cited_result=?', (cited,)).fetchone():
            return False
        self.db.execute('INSERT INTO research_withdrawn VALUES (?,?)', (cited, purpose))
        for artifact, version in self.db.execute(
                "SELECT artifact,version FROM research_artifacts WHERE kind='claim' AND cited_result=? AND reliance=1 "
                'AND purpose=? ORDER BY artifact,version', (cited, purpose)).fetchall():
            self._block(artifact, version, cited, now)
        return True

    # ------------------------------------------------------------------------------- signed peer events

    def accept_signed_event(self, envelope):
        """Check one peer event against the pinned institution key, then apply it to local records."""
        with self._lock, self.transaction() as now:
            return self._accept_signed_event(envelope, now)

    def _accept_signed_event(self, envelope, now):
        from scripts.research_relay import event_id, parse_event, verify_signature
        body = parse_event(envelope)
        require(body['deployment'] == self.deployment and body['issuer'] != self.institution, 'invalid-event')
        require(body['issued'] <= now < body['expires'], 'expired-event')
        row = self.db.execute('SELECT public,expires,revoked FROM institution_keys WHERE institution=?',
                              (body['issuer'],)).fetchone()
        require(row is not None and not row[2] and now < row[1], 'untrusted-institution')
        verify_signature(row[0], envelope['signature'], body)
        self._agreed(body['purpose'], now)
        event = event_id(body)
        if self.db.execute('SELECT 1 FROM research_inbox WHERE event=?', (event,)).fetchone():
            return dict(status='replayed', event_id=event, kind=body['kind'])
        kind, payload, purpose, issuer = body['kind'], body['payload'], body['purpose'], body['issuer']
        if kind == 'challenge':
            self._challenge(payload['challenge_id'], payload['cited_result'], payload['banner'], purpose, issuer, now)
            subject = payload['cited_result']
        elif kind == 'withdraw':
            self._withdraw(payload['cited_result'], purpose, now)
            subject = payload['cited_result']
        elif kind == 'dissent':
            require(institution_of(payload['actor']) == issuer, 'invalid-event')
            self.db.execute('INSERT OR REPLACE INTO research_dissents VALUES (?,?,?,?)',
                            (payload['cited_result'], issuer, payload['actor'], payload['details']))
            subject = payload['cited_result']
        elif kind == 'rely':
            # Only reliance on this node's own artifact, in the same purpose, is recorded.
            record = self._record(payload['artifact'], payload['version'])
            require(record['purpose'] == purpose, 'not-authorized')
            self.db.execute('INSERT OR IGNORE INTO research_dependents VALUES (?,?,?)',
                            (payload['artifact'], payload['version'], issuer))
            subject = f"{payload['artifact']}:v{payload['version']}"
        elif kind in ('affected', 'blocked'):
            relying = self.db.execute(
                'SELECT artifact,version FROM research_inputs WHERE input=? AND input_version=? AND owner=? '
                'AND relation IN (?,?,?) ORDER BY artifact,version',
                (payload['artifact'], payload['version'], issuer, *RELIANCE)).fetchall()
            require(relying, 'not-a-dependent')
            for artifact, version in relying:
                require(self._record(artifact, version)['purpose'] == purpose, 'not-authorized')
                if kind == 'affected':
                    self._known(payload['challenge_id'], payload['cited_result'], payload['banner'], purpose, issuer)
                    self._mark(artifact, version, payload['challenge_id'], issuer, payload['passage_sha256'], now)
                else:
                    self._block(artifact, version, payload['cited_result'], now)
            subject = f"{payload['artifact']}:v{payload['version']}"
        elif kind == 'signoff':
            record = self._record(payload['artifact'], payload['version'])
            require(record['kind'] == 'section' and issuer in record['signers'], 'not-authorized')
            require(record['purpose'] == purpose and institution_of(payload['actor']) == issuer, 'not-authorized')
            self._signoff(payload['artifact'], payload['version'], issuer, payload['actor'])
            subject = f"{payload['artifact']}:v{payload['version']}"
        else:
            raise ValueError('invalid-event')
        self.db.execute('INSERT INTO research_inbox VALUES (?,?,?,?)', (event, issuer, kind, subject))
        return dict(status='accepted', event_id=event, kind=kind)

    # ------------------------------------------------------------------------------- declarations

    def _op_research_claim(self, actor, agent, a, now):
        purpose = self._agreed(a['purpose'], now)
        for name in ('claim_id', 'unit_id', 'cited_result'):
            identifier(a[name])
        require(a['relation'] in RELATIONS and a['label'] in LABELS, 'invalid-request')
        # Reliance follows the label. A `does-not-depend` claim keeps its relation name and relies on nothing.
        evidence = a['evidence']
        require(type(evidence) is dict and set(evidence) == set(EVIDENCE), 'invalid evidence')
        hash_value(evidence['passage_sha256'])
        for name in ('citing_work_version', 'passage_position', 'label_source'):
            _text(evidence[name], 120)
        require(not self.db.execute('SELECT 1 FROM research_artifacts WHERE artifact=?',
                                    (a['claim_id'],)).fetchone(), 'artifact-exists')
        # A person's own record counts as confirmed. An agent's record waits for a person.
        self._research_insert(a['claim_id'], 1, 'claim', purpose, actor, 'proposed' if agent else 'active',
                     cited=a['cited_result'], reliance=a['label'] == 'depends', relation=a['relation'],
                     label=a['label'], evidence=dict(evidence, unit_id=a['unit_id']))
        return dict(claim_id=a['claim_id'], version='v1', state='proposed' if agent else 'active')

    def _op_research_confirm(self, actor, agent, a, now):
        identifier(a['claim_id'])
        row = self.db.execute("SELECT 1 FROM research_artifacts WHERE artifact=? AND version=1 AND state='proposed'",
                              (a['claim_id'],)).fetchone()
        require(row is not None, 'unknown-artifact')
        self.db.execute("UPDATE research_artifacts SET state='active', author=? WHERE artifact=? AND version=1",
                        (actor, a['claim_id']))
        return dict(claim_id=a['claim_id'], version='v1', state='active', confirmed_by=actor)

    def _op_research_derived(self, actor, agent, a, now):
        purpose = self._agreed(a['purpose'], now)
        identifier(a['derived_id'])
        require(not self.db.execute('SELECT 1 FROM research_artifacts WHERE artifact=?',
                                    (a['derived_id'],)).fetchone(), 'artifact-exists')
        inputs = self._inputs(a['inputs'], a['owners'], purpose)
        self._research_insert(a['derived_id'], 1, 'derived', purpose, actor, 'active')
        self._store_inputs(a['derived_id'], 1, inputs, {}, purpose, now)
        return dict(derived_id=a['derived_id'], version='v1', state='active')

    def _signers(self, signers):
        require(type(signers) is list and 1 <= len(signers) <= 16 and len(set(signers)) == len(signers),
                'invalid signers')
        for institution in signers:
            identifier(institution)
            require(institution == self.institution or institution in self._peers(), 'untrusted-institution')
        require(self.institution in signers, 'invalid signers')
        return sorted(signers)

    def _op_research_section(self, actor, agent, a, now):
        purpose = self._agreed(a['purpose'], now)
        identifier(a['section_id'])
        require(not self.db.execute('SELECT 1 FROM research_artifacts WHERE artifact=?',
                                    (a['section_id'],)).fetchone(), 'artifact-exists')
        signers = self._signers(a['signers'])
        inputs = self._inputs(a['inputs'], a['owners'], purpose)
        # A joint section is usable only after every signer institution signs this version.
        self._research_insert(a['section_id'], 1, 'section', purpose, actor, 'pending', signers=signers)
        self._store_inputs(a['section_id'], 1, inputs, {}, purpose, now)
        return dict(section_id=a['section_id'], version='v1', state='pending', signers=signers)

    def _signoff(self, section, version, institution, actor):
        record = self._record(section, version)
        require(record['state'] in ('pending', 'active'), 'not-authorized')
        self.db.execute('INSERT OR REPLACE INTO research_signoffs VALUES (?,?,?,?)', (section, version, institution, actor))
        signed = {row[0] for row in self.db.execute(
            'SELECT institution FROM research_signoffs WHERE artifact=? AND version=?', (section, version))}
        if record['state'] == 'pending' and signed >= set(record['signers']):
            for (older,) in self.db.execute(
                    "SELECT version FROM research_artifacts WHERE artifact=? AND version<? AND state='active'",
                    (section, version)).fetchall():
                self._supersede(section, older)
            self.db.execute("UPDATE research_artifacts SET state='active' WHERE artifact=? AND version=?",
                            (section, version))

    def _op_research_signoff(self, actor, agent, a, now):
        """The administrator signs a section version for this institution, here or at its owner."""
        identifier(a['section_id'])
        identifier(a['owner'])
        version = a['version']
        require(type(version) is int and 1 <= version <= 999999, 'invalid artifact version')
        if a['owner'] == self.institution:
            record = self._record(a['section_id'], version)
            require(record['kind'] == 'section', 'unknown-artifact')
            self._signoff(a['section_id'], version, self.institution, actor)
            return dict(section_id=a['section_id'], version=f'v{version}', signed_here=True)
        require(a['owner'] in self._peers(), 'untrusted-institution')
        purpose = self._only_purpose(now)
        self._outbox(a['owner'], 'signoff', purpose, dict(
            artifact=a['section_id'], version=version, actor=actor), now)
        return dict(section_id=a['section_id'], version=f'v{version}', sent_to=a['owner'])

    def _only_purpose(self, now):
        purposes = {json.loads(raw)['purpose'] for (raw,) in self.db.execute('SELECT body FROM agreements')
                    if now < json.loads(raw)['expires']}
        require(len(purposes) == 1, 'purpose-required')
        return purposes.pop()

    # ------------------------------------------------------------------------------- challenge and withdrawal

    def _op_research_challenge(self, actor, agent, a, now):
        purpose = self._agreed(a['purpose'], now)
        identifier(a['challenge_id'])
        identifier(a['cited_result'])
        _text(a['banner'], 200)
        require(not self.db.execute('SELECT 1 FROM research_challenges WHERE challenge=?',
                                    (a['challenge_id'],)).fetchone(), 'challenge-exists')
        # The challenge goes out before any `affected` event it causes.
        self._broadcast('challenge', purpose, dict(
            challenge_id=a['challenge_id'], cited_result=a['cited_result'], banner=a['banner']), now)
        self._challenge(a['challenge_id'], a['cited_result'], a['banner'], purpose, self.institution, now)
        return dict(challenge_id=a['challenge_id'], cited_result=a['cited_result'], blocks=False)

    def _op_research_dissent(self, actor, agent, a, now):
        purpose = self._agreed(a['purpose'], now)
        identifier(a['cited_result'])
        _text(a['details'], 500)
        self.db.execute('INSERT OR REPLACE INTO research_dissents VALUES (?,?,?,?)',
                        (a['cited_result'], self.institution, actor, a['details']))
        self._broadcast('dissent', purpose, dict(cited_result=a['cited_result'], actor=actor, details=a['details']), now)
        return dict(cited_result=a['cited_result'], dissent_by=actor, blocks=False)

    def _op_research_withdraw(self, actor, agent, a, now):
        purpose = self._agreed(a['purpose'], now)
        identifier(a['cited_result'])
        require(not self.db.execute('SELECT 1 FROM research_withdrawn WHERE cited_result=?',
                                    (a['cited_result'],)).fetchone(), 'already-withdrawn')
        self._broadcast('withdraw', purpose, dict(cited_result=a['cited_result']), now)
        self._withdraw(a['cited_result'], purpose, now)
        return dict(cited_result=a['cited_result'], withdrawn=True)

    # ------------------------------------------------------------------------------- repair

    def _new_version(self, artifact, version, record, actor, inputs, relations, now, **fields):
        new = version + 1
        state = 'pending' if record['kind'] == 'section' else 'active'
        self._research_insert(artifact, new, record['kind'], record['purpose'], actor, state,
                     signers=record['signers'], **fields)
        self._store_inputs(artifact, new, inputs, relations, record['purpose'], now)
        if state == 'active':
            self._supersede(artifact, version)
        return new

    def _op_research_replace(self, actor, agent, a, now):
        version, record = self._research_owned(a['claim_id'], 'claim', actor)
        identifier(a['new_source'])
        row = self.db.execute('SELECT relation,label FROM research_artifacts WHERE artifact=? AND version=?',
                              (a['claim_id'], version)).fetchone()
        new = version + 1
        self._research_insert(a['claim_id'], new, 'claim', record['purpose'], actor, 'active', cited=a['new_source'],
                     reliance=record['reliance'], relation=row[0], label=row[1], evidence=record['evidence'])
        self._supersede(a['claim_id'], version)
        return dict(claim_id=a['claim_id'], active_version=f'v{new}', superseded=f'v{version}')

    def _op_research_rebase(self, actor, agent, a, now):
        version, record = self._research_owned(a['derived_id'], 'derived', actor)
        inputs = self._inputs(a['inputs'], a['owners'], record['purpose'])
        new = self._new_version(a['derived_id'], version, record, actor, inputs, {}, now)
        return dict(derived_id=a['derived_id'], active_version=f'v{new}', superseded=f'v{version}')

    def _op_research_reassess(self, actor, agent, a, now):
        """A person keeps a derived claim but changes one edge, with a rationale checksum."""
        version, record = self._research_owned(a['derived_id'], 'derived', actor)
        identifier(a['input'])
        require(a['relation'] in RELATIONS, 'invalid-request')
        hash_value(a['rationale_sha256'])
        rows = self.db.execute('SELECT input,input_version,owner,relation FROM research_inputs '
                               'WHERE artifact=? AND version=? ORDER BY input', (a['derived_id'], version)).fetchall()
        require(any(row[0] == a['input'] for row in rows), 'unknown-artifact')
        relations = {row[0]: row[3] for row in rows}
        relations[a['input']] = a['relation']
        new = self._new_version(a['derived_id'], version, record, actor, [row[:3] for row in rows], relations, now,
                                rationale=a['rationale_sha256'])
        return dict(derived_id=a['derived_id'], active_version=f'v{new}', superseded=f'v{version}',
                    input=a['input'], relation=a['relation'])

    def _op_research_revise_section(self, actor, agent, a, now):
        version, record = self._research_owned(a['section_id'], 'section', actor)
        inputs = self._inputs(a['inputs'], a['owners'], record['purpose'])
        new = self._new_version(a['section_id'], version, record, actor, inputs, {}, now)
        return dict(section_id=a['section_id'], version=f'v{new}', state='pending', signers=record['signers'])

    def _op_research_retract(self, actor, agent, a, now):
        """The owner withdraws its own claim: the version is blocked here and at every relying institution."""
        identifier(a['artifact_id'])
        row = self._research_current(a['artifact_id'])
        require(row is not None and institution_of(actor) == self.institution, 'unknown-artifact')
        self._block(a['artifact_id'], row[0], f"retracted:{a['artifact_id']}", now)
        return dict(artifact_id=a['artifact_id'], version=f'v{row[0]}', blocked=True)

    # ------------------------------------------------------------------------------- reads

    def _parties(self, author):
        return [author], list(dict.fromkeys([author, self.administrator]))

    def _dissents(self, cited):
        return [dict(type='dissent', target=row[0], institution=row[1], by=row[2], details=row[3])
                for row in self.db.execute('SELECT cited_result,institution,actor,details FROM research_dissents '
                                           'WHERE cited_result=? ORDER BY institution,actor', (cited,))]

    def _notice(self, artifact, version, challenge, owner, passage):
        record = self._record(artifact, version)
        cited, banner = self.db.execute('SELECT cited_result,banner FROM research_challenges WHERE challenge=?',
                                        (challenge,)).fetchone()
        if record['kind'] == 'claim':
            evidence = {name: record['evidence'][name] for name in EVIDENCE}
            repairs = CLAIM_REPAIRS
        else:
            evidence = dict(citing_work_version='derived', passage_position=f'claim-input-edge:{owner}',
                            passage_sha256=passage, label_source='M4')
            repairs = DERIVED_REPAIRS
        # A proposed claim is never marked, so every notice rests on a person's record.
        evidence['human_confirmed'] = record['state'] != 'proposed'
        contributors, parties = self._parties(record['author'])
        return dict(
            affected_claim=dict(id=artifact, version=f'v{version}'),
            evidence=evidence,
            source_and_version=dict(cited_result=cited, version=NO_VERSION, challenge_event=challenge,
                                    simulated_label=banner),
            responsible=dict(institution=self.institution, contributors=contributors),
            disagreement=self._dissents(cited),
            repair=dict(permitted_actions=list(repairs), parties_able_to_act=parties))

    def _op_research_notices(self, actor, agent, a, now):
        purpose = self._agreed(a['purpose'], now)
        notices = []
        for artifact, version, challenge, owner, passage in self.db.execute(
                'SELECT m.artifact,m.version,m.challenge,m.via_owner,m.via_passage FROM research_marks m '
                'JOIN research_artifacts r ON r.artifact=m.artifact AND r.version=m.version '
                "WHERE r.purpose=? AND r.kind IN ('claim','derived') ORDER BY m.challenge,m.artifact,m.version",
                (purpose,)).fetchall():
            notices.append(self._notice(artifact, version, challenge, owner, passage))
        return dict(institution=self.institution, purpose=purpose, notices=notices)

    def _op_research_status(self, actor, agent, a, now):
        key = a['artifact_key']
        if type(key) is str and VERSIONED.fullmatch(key):
            artifact, version = parse_key(key)
        else:
            identifier(key)
            artifact = key
            row = self._research_current(artifact)
            version = row[0] if row else None
        record = None
        if version is not None:
            row = self.db.execute('SELECT 1 FROM research_artifacts WHERE artifact=? AND version=?',
                                  (artifact, version)).fetchone()
            record = self._record(artifact, version) if row else None
        if record is None:
            return dict(artifact_key=key, state='unknown', blocked=False, marked=[], is_usable=False)
        self._agreed(record['purpose'], now)
        blocked = bool(self.db.execute('SELECT 1 FROM research_blocks WHERE artifact=? AND version=?',
                                       (artifact, version)).fetchone())
        marked = [row[0] for row in self.db.execute(
            'SELECT challenge FROM research_marks WHERE artifact=? AND version=? ORDER BY challenge', (artifact, version))]
        usable = record['state'] in ('active', 'superseded') and not blocked
        return dict(artifact_key=f'{artifact}:v{version}', state=record['state'], blocked=blocked, marked=marked,
                    is_usable=usable)

    def _op_research_audit(self, actor, agent, a, now):
        """What this node learned from peers, for the leak count. Identifiers only."""
        return dict(
            institution=self.institution,
            inbox=[dict(issuer=row[0], kind=row[1], subject=row[2]) for row in self.db.execute(
                'SELECT issuer,kind,subject FROM research_inbox ORDER BY issuer,kind,subject')],
            artifacts=sorted({row[0] for row in self.db.execute('SELECT artifact FROM research_artifacts')}),
            foreign_inputs=[dict(artifact=row[0], version=row[1], owner=row[2]) for row in self.db.execute(
                'SELECT DISTINCT input,input_version,owner FROM research_inputs WHERE owner<>? ORDER BY input',
                (self.institution,))],
            dependents=[dict(artifact=row[0], version=row[1], institution=row[2]) for row in self.db.execute(
                'SELECT artifact,version,institution FROM research_dependents WHERE institution<>? '
                'ORDER BY artifact,version,institution', (self.institution,))],
            pending_events=self.db.execute('SELECT COUNT(*) FROM research_outbox').fetchone()[0],
            send_failures=[dict(recipient=row[0], kind=row[1], error=row[2]) for row in self.db.execute(
                'SELECT recipient,kind,error FROM research_send_failures ORDER BY sequence')])
