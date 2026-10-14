# Port requirements and their acceptance tests

Each row is a requirement from the paper's protocol section (signed envelopes,
release, building on released work, the ship gate, withdrawal and correction,
challenges and dissent). The test names start with the row ID. Run them with
`npm test`; they need Node 22.18 or later and `git`, and no Cloudflare account.

Status words: **tested** means local assertions exercise the requirement.
**Partial** means those assertions do not cover every clause. **Demonstrated**
means the saved deployed run exercised the success path, without fault injection.
**Design** means the requirement has no acceptance test. Test passage does not
establish protocol conformance or recovery on Workers.

| ID | Requirement | Where | Status |
| --- | --- | --- | --- |
| R01 | Only a person releases, approves, ships and withdraws; an agent gets `human-required` | `OrgNode.person` | partial |
| R02 | Forged, misaddressed, expired, wrong-deployment and wrong-collaboration envelopes are refused; a replay has no second effect; an event ID reused with another payload is a `conflict`; only the owner withdraws its contribution | `core/envelope.ts`, `OrgNode.receive` | tested |
| R03 | A signed record binds deployment, collaboration and owner; moving it into another collaboration fails | `core/record.ts` | tested |
| R04 | The recipient fetches the exact commit and recomputes the BLAKE3 content root; a changed byte or mode is refused | `verifySnapshot`, `core/content.ts` | tested |
| R05 | Onward release of work that builds on another organization's contribution needs an explicit grant from that owner for each recipient and purpose; the onward release cannot outlive the upstream grant | `OrgNode.release` | tested |
| R06 | A withdrawal blocks declared dependents and keeps its cause; the notice has six fields | `applyChange`, `openNotice` | partial |
| R07 | A node that blocks its own work sends `blocked` to each organization that relies on it, so a third organization learns without seeing the remote graph | `applyChange` | partial |
| R08 | A challenge produces notices and blocks nothing; `affected` reaches a third organization along declared builds-on reliance; a citation-only branch does not forward impact | `ownerChallenge`, `applyChange` | tested |
| R09 | Dissent after a withdrawal stays visible and clears no block | `OrgNode.dissent` | tested |
| R10 | A correction without a release of the replacement marks the old version for replacement and grants no access | `register` (supersedes), `correct` | tested |
| R11 | With two blocked inputs, replacing one leaves the other block in place | `planRepair` | tested |
| R12 | A separately released alternative from another organization is offered, never applied silently; the repair is a new version that needs fresh approval | `alternatives`, `planRepair` | partial |
| R13 | Approval binds record, commit, content root, inputs and base; `stale-base` when main changed a file this candidate changes after its base, even without a text conflict | `binding`, `baseCheck` | tested |
| R14 | A lost receipt causes a retry that the recipient answers as a duplicate; one effect only; a delayed release never revives a withdrawal | outbox, inbox | partial |
| R15 | Registering reliance and reading the owner's state is one owner-side step; a withdrawal before registration is in the reply; a reply bound to another request is refused | `rely`, `answerRely` | partial |
| R16 | Unknown owner state leaves reliance pending; the gate refuses with the reason | `rely`, `gate` | tested by R16 and R25 |
| R17 | An unknown Git outcome after a merge stays unresolved until reconciled against the actual ref and its note | `ship`, `reconcile` | tested locally; R30 injects an Artifacts note failure before the main update |
| R18 | After a crash with a claimed outbox entry, the restarted node reclaims and delivers it once | `recoverClaims` | tested |
| R19 | Another live token can still fetch a withdrawn version; the node refuses managed reuse of it | `readInput`, `requireUsable` | partial |
| R20 | Token secrets never appear in console state, logs or git notes | `state`, logs, `noteText` | tested |
| R21 | Intents that name the same file are flagged to both organizations while the agents run | `acceptIntent` | partial |
| R22 | A withdrawal that arrives before its release leaves a tombstone; the later release arrives withdrawn | `apply` (withdraw, release) | tested |
| R23 | An event retried after its envelope expired is re-sealed with the same event ID and delivered once | `deliverOne` | tested |
| R24 | Every declared transitive builds-on input needs a current, verified release for integration; an expired grant blocks ship | `requireInputGrants` | tested |
| R25 | Pending candidate reliance blocks ship; a confirmed owner reply permits a fresh attempt | `gate`, `approve` | tested |
| R26 | Withdrawal state and delivery work commit before network revocation | `eventTransaction` | tested with a restart at the revocation boundary |
| R27 | An inbox receipt and its forwarding work commit together before signing | `receive`, `prepareOutbox` | tested with a restart before signing |
| R28 | Reliance requires a grant to the requesting peer for its stated purpose; a former recipient can still learn of withdrawal | `answerRely` | tested |
| R29 | Dissent goes to the notice source, not to unrelated pinned peers | `dissent` | tested |
| R30 | A failed Artifacts note write leaves the main ref unchanged | `ArtifactsHost.merge` | tested with a local Git adapter and mocked transport |
| R31 | Peer URLs use HTTPS, except local loopback addresses | `pin` | tested |
| R32 | Agent registration checks the delegating person, exact task, input list, file scope, contribute purpose, expiry and single use | `delegateTask`, `requireDelegation`, `register` | six refusal cases tested; normal agent runs test acceptance |
| R33 | A forwarded challenge retains the withheld-evidence marker in its notice | `apply`, `openNotice` | tested |
| R34 | Content identity binds symlink target bytes and modes; submodules, unsafe paths, duplicate paths and file/directory collisions are refused | `contentRoot`, `pathBytes` | tested |
| R35 | Concurrent reliance registers both recipients; a correctly bound older reply does not replace newer withdrawal state | `answerRely`, `rely` | tested |
| R36 | Two envelope IDs for one cause produce one notice and one forwarding event | `applyChange` | tested |
| R37 | Dissent and its delivery work survive a restart before signing | `dissent`, `eventTransaction` | tested |
| R38 | Approval stores pending reliance before any owner request; an interrupted request cannot reuse the previous current state | `approve` | tested |
| R39 | A failed token revocation is retained and retried after restart | `retryRevocations` | tested |
| R40 | Held contributions export as PROV-JSON and PROV-O JSON-LD. A local import recovers the five relation types. Recipients, purposes, expiry, tokens, tasks and withdrawal reasons are absent. Invalidation is recorded only for a withdrawn contribution. Imported authority creates no grant | `core/prov.ts`, `OrgNode.provenance` | tested |
| D01 | Release of a fork whose history contains unreleased inputs needs a separate export repository | — | design |
| D02 | Withheld challenge evidence is marked as withheld in the forwarded notice | `affected` payload and notice source | tested by R33; evidence stays withheld |
| D03 | Delivery between Workers over authenticated HTTPS; token secrets only inside TLS | `src/worker/` | peer validation tested by R31; HTTPS demonstrated in the saved runs |
| D04 | ML-DSA-65 signatures in Workers | `crypto/signer.ts` | demonstrated on Workers; local tests use Ed25519; saved logs omit signed envelopes |
| D05 | People sign with personal keys | — | design (admin tokens stand for people) |

