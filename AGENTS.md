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
