"""Check listed quantitative statements and evidence bindings in paper.md.

Usage, from the repository root:

    python3 paper/verify.py [--draft]

Each check pairs one evidence value with the sentence fragment in paper.md that
states it, so an edit to either side fails. Without --draft, run-log placeholders
and sections still to confirm are errors. The private-name scan uses the list
outside every repository (~/.config/captain/private-names, or the path in
CAPTAIN_PRIVATE_NAMES) with the same rules as `captain leakcheck`.
"""
import hashlib
import json
import os
import re
import subprocess
import sys
from collections import Counter
from alignment import check_alignment, locations
from pathlib import Path

# Public layout: paper/ and evidence/ side by side. evidence/ keeps the paths
# of the research repository, so each evidence path below resolves under it.
ROOT = Path(__file__).resolve().parents[1] / 'evidence'
BUNDLE = Path(__file__).resolve().parent
PAPER = (BUNDLE / 'paper.md').read_text()
TEXT = ' '.join(PAPER.split())
DRAFT = '--draft' in sys.argv[1:]
failures = []
evidence_paths = set()


def load(path):
    evidence_paths.add(path)
    return json.loads((ROOT / path).read_text())


def read(path):
    evidence_paths.add(path)
    return (ROOT / path).read_text()


def sha256(path):
    evidence_paths.add(path)
    return hashlib.sha256((ROOT / path).read_bytes()).hexdigest()


def check(name, condition, *fragments):
    missing = [f for f in fragments if ' '.join(f.split()) not in TEXT]
    if not condition:
        failures.append(name + ': evidence differs')
    if missing:
        failures.append(name + ': paper text lacks ' + repr(missing))


def notice_inventory(report, scenario, oracle):
    challenges = {row['cited_result']: row['challenge_id']
                  for row in scenario['batch_challenges']}
    owners = {key: row['institution'] for key, row in scenario['derived_claims'].items()}
    expected = set()
    for cited, row in oracle['batch_run'].items():
        if row['declared_edge'] != 'builds-on':
            continue
        expected.add((challenges[cited], row['claim_id'], row['institution']))
        expected.update((challenges[cited], key, owners[key]) for key in row['downstream_derived'])
    known = set(challenges.values())
    other_events = {row['source_and_version']['challenge_event']
                    for rows in oracle['experience_run']['notices'].values() for row in rows}
    records, unknown = Counter(), set()
    for institution, rows in report['observed']['notices_after_batch'].items():
        for row in rows:
            event = row['source_and_version']['challenge_event']
            if event not in known:
                if event not in other_events:
                    unknown.add(event)
                continue
            claim = row['affected_claim']
            records[(event, claim['id'], institution, claim['version'])] += 1
    pairs = {key[:3] for key in records}
    versions = Counter(key[:3] for key in records)
    return dict(records=sum(records.values()), pairs=len(pairs), expected=len(expected),
                missing=sorted(expected - pairs), unexpected=sorted(pairs - expected),
                duplicate_records=sorted(key for key, count in records.items() if count > 1),
                multiple_versions=sorted(key for key, count in versions.items() if count > 1),
                unknown_events=sorted(unknown))


# 2 Open research platforms: replay of public challenge records.
yukon = load('research/experiments/yukon/report.json')
moves = [t for runs in yukon['transitions'].values() for t in runs]
git_only = ('git_ancestry', 'run_and_own_decision', 'scored_while_current')
check('challenge replay', yukon['credits']['ecdsafail-challenge']['promoted_lineage']['median_declared_models'] == 12
      and yukon['credits']['eip8200-challenges']['promoted_lineage']['median_declared_models'] == 21
      and yukon['replay']['flagged'] == yukon['replay']['expected'] == 369
      and all(yukon['fix']['methods'][k]['size'] == 369 for k in git_only)
      and len(moves) == 3 and sum(t['typed'] for t in moves) == 406
      and all(sum(t['methods'][k]['missed'] for t in moves) == 1 for k in git_only),
      'a median of 12 declared models in one challenge and 21 in the other',
      'Git-only methods missed 1 of 406 such outputs')

# 5.3 Plain tools.
plain = load('research/experiments/p1-7-plain-tools/report.json')
o = plain['observed']
check('plain decisions', o['decisions_matching_expected'] == 34
      and 34 + len(o['mismatched_events']) == 42, '34 of 42')
check('plain obsolete uses', o['obsolete_uses_accepted'] == 5,
      'Withdrawn or outdated work accepted for use | 5')
check('plain prohibited', o['prohibited_exchanges_or_public_releases'] == 2,
      'Prohibited exchanges or public releases | 2')
check('plain purpose', o['purpose_violations'] == 1,
      'Reuse for a new purpose without a grant | 1')
check('plain export', len(o['withdrawn_items_in_exit_export']) == 5,
      'Withdrawn items left in the exit export | 5')
check('plain lost updates', o['lost_updates'] == {'git': 0, 'shared-document': 1},
      '1 with a shared file; 0 with Git')
check('plain not stored', o['affected_outputs_flagged_by_tools'] == {'flagged': 0, 'of': 19}
      and o['dependency_edges_recorded_by_tools'] == {'of': 32, 'recorded': 0}
      and o['delegation_bounds_enforced'] == {'enforced': 0, 'of': 3},
      '19 affected outputs, 32 links and 3 limits')

# 5.4 Equipped reference, first collaboration.
status = load('research/experiments/p1-7-measures/status.json')
for name, bound in status['evidence'].items():
    check('measures evidence ' + name, sha256(bound['path']) == bound['sha256'])
m = status['measures']
faults = m['operational_failures']['value']
check('faults', sorted(faults) == ['kyoei-documents', 'kyoei-git', 'reference']
      and all(len(v) == 22 and sum(r['held'] for r in v.values()) == 66
              and sum(r['runs'] for r in v.values()) == 66 for v in faults.values()),
      'Fault trials held | 66 of 66 | 66 of 66 in each mode', 'The fault schedule has 22 classes')
