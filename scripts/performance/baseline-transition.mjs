import assert from 'node:assert/strict';
import { readFile, writeFile } from 'node:fs/promises';
import { basename, dirname, resolve } from 'node:path';
import { compareSamples, policy } from './comparison.mjs';
import { protocol, workloads } from './workloads.mjs';
import { releaseBaseline, requiredMetrics, verifyMeasuredEvidence } from './release-gate.mjs';
import { commitFor, git, gitState, harnessHashes, runtimeSnapshot, sha256 } from './sources.mjs';

export const transitionTag = 'v0.5.1';
export const transitionPolicyPath = 'release/performance-baseline-transition.json';
const historicalCommit = 'f2670e24aa210b80f6baedfcf09d22a5dd91e640';
const anchorCommit = '9ba8c632ba900c39c0b102daa163ae3f0409488e';
const reviewedCausalHash = 'a352ee31c5b2d9b9bc7f39caf70d54b7142bdc77f98b05d15ebada90de82a038';
const reviewedOrdinalHash = '18c43f31b08be80cf629e127ce5e6ad24607bf5efbc0ec854c0fa200d45ee24e';
const ordinalReviewPath = 'release/v0.5.1-ordinal-provenance/historical-round-eligibility-review-v1.json';
const adoptedPolicySha256 = 'a8416e057bd8c70444abf920b9deec78d8b53e6e2b7060bd56dc7ab9bc3468a7';
const transitionId = 'lexend-v0.5.1-historical-settling-2026-10-14';
const fileHash = async path => sha256(await readFile(path));
const parse = async path => JSON.parse(await readFile(path, 'utf8'));
const same = (actual, expected, message) => assert.deepEqual(actual, expected, message);
const measuredOrder = Array.from({ length: 6 }, (_, round) => ({ warmup: round === 0,
  versions: round % 2 ? ['candidate', 'baseline'] : ['baseline', 'candidate'] }));
const environmentFields = ['node', 'playwright', 'chromium', 'platform', 'arch', 'cpu'];

function ancestor(root, before, after) {
  assert.notEqual(before, after, 'Transition anchor must be a strict ancestor');
  try { git(root, 'merge-base', '--is-ancestor', before, after); }
  catch { throw new Error('Transition historical/anchor/candidate ancestry differs'); }
}

