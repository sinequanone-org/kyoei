"""Collaboration 2 on the Kyoei node collaboration 1 left behind (P2.1, L-01): what the public continuation adds.

The node opens the same database, key and custody under the unchanged lifecycle store; this subclass adds only
what P2.1 asks of both arms. A platform result enters as labelled facts and is never official. A person names
what a contribution is and how it relates, beside the inputs capture records, so a challenge is told of a change
without being blocked by it. An institution's dissent is signed by that institution, recorded apart from sign-off,
and accepted in place of it when the draft is published. A public package needs each contributing institution's
signed consent to this exact output and license, carries nothing private or outside the purpose, and after a
correction stays readable with managed endorsement stopped. Another institution's agent works in a draft only
under a grant its own institution signed. A Git event or a renamed file never authorizes. Each statement crossing
nodes follows the lease pattern: the issuing node signs it, and the receiving node checks it against the pinned
institution key. One operator still runs every node and holds every actor key.
"""
import json
import re

from scripts.context_shards import digest, hash_value, identifier, integer
from scripts.contributions import ContributionStore, validate_document
from scripts.institution_identity import _verify, institution_of
from scripts.lifecycle_status import closure, envelope, pin, signed
from scripts.lifecycle_store import LifecycleStore
from scripts.research_evidence import canonical
from scripts.review_verdict import MAX_BYTES, MAX_TIME, bounded_list
from scripts.shared_draft import MAX_CONTRIBUTORS, MAX_REVISIONS
from scripts.task_data import require

DISSENT = 'kyoei-continuation-dissent-v1'
CONSENT = 'kyoei-continuation-consent-v1'
GRANT = 'kyoei-continuation-draft-grant-v1'
SIGNED = ('domain', 'deployment', 'institution', 'institution_version', 'actor', 'issued')
DISSENT_FIELDS = SIGNED + ('host', 'draft', 'head', 'challenge')
CONSENT_FIELDS = SIGNED + ('owner', 'output', 'purpose', 'license')
GRANT_FIELDS = SIGNED + ('agent', 'host', 'draft', 'inputs', 'purpose', 'budget', 'expires')
IMPORT_FIELDS = ('commit', 'ended', 'fingerprint', 'label', 'license', 'official_result', 'pull', 'repository',
                 'stores_code')
ORIGINS = ('method', 'observation', 'challenge')
RELATIONS = ('builds-on', 'challenges', 'cites', 'reproduces')
LICENSES = ('Apache-2.0', 'CC-BY-4.0', 'MIT')
GIT_EVENTS = ('commit', 'push', 'merge', 'tag', 'force-push', 'history-rewrite', 'tag-delete', 'git-push')
FILE_EVENTS = ('rename-file',)
CORRECTION = ('correction-pending', 'replacement-required')
# A person from another institution deposits what its own node signed, or reads a public package.
FOREIGN_PEOPLE = ('accept_dissent', 'accept_consent', 'read_public')
# Another institution's agent, only under a grant its own institution signed.
FOREIGN_AGENTS = ('agent_draft_head', 'agent_draft_revise')
TABLES = (
    '''CREATE TABLE IF NOT EXISTS continuation_imports (artifact TEXT PRIMARY KEY REFERENCES nodes(digest),
        record BLOB NOT NULL, supersedes TEXT)''',
    '''CREATE TABLE IF NOT EXISTS continuation_origins (artifact TEXT NOT NULL REFERENCES nodes(digest),
        relation TEXT NOT NULL, target TEXT NOT NULL, kind TEXT NOT NULL, author TEXT NOT NULL,
        PRIMARY KEY(artifact, relation, target))''',
    '''CREATE TABLE IF NOT EXISTS continuation_dissents (draft TEXT NOT NULL, head TEXT NOT NULL,
        institution TEXT NOT NULL, actor TEXT NOT NULL, challenge TEXT NOT NULL, envelope BLOB NOT NULL,
        PRIMARY KEY(draft, head, institution))''',
    '''CREATE TABLE IF NOT EXISTS continuation_consents (output TEXT NOT NULL REFERENCES nodes(digest),
        institution TEXT NOT NULL, license TEXT NOT NULL, actor TEXT NOT NULL, envelope BLOB NOT NULL,
        PRIMARY KEY(output, institution, license))''',
    '''CREATE TABLE IF NOT EXISTS continuation_packages (artifact TEXT PRIMARY KEY REFERENCES nodes(digest),
        output TEXT NOT NULL, supersedes TEXT, body BLOB NOT NULL)''',
)