code = m['application_code']
check('application code', code['adopter_lines'] == {'kyoei': 0, 'reference': 2470,
      'reference_including_reused_modules': 4845} and code['kyoei']['by_role']['kyoei-supplier'] == 3684,
      '2,470 lines', "Kyoei's own code is 3,684 lines")
check('reference reuse', code['reference']['by_role']['kyoei-module-reused-by-reference'] == 2091
      and code['reference']['by_role']['reference-authored'] == 2470,
      "The reference also reuses 2,091 lines of Kyoei's modules")
cov = m['dependency_coverage']['value']
check('coverage', all(cov[a]['true_positive'] == 32 and cov[a]['extra'] == 0
                      and round(cov[a]['automatic_ratio'] * 32) == 30 for a in ('kyoei-documents', 'kyoei-git'))
      and all(cov[a]['true_positive'] == 30 and cov[a]['extra'] == 10 and cov[a]['missing'] == 2
              and round(cov[a]['automatic_ratio'] * 32) == 20 for a in ('reference-documents', 'reference-git')),
      '30, of which 20 automatic, plus 10 extra', '32, of which 30 automatic, none extra')
ref_cov = m['dependency_coverage']['value']
check('coverage granularity', 'correction and withdrawal sets are still exact' in m['dependency_coverage']['context']
      and all((ref_cov[a]['missing'], ref_cov[a]['extra'], ref_cov[a]['exact']) == (2, 10, False)
              for a in ('reference-documents', 'reference-git')),
      'missed 2 expected links and added 10', 'Its correction and withdrawal sets still matched')
conf = m['configuration_burden']
kinds = conf['context']['commands_by_kind']
check('configuration and setup', conf['value']['reference']['decisions_per_institution'] == 16
      and conf['value']['kyoei']['decisions_per_institution'] == 17
      and conf['value']['reference']['setup_commands'] == 13 and conf['value']['kyoei']['setup_commands'] == 20
      and kinds['reference'] == {'enroll': 4, 'node-start': 3, 'trust': 6}
      and kinds['kyoei'] == {'enroll': 4, 'init': 7, 'node-start': 3, 'trust': 6},
      'Configuration decisions per institution | 16 | 17', 'Setup commands | 13 | 20',
      'Both arms count three node starts, six trust commands and four enrollments',
      'Kyoei also counts seven key initializations')
thr = m['concurrent_throughput']['arms']
gate = status['mrd_gate']['comparison']['concurrent_throughput']
ref_rows = thr['reference']['summary']
check('throughput', gate['timeouts'] == {'kyoei-documents': 0, 'kyoei-git': 0, 'reference': 546}
      and sum(sum(r['timeouts']) for r in ref_rows) == 546
      and sum(sum(r['timeouts']) for r in ref_rows if r['workload'] == 'mixed' and r['actors'] == 27) == 546
      and all(not any(r['errors']) for arm in ('reference', 'kyoei-documents', 'kyoei-git') for r in thr[arm]['summary'])
      and all(thr[arm]['cells'] == 80 for arm in ('reference', 'kyoei-documents', 'kyoei-git'))
      and len(gate['groups_faster']['kyoei']) == 10 and len(gate['groups_faster']['reference']) == 5
      and len(gate['groups_faster']['split']) == 1
      and sum(g.startswith('mixed/') for g in gate['groups_faster']['kyoei']) == 8,
      'Requests slower than 5 s under load, 80 cells per arm | 546 | 0',
      'All 546 slow reference requests occurred in mixed workloads with 27 actors',
      'Throughput groups in which the arm was faster, of 16 | 5 | 10')

original_refusals, slow_outcomes = {}, {}
for arm in ('reference', 'kyoei-documents', 'kyoei-git'):
    raw_grid = load('research/experiments/p1-7-throughput/' + arm + '.json')
    original_refusals[arm], slow_outcomes[arm] = Counter(), Counter()
    for cell in raw_grid['cells']:
        original, classified = Counter(), Counter()
        for tally in cell['refusals_by_actor'].values():
            original.update(tally)
        original_refusals[arm].update(original)
        original['allowed'] = cell['attempted'] - sum(original.values())
        for tally in cell['outcomes'].values():
            classified.update(tally)
        slow = {kind: original[kind] - classified[kind]
                for kind in original.keys() | (classified.keys() - {'timeout'})}
        check('throughput original outcomes ' + arm,
              original['allowed'] >= 0 and all(value >= 0 for value in slow.values())
              and sum(classified.values()) == cell['attempted']
              and sum(slow.values()) == cell['timeouts'] == classified['timeout'])
        slow_outcomes[arm].update(slow)
check('throughput raw refusals',
      original_refusals['reference'] == Counter({'stale-base': 953, 'concurrent-change': 44})
      and original_refusals['kyoei-documents'] == Counter({'stale-base': 988})
      and original_refusals['kyoei-git'] == Counter({'stale-base': 986})
      and slow_outcomes['reference'] == Counter({'allowed': 502, 'concurrent-change': 44})
      and not any(slow_outcomes['kyoei-documents'].values())
      and not any(slow_outcomes['kyoei-git'].values()),
      '953 `stale-base`; 44 `concurrent-change`',
      '988 `stale-base` with documents; 986 with Git',
      '44 of these requests ended in `concurrent-change`; the other 502 were allowed')

harness = read('scripts/p1_7_throughput.py')
clean = m['concurrent_throughput']['value']['clean_comparison']['arms']
load_rule = load('research/experiments/p1-7-throughput/load-rule.json')
check('throughput threshold and exclusions', 'WARMUP, MEASURED, TIMEOUT_MS = 5, 20, 5000' in harness
      and clean['reference']['contaminated'] == 3
      and clean['kyoei-documents']['contaminated'] == clean['kyoei-git']['contaminated'] == 0
      and 'cell 23 of 80' in load_rule['frozen_before'],
      'Requests slower than 5 s', 'at cell 23 of 80', 'It excluded 3 reference cells')
