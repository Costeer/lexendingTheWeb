import assert from 'node:assert/strict';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import test from 'node:test';
import { compareSamples, policy } from '../scripts/performance/comparison.mjs';
import { protocol, workloads } from '../scripts/performance/workloads.mjs';
import { initialReleaseBaseline, releaseBaseline, requiredMetrics, verifyReleaseEvidence } from '../scripts/performance/release-gate.mjs';
import { git, gitState, harnessFiles, harnessHashes, runtimeSnapshot } from '../scripts/performance/sources.mjs';

const project = fileURLToPath(new URL('../', import.meta.url));
async function fixture(t) {
  const directory = resolve(project, 'dist/release-gate-tests');
  await mkdir(directory, { recursive: true });
  const root = await mkdtemp(`${directory}/repo-`);
  t.after(() => rm(root, { recursive: true, force: true }));
  const put = async (path, value) => {
    const file = resolve(root, path);
    await mkdir(dirname(file), { recursive: true });
    await writeFile(file, value);
  };
  git(root, 'init', '--quiet');
  git(root, 'config', 'user.email', 'test@example.invalid');
  git(root, 'config', 'user.name', 'Release gate test');
  git(root, 'config', 'commit.gpgsign', 'false');
  const commit = () => {
    git(root, 'add', '.');
    git(root, 'commit', '--quiet', '-m', 'fixture');
    return gitState(root).commit;
  };
  for (const path of harnessFiles) await put(path, await readFile(resolve(project, path)));
  await put('manifests/manifest.chrome.json', JSON.stringify({
    content_scripts: [{ js: ['src/runtime.js'] }], web_accessible_resources: [{ resources: ['assets/font.woff2'] }]
  }));
  await put('src/runtime.js', 'baseline runtime');
  await put('assets/font.woff2', 'fixture font');
  await put('package.json', '{"version":"0.1.0"}');
  const baseline = commit();
  git(root, 'tag', 'v0.1.0');
  await put('src/runtime.js', 'candidate runtime');
  await put('package.json', '{"version":"0.2.0"}');
  const candidate = commit();
  git(root, 'tag', 'v0.2.0');
  return { root, put, commit, baseline, candidate, tag: 'v0.2.0' };
}

async function passingEvidence(f) {
  return {
    schemaVersion: 2, status: 'passed', regressions: [], samplesPerVersion: 5,
    baseline: { commit: f.baseline, hashes: (await runtimeSnapshot(f.root, f.baseline)).hashes },
    candidate: { ...gitState(f.root), hashes: (await runtimeSnapshot(f.root)).hashes },
    endGitStatus: '', harnessHashes: await harnessHashes(f.root), protocol, policy,
    environment: { node: 'fixture-node', playwright: 'fixture-playwright', chromium: 'fixture-chromium', platform: 'fixture-os', arch: 'fixture-arch', cpu: 'fixture-cpu' },
    workloads: Object.fromEntries(workloads.map(workload => {
      // These are comparator fixtures, never empirical evidence or timing claims.
      const samples = Array.from({ length: 5 }, () => Object.fromEntries(requiredMetrics(workload).map(key => [key, 0])));
      return [workload.name, {
        baseline: structuredClone(samples), candidate: structuredClone(samples),
        order: Array.from({ length: 6 }, (_, round) => ({ warmup: round === 0, versions: round % 2 ? ['candidate', 'baseline'] : ['baseline', 'candidate'] })),
        comparison: compareSamples(samples, samples)
      }];
    }))
  };
}

test('release baseline is the previous version tag, never the candidate or a moving HEAD fallback', async t => {
  const f = await fixture(t);
  assert.deepEqual(releaseBaseline(f.root, f.tag), {
    tag: f.tag, candidate: f.candidate, baseline: f.baseline, baselineRef: 'refs/tags/v0.1.0', tree: gitState(f.root).tree
  });
  git(f.root, 'tag', 'v0.1.1');
  assert.throws(() => releaseBaseline(f.root, f.tag), /must predate/);
  git(f.root, 'tag', '--delete', 'v0.1.1', 'v0.1.0');
  assert.throws(() => releaseBaseline(f.root, f.tag), /Command failed/, 'a clone missing the fixed initial baseline must fail');
  assert.match(initialReleaseBaseline, /^[a-f0-9]{40}$/);
});

