import assert from 'node:assert/strict';
import { compareSamples, policy } from './comparison.mjs';
import { protocol, workloads } from './workloads.mjs';
import { commitFor, git, gitState, harnessHashes, runtimeSnapshot } from './sources.mjs';

// Only used before the repository has any lower-version release tag. This is
// the audited pre-roadmap source, never a moving HEAD/HEAD^ fallback.
export const initialReleaseBaseline = '9ba8c632ba900c39c0b102daa163ae3f0409488e';
const version = tag => /^v(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)$/.exec(tag)?.slice(1).map(Number);
const compareVersion = (a, b) => {
  const left = version(a), right = version(b);
  for (let i = 0; i < 3; i++) if (left[i] !== right[i]) return left[i] - right[i];
  return 0;
};

export function releaseBaseline(root, tag) {
  assert(version(tag), 'Release tag must be a stable vMAJOR.MINOR.PATCH version');
  const candidate = commitFor(root, `refs/tags/${tag}`);
  const state = gitState(root);
  assert.equal(state.commit, candidate, 'Checkout must be the exact tagged commit');
  assert.equal(state.gitStatus, '', 'Release verification requires a clean checkout');
  const packageVersion = JSON.parse(git(root, 'show', `${candidate}:package.json`)).version;
  assert.equal(tag, `v${packageVersion}`, 'Release tag and package version differ');
  const previous = git(root, 'tag', '--list').toString().trim().split('\n')
    .filter(other => version(other) && compareVersion(other, tag) < 0)
    .sort(compareVersion).at(-1);
  const ref = previous ? `refs/tags/${previous}` : initialReleaseBaseline;
  const baseline = commitFor(root, ref);
  assert.notEqual(baseline, candidate, 'Release baseline must predate the tagged commit');
  try { git(root, 'merge-base', '--is-ancestor', baseline, candidate); }
  catch { throw new Error(`Release baseline ${ref} must be an ancestor of the tagged commit; refusing a fallback baseline`); }
  return { tag, candidate, baseline, baselineRef: ref, tree: state.tree };
}

// Existing required phases are expressed using the comparator's metric names;
// additional metrics are compared too. Adding a workload phase requires adding
// its coverage here so a missing phase cannot silently weaken release evidence.
export function requiredMetrics(workload) {
  const work = ['taskMs', 'layouts', 'styleRecalculations', 'styleReads', 'boxReads', 'refreshes'];
  const timed = ['firstFontFrameMs', 'settledMs', ...work];
  const phases = { startup: timed, settings: timed, insertion: timed };
  if (workload.conversation) Object.assign(phases, {
    idle: work, stream: timed, replacement: work,
    memory: ['heapBytes', 'domNodes', 'heapGrowthBytes', 'nodeGrowth'], paused: work, resume: timed
  });
  const keys = Object.entries(phases).flatMap(([phase, names]) => names.map(name => `${phase}.${name}`));
  assert(keys.every(key => Object.hasOwn(policy, key.split('.').at(-1))), 'Release metric coverage must match the comparison policy');
  return keys;
}

export async function verifyReleaseEvidence(root, tag, report) {
  // Check status before provenance so a failed browser command never gains a
  // publishing route merely because the tag metadata is also invalid.
  assert.equal(report.status, 'passed', 'Performance report is not passed');
  assert.equal(report.schemaVersion, 2, 'Unsupported performance evidence schema');
  assert.equal(report.error, undefined, 'Errored performance evidence cannot publish');
  assert(report.negativeControl == null, 'Injected negative-control reports cannot qualify a release');
  assert.deepEqual(report.regressions, [], 'Performance regressions block publishing');
  const release = releaseBaseline(root, tag);
  assert.equal(report.candidate?.commit, release.candidate, 'Performance evidence is for a different tagged commit');
  assert.equal(report.candidate?.tree, release.tree, 'Performance evidence is for a different source tree');
  assert.equal(report.candidate?.gitStatus, '', 'Performance candidate was dirty');
  assert.equal(report.endGitStatus, '', 'Source changed during the performance run');
  assert.equal(report.baseline?.commit, release.baseline, 'Performance evidence used the wrong release baseline');
  assert.deepEqual(report.baseline?.hashes, (await runtimeSnapshot(root, release.baseline)).hashes, 'Baseline runtime hashes differ');
  assert.deepEqual(report.candidate?.hashes, (await runtimeSnapshot(root, release.candidate)).hashes, 'Tagged runtime hashes differ');
  assert.deepEqual(report.harnessHashes, await harnessHashes(root, release.candidate), 'Performance harness hashes differ');
  assert.deepEqual(report.protocol, protocol, 'Performance protocol differs');
  assert.deepEqual(report.policy, policy, 'Performance thresholds differ');
  assert.equal(report.samplesPerVersion, 5, 'Release evidence requires the default five measured samples');
  assert.deepEqual(Object.keys(report.workloads ?? {}).sort(), workloads.map(workload => workload.name).sort(), 'Performance workloads are missing or unexpected');
  for (const workload of workloads) {
    const runs = report.workloads[workload.name];
    assert.equal(runs.baseline?.length, 5, 'Baseline sample count differs');
    assert.equal(runs.candidate?.length, 5, 'Candidate sample count differs');
    assert.deepEqual(runs.order, Array.from({ length: 6 }, (_, round) => ({ warmup: round === 0,
      versions: round % 2 ? ['candidate', 'baseline'] : ['baseline', 'candidate'] })), 'Performance sampling order differs');
    for (const sample of [...runs.baseline, ...runs.candidate]) {
      for (const metric of requiredMetrics(workload)) assert(Object.hasOwn(sample, metric), `Missing required metric: ${workload.name}/${metric}`);
    }
    const comparison = compareSamples(runs.baseline, runs.candidate);
    assert(!comparison.some(row => row.regression), `Raw performance samples regress: ${workload.name}`);
    assert.deepEqual(runs.comparison, comparison, `Stored comparison differs from raw samples: ${workload.name}`);
  }
  for (const field of ['node', 'playwright', 'chromium', 'platform', 'arch', 'cpu']) {
    assert(typeof report.environment?.[field] === 'string' && report.environment[field], `Missing environment identity: ${field}`);
  }
  return release;
}