// There is deliberately no caller-supplied tag, anchor, baseline or policy path.
// This one-use route can only authorize the named, committed v0.5.1 boundary.
export async function transitionPlan(root, tag) {
  assert.equal(tag, transitionTag, 'The baseline transition is only authorized for v0.5.1; reuse is forbidden');
  const release = releaseBaseline(root, tag);
  assert.equal(release.baselineRef, 'refs/tags/v0.5.0', 'Transition preceding release tag differs');
  assert.equal(release.baseline, historicalCommit, 'Historical v0.5.0 tag moved');
  assert.equal(commitFor(root, anchorCommit), anchorCommit, 'Frozen anchor is missing');
  ancestor(root, historicalCommit, anchorCommit);
  ancestor(root, anchorCommit, release.candidate);
  assert.equal(Number(git(root, 'rev-list', '--count', `${historicalCommit}..${anchorCommit}`).toString()), 19,
    'Historical coverage gap differs');
  const bytes = git(root, 'show', `${release.candidate}:${transitionPolicyPath}`);
  assert.equal(sha256(bytes), adoptedPolicySha256, 'Adopted transition policy changed');
  const record = JSON.parse(bytes);
  same(await readFile(resolve(root, transitionPolicyPath)), bytes, 'Policy differs from the committed candidate');
  assert.equal(record.schemaVersion, 1, 'Unsupported transition policy');
  assert.equal(record.id, transitionId, 'Transition policy identity differs');
  assert.equal(record.intendedTag, transitionTag, 'Transition policy tag differs');
  assert.equal(record.expiry, 'v0.5.1-only; subsequent releases use highest-lower-stable-tag', 'Transition expiry differs');
  same(record.historical, { tag: 'v0.5.0', commit: historicalCommit,
    hashes: (await runtimeSnapshot(root, historicalCommit)).hashes }, 'Frozen historical bytes differ');
  same(record.anchor, { commit: anchorCommit,
    hashes: (await runtimeSnapshot(root, anchorCommit)).hashes }, 'Frozen anchor bytes differ');
  assert.equal(record.coverageGapCommits, 19, 'Missing 19-commit coverage disclosure');
  same(record.measurement, { samplesPerVersion: 5, protocol, policy,
    workloads: workloads.map(({ name, html, conversation }) => ({ name, htmlSha256: sha256(html), conversation: !!conversation })) },
  'Transition changes protocol, workloads, policy or default sampling');
  same(record.harnessHashes, await harnessHashes(root, release.candidate), 'Transition approved harness differs');
  const reference = { commit: 'c38a14a1fbbf7f5e8083e3f4bdd36da3063f065d',
    unchangedFiles: ['scripts/performance/comparison.mjs', 'scripts/performance/responsiveness.mjs',
      'scripts/performance/runtime-resources.mjs', 'scripts/performance/sources.mjs', 'test/helpers/conversation.mjs'],
    observationOnlyFiles: ['scripts/test-performance.mjs', 'scripts/performance/workloads.mjs'] };
  same(record.successfulMeasurementReference, reference, 'Measurement reference differs');
  for (const path of reference.unchangedFiles) same(git(root, 'show', `${release.candidate}:${path}`),
    git(root, 'show', `${reference.commit}:${path}`), `Unchanged measurement source differs: ${path}`);

  assert.equal(record.provenance.review, 'release/v0.5.1-provenance/workflow-independent-evidence-review.json', 'Causal review path differs');
  assert.equal(record.provenance.files[record.provenance.review], reviewedCausalHash, 'Unapproved causal review');
  const review = JSON.parse(git(root, 'show', `${release.candidate}:${record.provenance.review}`));
  const expectedFiles = Object.fromEntries(Object.entries(review.artifactHashes).map(([path, hash]) => [`release/v0.5.1-provenance/${path}`, hash]));
  expectedFiles[record.provenance.review] = reviewedCausalHash;
  expectedFiles['release/v0.5.1-provenance/user-authorization.json'] = record.provenance.authorizationSha256;
  same(record.provenance.files, expectedFiles, 'Causal evidence inventory differs');
  for (const [path, hash] of Object.entries(expectedFiles)) {
    assert.equal(sha256(git(root, 'show', `${release.candidate}:${path}`)), hash, `Reviewed causal evidence changed: ${path}`);
  }
  assert.equal(review.reading.literalEarlierEventDispatchCriterionMet, false, 'Native event-label caveat is missing');
  assert(review.reading.explicitEvidenceAdjustment.includes('Literal labelled/enclosing EventDispatch is absent'), 'Missing approved native source-causal interpretation');
  const authorization = JSON.parse(git(root, 'show', `${release.candidate}:release/v0.5.1-provenance/user-authorization.json`));
  assert.equal(authorization.authority, 'Explicit user response: Implement the one-time exception for v0.5.1', 'Missing explicit one-time authority');
  assert.equal(authorization.intendedTag, tag, 'Authorization tag differs');
  assert.equal(authorization.historicalCommit, historicalCommit, 'Authorization historical identity differs');
  assert.equal(authorization.frozenAnchor, anchorCommit, 'Authorization anchor differs');

  // This separate ordinal review supplements, never replaces or edits, the
  // canonical causal inventory above. Its original occurrence stays error.
  assert.equal(record.ordinalProvenance?.review, ordinalReviewPath, 'Ordinal review path differs');
  const ordinalBytes = git(root, 'show', `${release.candidate}:${ordinalReviewPath}`);
  assert.equal(sha256(ordinalBytes), reviewedOrdinalHash, 'Unapproved ordinal eligibility review');
  const ordinalReview = JSON.parse(ordinalBytes);
  const ordinalFiles = Object.fromEntries(Object.values(ordinalReview.actualUnsuccessfulOccurrence.artifacts)
    .map(({ recommendedCommittedPath, sha256: hash }) => [recommendedCommittedPath, hash]));
  ordinalFiles[ordinalReviewPath] = reviewedOrdinalHash;
  same(record.ordinalProvenance.files, ordinalFiles, 'Ordinal provenance inventory differs');
  for (const [path, hash] of Object.entries(ordinalFiles)) assert.equal(
    sha256(git(root, 'show', `${release.candidate}:${path}`)), hash, `Ordinal scope evidence changed: ${path}`);
  for (const path of ['scripts/performance/workloads.mjs', 'scripts/test-performance.mjs', 'scripts/performance/comparison.mjs']) {
    assert.equal(record.harnessHashes[path], ordinalReview.reviewedCandidate.sourceHashes[path],
      `Ordinal review measurement source differs: ${path}`);
  }

  return { ...release, kind: 'one-time-transition', historical: historicalCommit, baseline: anchorCommit,
    policySha256: sha256(bytes), transitionId, record };
}