check('throughput classification boundary',
      "outcome = 'timeout' if latency > limit else item['outcome']" in harness
      and "successful = [latency for _, outcome, latency in classified if outcome == 'allowed']" in harness,
      'The reported throughput counts allowed responses that meet the five-second threshold',
      'It is not the completion rate of all requests')

# 5.5 Reuse in later collaborations.
p3 = {'reference': load('research/experiments/p3-reference/report.json'),
      'kyoei-documents': load('research/experiments/p3-kyoei/kyoei-documents.json'),
      'kyoei-git': load('research/experiments/p3-kyoei/kyoei-git.json')}
check('P3 code and decisions', p3['reference']['new_application_code'] == 45
      and all(p3[a]['new_application_code'] == 0 for a in ('kyoei-documents', 'kyoei-git'))
      and all(r['decisions'] == {'allowed': 20, 'refused': 0} and r['repetitions'] == 3 for r in p3.values()),
      'a new 45-line adapter', 'allowed the same 20 scenario decisions')
check('P3 faults', all(r['measures']['failures']['cases'] == 2 and r['measures']['failures']['held'] == 6
                       for r in p3.values()), 'held both injected faults, three times each')
check('P3 setup and repair', p3['reference']['measures']['setup_commands']['client'] == 20
      and all(p3[a]['measures']['setup_commands']['client'] == 24 for a in ('kyoei-documents', 'kyoei-git'))
      and all(r['measures']['setup_commands']['restarts'] == 3 for r in p3.values())
      and p3['reference']['measures']['repair_steps']['steps'] == 23
      and all(p3[a]['measures']['repair_steps']['steps'] == 22 for a in ('kyoei-documents', 'kyoei-git'))
      and all(r['measures']['isolation_breaches']['count'] == 0 for r in p3.values()),
      '20 client setup commands against 24 for Kyoei', 'Kyoei needed 22 repair steps against 23')
p21 = load('research/experiments/p2-1-comparison/report.json')
check('P2.1 inputs are current', all(sha256(v['path']) == v['sha256'] for v in p21['inputs'].values()))
check('P2.1 code', p21['measures']['reference']['adopter_lines'] == 360
      and all(p21['measures'][a]['supplier_lines'] == 363 for a in ('kyoei-documents', 'kyoei-git')),
      'the reference needed 360 new lines', 'added 363 lines to Kyoei itself')
pm = p21['measures']
check('P2.1 operation', (pm['reference']['configuration_decisions'], pm['reference']['setup_commands'],
                         pm['reference']['repair_steps']) == (21, 28, 32)
      and all((pm[a]['configuration_decisions'], pm[a]['setup_commands'], pm[a]['repair_steps']) == (22, 30, 34)
              for a in ('kyoei-documents', 'kyoei-git'))
      and all(p21['falsifier'][a]['with_supplier']['fires'] and not p21['falsifier'][a]['adopter']['fires']
              for a in ('kyoei-documents', 'kyoei-git'))
      and 'If the reference needs no more new code, configuration decisions or setup commands than Kyoei, and matches on repair and failures' in load('research/priority-two/contract.json')['comparison']['falsifier'],
      'fewer configuration decisions (21 against 22), setup commands (28 against 30) and repair steps (32 against 34)',
      'The claim fails if the reference needs no more new code, configuration decisions or setup commands than Kyoei, and matches it on repair and failures',
      'Counting the 363 lines added to Kyoei as new code, the reference meets every condition, so the claim fails',
      "counting only the adopter's code, none against 360, it survives")
p21_before = load('research/experiments/p2-1-comparison/attempt-before-isolation/report.json')
check('P2.1 count before the isolation fix',
      all(p21_before['measures'][a]['supplier_lines'] == 355 and not p21_before['falsifier'][a]['with_supplier']['fires']
          for a in ('kyoei-documents', 'kyoei-git')),
      'an 8-line isolation fix made after the first runs')

# 5.6 Dependency proposals.
a = load('research/experiments/f2-v2/report.json')['calibration']
check('stage A', a['reviewer_units'] == 160 and a['eligible'] == 143
      and round(a['reviewer_kappa_all_labels'], 2) == 0.75
      and a['locator_diagnostic']['locator'] == {'depends': 20, 'does-not-depend': 28},
      'They agreed on 143 (Cohen\'s kappa 0.75 over all labels)', '20 depend and 28 do not')
b = load('research/experiments/f2-stage-b-retry/report.json')
v = b['variants']['agreed-subset']
m3, m4 = v['methods']['M3'], v['methods']['M4']
check('stage B', v['common_support'] == 118 and v['coverage']['M4']['reference_positive'] == 60
      and (m3['tp'], m3['fp'], round(m3['f1'], 3)) == (32, 1, 0.688)
      and (m4['tp'], m4['fp'], round(m4['f1'], 3)) == (44, 0, 0.846)
      and round(m4['f1'] - m3['f1'], 3) == 0.158
      and (v['paired_interval']['low'], v['paired_interval']['high'], v['paired_interval']['resamples'])
      == (0.0669, 0.2559, 2000)
      and b['effort']['M4']['calls'] == 92 and round(b['effort']['M4']['cost_usd'], 2) == 2.57,
      '32 of 60 | 1 | 0.688', '44 of 60 | 0 | 0.846', 'The paired F1 gain is 0.158',
      '0.067 to 0.256', 'USD 2.57 for 92 model calls')
