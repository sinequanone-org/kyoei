# Security

## Report a problem

Do not open a public issue for a vulnerability. Send a private report to
[security@sinequanone.org](mailto:security@sinequanone.org). Include the affected
version, expected behavior, observed behavior, and a minimal reproduction.
Remove credentials and personal data from the report.

## Trust boundaries

- **Between organizations:** only signed envelopes. Each names its issuer,
  audience, deployment, collaboration, kind, stable event ID, issue time,
  expiry and nonce. The receiver checks a pinned key, the audience, the
  deployment, the collaboration, the expiry and the signature, then the
  authority of the issuer over the named object. A replay has no second
  effect; an event ID reused with another payload is refused.
- **Repository access:** repo-scoped bearer tokens, sent only inside a release.
  Signatures do not encrypt. Between Workers the transport is HTTPS; the local
  demo uses loopback HTTP on 127.0.0.1.
- **Admin API:** every change needs the organization's admin token, compared
  by digest in constant time. Release, sign-off, ship and withdrawal refuse
  agents with `human-required`.
- **Model output:** untrusted. It must stay inside the task's file list and
  under 64 KiB per file. Material from other organizations is quoted as data in
  the prompt.

## Secrets

Token secrets and admin tokens never enter logs, console state, git notes,
errors or run logs. Test R20 checks this. `tools/record.py --check` scans
terminal recordings for token shapes. Local demo secrets live in
`runs/<id>/state/`, which Git ignores.

## Known limits

See the Limits section of the README and `docs/acceptance.md`, rows D01 to D05.
