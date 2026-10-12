# Decisions and dependency checks

## Dependencies (pinned in package-lock.json)

| Package | Version | Use | Check |
| --- | --- | --- | --- |
| `@noble/hashes` | 2.4.0 | BLAKE3 content root (runtime) | MIT; registry publisher checked; no install script |
| `isomorphic-git` | 1.43.3 | Git over HTTPS in Workers (runtime, Worker only) | MIT; no install script |
| `typescript` | 7.0.2 | type check (dev) | Apache-2.0 |
| `@types/node` | 22.20.5 | Node types (dev) | MIT |
| `wrangler` | 4.149.0 | bundle and deploy Workers (dev) | MIT/Apache-2.0; published by Cloudflare; `workerd` and `esbuild` install scripts read before running: they only verify or fetch their platform binary from registry.npmjs.org |

## Design decisions

- Node tests run without a test framework: `node --test` with built-in type
  stripping. No Cloudflare account is needed to run them.
- Node 22 WebCrypto has no ML-DSA, so local tests sign with Ed25519. The
  Worker configuration selects ML-DSA-65. Both algorithms come from local
  configuration or a pinned peer, never from an incoming message.
- One OrgNode Durable Object per organization. Agent runs execute inside it.
  This is the confirmed contest architecture. Each run gets its own repository
  and write token. Runs share the organization's runtime and resource limits.
  The outbox alarm retries messages. Interrupted agent runs do not yet resume
  automatically from their last step.
- `stale-base` is per file (see docs/acceptance.md).
- A correction does not clear an earlier withdrawal.

## License and ownership

The copyright notice is `Copyright 2026 Slyseed, Inc. and Lemma Ventures AG`.
The project owner confirmed permission from both companies to publish and
submit the work. The release repository is `sinequanone-org/kyoei`. It remains private while
the initial release is reviewed.

Apache 2.0 remains the license. Like MIT, it permits commercial use and
proprietary derivatives. It also states a contributor patent grant for claims
necessarily infringed by the contribution, subject to the license terms.
Redistribution must preserve applicable notices and identify modified files.
This license does not grant rights to third-party patents or trademarks.