## Rules that differ from the research prototype

- `stale-base` is per file: the candidate's base must be on main, and no later
  merge may have changed a file the candidate changes.
- A correction does not clear an earlier withdrawal. The withdrawn version stays
  blocked. Dependents repair onto the replacement or onto an alternative.
- Notices close only when a newer version of the same line is in force (and,
  at the integrator, shipped). The old version keeps its block for traceability.

## Recovery and authority limits

State changes first store unsigned delivery work in the same transaction.
The dispatcher signs that work and moves it to the outbox in one transaction.
A restart resumes either stage. Failed token revocations remain queued until
the host confirms revocation or the token lifetime ends. Event delivery runs
before revocation retries. The Worker arms a retry alarm before requests
and before delivery. It keeps a 30-second alarm after first use, including
idle periods, so an interrupted background task cannot lose its retry trigger.
The crash tests use saved local store state. They do not inject a process crash
into a deployed Durable Object.

Authenticated administrator requests create task delegations. A delegation
lasts at most one hour and permits one contribution registration. It does not
permit release, approval, withdrawal or dissent. Personal signing keys remain
D05 work. The node checks declared inputs and recorded snapshots; it does not
prove that an edit declares every dependency or implements its stated task.

Artifacts writes the operation note before it updates main. A note failure
cannot leave an unmarked merge on main. A failed main update can leave an
unused note. Reconciliation still leaves the operation unresolved when another
change moved main beyond the operation under review.

The original deployed logs stay unchanged. Local fixes and local tests do not
establish that those historical deployments used the new code. Fork-history
isolation remains D01 work. HTTP transport, administrator routes, model service
and alarm behavior still need deployed fault tests.

A gate uses the latest authenticated owner state held by the node and requires
completed reliance registration. It does not contact every owner for each use.
It cannot retract copies already fetched or override an irrevocable licence.
