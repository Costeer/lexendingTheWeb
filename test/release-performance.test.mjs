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
    content_scripts: [{ js: ['src/runtime.js'], run_at: 'document_start' }], web_accessible_resources: [{ resources: ['assets/font.woff2'] }]
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
    schemaVersion: 2, status: 'passed', regressions: [], samplesPerVersion: 5, negativeControl: null,
    baseline: { commit: f.baseline, hashes: (await runtimeSnapshot(f.root, f.baseline)).hashes },
    candidate: { ...gitState(f.root), hashes: (await runtimeSnapshot(f.root)).hashes },
    endGitStatus: '', harnessHashes: await harnessHashes(f.root), protocol, policy,
    environment: { node: 'fixture-node', playwright: 'fixture-playwright', chromium: 'fixture-chromium', platform: 'fixture-os', arch: 'fixture-arch', cpu: 'fixture-cpu' },
    workloads: Object.fromEntries(workloads.map(workload => {
      // These are comparator fixtures, never empirical evidence or timing claims.
      const samples = Array.from({ length: 5 }, () => Object.fromEntries(requiredMetrics(workload).map(key => [key, 0])));
      const raw = workload.conversation ? Array.from({ length: 5 }, () => ({
        startTime: 200, endTime: 3000,
        calibration: { startTime: 100, endTime: 170, tasks: [{ startTime: 100, duration: 70 }] },
        stream: Array.from({ length: 100 }, (_, index) => ({ index, scheduledAt: 225 + index * 25, deliveredAt: 225 + index * 25 })),
        longTasks: [{ startTime: 2750, duration: 100 }],
        authorWrites: 120, observerDeliveries: 125, injectedBlock: null
      })) : undefined;
      if (raw) for (const sample of samples) Object.assign(sample, {
        'responsiveness.maxLongTaskMs': 100, 'responsiveness.longTaskCount': 1, 'responsiveness.totalBlockingMs': 50
      });
      return [workload.name, {
        baseline: structuredClone(samples), candidate: structuredClone(samples),
        ...(raw && { rawResponsiveness: { baseline: structuredClone(raw), candidate: structuredClone(raw) } }),
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
    ['omitted negative control declaration', value => { delete value.negativeControl; }, /negative-control reports/],
    ['false negative control declaration', value => { value.negativeControl = false; }, /negative-control reports/],
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
    ['old protocol version', value => { value.protocol.version = 1; }, /protocol differs/],
    ['old evidence schema', value => { value.schemaVersion = 1; }, /evidence schema/],
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

test('release gate requires calibrated, timed, uncontaminated raw responsiveness observations', async t => {
  const f = await fixture(t);
  const report = await passingEvidence(f);
  const attacks = [
    ['absent raw evidence', runs => { delete runs.rawResponsiveness; }, /Raw responsiveness sample count/],
    ['missing baseline sample', runs => { runs.rawResponsiveness.baseline.pop(); }, /sample count differs: baseline/],
    ['missing candidate sample', runs => { runs.rawResponsiveness.candidate.pop(); }, /sample count differs: candidate/],
    ['null raw sample', runs => { runs.rawResponsiveness.candidate[0] = null; }, /responsiveness window/],
    ['missing mandatory metric', runs => { for (const sample of [...runs.baseline, ...runs.candidate]) delete sample['responsiveness.totalBlockingMs']; }, /Missing required metric/],
    ['raw maximum differs', runs => { runs.rawResponsiveness.candidate[0].longTasks[0].duration = 101; }, /Raw responsiveness metric differs: maxLongTaskMs/],
    ['raw count differs', runs => { runs.candidate[0]['responsiveness.longTaskCount'] = 0; }, /Raw responsiveness metric differs: longTaskCount/],
    ['raw total differs', runs => { runs.candidate[0]['responsiveness.totalBlockingMs'] = 0; }, /Raw responsiveness metric differs: totalBlockingMs/],
    ['raw injection behind clean top-level declaration', runs => { runs.rawResponsiveness.candidate[4].injectedBlock = { startTime: 2750, endTime: 2751 }; }, /injected block/],
    ['missing raw injection declaration', runs => { delete runs.rawResponsiveness.candidate[0].injectedBlock; }, /omits its declaration/],
    ['absent positive calibration', runs => { runs.rawResponsiveness.baseline[0].calibration.tasks = []; }, /calibration was not observed/],
    ['unrelated positive calibration task', runs => { runs.rawResponsiveness.baseline[0].calibration.tasks[0].startTime = 110; }, /calibration was not observed/],
    ['shortened calibration', runs => { runs.rawResponsiveness.baseline[0].calibration.endTime = 150; }, /calibration window/],
    ['calibration overlaps measured window', runs => { runs.rawResponsiveness.baseline[0].calibration.endTime = 201; }, /calibration window/],
    ['shortened measured window', runs => { runs.rawResponsiveness.candidate[0].endTime = 2690; }, /responsiveness window/],
    ['task before measured window', runs => { runs.rawResponsiveness.candidate[0].longTasks[0].startTime = 199; }, /observation window/],
    ['task at exclusive window end', runs => { runs.rawResponsiveness.candidate[0].longTasks[0].startTime = 3000; }, /observation window/],
    ['sub-threshold native task', runs => { runs.rawResponsiveness.candidate[0].longTasks[0].duration = 49; }, /observation window/],
    ['nonfinite task timestamp', runs => { runs.rawResponsiveness.candidate[0].longTasks[0].startTime = Infinity; }, /observation window/],
    ['duplicated native task', runs => { const raw = runs.rawResponsiveness.candidate[0]; raw.longTasks.push({ ...raw.longTasks[0] }); }, /overlap or are unordered/],
    ['stream misses an edit', runs => { runs.rawResponsiveness.candidate[0].stream.pop(); }, /edit count differs/],
    ['stream schedules every edit immediately', runs => { for (const edit of runs.rawResponsiveness.candidate[0].stream) edit.scheduledAt = 225; }, /stream timing/],
    ['stream runs before scheduled arrival', runs => { runs.rawResponsiveness.candidate[0].stream[1].deliveredAt = 240; }, /stream timing/],
    ['stream delivers after measurement', runs => { runs.rawResponsiveness.candidate[0].stream[99].deliveredAt = 3000; }, /stream timing/],
    ['stream reorders edits', runs => { runs.rawResponsiveness.candidate[0].stream.reverse(); }, /stream timing/],
    ['no author writes', runs => { runs.rawResponsiveness.candidate[0].authorWrites = 0; }, /author contention/],
    ['no observer delivery', runs => { runs.rawResponsiveness.candidate[0].observerDeliveries = 0; }, /author contention/]
  ];
  for (const [name, attack, expected] of attacks) {
    const changed = structuredClone(report);
    attack(changed.workloads['conversation-120']);
    await assert.rejects(() => verifyReleaseEvidence(f.root, f.tag, changed), expected, name);
  }
});

test('release gate rejects one raw long-task outlier even when median and stored pass are unchanged', async t => {
  const f = await fixture(t);
  const report = await passingEvidence(f);
  const runs = report.workloads['conversation-120'];
  runs.rawResponsiveness.candidate[4].endTime = 4000;
  runs.rawResponsiveness.candidate[4].longTasks[0].duration = 1000;
  runs.candidate[4]['responsiveness.maxLongTaskMs'] = 1000;
  runs.candidate[4]['responsiveness.totalBlockingMs'] = 950;
  const recomputed = compareSamples(runs.baseline, runs.candidate).find(row => row.metric === 'responsiveness.maxLongTaskMs');
  assert.equal(recomputed.baseline.median, recomputed.candidate.median);
  assert.equal(recomputed.candidate.max, 1000);
  assert.equal(recomputed.statistic, 'max');
  assert.equal(recomputed.regression, true);
  await assert.rejects(() => verifyReleaseEvidence(f.root, f.tag, report), /Raw performance samples regress: conversation-120/);
});

test('release gate preserves native start-window semantics and permits task-free measured samples', async t => {
  const f = await fixture(t);
  const report = await passingEvidence(f);
  const runs = report.workloads['conversation-120'];
  // This task starts inside the observer's filter but finishes after endTime.
  for (const version of ['baseline', 'candidate']) {
    runs.rawResponsiveness[version][0].longTasks[0].startTime = 2990;
    // A future faster runtime need not generate any measured long task. The
    // separate positive control still has to prove the native observer works.
    runs.rawResponsiveness[version][1].longTasks = [];
    for (const key of ['maxLongTaskMs', 'longTaskCount', 'totalBlockingMs']) runs[version][1][`responsiveness.${key}`] = 0;
  }
  runs.comparison = compareSamples(runs.baseline, runs.candidate);
  await assert.doesNotReject(() => verifyReleaseEvidence(f.root, f.tag, report));
});
