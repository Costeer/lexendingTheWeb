# Performance validation

For changes to page typography, layout repair, mutation handling, scheduling,
font loading, or runtime resources, run the empirical comparison before handing
the work back:

```sh
npm run test:performance -- --base HEAD
```

`HEAD` compares uncommitted edits with the current commit. If changes are already
committed, use the commit from before the changes or the PR base, for example
`--base origin/main`. Do not use a baseline that already includes the change.
Run the benchmark by itself on an idle machine. It takes several minutes.
Install prerequisites with `npm ci` and `npx playwright install chromium`.

The command fails on timing/work/memory regressions or broken behavior and saves
raw samples, source hashes, environment, medians, p95, and thresholds to
`dist/performance/report.json`. Run it after builds: `npm run build` deletes
`dist`. Preserve failed reports with `--output` before investigating a rerun.
Do not loosen tolerances, shrink workloads, or select a newer baseline to make a
regression pass. Investigate the measurements and rerun both versions together
if there is evidence of machine contention. Report the baseline commit, result,
and any remaining regressions. A pass covers these fixtures, not every website.

Also run `npm test` and `npm run check`. For performance-harness changes, verify
the comparator's negative tests and demonstrate that an injected slowdown causes
the actual browser command to exit nonzero. See [the performance guide](docs/performance.md)
for workload definitions and profiling commands.

The repository owner explicitly authorized one narrow exception for **v0.5.1**
on 2026-10-14. Only the committed
[transition policy](release/performance-baseline-transition.json), enforced by
[the shared verifier](scripts/performance/baseline-transition.mjs), may qualify
that exact clean tag against frozen `9ba8c632ba900c39c0b102daa163ae3f0409488e`.
Retain the original full unsuccessful `v0.5.0` comparison and full default3x5
anchor comparison for the same candidate/harness, with original exits and all
raw evidence. Disclose the 19-commit numerical coverage gap. This authorization
supersedes the no-newer-baseline rule only for this named transition; no other
validation, tolerance, workload or release requirement is waived. The ordinary
selector stays unchanged, and v0.5.2 must use v0.5.1. See
[the exact contract](docs/release-baseline-policy.md).