reviewers = [b['effort'][role] for role in ('reviewer-a', 'reviewer-b')]
check('stage B cost boundary', sum(row['calls'] for row in reviewers) == 184
      and round(sum(row['cost_usd'] for row in reviewers), 2) == 15.61
      and sum(row['calls'] for row in b['effort'].values()) == 276
      and round(sum(row['cost_usd'] for row in b['effort'].values()), 2) == 18.18,
      "This is the proposal model's cost alone",
      'The two reviewer models cost USD 15.61 for 184 further calls',
      'The three roles total USD 18.18 for 276 completed calls in the retry run',
      'exclude the earlier stage A calls, collection, human review, and infrastructure')
check('stage B exclusions and version limit', b['population']['excluded'] == 24
      and b['population']['planned'] + b['population']['excluded'] == a['reviewer_units'] == 160
      and 'Dataset bytes are pinned; arXiv version labels remain unproven.' in b['limits']
      and 'Only the citing source is provided; the cited theorem is not proved by this experiment.' in b['limits'],
      'It excluded 24 of the 160 stage A units under that source size rule',
      'The exact source bytes are pinned, but their arXiv version labels remain unproven',
      'The experiment provides the citing source, not a verification of the cited theorem')
shift = load('research/experiments/f2-stage-b-retry/reference-shift.json')['counts']
check('stage B label shift', any(r['stage_a'] == 'does-not-depend' and r['stage_b'] == 'depends'
                                 and r['units'] == 21 for r in shift),
      'moved 21 units from "does not depend" to "depends"')
contract = read('research/fallen-claims/successor-v2/stage-b-retry/contract.json')
check('stage B models', all(model in contract for model in
                            ('google/gemini-3.8-flash', 'anthropic/claude-sonnet-5.5', 'openai/gpt-6-sol')),
      'google/gemini-3.8-flash', 'anthropic/claude-sonnet-5.5', 'openai/gpt-6-sol')
stage_a_run = load('research/fallen-claims/successor-v2/contract.json')['run']
stage_b = json.loads(contract)
check('stage B design', b['population']['planned'] == 136 and b['population']['works'] == 92
      and '<=160000 bytes' in b['population']['rule'] and v['common_support'] == 118
      and stage_a_run['batch_size'] == 20 and stage_b['run']['batching'].startswith('One complete work per request')
      and stage_b['M4'].startswith('Same Google model as M3') and stage_b['routes']['M4']['model'] == 'google/gemini-3.8-flash',
      'Stage B selected the 136 units whose complete source was at most 160,000 bytes', 'from 92 citing works',
      'agreed on 118, of which 60 depend', '20 units per request', 'one work per request')
ra, rb = b['variants']['reviewer-a'], b['variants']['reviewer-b']
check('stage B per reviewer', round(ra['f1_difference'], 3) == 0.170 and round(rb['f1_difference'], 3) == 0.119
      and ra['paired_interval']['low'] > 0 and rb['paired_interval']['low'] > 0,
      'the gain is 0.170 and 0.119, and neither interval includes zero')
check('stage B misses', v['coverage']['M4']['reference_positive'] - m4['tp'] == 16,
      'still missed 16 of the 60 agreed dependencies')
check('stage B population', any('no held-out generalization' in limit for limit in b['limits']),
      'with no held-out set')

# 5.7 Withdrawal across separate nodes.
relay = load('research/experiments/f3-kyoei-relay/report.json')
score = load('research/experiments/f3-kyoei-relay/score.json')
check('relay source bindings', bool(relay.get('sources'))
      and all(sha256(path) == digest for path, digest in relay['sources'].items()))
trace = relay['trace']
rebuilt = {'requests': len(trace)}
for phase, name in (('setup', 'setup'), ('declaration', 'declaration_work'),
                    ('repair', 'repair_work'), ('batch', 'batch_work')):
    rows = [row for row in trace if row['role'] == 'adopter' and row['phase'] == phase]
    rebuilt[name] = dict(steps=len(rows), refused=sum(row['outcome'] != 'ok' for row in rows),
                         operations=dict(sorted(Counter(row['operation'] for row in rows).items())))
rebuilt['external_events'] = sum(row['role'] == 'external' for row in trace)
rebuilt['observations'] = sum(row['role'] == 'observation' for row in trace)
rebuilt['relay'] = {key: sum(row.get('relay', {}).get(key, 0) for row in trace)
                    for key in ('delivered', 'refused', 'unavailable')}
check('relay measures rebuilt from trace', relay['measures'] == rebuilt)
work = relay['measures']
check('relay mechanism', relay['processes'] == {'parent_holds_store': False, 'per_institution': 3}
      and work['requests'] == 869
      and sum(work[k]['refused'] for k in ('setup', 'declaration_work', 'repair_work', 'batch_work')) == 0
      and work['relay'] == {'delivered': 432, 'refused': 0, 'unavailable': 0}
      and (work['setup']['steps'], work['declaration_work']['steps'], work['repair_work']['steps']) == (15, 332, 12)
      and work['declaration_work']['operations']['research_claim'] == 136
      and work['declaration_work']['operations']['research_derived'] == 36
      and work['declaration_work']['operations']['research_section'] == 6,
      'All 869 requests were signed', '432 signed events', '136 claims', '36 derived claims and 6 joint sections',
      '15 setup requests, 332 declaration requests, 12 repair requests, 137 external events and 373 observations')
check('relay request total', work['requests'] == 15 + 332 + 12 + work['external_events'] + work['observations']
      and (work['external_events'], work['observations']) == (137, 373), 'All 869 requests were signed')
check('relay score', score['missed_alerts'] == {'delivery': 0, 'label_limited': 16}
      and score['false_alarms']['delivery'] == 0 and score['false_alarms']['structural'] == 0
      and score['false_alarms']['m1_baseline'] == 58 and score['leaks']['count'] == 0
      and score['continuity_breaks'] == 0 and score['derived']['delivered'] == score['derived']['expected'] == 31
      and score['experience']['complete'] == 3 and score['experience']['delivered'] == 3,
      'All 31 expected derived claim/event pairs had a notice', 'Sixteen dependencies', '58 false alarms')
