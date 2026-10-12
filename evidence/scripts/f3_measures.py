"""Work counts for an F3 arm, rebuilt from the arm's own trace and nothing else.

A row is one signed client request. `observation` rows (notice and status reads by
the harness) and `external` rows (the simulated outside challenge and withdrawal)
are not adopter work. Failed attempts count. No count is typed in.
"""
from collections import Counter


def measures(report):
    trace = report['trace']
    work = [row for row in trace if row['role'] == 'adopter']

    def count(phase):
        rows = [row for row in work if row['phase'] == phase]
        return dict(steps=len(rows), refused=sum(row['outcome'] != 'ok' for row in rows),
                    operations=dict(sorted(Counter(row['operation'] for row in rows).items())))

    relay = Counter()
    for row in trace:
        for name in ('delivered', 'refused', 'unavailable'):
            relay[name] += row.get('relay', {}).get(name, 0)
    return dict(
        setup=count('setup'),
        declaration_work=count('declaration'),
        repair_work=count('repair'),
        batch_work=count('batch'),
        external_events=sum(row['role'] == 'external' for row in trace),
        observations=sum(row['role'] == 'observation' for row in trace),
        relay=dict(sorted(relay.items())),
        requests=len(trace))
