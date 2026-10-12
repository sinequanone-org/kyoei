# Paper: Kyoei, repairable collaboration across organizations

Research preprint, 12 October 2026. Author: Captain Operator - Slyseed, Inc. &
Lemma Ventures AG. The paper distinguishes the specified protocol, the reviewed
source, and the two historical Cloudflare runs.

Two figures explain the specified workflow cycle and
the Cloudflare experiment architecture. The introduction presents context,
vision and goal before the request-signing example, requirements and approach.
The queued-event counts are unchanged. A separate row reports the 13
synchronous reliance exchanges in each deployed run. This revision follows the research-writing
skill.
The paper accompanies the Cloudflare contest entry. Its sections are:
introduction, state of the art, model and definitions, protocol, implementation
and evaluation, and conclusion with perspectives.

| File | Purpose |
| --- | --- |
| `paper.md` | Manuscript (pandoc Markdown). |
| `article.latex`, `format.lua` | LaTeX template and pandoc filter, adapted from the earlier Kyoei paper. |
| `build.py` | Builds `kyoei-repairable-collaboration.pdf` in this folder. |
| `figures/*.latex` | Editable TikZ sources for the workflow and experiment figures. |
| `figures/*.pdf`, `figures/*.png` | Vector figures for the PDF and previews for Markdown. |
| `verify.py` | Checks listed quantitative statements against saved evidence and selected source text, note numbers, placeholders, private names, and whether cited evidence is committed for release. |

Build and check, from the repository root:

The build uses pandoc, XeLaTeX with TikZ, and Poppler's `pdftoppm`. It rebuilds
both figures before the manuscript, so the PDF and Markdown previews agree.

```sh
python3 paper/build.py
python3 paper/verify.py --draft
python3 paper/verify.py   # release check
```

## Evidence rule

The evidence files are in [`../evidence/`](../evidence/README.md). They keep
their paths from the research repository: `verify.py` reads
`research/experiments/...` from `evidence/research/experiments/...`.

`alignment.json` pins the current source review, configuration, scenario, tests,
saved run files and figure sources. `alignment.py` rejects changed or missing
files and changed scope statements. It checks drift, not protocol conformance.
It does not identify the historical deployed bundle; neither run retained that
digest. The private check needs the adjacent port checkout. The public check
uses the source tree beside `paper/`. Review a changed file before updating its
binding. Never use this manifest as retrospective deployment evidence.

`verify.py` pairs selected evidence values with the text that states them, so a
change on either side fails. New claims require new checks and review. The relay
run's source hashes and totals are also checked against the source files and
request trace. These checks detect drift; they do not validate the experimental
design. Without `--draft`, the checker also fails when a cited evidence file is
modified or not yet committed.

The Cloudflare table (section 5.9) cites run `deployed-2-ai`. Its node logs are
copied to `research/experiments/cloudflare/`, and `verify.py` recounts every
table value from those logs, separately from the port's own `scripts/summary.ts`.
The checker also matches queued, delivered, and received events by identifier,
issuer, recipient, and kind, and verifies the sender's queue-to-receipt intervals.
This tests consistency, not log authenticity. The saved logs contain neither the
signed envelopes nor a deployed build digest.
To cite a later run, retain its build digest and non-secret verification evidence,
copy its logs there, and update the run name and bound values.

The 10 October audit excluded these results, and the paper does not use them:
the withdrawn SIDH score; the Priority 4 fewer-steps, cross-collaboration view
and F3 reference-arm results; the Kyoei "41 of 42 events" count; recovery steps
as a measured burden; the third-collaboration configuration count; and any
statement that a test gate covers the current tree.

## Scope of this release

The TypeScript port and its local tests accompany the paper. The selected
Python source files support evidence checks; they are not a runnable release
of the research prototype. The evidence README lists excluded material and
historical source snapshots.

Section 5.8 separates the current port fixes from remaining implementation
limits. Neither local tests nor source hashes retroactively validate the
historical deployed build. The saved Cloudflare logs have no signed envelopes
or deployed-build digest. Generated edits were not independently reviewed by
people, and the runs used one operator and one Cloudflare account.

The third-collaboration code count and batch-notice scorer keep the limitations
stated beside their results. No new benchmark result is inferred from this
release's code fixes.

## Interpretation after review

The novelty claim is integration, not the absence of existing mechanisms. No
result establishes that a paper is sound, that a claim is correct, or that
independent teams save time. The Cloudflare runs show that the port's mechanisms
work together in one account with scripted people; they are not a comparison.
The private review record stays outside the public repository.