def _document(title, body, uncertainty, kind='finding'):
    return dict(contribution_type=kind, title=title, body=body, uncertainty=uncertainty, evidence=[],
                attachments=[])


class ContinuationStore(LifecycleStore):
    OPERATIONS = dict(LifecycleStore.OPERATIONS,
                      credential=((), ()),
                      import_record=(('record', 'recipients', 'supersedes', 'purpose', 'expires'), ()),
                      relabel=(('artifact', 'official_result'), ()),
                      originate=(('kind', 'artifact', 'relation', 'target'), ()),
                      draft_grant=(('agent', 'host', 'draft', 'inputs', 'purpose', 'budget', 'expires'), ()),
                      agent_draft_head=(('draft', 'grant'), ()),
                      agent_draft_revise=(('draft', 'base', 'document', 'grant'), ()),
                      dissent=(('host', 'draft', 'head', 'challenge'), ()),
                      accept_dissent=(('envelope',), ()),
                      mark_signoff=(('draft', 'artifact'), ()),
                      preview=(('output',), ()),
                      consent=(('owner', 'output', 'purpose', 'license'), ()),
                      accept_consent=(('envelope',), ()),
                      public_export=(('output', 'license', 'supersedes'), ()),
                      use=(('artifact', 'purpose'), ()),
                      admit=(('artifact', 'purpose'), ()),
                      source_event=(('kind', 'artifact'), ()),
                      read_public=(('package',), ()),
                      notices=(('purpose',), ()))
    READS = LifecycleStore.READS + ('credential', 'preview', 'use', 'read_public', 'notices')
    ADMINISTRATIVE = LifecycleStore.ADMINISTRATIVE + ('import_record', 'consent')
    # Reaching these, an agent learns only the refusal a person would get first; each checks who asks itself.
    DELEGATED = LifecycleStore.DELEGATED + ('relabel', 'public_export')

    def __init__(self, path, **kwargs):
        super().__init__(path, **kwargs)
        for statement in TABLES:
            self.db.execute(statement)

    def _dispatch(self, actor, credential, home, operation, arguments, now):
        if not home and operation in FOREIGN_PEOPLE:
            require(credential['kind'] == 'human', 'human-required')
            return getattr(self, '_op_' + operation)(actor, False, arguments, now)
        if not home and operation in FOREIGN_AGENTS:
            require(credential['kind'] == 'agent', 'human-required')
            return getattr(self, '_op_' + operation)(actor, True, arguments, now)
        require(operation not in FOREIGN_AGENTS, 'wrong-owner')
        return super()._dispatch(actor, credential, home, operation, arguments, now)

    # ------------------------------------------------------------------------------------------ signed statements

    def _sign(self, domain, actor, now, **fields):
        return signed(self.private_key, dict(domain=domain, deployment=self.deployment, institution=self.institution,
                                             institution_version=self.key_version, actor=actor, issued=now,
                                             **fields))

    def _checked(self, statement, domain, names, now):
        """Another institution's statement, checked against its pinned key; its own actor must deposit it."""
        try:
            body = envelope(statement, names)
        except ValueError as exc:
            raise ValueError('invalid-request') from exc
        require(body['domain'] == domain and body['deployment'] == self.deployment and
                body['institution'] != self.institution and type(body['issued']) is int and body['issued'] <= now,
                'invalid-request')
        pinned = pin(self.db, body['institution'], body['institution_version'], now)
        _verify(pinned[1], statement['signature'], body, 'invalid-signature')
        return body

    # ------------------------------------------------------------------------------------------------ helpers

    def _agreement(self, purpose, now):
        for (raw,) in self.db.execute('SELECT body FROM agreements ORDER BY agreement'):
            terms = json.loads(raw)
            if terms['purpose'] == purpose and now < terms['expires']:
                return terms['agreement']
        raise ValueError('agreement-required')

    def _held(self, key):
        """A node here: its owner's digest, owning institution and purpose, whether published here or received."""
        view = self.db.execute('SELECT institution,artifact,purpose FROM foreign_views WHERE ref=?', (key,)).fetchone()
        if view:
            return dict(artifact=view[1], institution=view[0], purpose=view[2])
        return dict(artifact=key, institution=self.institution, purpose=self._row(key)[2])

    def _use(self, key, actor, purpose, now):
        try:
            self._usable(key, actor, purpose, now)
        except ValueError as exc:
            if str(exc) in CORRECTION:
                raise ValueError('correction-blocked') from exc
            raise

    def _managed(self, key, actor, now):
        state = self._reason(self._conditions(key, now), actor)
        return 'correction-blocked' if state in CORRECTION else state

    # --------------------------------------------------------------------------------------------- operations

    def _op_credential(self, actor, agent, a, now):
        body = self._current(actor, now)
        return dict(actor=actor, kind=body['kind'], institution=self.institution, key_version=body['key_version'],
                    expires=body['expires'], revoked=body['revoked'])

    def _op_import_record(self, actor, agent, a, now):
        """A platform result enters as labelled facts: never official, no code, its license stated, not inferred."""
        record = a['record']
        require(type(record) is dict and set(record) == set(IMPORT_FIELDS), 'invalid-request')
        require(record['official_result'] is False and record['label'] == 'platform-import', 'not-official')
        require(record['stores_code'] is False and type(record['pull']) is int and 0 < record['pull'] and
                record['license'] in LICENSES and type(record['repository']) is str and
                re.fullmatch('[0-9a-f]{40}', str(record['commit'])) and
                re.fullmatch('[0-9a-f]{64}', str(record['fingerprint'])) and
                (record['ended'] is None or type(record['ended']) is str), 'invalid-request')
        identifier(a['purpose'])
        old = a['supersedes']
        if old is not None:
            hash_value(old)
            previous = self.db.execute('SELECT record FROM continuation_imports WHERE artifact=?', (old,)).fetchone()
            require(previous is not None and json.loads(previous[0])['repository'] == record['repository'],
                    'not-authorized')
        context = self._op_open(actor, False, dict(purpose=a['purpose'], name='import-' + record['commit'][:16]),
                                now)
        document = _document(f"platform-import {record['repository']}#{record['pull']}", canonical(record).decode(),
                             'Platform import: recorded facts only, not an official result; no challenge code.')
        bounded_list(a['recipients'], 1, 16, identifier, 'recipients')
        require(a['recipients'] == sorted(set(a['recipients'])), 'noncanonical recipients')
        home = sorted({actor} | {person for person in a['recipients'] if institution_of(person) == self.institution})
        foreign = [person for person in a['recipients'] if institution_of(person) != self.institution]
        key = self._op_publish(actor, False, dict(document=document, purpose=a['purpose'], recipients=home,
                                                   expires=a['expires'], context=context), now)
        self.db.execute('INSERT OR IGNORE INTO continuation_imports VALUES (?,?,?)', (key, canonical(record), old))
        if old is not None:
            self._op_replace(actor, False, dict(artifact=old, replacement=key,
                                                reason=f"Checker changed in pull {record['pull']}."), now)
        # People are named; their agents use the import only through delegations the release allows.
        self._op_release(actor, False, dict(artifact=key, recipients=foreign, purpose=a['purpose'],
                                            expires=a['expires'], agreement=self._agreement(a['purpose'], now),
                                            delegates=True), now)
        return dict(artifact=key, label='platform-import', official_result=False, supersedes=old)

    def _op_relabel(self, actor, agent, a, now):
        key = self._local(a['artifact'])
        require(self.db.execute('SELECT 1 FROM continuation_imports WHERE artifact=?', (key,)).fetchone(),
                'not-authorized')
        require(a['official_result'] is False, 'not-official')
        return dict(artifact=key, official_result=False)

    def _op_originate(self, actor, agent, a, now):
        """A person names what their contribution is and how it relates; it is not a use, so it never blocks."""
        key, target = self._local(a['artifact']), self._local(a['target'])
        require(a['kind'] in ORIGINS and a['relation'] in RELATIONS and key != target, 'invalid-request')
        require(self._row(key)[1] == actor, 'not-authorized')
        self.db.execute('INSERT OR IGNORE INTO continuation_origins VALUES (?,?,?,?,?)',
                        (key, a['relation'], target, a['kind'], actor))
        return dict(artifact=key, kind=a['kind'], relation=a['relation'], target=target)

    def _op_draft_grant(self, actor, agent, a, now):
        """This institution lets its agent work in another node's draft for a person here who takes part in it."""
        identifier(a['host'])
        require(institution_of(a['agent']) == self.institution and a['host'] != self.institution,
                'invalid-request')
        delegate = self._current(a['agent'], now)
        require(delegate['kind'] == 'agent' and not delegate['revoked'], 'agent-required')
        hash_value(a['draft'])
        bounded_list(a['inputs'], 0, 16, hash_value, 'inputs')
        require(a['inputs'] == sorted(set(a['inputs'])), 'noncanonical inputs')
        identifier(a['purpose'])
        integer(a['budget'], 1, 64, 'delegation budget')
        integer(a['expires'], now + 1, min(self._current(actor, now)['expires'], delegate['expires']),
                'delegation expiry')
        return self._sign(GRANT, actor, now, agent=a['agent'], host=a['host'], draft=a['draft'], inputs=a['inputs'],
                          purpose=a['purpose'], budget=a['budget'], expires=a['expires'])

    def _grant(self, actor, a, now):
        body = self._checked(a['grant'], GRANT, GRANT_FIELDS, now)
        require(body['agent'] == actor and institution_of(actor) == body['institution'] and
                body['host'] == self.institution and body['draft'] == a['draft'], 'delegation-scope')
        require(institution_of(body['actor']) == body['institution'], 'delegation-scope')
        require(not self._foreign(body['actor'], now)['revoked'], 'delegation-revoked')
        integer(body['budget'], 1, 64, 'delegation budget')
        integer(body['expires'], 0, MAX_TIME, 'delegation expiry')
        self._deadline = min(self._deadline, body['expires'])
        require(now < body['expires'], 'delegation-expired')
        draft = self._draft(body['actor'], a['draft'])
        require(draft['purpose'] == body['purpose'], 'delegation-scope')
        return body, draft

    def _op_agent_draft_head(self, actor, agent, a, now):
        body, draft = self._grant(actor, a, now)
        result = self._op_draft_head(body['actor'], False, dict(draft=a['draft']), now)
        require(set(item['artifact'] for item in result['inputs']) <= set(body['inputs']), 'delegation-scope')
        return result

    def _op_agent_draft_revise(self, actor, agent, a, now):
        """The agent's revision, attributed to it and to the person it works for, within the grant's budget."""
        body, draft = self._grant(actor, a, now)
        self._writable(draft, now)
        document = a['document']
        require(type(document) is dict and document.get('evidence') == [], 'inputs-are-captured')
        validate_document(document)
        head = self._revision(draft)
        inputs = head['inputs'] if head else []
        require(set(inputs) <= set(body['inputs']), 'delegation-scope')
        self._current_head(draft, a['base'])
        require(draft['revisions'] < MAX_REVISIONS, 'draft-full')
        require(len(self._contributors(draft, [actor, body['actor']])) <= MAX_CONTRIBUTORS, 'too-many-contributors')
        grant = digest(body)
        used = self.db.execute('SELECT COUNT(*) FROM draft_revisions WHERE delegation=?', (grant,)).fetchone()[0]
        require(used < body['budget'], 'delegation-budget')
        self._admissible(draft, inputs, body['actor'], now)
        revision = dict(kind='draft-revision', version=1, draft=draft['id'], base=a['base'], author=actor,
                        principal=body['actor'], delegation=grant, document=document, inputs=inputs,
                        request=self._request, at=now)
        content = canonical(revision)
        require(len(content) <= MAX_BYTES, 'revision too large')
        key = digest(revision)
        self.db.execute('INSERT INTO draft_revisions VALUES (?,?,?,?,?,?,?,?)',
                        (key, draft['id'], a['base'], actor, body['actor'], grant, content, now))
        self.db.execute('UPDATE shared_drafts SET head=?, revisions=revisions+1 WHERE id=?', (key, draft['id']))
        return dict(kind='draft-revision', draft=draft['id'], revision=key, base=a['base'], head=key, inputs=inputs)

    def _op_dissent(self, actor, agent, a, now):
        """This institution's challenge, signed here, to stand beside a draft's sign-offs at its host."""
        challenge = self._local(a['challenge'])
        require(self.db.execute("SELECT 1 FROM continuation_origins WHERE artifact=? AND kind='challenge' AND "
                                "author=?", (challenge, actor)).fetchone(), 'not-authorized')
        hash_value(a['draft'])
        hash_value(a['head'])
        identifier(a['host'])
        require(a['host'] != self.institution, 'invalid-request')
        return self._sign(DISSENT, actor, now, host=a['host'], draft=a['draft'], head=a['head'], challenge=challenge)

    def _op_accept_dissent(self, actor, agent, a, now):
        body = self._checked(a['envelope'], DISSENT, DISSENT_FIELDS, now)
        require(body['actor'] == actor and body['host'] == self.institution, 'not-authorized')
        draft = self._draft(actor, body['draft'])
        self._writable(draft, now)
        self._current_head(draft, body['head'])
        # The challenge is one this node holds from the dissenting institution.
        require(self.db.execute('SELECT 1 FROM foreign_views WHERE institution=? AND artifact=?',
                                (body['institution'], body['challenge'])).fetchone(), 'not-authorized')
        old = self.db.execute('SELECT challenge FROM continuation_dissents WHERE draft=? AND head=? AND '
                              'institution=?', (body['draft'], body['head'], body['institution'])).fetchone()
        require(old is None or old[0] == body['challenge'], 'conflicting-dissent')
        self.db.execute('INSERT OR IGNORE INTO continuation_dissents VALUES (?,?,?,?,?,?)',
                        (body['draft'], body['head'], body['institution'], actor, body['challenge'],
                         canonical(a['envelope'])))
        return dict(draft=body['draft'], head=body['head'], dissent=sorted(self._dissent(body['draft'], body['head'])))

    def _dissent(self, draft, head):
        return {row[0]: row[1] for row in self.db.execute(
            'SELECT institution,challenge FROM continuation_dissents WHERE draft=? AND head=?', (draft, head))}

    def _op_draft_publish(self, actor, agent, a, now):
        """As the draft store's publication, except that a recorded dissent stands in place of that sign-off."""
        draft = self._draft(actor, a['draft'])
        self._writable(draft, now)
        integer(a['expires'], now + 1, draft['expires'], 'output expiry')
        bound = self._output(a['output'])
        self._current_head(draft, a['head'])
        require(draft['revisions'] > 0, 'empty-draft')
        signers = [row[0] for row in self.db.execute('SELECT actor FROM draft_signoffs WHERE draft=? AND head=? '
                                                     'AND output=? ORDER BY actor',
                                                     (draft['id'], draft['head'], bound))]
        signers = [person for person in signers if not self._credential(person, now)['revoked']]
        missing = sorted({institution_of(person) for person in draft['participants']} -
                         {institution_of(person) for person in signers} - set(self._dissent(draft['id'],
                                                                                          draft['head'])))
        require(not missing, 'signoff-required:' + ','.join(missing))
        head = self._revision(draft)
        inputs = head['inputs']
        self._admissible(draft, inputs, actor, now)
        contributors = self._contributors(draft, [actor])
        home = [person for person in draft['participants'] if institution_of(person) == self.institution]
        foreign = [person for person in draft['participants'] if institution_of(person) != self.institution]
        shared = ContributionStore.publish(self, dict(head['document'], evidence=inputs), actor=actor, purpose=draft['purpose'],
                              recipients=home, expires=a['expires'], contributors=contributors)
        self._capture(shared, [(key, 'use') for key in inputs], [], [], self._prior(shared))
        key = ContributionStore.publish(self, dict(a['output'], evidence=[shared]), actor=actor, purpose=draft['purpose'],
                           recipients=home, expires=a['expires'], contributors=contributors)
        self._capture(key, [(shared, 'use')], [], [], self._prior(key))
        release = self._op_release(actor, False, dict(artifact=key, recipients=foreign, purpose=draft['purpose'],
                                                      expires=a['expires'], agreement=draft['agreement'],
                                                      delegates=False), now)
        self.db.execute('UPDATE shared_drafts SET published_draft=?, published=? WHERE id=?',
                        (shared, key, draft['id']))
        return dict(kind='draft-publication', draft=draft['id'], head=draft['head'], draft_artifact=shared,
                    artifact=key, release=release, contributors=contributors, signoffs=signers,
                    dissent=sorted(self._dissent(draft['id'], draft['head'])), expires=a['expires'])

    def _op_mark_signoff(self, actor, agent, a, now):
        """Only a participant's own sign-off counts; a recorded challenge never becomes one."""
        hash_value(a['draft'])
        hash_value(a['artifact'])
        require(not self.db.execute('SELECT 1 FROM continuation_dissents WHERE draft=? AND challenge=?',
                                    (a['draft'], a['artifact'])).fetchone(), 'dissent-not-signoff')
        raise ValueError('signoff-required')

    def _members(self, output, now):
        """The output's managed closure as a public package would carry it; a published draft travels in its output."""
        row = self._row(output)
        working = {draft for (draft,) in self.db.execute('SELECT published_draft FROM shared_drafts WHERE '
                                                         'published=?', (output,))}
        members = []
        for key in closure(self.db, output):
            if key in working:
                continue
            require(not self.db.execute('SELECT 1 FROM private_sources WHERE artifact=?', (key,)).fetchone(),
                    'isolation')
            held = self._held(key)
            require(held['purpose'] == row[2], 'isolation')
            members.append(dict(artifact=held['artifact'], institution=held['institution']))
        return sorted(members, key=lambda item: item['artifact']), row

    def _dissent_of(self, output):
        rows = self.db.execute('SELECT id,head FROM shared_drafts WHERE published=?', (output,)).fetchall()
        return {institution: challenge for draft, head in rows for institution, challenge in
                self._dissent(draft, head).items()}

    def _consents(self, output, license_id):
        return {row[0]: row[1] for row in self.db.execute(
            'SELECT institution,envelope FROM continuation_consents WHERE output=? AND license=?',
            (output, license_id))}

    def _op_preview(self, actor, agent, a, now):
        output = self._local(a['output'])
        members, row = self._members(output, now)
        self._use(output, actor, row[2], now)
        consented = {}
        for institution, license_id in self.db.execute('SELECT institution,license FROM continuation_consents '
                                                       'WHERE output=? ORDER BY institution,license', (output,)):
            consented.setdefault(institution, []).append(license_id)
        return dict(output=output, members=members,
                    consent_required=sorted({item['institution'] for item in members}), consented=consented,
                    dissent=self._dissent_of(output), licenses=list(LICENSES), bytes_revocable=False)

    def _op_consent(self, actor, agent, a, now):
        """This institution's consent to publish this exact output under this license; a new version needs a new one."""
        identifier(a['owner'])
        hash_value(a['output'])
        identifier(a['purpose'])
        require(a['license'] in LICENSES, 'invalid-request')
        statement = self._sign(CONSENT, actor, now, owner=a['owner'], output=a['output'], purpose=a['purpose'],
                               license=a['license'])
        if a['owner'] != self.institution:
            return statement
        output = self._local(a['output'])
        require(self._row(output)[2] == a['purpose'], 'not-authorized')
        self._use(output, actor, a['purpose'], now)
        self.db.execute('INSERT OR REPLACE INTO continuation_consents VALUES (?,?,?,?,?)',
                        (output, self.institution, a['license'], actor, canonical(statement)))
        return dict(output=output, consented=sorted(self._consents(output, a['license'])))

    def _op_accept_consent(self, actor, agent, a, now):
        body = self._checked(a['envelope'], CONSENT, CONSENT_FIELDS, now)
        require(body['actor'] == actor and body['owner'] == self.institution and body['license'] in LICENSES,
                'not-authorized')
        output = self._local(body['output'])
        require(self._row(output)[2] == body['purpose'], 'not-authorized')
        self.db.execute('INSERT OR REPLACE INTO continuation_consents VALUES (?,?,?,?,?)',
                        (output, body['institution'], body['license'], actor, canonical(a['envelope'])))
        return dict(output=output, consented=sorted(self._consents(output, body['license'])))

    def _op_public_export(self, actor, agent, a, now):
        """A public package: every contributing institution consented, nothing private, nothing blocked."""
        output, license_id = self._local(a['output']), a['license']
        require(license_id in LICENSES, 'invalid-request')
        members, row = self._members(output, now)
        consents = self._consents(output, license_id)
        institutions = sorted({item['institution'] for item in members})
        # Consent is checked before who asks: an agent learns only that the institutions have not all agreed.
        require(all(institution in consents for institution in institutions), 'consent-required')
        require(not agent, 'human-required')
        require(actor in (row[1], self.administrator), 'owner-required')
        self._use(output, actor, row[2], now)
        dissent, old = self._dissent_of(output), a['supersedes']
        if old is not None:
            hash_value(old)
            previous = self.db.execute('SELECT body FROM continuation_packages WHERE artifact=?', (old,)).fetchone()
            require(previous is not None, 'not-authorized')
            dissent = {**json.loads(previous[0])['dissent'], **dissent}
        imports = {key for (key,) in self.db.execute('SELECT artifact FROM continuation_imports')}
        package = dict(kind='public-package', output=output, purpose=row[2], license=license_id, members=members,
                       consents={key: digest(json.loads(consents[key])) for key in institutions}, dissent=dissent,
                       imports=sorted(item['artifact'] for item in members if item['artifact'] in imports),
                       official_result=False, bytes_revocable=False)
        key = ContributionStore.publish(self, dict(_document('public package', canonical(package).decode(),
                                          'Public package; managed endorsement can stop, published bytes stay.'),
                                evidence=[output]), actor=actor, purpose=row[2], recipients=[actor],
                           expires=row[4])
        self._capture(key, [(output, 'use')], [], [], self._prior(key))
        self.db.execute('INSERT OR IGNORE INTO continuation_packages VALUES (?,?,?,?)',
                        (key, output, old, canonical(package)))
        if old is not None:
            self._op_replace(actor, False, dict(artifact=old, replacement=key, reason='A corrected package.'), now)
        return dict(package=key, members=[item['artifact'] for item in members], license=license_id,
                    dissent=sorted(dissent))

    def _op_use(self, actor, agent, a, now):
        key = self._local(a['artifact'])
        identifier(a['purpose'])
        self._use(key, actor, a['purpose'], now)
        return dict(artifact=key, state='active')

    def _op_admit(self, actor, agent, a, now):
        """Nothing private and nothing granted for another purpose enters this purpose's work."""
        key = self._local(a['artifact'])
        identifier(a['purpose'])
        require(not self.db.execute('SELECT 1 FROM private_sources WHERE artifact=?', (key,)).fetchone(), 'isolation')
        require(self._held(key)['purpose'] == a['purpose'], 'new-grant-required')
        return dict(artifact=key, admitted=True)

    def _op_source_event(self, actor, agent, a, now):
        """A commit, push, tag or renamed file is a locator; it never grants, extends or revives use."""
        hash_value(a['artifact'])
        require(a['kind'] not in GIT_EVENTS, 'git-not-authority')
        require(a['kind'] not in FILE_EVENTS, 'source-not-authority')
        raise ValueError('invalid-request')

    def _op_read_public(self, actor, agent, a, now):
        """Public bytes stay readable after a correction; the reader is told managed endorsement stopped."""
        hash_value(a['package'])
        row = self.db.execute('SELECT body FROM continuation_packages WHERE artifact=?', (a['package'],)).fetchone()
        require(row is not None, 'not-authorized')
        managed = self._managed(a['package'], None, now)
        return dict(package=a['package'], content=json.loads(row[0]), managed=managed, bytes_revoked=False,
                    notice=None if managed == 'active' else 'managed-endorsement-stopped')

    def _op_notices(self, actor, agent, a, now):
        """A citation or challenge whose target changed is reported; the citing work is not blocked."""
        identifier(a['purpose'])
        notices = []
        for artifact, relation, target in self.db.execute('SELECT artifact,relation,target FROM continuation_origins '
                                                          'WHERE author=? ORDER BY artifact,relation,target',
                                                          (actor,)).fetchall():
            state = self._reason(self._conditions(target, now), actor)
            if state != 'active':
                notices.append(dict(artifact=artifact, relation=relation, target=target, target_state=state,
                                    blocks=False))
        return dict(notices=notices)