async function commonIdentity(root, plan, report, baseline) {
  assert.equal(report.schemaVersion, 2, 'Unsupported historical evidence schema');
  assert.equal(report.negativeControl, null, 'Historical negative control cannot qualify');
  assert.equal(report.samplesPerVersion, 5, 'Historical command must use five measured samples');
  same(report.protocol, protocol, 'Historical protocol differs');
  same(report.policy, policy, 'Historical thresholds differ');
  same(report.harnessHashes, plan.record.harnessHashes, 'Dual-report harness differs');
  same(report.candidate, { ...gitState(root), hashes: (await runtimeSnapshot(root, plan.candidate)).hashes }, 'Historical candidate source/clean status differs');
  assert.equal(report.endGitStatus, '', 'Historical source stability is missing');
  assert.equal(report.baseline?.commit, baseline, 'Historical baseline differs');
  same(report.baseline?.hashes, plan.record.historical.hashes, 'Historical runtime/font bytes differ');
  for (const field of environmentFields) assert(typeof report.environment?.[field] === 'string' && report.environment[field], `Missing historical environment: ${field}`);
}

async function verifyHistorical(root, plan, report) {
  assert.equal(report.status, 'error', 'Original historical report must remain error');
  assert(typeof report.error === 'string' && report.error.length > 0, 'Original historical failure is missing');
  assert.equal(report.browserShutdownError, undefined, 'Historical browser shutdown failure blocks qualification');
  assert(!report.error.includes('Browser shutdown failed:'), 'Historical appended browser shutdown failure blocks qualification');
  assert.equal(report.regressions, undefined, 'Historical failure may not masquerade as a completed comparison');
  await commonIdentity(root, plan, report, historicalCommit);
  const failure = report.failure;
  assert(failure && failure.version === 'baseline' && Number.isInteger(failure.round)
    && failure.round >= 0 && failure.round <= 5 && failure.warmup === (failure.round === 0),
    'Historical baseline startup sampling position differs');
  const observation = failure.observation;
  assert(observation && observation.originalAssertion === true && observation.phase === 'startup'
    && observation.workload === failure.workload && observation.source === 'scripts/performance/workloads.mjs',
  'Missing historical phase/source/original assertion provenance');
  same(observation.browserErrors, [], 'Historical resource/page/browser errors block qualification');
  const atomic = observation.atomic;
  const state = atomic?.state;
  assert(state?.healthy === true && state.active === true && state.pending === true && state.ready === true
    && state.error === null && state.hostname === 'performance.test' && state.scope === 'all',
  'Historical failure does not match the reviewed healthy/active/pending predicate');
  assert.equal(atomic.fontsStatus, 'loaded', 'Historical fonts are not loaded');
  assert.equal(atomic.requestedSize, 19.2, 'Historical requested typography differs');
  assert(Number.isFinite(atomic.capturedAt) && atomic.capturedAt >= 0, 'Missing atomic historical failure capture');
  const reading = failure.workload === 'reading-80' && atomic.kind === 'final-check' && state.refreshRevision === 1;
  const conversation = failure.workload === 'conversation-120' && failure.round === 0 && failure.warmup === true
    && atomic.kind === 'settle-timeout'
    && Number.isInteger(state.refreshRevision) && state.refreshRevision >= 2
    && atomic.loaded === true && atomic.stableFrames < 2 && atomic.elapsedMs > 15000
    && Number.isFinite(atomic.firstFontFrameMs);
  assert(reading || conversation, 'Historical failure is unexpected or undiagnosed');
  assert(report.error.includes(reading ? 'Runtime did not finish healthy and active'
    : 'Typography did not settle with loaded fonts within 15 seconds'), 'Historical original assertion differs');
  const expectedNames = reading ? ['reading-80'] : workloads.map(workload => workload.name);
  same(Object.keys(report.workloads), expectedNames, 'Historical failure workload position differs');
  for (const workload of workloads) {
    const runs = report.workloads[workload.name];
    if (!runs) continue;
    if (reading) {
      verifyReadingPrefix(runs, workload, failure.round);
    } else if (workload.name === failure.workload) {
      same(runs.baseline, [], 'Historical failed warmup has measured baseline records');
      same(runs.candidate, [], 'Historical failed warmup has candidate records');
      same(runs.order, measuredOrder.slice(0, 1), 'Historical warmup order differs');
      assert.equal(runs.comparison, undefined, 'Failed historical workload contains a comparison');
      if (workload.conversation) same(runs.rawResponsiveness, { baseline: [], candidate: [] }, 'Failed historical workload contains raw measurements');
    } else {
      // Earlier reading workloads may have completed before the independently
      // diagnosed conversation startup. Reuse the full numerical verifier on
      // their raw records below, with the untouched failing workload excluded.
      assert.equal(runs.baseline?.length, 5, 'Historical preceding sample count differs');
      assert.equal(runs.candidate?.length, 5, 'Historical preceding sample count differs');
      same(runs.order, measuredOrder, 'Historical preceding sampling order differs');
    }
  }
  // Earlier successful phases may contain an actual regression; never turn
  // that into an approved settling failure. A complete surrogate is forbidden:
  // check just the genuinely completed raw reading records directly.
  if (conversation) {
    for (const workload of workloads.filter(item => !item.conversation)) {
      const runs = report.workloads[workload.name];
      for (const sample of [...runs.baseline, ...runs.candidate]) for (const metric of requiredMetrics(workload)) {
        assert(Number.isFinite(sample[metric]), `Missing historical preceding metric: ${metric}`);
      }
      const comparison = compareSamples(runs.baseline, runs.candidate);
      assert(!comparison.some(row => row.regression), 'Historical preceding measured regression remains blocking');
      same(runs.comparison, comparison, 'Historical preceding raw/computed records differ');
    }
  }
  return reading ? 'historical-loadingdone-after-settled-frame' : 'historical-author-style-feedback';
}