check('relay scoring population', score['false_alarms']['m1_baseline'] + v['coverage']['M4']['reference_positive']
      == v['common_support'] == 118
      and score['disputed'] == {'notified': 1, 'silent': 17}
      and b['population']['planned'] - v['common_support'] == 18,
      'The scorer counts only the 118 units on which the reviewers agreed for accuracy',
      'Of 18 disputed units, one received a notice and 17 remained silent')
check('relay status stays in-repair', relay['status'] == score['status'] == 'in-repair',
      'This is mechanism evidence, not a comparison')
relay_scenario = load('research/priority-four/f3/scenario.json')
relay_oracle = load('research/priority-four/f3/oracle.json')
relay_contract = load('research/priority-four/f3/contract.json')
check('relay oracle bindings',
      sha256('research/priority-four/f3/contract.json')
      == read('research/priority-four/f3/contract.sha256').strip() == relay['contract_digest']
      and all(sha256('research/priority-four/f3/' + name) == relay_contract['artifacts'][name]
              for name in ('scenario.json', 'oracle.json')))
inventory = notice_inventory(relay, relay_scenario, relay_oracle)
check('relay notice inventory',
      (inventory['records'], inventory['pairs'], inventory['expected']) == (76, 75, 75)
      and len(inventory['multiple_versions']) == 1
      and not any(inventory[key] for key in ('missing', 'unexpected', 'duplicate_records', 'unknown_events')),
      'The saved batch has 76 records for 75 distinct claim/event pairs',
      'with no repeated record for the same version',
      'does not validate each version against an independent repair oracle')

# 5.9 Deployed runs on Cloudflare. Each value is recounted here from the three
# node logs, separately from the port's own summary script, and must also equal
# that script's summary.json.
CF = 'research/experiments/cloudflare/'


def node_log(run):
    rows = []
    for org in 'abc':
        rows += [json.loads(line) for line in read(CF + run + '/' + org + '.jsonl').splitlines() if line.strip()]
    return sorted(rows, key=lambda e: e['t'])


def delivery_inventory(rows):
    def sent_key(row):
        return row['org'], row['to'], row['event'], row['kind']

    queued = [row for row in rows if row['type'] == 'event.queued']
    delivered = [row for row in rows if row['type'] == 'event.delivered']
    received = [row for row in rows if row['type'] == 'event.received']
    queue_keys = Counter(sent_key(row) for row in queued)
    sent_keys = Counter(sent_key(row) for row in delivered)
    received_keys = Counter((row['from'], row['org'], row['event'], row['kind'])
                            for row in received)
    queue_times = {sent_key(row): row['t'] for row in queued}
    return (bool(queue_keys) and queue_keys == sent_keys == received_keys
            and all(count == 1 for count in queue_keys.values())
            and all(row['status'] == 'applied' and row['ms'] >= 0
                    and row['t'] - queue_times[sent_key(row)] == row['ms']
                    for row in delivered))


def recount(rows):
    def of(kind):
        return [e for e in rows if e['type'] == kind]
    finished = of('run.finished')
    spans = [(e['started'], e['t']) for e in finished]
    done = {(e['org'], e['agent']): e['t'] for e in finished}
    early = [o for o in of('overlap.flagged')
             if all(o['t'] < done.get(tuple(a.split('/')), float('inf')) for a in o['agents'])]
    w = of('withdraw.issued')[0]
    own = {w['id'], 'main:' + w['id']}
    notices = [n for n in of('notice.opened') if n['cause'] == w['cause']]
    work = {(n['org'], n['item']) for n in notices
            if n['blocking'] and not n['item'].startswith('main:') and n['item'] not in own}
    correction = next(e for e in of('release.sent') if e['org'] == w['org'] and e['line'] == w['line'] and e['t'] > w['t'])
    window = [e for e in of('ship.merged') if w['t'] < e['t'] < correction['t']]
    notified = {n['line'] for n in notices if n['item'] not in own}
    acks = [e for e in of('event.delivered') if e['org'] == w['org'] and e['kind'] == 'withdraw' and e['t'] >= w['t']]
    records = {e['id']: e for e in of('contribution.registered')}
    paths = []
    for e in of('repair.planned'):
        if e['from'] != w['id']:
            continue
        onto = records[e['onto']]
        merged = next(m for m in of('ship.merged') if m['org'] == e['org'] and m['line'] == e['line']
                      and m['version'] > 1 and m['t'] > e['t'])
        kind = 'replacement' if (onto['org'], onto['line']) == (w['org'], w['line']) else 'alternative'
        paths.append((kind, (merged['t'] - w['t']) / 1000))
    repaired = [e['t'] for e in of('ship.merged') if e['version'] > 1 and e['t'] >= correction['t']]
    closed = {e['notice'] for e in of('notice.closed')}
    still_open = [n for n in of('notice.opened') if n['notice'] not in closed]
    stale = (sum(1 for e in of('ship.refused') if e.get('code') == 'stale-base')
             + sum(1 for e in of('gate.decided') if not e['ok'] and any(c.get('code') == 'stale-base' for c in e['checks'])))
    return {
        'runs': (len(finished), len(of('run.failed'))),
        'models': sorted({e['model'] for e in finished}),
        'concurrent': max(sum(1 for a, b in spans if a <= start < b) for start, _ in spans),
        'agent_seconds': (min(b - a for a, b in spans) / 1000, max(b - a for a, b in spans) / 1000),
        'overlap': (len(early), len(of('overlap.flagged'))),
        'releases': (sum(e['content_verified'] is True for e in of('release.received')), len(of('release.received'))),
        'events': (len(of('event.delivered')), len(of('event.refused')), len(of('event.retry'))),
        'tokens': (sum(len(e['tokens']) for e in of('release.sent')), w['tokens_revoked']),
        'ack': (max(a['ms'] for a in acks), max(a['attempt'] for a in acks),
                sorted(a['to'] for a in acks if a['status'] == 'applied')),
        'blocked_by_org': tuple(sum(1 for org, _ in work if org == x) for x in 'abc'),
        'blocked_shipped': len({n['item'] for n in notices if n['blocking'] and n['item'].startswith('main:')}),
        'notice_only': len({n['item'] for n in notices if not n['blocking']}),
        'notice_only_shipped': sum(1 for e in window if any(not n['blocking'] and (n['org'], n['line']) == (e['org'], e['line'])
                                                            for n in notices)),
        'unrelated_shipped': sum(1 for e in window if e['version'] == 1 and e['line'] not in notified),
        'gate_refusals': sum(1 for e in of('gate.decided') if w['t'] < e['t'] < correction['t'] and not e['ok']),
        'paths': sorted(k for k, _ in paths),
        'alternative_seconds': [t for k, t in paths if k == 'alternative'],
        'replacement_seconds': (max(repaired) - correction['t']) / 1000,
        'stale_base': stale,
        'person_actions': (len(of('approval.recorded')), len(of('release.sent')), len(of('withdraw.issued'))),
        'open_notices': [(n['org'], n['line'], n['blocking']) for n in still_open],
        'duration': (rows[-1]['t'] - rows[0]['t']) / 1000,
    }


