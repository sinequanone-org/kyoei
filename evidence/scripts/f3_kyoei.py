"""F3 Kyoei arm: one process per institution, every step a signed client request.

The driver acts only as each institution's own people and agents, on that
institution's own node. Nothing crosses between institutions except the nodes'
signed relay events. The driver reads the scenario and the M4 declarations, never
the oracle or the reviewer labels. It records what each node answered. The scorer
and `scripts/f3_measures.py` rebuild every number from this report.

The output is a diagnostic run, status `in-repair`: the reference arm has not been
rebuilt with one process per institution, so no comparison exists.
"""
import argparse
import hashlib
import json
import tempfile
import time
from pathlib import Path

from scripts.actor_request import sign_request
from scripts.f3_contract import verify as verify_contract
from scripts.f3_measures import measures
from scripts.pq_crypto import SigningKey
from scripts.priority_one import ROOT
from scripts.research_relay import RelayNode

BASE = ROOT / 'research' / 'priority-four' / 'f3'
OUTPUT = ROOT / 'research' / 'experiments' / 'f3-kyoei-relay' / 'report.json'
SOURCES = ('scripts/f3_kyoei.py', 'scripts/f3_store.py', 'scripts/research_relay.py',
           'scripts/f3_measures.py', 'scripts/continuation_store.py')
PURPOSE = 'f3-repair-experience'
DEPLOYMENT = 'f3-kyoei'
INSTITUTIONS = ('a', 'b', 'c')
NOW = 1000000
LIFE = 1000000


def sha256_file(path):
    return hashlib.sha256((ROOT / path).read_bytes()).hexdigest()


def public(key):
    return key.public_key().public_bytes_raw().hex()