// Each workload invocation has a fresh document. The reviewed late loadingdone
// mechanism is independent of its sampling ordinal, but every completed sample
// and the exact default schedule prefix still have to be retained and valid.
function verifyReadingPrefix(runs, workload, failedRound) {
  same(runs.order, measuredOrder.slice(0, failedRound + 1), 'Historical reading sampling prefix differs');
  const completed = { baseline: 0, candidate: 0 };
  for (let round = 0; round <= failedRound; round++) {
    for (const version of measuredOrder[round].versions) {
      if (round === failedRound && version === 'baseline') break;
      if (round > 0) completed[version]++;
    }
  }
  for (const version of ['baseline', 'candidate']) {
    assert(Array.isArray(runs[version]) && runs[version].length === completed[version],
      `Historical failed prefix measured ${version} count differs`);
  }
  assert.equal(runs.comparison, undefined, 'Incomplete historical reading cannot contain a comparison');
  assert.equal(runs.rawResponsiveness, undefined, 'Historical reading cannot contain raw responsiveness');
  const metrics = requiredMetrics(workload).sort();
  assert.equal(metrics.length, 24, 'Reviewed historical reading metric coverage differs');
  for (const sample of [...runs.baseline, ...runs.candidate]) {
    assert(sample && typeof sample === 'object' && !Array.isArray(sample), 'Missing historical reading sample');
    same(Object.keys(sample).sort(), metrics, 'Historical reading metric coverage differs');
    for (const metric of metrics) assert(Number.isFinite(sample[metric]) && sample[metric] >= 0,
      `Historical reading metric must be finite and nonnegative: ${metric}`);
  }
  // Only actual common-index pairs enter the unchanged comparator. An extra
  // completed candidate remains in the raw report/manifest, never fabricated
  // into a pair or discarded. This is a veto, not a completed v0.5.0 comparison.
  const paired = runs.baseline.length;
  if (paired >= 3) {
    const comparison = compareSamples(runs.baseline, runs.candidate.slice(0, paired));
    assert(!comparison.some(row => row.regression), 'Historical partial reading regression remains blocking');
  }
}