cf = recount(node_log('deployed-2-ai'))
cf1 = recount(node_log('deployed-1'))
check('cloudflare delivery identities and queue intervals',
      all(delivery_inventory(node_log(run)) for run in ('deployed-1', 'deployed-2-ai')),
      'For both runs, the checker matches each queued event to one sender receipt and one receiver entry by event, issuer, recipient, and kind',
      'The 65 ms starts when the sender creates each outbox entry and ends at its receipt',
      'It excludes earlier owner processing, token revocation, and envelope signing',
      'Peak overlap counts preparation, model calls, and Git work, not simultaneous model inference')
def reliance_inventory(rows):
    answered = Counter((r['org'], r['from'], r['id'], r['relation'], r['rev'])
                       for r in rows if r['type'] == 'rely.answered')
    registered = Counter((r['owner'], r['org'], r['id'], r['relation'], r['rev'])
                         for r in rows if r['type'] == 'rely.registered')
    return answered == registered and sum(registered.values()) == 13


check('cloudflare synchronous reliance exchanges',
      all(reliance_inventory(node_log(run)) for run in ('deployed-1', 'deployed-2-ai')),
      '| Reliance registrations with an owner reply, outside the queued count | 13 |',
      'The 50 deliveries count queued events only',
      'Both runs also record 13 synchronous reliance request/reply exchanges, outside that count')

cfs = load(CF + 'deployed-2-ai/summary.json')
cfw = cfs['withdraw']
check('cloudflare recount equals the port summary',
      cf['runs'] == (cfs['runs']['total'], cfs['runs']['failed'])
      and cf['concurrent'] == cfs['runs']['max_concurrent']
      and cf['overlap'] == (cfs['overlap']['flagged_early'], cfs['overlap']['flagged'])
      and cf['releases'] == (cfs['releases']['content_verified'], cfs['releases']['received'])
      and cf['events'] == (cfs['events']['sent'], cfs['events']['refused'], cfs['events']['retries'])
      and cf['tokens'] == (cfs['tokens']['issued'], cfs['tokens']['revoked'])
      and cf['ack'][:2] == (cfw['ack_max_ms_owner_clock'], cfw['ack_attempts_max'])
      and cf['blocked_by_org'] == tuple(cfw['blocked_work_by_org'].get(x, 0) for x in 'abc')
      and (cf['blocked_shipped'], cf['notice_only'], cf['notice_only_shipped'], cf['unrelated_shipped'],
           cf['gate_refusals']) == (cfw['blocked_shipped'], cfw['notice_only'], cfw['notice_only_shipped'],
                                    cfw['unrelated_shipped'], cfw['gate_refusals'])
      and cf['paths'] == sorted(p['kind'] for p in cfs['repair']['paths'])
      and cf['replacement_seconds'] == cfs['repair']['seconds_after_correction']
      and cf['stale_base'] == cfs['merge']['stale_base']
      and cf['person_actions'] == (cfs['approvals']['signoffs'], cfs['approvals']['releases'], cfs['approvals']['withdrawals'])
      and cf['duration'] == cfs['elapsed_seconds'])
