# Deploy on Cloudflare

This page deploys three organization nodes (Acme, Birch, Cove) to one
Cloudflare account and runs the scenario against them. Independently operated
accounts need a separate deployment and trust review. The saved scenario does
not establish independent administration.

## Requirements

- A Workers Paid plan with Artifacts enabled.
- Node.js 22.18 or later, and `npm ci` in this repository.
- `npx wrangler login`. If Wrangler later answers `Authentication error
  [code: 10000]` for every account call, run `npx wrangler logout` and log in
  again.

## 1. Check the platform

`tools/probe` is a separate Worker. It runs the real Artifacts host and model
adapter against live bindings in its own namespace, then deletes the
repositories it made.

```bash
npx wrangler deploy -c tools/probe/wrangler.jsonc
openssl rand -hex 24 > /path/outside/repo/probe-token     # keep it private
printf '%s' "$(cat /path/outside/repo/probe-token)" | shasum -a 256 | cut -d' ' -f1 | tr -d '\n' \
  | npx wrangler secret put PROBE_TOKEN_SHA256 -c tools/probe/wrangler.jsonc
curl -H "authorization: Bearer $(cat /path/outside/repo/probe-token)" https://kyoei-probe.<subdomain>.workers.dev/run
npx wrangler delete -c tools/probe/wrangler.jsonc
```

It checks: repository create and fork; write and read tokens; commit, push
and notes from a Worker; refusal of a non-fast-forward push and of a push with
a read token; refusal of a stale merge; token revocation; ML-DSA-65 signing;
and JSON output from both Workers AI models.

## 2. Deploy the nodes

```bash
node scripts/deploy.ts up /path/outside/repo/env.json --subdomain <subdomain> --model workers-ai
```

The first call writes `env.json` (mode 0600) with one admin token per
organization. Each Worker stores only the SHA-256 digest of its token, as the
secret `ADMIN_TOKEN_SHA256`. `--model scripted` uses the recorded edits in
`demo/edits/` instead of a model.

## 3. Run the scenario

```bash
npm run demo -- --remote /path/outside/repo/env.json --run <id>
node scripts/map.ts runs/<id>
```

The runner acts as the three organizations' people through each node's admin
API. At the end it copies each node's log (`GET /api/log`) to
`runs/<id>/<org>.jsonl` and builds `runs/<id>/summary.json` from those logs
only. It clones the shared repository with a 120-second read token. The token
goes to Git as a header through the environment, not in the URL or the
arguments.

## 4. Reset

```bash
node scripts/deploy.ts reset /path/outside/repo/env.json
```

This deletes the three Workers, which deletes each node's Durable Object state
and signing key. It then deploys `tools/cleanup` for one call to delete every
repository in the three namespaces, and deletes that Worker. Wrangler cannot
confirm a repository delete without a terminal, so the cleanup Worker uses the
Artifacts binding.

## Notes

- Node clocks are separate. Times in a summary come from each node's own
  clock.
- A node's admin API is public behind its bearer token. Do not share
  `env.json`.