class Arm:
    def __init__(self, root, scenario):
        self.scenario = scenario
        self.people = scenario['institutions']
        self.keys = {name: SigningKey.generate() for roles in self.people.values() for name in roles.values()}
        self.custody = {inst: SigningKey.generate() for inst in INSTITUTIONS}
        self.trace, self.phase = [], 'setup'
        self.nodes = {}
        for inst in INSTITUTIONS:
            lead = self.people[inst]['lead']
            self.nodes[inst] = RelayNode(
                Path(root) / f'{inst}.sqlite', deployment=DEPLOYMENT, institution=inst,
                private_key=self.custody[inst], administrator=lead, administrator_public=public(self.keys[lead]),
                key_expires=NOW + LIFE, max_age=300, now=NOW)
        for inst, node in self.nodes.items():
            node.set_peers({other: self.nodes[other].url for other in INSTITUTIONS if other != inst})

    def close(self):
        for node in self.nodes.values():
            node.close()

    def human(self, inst):
        roles = self.people[inst]
        return next(name for role, name in roles.items() if role not in ('lead', 'agent'))

    def act(self, actor, operation, arguments, role='adopter'):
        """One signed request by `actor` to the actor's own institution node."""
        inst = actor.split('.', 1)[0]
        envelope = sign_request(self.keys[actor], deployment=DEPLOYMENT, node=inst, actor=actor, key_version=1,
                                operation=operation, arguments=arguments, issued=NOW, expires=NOW + 60)
        row = dict(step=len(self.trace), phase=self.phase, role=role, institution=inst, actor=actor,
                   operation=operation)
        try:
            result, relay = self.nodes[inst].handle(envelope)
        except ValueError as exc:
            self.trace.append(dict(row, outcome='refused', error=str(exc)))
            raise
        self.trace.append(dict(row, outcome='ok', relay=dict(
            delivered=relay['delivered'], refused=len(relay['refused']), unavailable=relay['unavailable'],
            refusals=relay['refused'])))
        return result

    def read(self, actor, operation, arguments):
        return self.act(actor, operation, arguments, role='observation')

    # ------------------------------------------------------------------ phases

    def setup(self):
        self.phase = 'setup'
        for inst in INSTITUTIONS:
            lead = self.people[inst]['lead']
            for other in INSTITUTIONS:
                if other != inst:
                    self.act(lead, 'trust', dict(institution=other, public=public(self.custody[other]),
                                                 version=1, expires=NOW + LIFE))
            self.act(lead, 'accept', dict(agreement='f3', version=1,
                                          terms=hashlib.sha256(b'f3-terms').hexdigest(),
                                          purpose=PURPOSE, expires=NOW + LIFE))
            for role, name in self.people[inst].items():
                if role == 'lead':
                    continue
                self.act(lead, 'enroll', dict(actor=name, kind='agent' if role == 'agent' else 'human',
                                              public=public(self.keys[name]), expires=NOW + LIFE))

    def declare(self, declarations):
        self.phase = 'declaration'
        claims = self.scenario['first_hop_claims']
        for unit, row in sorted(declarations['units'].items()):
            claim = claims[row['claim_id']]
            inst = claim['institution']
            evidence = dict(citing_work_version=claim['version'], passage_position=claim['position'],
                            passage_sha256=claim['passage_sha256'], label_source='M4')
            self.act(self.people[inst]['agent'], 'research_claim', dict(
                claim_id=row['claim_id'], unit_id=unit, cited_result=row['cited_result'], evidence=evidence,
                relation=row['m4_relation'], label=row['m4_label'], purpose=PURPOSE))
            self.act(self.human(inst), 'research_confirm', dict(claim_id=row['claim_id']))
        for derived, row in sorted(self.scenario['derived_claims'].items()):
            owners = {cid: claims[cid]['institution'] for cid in row['inputs']}
            self.act(self.human(row['institution']), 'research_derived', dict(
                derived_id=derived, inputs=[f'{cid}:v1' for cid in row['inputs']],
                owners={cid: owner for cid, owner in owners.items() if owner != row['institution']},
                purpose=PURPOSE))
        for section, row in sorted(self.scenario['sections'].items()):
            self.section(section, [f'{did}:v1' for did in row['inputs']], 1, create=True)

    def section(self, section, inputs, version, *, create):
        """Joint sections live on A's node; every institution's lead signs each version."""
        derived = self.scenario['derived_claims']
        owners = {key.split(':')[0]: derived[key.split(':')[0]]['institution'] for key in inputs}
        owners = {did: owner for did, owner in owners.items() if owner != 'a'}
        if create:
            self.act(self.people['a']['lead'], 'research_section', dict(
                section_id=section, inputs=inputs, owners=owners, signers=list(INSTITUTIONS), purpose=PURPOSE))
        else:
            self.act(self.people['a']['lead'], 'research_revise_section', dict(
                section_id=section, inputs=inputs, owners=owners))
        for inst in INSTITUTIONS:
            self.act(self.people[inst]['lead'], 'research_signoff', dict(section_id=section, version=version, owner='a'))

    def notices(self):
        return {inst: self.read(self.human(inst), 'research_notices', dict(purpose=PURPOSE))['notices']
                for inst in INSTITUTIONS}

    def statuses(self, keys):
        """Each key read at its owner's node by that institution's own person."""
        return {key: self.read(self.human(owner), 'research_status', dict(artifact_key=key))
                for key, owner in keys}

    def owners(self):
        rows = [(cid, row['institution']) for cid, row in self.scenario['first_hop_claims'].items()]
        rows += [(did, row['institution']) for did, row in self.scenario['derived_claims'].items()]
        rows += [(sid, 'a') for sid in self.scenario['sections']]
        return sorted(rows)

    def experience(self):
        run = self.scenario['experience_run']
        cited, claim = run['target_cited_result'], run['target_claim']
        banner = self.scenario['simulated_label']
        claim_owner = self.scenario['first_hop_claims'][claim]['institution']
        recorder = next(inst for inst in INSTITUTIONS if inst != claim_owner)
        observed = {}
        self.phase = 'repair'
        self.act(self.human(recorder), 'research_challenge', dict(
            challenge_id='exp.challenge', cited_result=cited, banner=banner, purpose=PURPOSE), role='external')
        observed['notices_after_challenge'] = self.notices()
        observed['status_after_challenge'] = self.statuses(self.owners())
        for event in run['events']:
            action = event['action']
            if action == 'dissent':
                self.act(event['by'], 'research_dissent', dict(
                    cited_result=event['target'], details='simulated dissent recorded by the scenario',
                    purpose=PURPOSE))
                observed['notices_after_dissent'] = self.notices()
            elif action == 'replace':
                self.act(event['by'], 'research_replace', dict(claim_id=event['subject'], new_source=event['new_source']))
            elif action == 'rebase':
                derived = self.scenario['derived_claims'][event['subject']]
                new = event['new_input']
                inputs = [new if cid == new.split(':')[0] else f'{cid}:v1' for cid in derived['inputs']]
                owners = {cid: self.scenario['first_hop_claims'][cid]['institution'] for cid in derived['inputs']}
                self.act(event['by'], 'research_rebase', dict(
                    derived_id=event['subject'], inputs=inputs,
                    owners={cid: owner for cid, owner in owners.items() if owner != event['institution']}))
            elif action == 'reassess':
                self.act(event['by'], 'research_reassess', dict(
                    derived_id=event['subject'], input=event['edge_to'], relation=event['new_relation'],
                    rationale_sha256=event['rationale_sha256']))
            elif action == 'revise_sections':
                repaired = {'derived.a.01', 'derived.c.01'}
                for section in event['sections']:
                    inputs = [f'{did}:v2' if did in repaired else f'{did}:v1'
                              for did in self.scenario['sections'][section]['inputs']]
                    self.section(section, inputs, 2, create=False)
            elif action == 'withdraw':
                self.act(self.human(recorder), 'research_withdraw', dict(cited_result=event['target'], purpose=PURPOSE),
                         role='external')
            elif action != 'challenge':
                raise ValueError('unknown scenario action ' + action)
        keys = [(f'{key}:v1', owner) for key, owner in self.owners()]
        repaired = [(claim, claim_owner), ('derived.a.01', 'a'), ('derived.c.01', 'c'),
                    ('section.01', 'a'), ('section.02', 'a')]
        keys += [(f'{key}:v2', owner) for key, owner in repaired]
        observed['status_after_withdraw'] = self.statuses(sorted(keys))
        return observed

    def batch(self):
        self.phase = 'batch'
        claims = self.scenario['first_hop_claims']
        banner = self.scenario['simulated_label']
        for index, item in enumerate(self.scenario['batch_challenges']):
            owner = claims[item['claim_id']]['institution']
            # The challenge is recorded at another institution, so every alert must cross by relay.
            recorder = [inst for inst in INSTITUTIONS if inst != owner][index % 2]
            self.act(self.human(recorder), 'research_challenge', dict(
                challenge_id=item['challenge_id'], cited_result=item['cited_result'], banner=banner,
                purpose=PURPOSE), role='external')
        return self.notices()

    def audit(self):
        return {inst: self.read(self.people[inst]['lead'], 'research_audit', {}) for inst in INSTITUTIONS}