function artifactPath(directory, name) {
  assert(typeof name === 'string' && /^[a-zA-Z0-9][a-zA-Z0-9._-]*$/.test(name), 'Unsafe or missing evidence artifact name');
  return resolve(directory, name);
}

async function verifyCommand(directory, artifact, report, plan, baseline, expectedExit) {
  same(Object.keys(artifact).sort(), ['command', 'log', 'report'].sort(), 'Command artifact inventory differs');
  const command = await parse(artifactPath(directory, artifact.command));
  assert.equal(command.schemaVersion, 1, 'Missing command execution record');
  assert.equal(command.exitCode, expectedExit, 'Actual performance command exit differs');
  assert.equal(command.signal, null, 'Performance command was interrupted');
  same(command.candidateBefore, { commit: plan.candidate, tree: plan.tree, gitStatus: '' }, 'Command started on stale or dirty candidate');
  same(command.candidateAfter, command.candidateBefore, 'Command source changed');
  assert.equal(basename(command.output), artifact.report, 'Command output report name differs');
  same(command.argv, ['npm', 'run', 'test:performance', '--', '--base', baseline, '--output', command.output],
    'Command must be the full default unchanged performance command');
  assert.equal(command.reportSha256, await fileHash(artifactPath(directory, artifact.report)), 'Original report bytes changed');
  assert.equal(command.logSha256, await fileHash(artifactPath(directory, artifact.log)), 'Command output bytes changed');
  const start = Date.parse(command.startedAt), end = Date.parse(command.finishedAt);
  const reportStart = Date.parse(report.startedAt), reportEnd = Date.parse(report.finishedAt);
  assert(Number.isFinite(start) && Number.isFinite(end) && start <= reportStart && reportStart <= reportEnd && reportEnd <= end,
    'Report does not belong to its command execution');
  assert(command.cwd && typeof command.cwd === 'string', 'Missing execution directory');
  return command;
}

export async function verifyTransitionReports(root, tag, directory) {
  const plan = await transitionPlan(root, tag);
  const historical = await parse(resolve(directory, 'historical-report.json'));
  const anchor = await parse(resolve(directory, 'report.json'));
  const classification = await verifyHistorical(root, plan, historical);
  await verifyMeasuredEvidence(root, plan, anchor);
  same(anchor.harnessHashes, historical.harnessHashes, 'Dual-report harness mismatch');
  same(anchor.candidate, historical.candidate, 'Dual-report candidate mismatch');
  same(anchor.environment, historical.environment, 'Dual-report environment mismatch');
  const historicalCommand = await verifyCommand(directory, { command: 'historical-command.json', log: 'historical.log', report: 'historical-report.json' }, historical, plan, historicalCommit, 1);
  const anchorCommand = await verifyCommand(directory, { command: 'anchor-command.json', log: 'anchor.log', report: 'report.json' }, anchor, plan, anchorCommit, 0);
  assert(Date.parse(historicalCommand.finishedAt) <= Date.parse(anchorCommand.startedAt), 'The dual comparisons must run serially');
  return { plan, historical, anchor, classification };
}