test('release baseline rejects unrelated tags, mismatched versions, checkout drift, and dirty source', async t => {
  const f = await fixture(t);
  await f.put('src/runtime.js', 'dirty source');
  assert.throws(() => releaseBaseline(f.root, f.tag), /clean checkout/);
  git(f.root, 'restore', 'src/runtime.js');
  git(f.root, 'tag', 'v0.3.0');
  assert.throws(() => releaseBaseline(f.root, 'v0.3.0'), /package version differ/);
  git(f.root, 'checkout', '--quiet', '--detach', f.baseline);
  assert.throws(() => releaseBaseline(f.root, f.tag), /exact tagged commit/);
  await f.put('package.json', '{"version":"0.1.1"}');
  f.commit();
  git(f.root, 'tag', 'v0.1.1');
  git(f.root, 'checkout', '--quiet', '--detach', f.candidate);
  assert.throws(() => releaseBaseline(f.root, f.tag), /must be an ancestor.*refusing a fallback/);
  assert.throws(() => releaseBaseline(f.root, 'HEAD'), /stable vMAJOR/);
});

test('release gate accepts complete exact-source evidence and rejects provenance or coverage bypasses', async t => {
  const f = await fixture(t);
  const report = await passingEvidence(f);
  await assert.doesNotReject(() => verifyReleaseEvidence(f.root, f.tag, report));
  const attacks = [
    ['failed browser run', value => { value.status = 'failed'; }, /not passed/],
    ['errored browser run', value => { value.error = 'browser crashed'; }, /Errored/],
    ['small negative control that passed thresholds', value => { value.negativeControl = { duration: 1 }; }, /negative-control reports/],
    ['candidate as baseline', value => { value.baseline.commit = f.candidate; }, /wrong release baseline/],
    ['different commit', value => { value.candidate.commit = f.baseline; }, /different tagged commit/],
    ['different tree', value => { value.candidate.tree = '0'.repeat(40); }, /different source tree/],
    ['dirty candidate', value => { value.candidate.gitStatus = ' M src/runtime.js'; }, /candidate was dirty/],
    ['source changed mid-run', value => { value.endGitStatus = ' M src/runtime.js'; }, /Source changed/],
    ['runtime edits', value => { value.candidate.hashes['src/runtime.js'] = 'wrong'; }, /runtime hashes differ/],
    ['baseline edits', value => { value.baseline.hashes['src/runtime.js'] = 'wrong'; }, /runtime hashes differ/],
    ['harness edits', value => { value.harnessHashes['scripts/performance/workloads.mjs'] = 'wrong'; }, /harness hashes differ/],
    ['relaxed thresholds', value => { value.policy.taskMs.relative = 100; }, /thresholds differ/],
    ['smaller workload', value => { value.protocol.streamEdits = 1; }, /protocol differs/],
    ['fewer samples', value => { value.samplesPerVersion = 3; }, /five measured/],
    ['omitted workload', value => { delete value.workloads['conversation-120']; }, /workloads are missing/],
    ['omitted candidate sample', value => { value.workloads['reading-80'].candidate.pop(); }, /sample count differs/],
    ['no warmup', value => { value.workloads['reading-80'].order.shift(); }, /sampling order differs/],
    ['omitted phase', value => { for (const sample of [...value.workloads['reading-80'].candidate, ...value.workloads['reading-80'].baseline]) delete sample['settings.taskMs']; }, /Missing required metric/],
    ['forged pass over slow samples', value => { for (const sample of value.workloads['reading-80'].candidate) sample['settings.taskMs'] = 500; }, /Raw performance samples regress/],
    ['forged stored comparison', value => { value.workloads['reading-80'].comparison = []; }, /Stored comparison differs/],
    ['no browser identity', value => { delete value.environment.chromium; }, /Missing environment identity/]
  ];
  for (const [name, attack, expected] of attacks) {
    const changed = structuredClone(report);
    attack(changed);
    await assert.rejects(() => verifyReleaseEvidence(f.root, f.tag, changed), expected, name);
  }
});

