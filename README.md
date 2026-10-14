<p align="center">
  <img src="assets/logo.svg" alt="Kyoei Logo" width="120" height="120">
</p>

# Kyoei

Git records what changed. Kyoei records what each change depends on and who
may use it. Agents and people from several organizations can then build one
codebase together, and the shared result stays repairable.

The name is Japanese 共栄, *kyōei*: mutual prosperity, people and AI prospering
together.

## What it does

Each organization runs its own Kyoei node, with its own signing key and its
own repositories. Agents work at the same time, one repository per agent run.

- **Contribution.** Each change becomes a signed record: who made it, the
  task, the rationale, the inputs it builds on or cites, the model, and a
  BLAKE3 root over the exact committed files. The record also travels with the
  commit as a git note under `refs/notes/kyoei`.
- **Release.** Work crosses organizations only when a person releases it. A
  release is a signed message to named organizations, for named purposes, until
  an expiry. It carries a read token for that one repository. The recipient
  fetches the exact commit and recomputes the content root.
- **Coordination.** Agents declare intents. The integrator's node flags two
  intents on the same file while both agents still run.
- **Review and ship.** A person signs off the exact version. The gate checks
  the signature, the content root, the release, the inputs, the sign-off and
  the base, and shows each check. A change on a stale base gets `stale-base`
  and a rebase repair.
- **Change after use.** When an owner withdraws a contribution, its node
  revokes the read tokens it issued and sends a signed event. Each node
  computes which of its own work builds on it, blocks only that work, and opens
  a notice with the cause, the evidence, who can act and the allowed repairs.
  Work that only cites it gets a notice and stays usable. Unrelated work keeps
  shipping.
- **Repair.** A blocked line of work can move onto a replacement from the same
  owner or onto an alternative that another organization released. Kyoei offers
  the options; a person chooses; the repair is a new version that needs a fresh
  sign-off.

## Quickstart (no Cloudflare account needed)

Requirements: Node.js 22.18 or later and `git`.

```bash
npm ci
npm run typecheck
npm test
npm run demo -- --run my-run   # the full scenario: three node processes
```

`npm run demo` starts one local repository service and three node processes
(Acme, Birch, Cove) on `127.0.0.1:8700-8703`. It runs 16 agent runs in two
waves, a merge conflict, a withdrawal, a move onto another organization's
signer, a correction and its repairs, then a plain `git log --notes=kyoei` on a
fresh clone. It writes:

- `runs/<id>/a.jsonl`, `b.jsonl`, `c.jsonl`: what each node logged;
- `runs/<id>/summary.json`: every reported number, computed from those logs by
  `scripts/summary.ts`;
- `runs/<id>/git-log.txt`: the notes as Git shows them.

Then draw the branch map: `node scripts/map.ts runs/<id>` → `runs/<id>/map.svg`.

While a demo runs with `--hold`, watch one organization:

```bash
./bin/kyoei.mjs watch --org a
./bin/kyoei.mjs alternatives a3 --org a
./bin/kyoei.mjs gate a3 --org c
```

## On Cloudflare

`src/worker/` runs the same node in a Durable Object, with Artifacts as the
repository host and Workers AI for agents. Each organization has one OrgNode
Durable Object; its agents run inside it, with one repository per agent run.
There is no separate AgentRun Durable Object. One Worker per organization. After `npx wrangler login`:

```bash
node scripts/deploy.ts up ~/kyoei-env.json --subdomain <your workers.dev subdomain> --model workers-ai
npm run demo -- --remote ~/kyoei-env.json
node scripts/deploy.ts reset ~/kyoei-env.json   # removes Workers, node state and repositories
```

See [docs/deploy.md](docs/deploy.md) for the steps and what each one checks.

Status (11 October 2026): the full scenario ran on three deployed Workers
twice, once with scripted edits and once with Workers AI agents
(`runs/deployed-1`, `runs/deployed-2-ai`). Both runs give the same counts;
only the edit source and the times differ. `tools/probe` checked the
Artifacts and Workers AI calls first (`runs/probe/result.json`, 25 of 25).
See [docs/acceptance.md](docs/acceptance.md) for what is tested and what is
design only.

## Limits

- A withdrawal stops managed use: the node refuses it and the owner revokes the
  read tokens it issued. It does not delete copies already fetched and does not
  cancel licences already granted. Another live token to the same repository
  can still fetch the old version.
- Each node finds only the dependencies that were declared. Nothing finds an
  undeclared one.
- A signature attributes a record to an organization key. It does not prove
  that the code is correct, tested or licensed.
- In the demo, people are represented by an admin token per organization, not
  by personal keys. All three organizations run on one machine (locally) or one
  account (on Cloudflare). Independent administration is a deployment goal;
  these runs do not establish it.
- With `--model scripted`, agent edits are scripted and labelled as such in
  every record. With `--model workers-ai`, a model writes the edits. Kyoei
  checks that each edit stays inside the task's files and size limit; it does
  not check that the code compiles or is correct.
- Agents share their organization's runtime and resource limits. Run status is
  stored, but interrupted agent runs do not yet resume automatically. Message
  retries use the organization's outbox alarm.
- Repository tokens grant access to Git history. Do not release a repository
  that contains undisclosed work in its history. The port does not yet create
  a separate export repository automatically.
- Local checks cover the current source. The historical Cloudflare logs do not
  include a deployed-build digest or signed envelopes. They cannot establish
  that the current fixes ran on Workers.
- No measured saving in time or effort is claimed.

## Paper and verification

Read the [paper](paper/kyoei-repairable-collaboration.pdf), its
[source and checks](paper/README.md), and the [evidence scope](evidence/README.md).
[CONTRIBUTING.md](CONTRIBUTING.md) lists the release checks. Report security
issues to [security@sinequanone.org](mailto:security@sinequanone.org).

## Layout

| Path | Content |
| --- | --- |
| `src/core/` | canonical JSON, records, envelopes, BLAKE3 content root, vocabulary |
| `src/crypto/` | ML-DSA-65 and Ed25519 keys through WebCrypto |
| `src/node/` | the node: ledger, releases, reliance, gate, withdrawal, outbox, HTTP API |
| `src/agents/` | the agent run and scripted edits |
| `src/local/` | local repository service and node process |
| `src/worker/` | Worker, Durable Object, Artifacts host, Workers AI model |
| `src/cli/` | the `kyoei` command and the watch view |
| `demo/` | seed files and scripted edits |
| `scripts/` | demo runner, summary, branch map |
| `tools/record.py` | terminal recorder (asciicast v2) with a secret check |
| `test/` | acceptance and flow tests |

## License

Apache License 2.0. See [LICENSE](LICENSE) and [NOTICE](NOTICE).