async function binding(root, directory, verified) {
  const { plan, classification } = verified;
  const files = ['historical-report.json', 'report.json', 'historical-command.json', 'anchor-command.json', 'historical.log', 'anchor.log'];
  return {
    schemaVersion: 1, transitionId, tag: transitionTag, packageVersion: '0.5.1',
    candidate: { commit: plan.candidate, tree: plan.tree, gitStatus: '' },
    policySha256: plan.policySha256, historicalCommit, anchorCommit, classification,
    harnessHashes: plan.record.harnessHashes,
    gateHashes: Object.fromEntries(['scripts/performance/release-gate.mjs', 'scripts/performance/baseline-transition.mjs', 'scripts/release-performance.mjs']
      .map(path => [path, sha256(git(root, 'show', `${plan.candidate}:${path}`))])),
    provenanceHashes: plan.record.provenance.files,
    ordinalProvenanceHashes: plan.record.ordinalProvenance.files,
    artifacts: Object.fromEntries(await Promise.all(files.map(async name => [name, await fileHash(resolve(directory, name))])))
  };
}

// This is a machine acceptance record, never a claim of human approval. Real
// independent source/raw-evidence review remains separate release evidence.
// Generated binding avoids embedding a candidate hash in its own source tree.
export async function createTransitionManifest(root, tag, directory) {
  const verified = await verifyTransitionReports(root, tag, directory);
  const expected = await binding(root, directory, verified);
  const signoff = { schemaVersion: 1, kind: 'machine-verification',
    decision: 'verified-v0.5.1-transition', verifier: 'shared-release-performance-verifier',
    verifiedAt: new Date().toISOString(), coverageGapDisclosed: 19, binding: expected };
  verifySignoff(signoff, expected);
  const manifest = { ...expected, finalCandidateSignoff: signoff };
  await writeFile(resolve(directory, 'transition-manifest.json'), JSON.stringify(manifest, null, 2) + '\n');
  return manifest;
}

function verifySignoff(signoff, expected) {
  assert(signoff && signoff.schemaVersion === 1 && signoff.kind === 'machine-verification'
    && signoff.decision === 'verified-v0.5.1-transition', 'Missing final candidate machine verification');
  assert.equal(signoff.verifier, 'shared-release-performance-verifier', 'Final verifier identity differs');
  assert(Number.isFinite(Date.parse(signoff.verifiedAt)), 'Missing final verification time');
  assert.equal(signoff.coverageGapDisclosed, 19, 'Final verification must disclose the explicit coverage gap');
  same(signoff.binding, expected, 'Final candidate review is stale or does not bind all original evidence');
}

export async function transitionReviewBinding(root, tag, directory) {
  return binding(root, directory, await verifyTransitionReports(root, tag, directory));
}

export async function verifyTransitionEvidence(root, tag, manifestPath) {
  assert(manifestPath, 'v0.5.1 requires the generated dual-report transition manifest');
  const directory = dirname(resolve(manifestPath));
  const manifest = await parse(manifestPath);
  const verified = await verifyTransitionReports(root, tag, directory);
  const expected = await binding(root, directory, verified);
  const { finalCandidateSignoff, ...actual } = manifest;
  same(actual, expected, 'Generated transition manifest is stale, altered or missing evidence');
  verifySignoff(finalCandidateSignoff, expected);
  return verified.plan;
}
