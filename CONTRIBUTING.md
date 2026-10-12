# Contributing

Use Node.js 24, Python 3.12 or later, Git, and Poppler (`pdftotext`). Install the
locked JavaScript packages with `npm ci --ignore-scripts`.

Run these checks before a pull request:

```sh
npm run typecheck
npm test
python3 -B -m unittest discover -s test -p 'release_scan_test.py'
python3 -B evidence/check.py
python3 -B scripts/check-release.py --history
```

The release scan checks tracked files and unignored files in the working tree.
With `--history`, it also checks every commit reachable from local refs,
including file versions that later commits deleted, commit identities, commit
messages, and annotated tag metadata. A shallow clone fails the check. Fetch
all branches and tags before a release scan. Ignored local runtime files are
not release files and are excluded unless they are tracked.

The scan detects selected credential formats, literal bearer tokens, absolute
home paths, non-regular files, selected runtime and archive artifacts, unresolved
document markers, and missing relative Markdown link targets. It extracts PDF
text with Poppler. PDF text extraction does not inspect attachments or every
encoded object. Credential checks use explicit patterns, not a comprehensive
secret detector. They cannot prove that a tree contains no secrets. The scan
prints file names and reason codes, never matching content.

A release also needs the maintainer's private-name check. Keep that policy
outside the repository. Set `CAPTAIN_PRIVATE_NAMES` to its path and run:

```sh
python3 -B paper/verify.py
```

The paper check validates its listed evidence bindings and requires committed
evidence. CI supplies an empty policy file to run those public checks. CI does
not claim to check the maintainer's private-name policy.

Run the quickstart in a disposable checkout. It starts local services and writes
local keys and tokens under its ignored run state directory:

```sh
npm run demo -- --run local-check
```

Use simulated participants and local test services. Do not add credentials,
private keys, local state, or personal paths to a pull request. Keep changes and
tests focused on one behavior. Report security issues through
[SECURITY.md](SECURITY.md).