check('cloudflare run table',
      cf['runs'] == (16, 0) and cf['models'] == ['@cf/moonshotai/kimi-k2.7-code'] and cf['concurrent'] == 6
      and cf['overlap'] == (1, 1) and cf['releases'] == (14, 14) and cf['events'] == (50, 0, 0)
      and cf['tokens'] == (14, 2) and cf['ack'] == (65, 1, ['a', 'c'])
      and cf['blocked_by_org'] == (1, 1, 1) and cf['blocked_shipped'] == 2
      and (cf['notice_only'], cf['notice_only_shipped'], cf['unrelated_shipped'], cf['gate_refusals']) == (1, 1, 1, 1)
      and cf['paths'] == ['alternative', 'replacement', 'replacement']
      and [round(t, 1) for t in cf['alternative_seconds']] == [143.2] and round(cf['replacement_seconds'], 1) == 93.8
      and cf['stale_base'] == 1 and cf['person_actions'] == (15, 11, 1)
      and cf['open_notices'] == [('b', 'b3', False), ('b', 'b3', False)] and round(cf['duration']) == 589,
      '| Agent runs; failed | 16; 0 |',
      '| Runs labelled with model `@cf/moonshotai/kimi-k2.7-code` | 16 of 16 |',
      '| Overlapping logged agent-run lifetimes, maximum | 6 |',
      '| Same-file overlaps flagged before either agent finished | 1 of 1 |',
      '| Releases received with the BLAKE3 root recomputed from the fetched commit | 14 of 14 |',
      '| Queued signed events delivered between nodes; refused; retried | 50; 0; 0 |',
      '| Read tokens issued in releases; revoked at the withdrawal | 14; 2 |',
      '| Maximum withdrawal queue-to-receipt time, owner\'s clock | 65 ms, first attempt |',
      '| Lines of work blocked by the withdrawal at Acme; Birch; Cove | 1; 1; 1 |',
      '| Shipped items blocked in the integration repository | 2 |',
      '| Citing lines with a notice and no block; shipped during the incident | 1; 1 |',
      '| Unrelated lines shipped during the incident | 1 |',
      '| Ship-gate refusals during the incident | 1 |',
      '| Repairs onto another organization\'s alternative; onto the owner\'s replacement | 1; 2 |',
      '| Withdrawal to the merge of the repair onto the alternative | 143.2 s |',
      '| Replacement release to the last repaired merge | 93.8 s |',
      '| Merges refused with `stale-base`, then repaired | 1 |',
      '| Person actions: approvals; releases; withdrawals | 15; 11; 1 |',
      '| Notices open at the end, all without a block | 2 |',
      '| Run duration | 589 s |',
      'Each agent run took 15.5 to 115.4 s', 'Both open notices belong to the citing line')
check('cloudflare scripted run has the same counts',
      cf1['models'] == ['scripted']
      and {k: v for k, v in cf1.items() if k not in ('models', 'agent_seconds', 'ack', 'alternative_seconds',
                                                      'replacement_seconds', 'duration')}
      == {k: v for k, v in cf.items() if k not in ('models', 'agent_seconds', 'ack', 'alternative_seconds',
                                                    'replacement_seconds', 'duration')},
      'The run with scripted edits gave the same counts for every row except the edit source and the times')
rows2 = node_log('deployed-2-ai')
w2 = next(e for e in rows2 if e['type'] == 'withdraw.issued')
overlap2 = [e for e in rows2 if e['type'] == 'overlap.flagged']
stale2 = [c for e in rows2 if e['type'] == 'gate.decided' and not e['ok']
          for c in e['checks'] if c.get('code') == 'stale-base']
shipped_first = [e for e in rows2 if e['type'] == 'ship.merged' and (e['org'], e['line'], e['version']) == ('b', 'b1', 1)]
b1_tokens = sum(len(e['tokens']) for e in rows2 if e['type'] == 'release.sent' and e['line'] == 'b1' and e['t'] < w2['t'])
seed_releases = [e for e in rows2 if e['type'] == 'release.sent' and e['line'] == 'seed' and e['t'] < w2['t']]
repair_runs = sorted(e['agent'] for e in rows2 if e['type'] == 'run.finished' and e['agent'].endswith('r'))
c4_start = [e for e in rows2 if e['type'] == 'run.started' and (e['org'], e['agent']) == ('c', 'c4')]
check('cloudflare run narrative',
      len(overlap2) == 1 and overlap2[0]['org'] == 'c' and all(a.startswith('a/') for a in overlap2[0]['agents'])
      and len(stale2) == 1 and stale2[0]['reason'] == 'main changed src/retry.ts after this base'
      and len(shipped_first) == 1 and shipped_first[0]['t'] < w2['t']
      and w2['tokens_revoked'] == b1_tokens == 2 and len(seed_releases) == 1
      and repair_runs == ['a2r', 'a3r', 'b2r', 'c2r']
      and len(c4_start) == 1 and c4_start[0]['t'] > w2['t'] and cf['unrelated_shipped'] == 1,
      'flagged two Acme intents on the same file',
      'the reason "main changed src/retry.ts after this base"',
      'which had already shipped to the integration repository',
      'two more repair agents moved the other blocked lines onto it',
      'An unrelated Cove line started just after the withdrawal')
stale_ev = [e for e in rows2 if e['type'] == 'gate.decided' and not e['ok']
            and any(c.get('code') == 'stale-base' for c in e['checks'])]
a1_ship = [e for e in rows2 if e['type'] == 'ship.merged' and (e['org'], e['line'], e['version']) == ('a', 'a1', 1)]
correction2 = next(e for e in rows2 if e['type'] == 'release.sent' and e['org'] == w2['org'] and e['line'] == w2['line'] and e['t'] > w2['t'])
incident = [e for e in rows2 if e['type'] == 'gate.decided' and not e['ok'] and w2['t'] < e['t'] < correction2['t']]
main_blocked = {(n['line'], n['version']) for n in rows2 if n['type'] == 'notice.opened'
                and n.get('item', '').startswith('main:') and n['blocking']}
reg = {(e['line'], e['version']): e for e in rows2 if e['type'] == 'contribution.registered'}
check('cloudflare overlap and incident',
      sorted(overlap2[0]['agents']) == ['a/a1', 'a/a2'] and overlap2[0]['files'] == ['src/retry.ts']
      and len(stale_ev) == 1 and stale_ev[0]['line'] == 'a2' and len(a1_ship) == 1 and a1_ship[0]['t'] < stale_ev[0]['t']
      and len(incident) == 1 and incident[0]['line'] == 'a3'
      and any(c.get('code') == 'withdrawn' and w2['reason'] in c.get('reason', '') for c in incident[0]['checks'])
      and w2['reason'] == 'origin of one snippet is not verified; license unknown'
      and main_blocked == {('b1', 1), ('c2', 1)}
      and {'id': reg[('b1', 1)]['id'], 'relation': 'builds-on'} in reg[('c2', 1)]['inputs'],
      'Cove\'s node flagged two Acme intents on the same file, src/retry.ts, before either agent finished',
      'The first of the two changes shipped. The gate refused the second with `stale-base`',
      'Birch\'s signer and Cove\'s line built on it',
      'Cove\'s gate refused Acme\'s dependent line with `withdrawn` and Birch\'s reason, "origin of one snippet is not verified; license unknown"')
