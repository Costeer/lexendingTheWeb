# Release performance baseline: decision proposal

**Publication remains blocked. This document proposes a policy decision; it does
not change the release gate or qualify a release.**

## Why the next release is blocked

The [release selector](../scripts/performance/release-gate.mjs) requires the
highest lower stable version tag to be a strict ancestor of the exact, clean
candidate tag. The next release therefore selects `v0.5.0`, commit
`f2670e24aa210b80f6baedfcf09d22a5dd91e640`. The fixed initial anchor is used
only when there is no lower version tag; it is not an escape hatch.

A retained browser probe of those historical bytes failed the unchanged
`conversation-120` startup: typography did not settle within 15 seconds. The
historical runtime predates the author-style feedback fix. That probe confirms
the compatibility failure; it is not a full performance comparison or evidence
that the candidate regressed. Fixing the current candidate cannot repair an
immutable historical version.

Current implementation acceptance passed separately against the pre-audit
revision `9ba8c632ba900c39c0b102daa163ae3f0409488e`. That revision is **19 commits
after the published release**. Its passing report cannot establish a passing
comparison against `v0.5.0`.

A fresh default full comparison command against `v0.5.0` exited 1 earlier in
the sequence: the first `reading-80` baseline warm-up reported `Runtime did not
finish healthy and active`. The retained
`next-release-readiness/historical-full-command-report.json` has status `error`,
zero measured baseline samples and zero candidate samples. The historical
runtime hashes match the earlier probe. The candidate was commit `61dc8868`
with unchanged runtime bytes and uncommitted documentation explicitly recorded.
This is an additional, **unclassified failure**, not the previously observed
conversation timeout. It establishes neither a candidate regression nor
intended-tag proof. Diagnose it before deciding what, if any, narrow historical
exception could be justified.

A follow-up passive diagnostic completed `reading-80` and reproduced the
conversation's 15-second startup timeout with the same historical runtime
hashes and no captured console or page errors. It added state queries around
checks, which affect timing, and retained only the last successful check state.
It therefore does **not** explain or supersede the primary `reading-80` failure.
The retained `next-release-readiness/historical-startup-diagnostic.json` is
diagnostic evidence only. Further diagnosis must retain each phase and check
index, all state observations and the failing check's evidence. No exception is
ready for adoption.

## Recommended decision

Keep the existing gate fail closed until a separately reviewed policy is
adopted. The immediate next task is to explain the fresh `reading-80` failure
without modifying either runtime or the gate. If the historical incompatibility
is then understood and releasing across it is necessary, consider
one explicit migration for **one named future release**, using the already
frozen pre-audit revision above. Do not choose a revision after the candidate
changes, search for another passing revision, rewrite `v0.5.0`, or change any
fixture, settling requirement, threshold or sample count.

This is a change to release qualification, not a repair to the measurement.
[AGENTS.md](../AGENTS.md) prohibits selecting a newer baseline to make a
regression pass. The proposed anchor is newer than the preceding release, so
this proposal cannot be implemented as a routine fallback under that rule.
Adoption requires an explicit repository policy decision describing this one
compatibility boundary and its coverage loss. Until that decision is made,
publication stays blocked. Keeping the strict contract permanently is also a
valid decision.

The release disclosure must say that the historical comparison could not be
completed and that the candidate passed against the pre-audit anchor. It must
not claim unchanged or improved performance relative to `v0.5.0`; numerical
regression coverage for the intervening 19 commits is unavailable.

## Conditions for implementing that one migration

1. Name the intended release version before validation. Commit a reviewed,
   one-use policy record identifying that tag, historical tag and commit,
   frozen anchor, reason and required evidence. No generic `--base` override,
   environment switch, automatic “baseline failed” fallback or transferable
   exception may authorize publication. The current untagged package version
   `0.5.0` does not identify a future release.
2. Run the full, unchanged default comparison against the actual historical
   release on an idle machine and retain its nonzero exit, raw failure report,
   exact runtime/font/harness hashes and environment. The older single-workload
   probe supports the decision but does not replace this attempt. Preserve the
   fresh early `reading-80` failure and diagnose it independently; it cannot be
   grandfathered into a conversation-only exception. Only specifically
   diagnosed and reviewed historical incompatibilities may enter the policy
   record. A missing resource, browser crash, unclassified failure, different
   failure or candidate error must remain blocking.
3. Run all three workloads with alternating warm-ups and five measured samples
   per version against the frozen pre-audit anchor. Require unchanged policy,
   complete raw observations, no regression and `negativeControl: null` for
   the exact, clean intended tagged commit. Verify source stability at both
   ends and recompute comparisons from raw samples. Existing local audit
   acceptance is supporting evidence, not this intended-tag proof.
4. Bind both reports to the same candidate and current harness identities in a
   separate migration decision record. Preserve the historical report as
   **unsuccessful, with its original status, error and raw bytes** (`error` for
   the fresh command). Do not edit it into a pass or change the ordinary
   comparison schema to conceal its baseline. Both the CI gate and the
   publishing job must verify the same policy record and evidence before
   publication.
5. Keep all existing interface, installed-browser, package-integrity, test,
   check and release requirements. A baseline migration does not waive them.
   For every subsequent release, use its highest lower stable version tag
   under the existing strict-ancestor contract; the migration cannot recur.

## Required proof before the blocker can close

Add tests that accept only the named migration and reject reuse on another
tag, moved historical/anchor identities, an unrelated anchor, candidate-as-
baseline, stale or dirty candidate evidence, changed harness/protocol/policy,
missing historical failure, unexpected historical failure, negative-control
reports and missing metrics or samples. Preserve the existing strict-selector
and verifier negatives. Test that the next release selects the migrated
release itself, with no fallback to the old anchor.

Run `npm test`, `npm run check`, and the real empirical browser command after
builds, in isolation. Demonstrate an injected slowdown causing the actual
browser command and release verifier to exit nonzero. Finally require a
positive, complete verification of the exact intended tag and independently
review the two reports, policy decision and publishing checks. A unit fixture
or synthetic passing report is insufficient. Do not publish to test a gate.

The selector, workflows and verifier are unchanged by this proposal. The
[performance guide](performance.md#release-evidence-and-detector-controls)
continues to describe the active release contract.
