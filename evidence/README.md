# Evidence

This folder holds the saved evidence that the paper in [`../paper/`](../paper/)
cites, and the frozen contracts that this evidence binds. The checker
`paper/verify.py` reads these files.

The files keep their paths from the research repository. For example, the
checker reads `research/experiments/f2-v2/report.json` from
`evidence/research/experiments/f2-v2/report.json`. The digests inside the files
refer to these paths.

## Contents

| Path | Content |
| --- | --- |
| `research/experiments/` | The saved results that sections 2 and 5 of the paper cite. |
| `research/priority-one/`, `research/priority-two/`, `research/priority-three/` | The frozen scenario contracts of the first, second and third collaborations. |
| `research/priority-four/f3/` | The frozen contract, scenario and oracle of the withdrawal run (section 5.7). |
| `research/fallen-claims/successor-v2/` | The frozen contracts and protocol of the dependency-proposal experiment (section 5.6). Only the contracts are here. |
| `scripts/` | Seven modules of the research prototype. The withdrawal-run report binds five of them by digest. Section 5 quotes constants from three of them. They are here so that the checker can verify these bindings. They are not a runnable prototype. |

## Limits

- The files are published as they were saved. An edit breaks the digests that
  bind them.
- The replay of public challenge records
  (`research/experiments/yukon/report.json`) holds aggregate counts. The raw
  records come from third-party repositories and are not included. The report
  keeps their SHA-256 digests.
- You cannot rerun the dependency-proposal experiment (F2) from this folder. Its
  units hold passage hashes. The passages, the model receipts and the API keys
  are not published.
- Many evidence files also bind prototype modules, earlier attempts and logs by
  digest. Those files are not in this folder. The research prototype is planned
  for a later release.

## Historical bindings

Five saved bindings refer to earlier file versions that also appear
in this bundle. `binding-snapshots.json` maps each original report, path and
SHA-256 digest to an exact archived copy. The map also pins the report itself.
The original reports and their digests have not changed.

- The workspace-capture report binds the earlier identity module in
  `research/experiments/p1-2/source-snapshot/institution_identity.py`. This copy
  was recovered from version control. Its bytes match the saved digest.
- The comparison before isolation binds the two arm reports in
  `research/experiments/p2-1-kyoei/attempt-before-isolation/`. Their bytes match
  the saved digests. The later arm reports remain at their original paths.
- Both earlier arm reports bind the continuation module in their
  `source-snapshot/continuation_store.py` folder. This copy was recovered from
  version control. Its bytes match both saved digests.

The export gate checks these snapshots and rejects stale bindings. It also
rejects changed reports, changed snapshots and unused map entries. An archived
source digest does not prove that the source was deployed. The saved Cloudflare
runs still lack deployed-build digests and signed envelopes.

## Check

From the repository root:

```sh
python3 evidence/check.py
python3 paper/verify.py --draft
```