ids = load(CF + 'deployed-2-ai/identities.json')['nodes']
pinned = {(e['org'], e['peer']): e['fingerprint'] for e in node_log('deployed-2-ai') if e['type'] == 'peer.pinned'}
check('cloudflare node keys',
      all(n['alg'] == 'ML-DSA-65' for n in ids.values()) and len(pinned) == 6
      and all(ids[peer]['fingerprint'].startswith(fp) for (_, peer), fp in pinned.items()),
      'Signatures use ML-DSA-65 through WebCrypto')
check('restated cloudflare',
      cf['runs'][0] == 16 and cf['concurrent'] == 6 and cf['blocked_by_org'] == (1, 1, 1)
      and cf['releases'][0] == cf['releases'][1] and cf['ack'][0] == 65 and cf['overlap'] == (1, 1)
      and len(overlap2) == 1 and len({a.split('/')[0] for a in overlap2[0]['agents']}) == 1,
      'in a single Cloudflare account, 16 agent runs completed, with six overlapping logged lifetimes',
      'flagged two agents of one organization that declared the same file before either finished',
      'One withdrawal blocked one line of work at each of three organizations')

# 4.9 The research prototype: constants quoted from its source.
identity = read('scripts/institution_identity.py')
relay_store = read('scripts/f3_store.py')
check('prototype constants', 'MAX_WINDOW = 300' in identity and 'expires=int(now) + 60' in relay_store
      and "RELIANCE = ('builds-on', 'reproduces', 'supersedes')" in relay_store
      and "lineage='withheld'" in identity,
      'A request expires at most 300 seconds after issue', 'A relay event expires after 60 seconds',
      'builds-on, reproduces and supersedes (withdrawal run)', 'withholds the work\'s own inputs')

# Abstract and conclusion: each restated number must match the same evidence.
check('restated plain tools', 42 - o['decisions_matching_expected'] == 8,
      'left 8 of 42 decisions to people')
check('restated faults', all(sum(r['held'] for r in arm.values()) == 66 for arm in faults.values()),
      'reference that we built each held all 66 of our fault trials')
check('restated code', code['adopter_lines']['reference'] == 2470 and code['adopter_lines']['kyoei'] == 0,
      'no application code, against 2,470 lines for building the reference')
check('restated P2.1', p21['measures']['reference']['adopter_lines'] == 360
      and p21['measures']['kyoei-documents']['supplier_lines'] == 363,
      'a second collaboration added 363 lines to Kyoei itself against 360 new lines for the reference')

alignment = json.loads((BUNDLE / 'alignment.json').read_text())
alignment_root, port_root = locations(BUNDLE)
failures.extend(check_alignment(alignment, BUNDLE, alignment_root, port_root))
evidence_paths.update(alignment['files']['evidence'])

# Placeholders and sections still to confirm.
open_items = sorted(set(re.findall(r'⟦[a-z_.]+⟧|[A-Z][A-Z-]+-(?:PENDING|TO-CONFIRM)[A-Z-]*', PAPER)))
if open_items and not DRAFT:
    failures.append('open placeholders: ' + ', '.join(open_items))

# Numbered notes: every superscript cites a listed reference, and every reference is cited.
body, references = PAPER.split('# Notes and references', 1)
cited = {int(n) for group in re.findall(r'\^([\d,]+)\^', body) for n in group.split(',')}
listed = {int(n) for n in re.findall(r'^(\d+)\.', references, re.M)}
if cited != listed:
    failures.append('notes: cited %s, listed %s' % (sorted(cited - listed), sorted(listed - cited)))

# Private names, with the rules of `captain leakcheck`.
names_path = Path(os.environ.get('CAPTAIN_PRIVATE_NAMES') or Path.home() / '.config/captain/private-names')
if names_path.exists():
    entries = [line.strip() for line in names_path.read_text().splitlines()
               if line.strip() and not line.strip().startswith('#')]
    allowed = [e[1:] for e in entries if e.startswith('!') and len(e) > 1]
    for name in (e for e in entries if not e.startswith('!')):
        flags = re.I if name == name.lower() else 0
        pattern = re.compile(r'(^|[^A-Za-z0-9])' + re.escape(name) + r'($|[^A-Za-z0-9])', flags)
        masks = [re.escape(p) for p in allowed if name.lower() in p.lower()]
        mask = re.compile('|'.join(masks), re.I) if masks else None
        for number, line in enumerate(PAPER.splitlines(), 1):
            if pattern.search(mask.sub(' ', line) if mask else line):
                failures.append('private name on line %d' % number)
                break
else:
    failures.append('private-name list not found: ' + str(names_path))

# A released number needs committed evidence: verify the files at HEAD, not local edits.
git_status = subprocess.run(['git', '-C', str(ROOT), 'status', '--porcelain', '--', *sorted(evidence_paths)],
                            capture_output=True, text=True)
# Outside a Git work tree, no evidence counts as committed.
uncommitted = (sorted(evidence_paths) if git_status.returncode else
               sorted(line[3:] for line in git_status.stdout.splitlines() if line.strip()))
if uncommitted and not DRAFT:
    failures.append('uncommitted evidence: ' + ', '.join(uncommitted))

result = {'checks_failed': len(failures), 'draft': DRAFT, 'open_items': open_items,
          'uncommitted_evidence': uncommitted, 'words': len(PAPER.split())}
print(json.dumps(result, indent=2))
for failure in failures:
    print('FAIL', failure)
sys.exit(1 if failures else 0)
