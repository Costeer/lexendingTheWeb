# One-time release baseline transition for v0.5.1

The repository owner explicitly selected “Implement the one-time exception for
v0.5.1” on 2026-10-14. The committed
[policy record](../release/performance-baseline-transition.json) adopts that
single transition. It does not itself qualify a release or authorize publication.
All other release requirements remain in force.

The ordinary selector is unchanged: select the highest lower stable version
tag, require a strict ancestor of the exact clean tagged candidate, and require
the package version to match. It still selects published `v0.5.0`, commit
`f2670e24aa210b80f6baedfcf09d22a5dd91e640`, for `v0.5.1`. The separate named
transition requires retaining that original unsuccessful full command plus a
complete full comparison against frozen pre-audit commit
`9ba8c632ba900c39c0b102daa163ae3f0409488e`. That anchor is **19 commits later**.
Numerical regression coverage for those intervening commits is unavailable;
there is no unchanged or improved performance claim relative to `v0.5.0`.
`v0.5.2` and every subsequent release return to the ordinary selector; `v0.5.2`
therefore uses `v0.5.1`. No generic base argument, environment override,
automatic failed-baseline fallback, or transferable exception authorizes release.

## Reviewed historical failure mechanisms

The first `reading-80` baseline warmup can finish its two settled frames before
the first font `loadingdone` callback schedules a 100 ms refresh. The final
original check then sees healthy/active/ready with `pending: true`, revision 1.
The retained native trace identifies the exact `FunctionCall` registered at
historical `src/content.js:1039`, its timer stack `1059 → 913 → 909`, and its live
lifetime after the final frame. **A literal `loadingdone`-labelled or enclosing
`EventDispatch` is absent.** The independent review explicitly accepted the
exact native callback/source/lifetime evidence and disclosed that adjustment.
No event label is invented.

The conversation fixture's author observer and historical unconditional
invalidation produce ongoing refresh feedback. Source-linked queue evidence
and an intervention performed only after the original 15-second timeout show
that disconnecting only the author observer freezes writes/queues, permits one
pending refresh, and allows the original check to pass. The diagnostic is not a
full performance pass. Both mechanisms, scripts, source hashes, raw trace,
original failed report and independent review are preserved byte for byte under
[the provenance directory](../release/v0.5.1-provenance/).

The current harness records the exact state already read by a failed original
predicate/frame, then preserves the same assertion and throw/reject. After an
error it records phase, workload, browser/resource errors and source identity.
It adds no runtime hooks or diagnostic timers and does not change the runtime,
fonts, workload, settling condition, sample count, thresholds or successful
numerical operations. Failure strings alone cannot classify an occurrence.
Any different phase, missing atomic state, different pending predicate,
unexpected resource/browser/candidate error or unreviewed mechanism blocks the
transition. Existing historical records are never backfilled with new state.

## Exact-tag qualification contract

Use a committed, exact, clean `v0.5.1` checkout with full history and tags. Run
serially on an idle machine after builds. `--directory` accepts an absolute
external directory; prefer one so later builds cannot delete evidence.

```sh
node scripts/release-performance.mjs baseline --tag v0.5.1
node scripts/release-performance.mjs plan --tag v0.5.1
node scripts/release-performance.mjs collect-transition --tag v0.5.1 --directory /absolute/evidence
node scripts/release-performance.mjs seal-transition --tag v0.5.1 --directory /absolute/evidence
node scripts/release-performance.mjs verify --tag v0.5.1 --manifest /absolute/evidence/transition-manifest.json
```

`baseline` remains the ordinary historical selector. `plan` is the separate
named-policy check. Collection executes the original default full command
against the historical release and then the frozen anchor without changing any
fixture, assertion or tolerance. It retains `historical-report.json`,
`historical-command.json`, `historical.log`, `report.json`, `anchor-command.json`
and `anchor.log`. Historical status `error`, actual exit 1 and original raw bytes
remain unsuccessful. Collection alone grants no qualification: unexpected
errors remain in the artifacts and the separate verifier rejects them.

Sealing verifies the committed policy, frozen historical/anchor runtime and
font bytes, strict ancestry, approved causal inventory, unchanged measurement
sources, same exact candidate/harness/environment in both reports, default
three workloads and five samples plus alternating warmups, complete metrics,
raw responsiveness calibration/tasks/stream, recomputed comparisons, clean
source at both ends, original command arguments/exits/log/report hashes and
serial order. Any negative control remains disallowed. The generated manifest
binds the exact tag/commit/tree, policy blob, gate/harness/provenance hashes and
all raw artifact hashes. The committed policy avoids a self-referential
candidate hash.

The manifest's `finalCandidateSignoff` is explicitly a **machine verification
result**, created by a separate sealing step, never a claim of human approval.
This implements the proposal's final-candidate acceptance binding without
adding an unconfigured external approval dependency. Fresh independent source
and final raw-evidence review remain separate qualification evidence. The same
shared verifier is called by the CLI, performance CI and publishing CI.
Publishing downloads all original artifacts after builds, repeats verification
against the exact clean tag, and includes the
[coverage disclosure](../release/v0.5.1-disclosure.md).

## Detector controls and remaining requirements

Run `npm test`, `npm run check`, package/interface/installed-browser/integrity
and other existing release requirements. A synthetic unit fixture is never
release evidence. Preserve a full actual injected slowdown separately and
prove both ordinary and transition verification reject it. A supported control
runs a real 1000 ms candidate block against the frozen anchor; point it at a
**copy** of a complete positive bundle:

```sh
node scripts/release-performance.mjs collect-negative-control --tag v0.5.1 --directory /absolute/control-copy
node scripts/release-performance.mjs seal-transition --tag v0.5.1 --directory /absolute/control-copy
node scripts/release-performance.mjs verify --tag v0.5.1 --manifest /absolute/control-copy/transition-manifest.json
```

The latter two commands must exit nonzero. The control replaces only the copy's
anchor report/command/log with actual injected output, retaining the positive
historical evidence and stale positive manifest so fabrication is unnecessary.
Also submit its actual report to `verifyReleaseEvidence` (the ordinary verifier)
and require rejection. Retain the original actual command exit, intended raw
responsiveness detector regression, and both verifier rejections. Do not publish
to test a gate; do not loosen thresholds or change baselines after a failure.