def run(root):
    contract = verify_contract(ROOT)
    scenario = json.loads((BASE / 'scenario.json').read_text())
    declarations = json.loads((BASE / 'declarations.json').read_text())
    started = time.perf_counter()
    arm = Arm(root, scenario)
    try:
        arm.setup()
        arm.declare(declarations)
        observed = arm.experience()
        observed['notices_after_batch'] = arm.batch()
        observed['audit'] = arm.audit()
    finally:
        arm.close()
    report = dict(
        kind='f3-kyoei-relay-run', arm='kyoei', status='in-repair',
        status_note=('Diagnostic run. One process per institution; events cross only as signed relay events. '
                     'The reference arm is not rebuilt yet, so this is not a comparison and not a benchmark '
                     'result. The report stays in-repair until a separate review of this driver.'),
        contract_digest=contract['contract_digest'],
        sources={path: sha256_file(path) for path in SOURCES},
        processes=dict(per_institution=len(INSTITUTIONS), parent_holds_store=False),
        trace=arm.trace, observed=observed,
        elapsed_seconds=round(time.perf_counter() - started, 3))
    report['measures'] = measures(report)
    return report


def main():
    parser = argparse.ArgumentParser(description=__doc__.splitlines()[0])
    parser.add_argument('--output', type=Path, default=OUTPUT)
    args = parser.parse_args()
    with tempfile.TemporaryDirectory(prefix='f3-kyoei-', dir='/tmp') as root:
        report = run(root)
    args.output.parent.mkdir(parents=True, exist_ok=True)
    args.output.write_text(json.dumps(report, indent=1, sort_keys=True) + '\n')
    print(json.dumps(dict(measures=report['measures'], elapsed=report['elapsed_seconds']), sort_keys=True))


if __name__ == '__main__':
    main()
