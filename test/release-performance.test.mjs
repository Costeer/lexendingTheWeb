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

// Transition fixtures clone real history so frozen commit/source identities and
// ancestry are exercised. Their numerical records are synthetic verifier units,
// explicitly not browser performance measurements or qualification evidence.
async function transitionFixture(t) {
  const { readdir } = await import('node:fs/promises');
  const { transitionPolicyPath } = await import('../scripts/performance/baseline-transition.mjs');
  const directory = resolve(project, 'dist/release-gate-tests');
  await mkdir(directory, { recursive: true });
  const root = await mkdtemp(`${directory}/transition-`);
  t.after(() => rm(root, { recursive: true, force: true }));
  git(project, 'clone', '--quiet', '--shared', project, root);
  git(root, 'config', 'user.email', 'test@example.invalid');
  git(root, 'config', 'user.name', 'Transition verifier unit');
  git(root, 'config', 'commit.gpgsign', 'false');
  const paths = [...harnessFiles, 'package.json', 'package-lock.json',
    'manifests/manifest.chrome.json', 'manifests/manifest.firefox.json',
    'scripts/performance/release-gate.mjs', 'scripts/performance/baseline-transition.mjs',
    'scripts/release-performance.mjs', transitionPolicyPath,
    ...(await readdir(resolve(project, 'release/v0.5.1-provenance'))).map(name => `release/v0.5.1-provenance/${name}`)];
  for (const path of paths) {
    await mkdir(dirname(resolve(root, path)), { recursive: true });
    await writeFile(resolve(root, path), await readFile(resolve(project, path)));
  }
  git(root, 'add', '.');
  git(root, 'commit', '--quiet', '--allow-empty', '-m', 'Synthetic transition verifier fixture; not empirical evidence');
  git(root, 'tag', '--force', 'v0.5.1');
  const candidate = gitState(root).commit;
  const baseline = '9ba8c632ba900c39c0b102daa163ae3f0409488e';
  const f = { root, baseline, candidate, tag: 'v0.5.1' };
  const evidence = resolve(root, 'dist/transition-unit-evidence');
  await mkdir(evidence, { recursive: true });
  const anchor = await passingEvidence(f);
  anchor.startedAt = '2026-10-14T19:00:05.100Z';
  anchor.finishedAt = '2026-10-14T19:00:09.900Z';
  const historical = {
    schemaVersion: 2, status: 'error', startedAt: '2026-10-14T19:00:00.100Z', finishedAt: '2026-10-14T19:00:04.900Z',
    negativeControl: null, samplesPerVersion: 5, protocol, policy,
    baseline: { ref: 'f2670e24aa210b80f6baedfcf09d22a5dd91e640', commit: 'f2670e24aa210b80f6baedfcf09d22a5dd91e640',
      hashes: (await runtimeSnapshot(root, 'f2670e24aa210b80f6baedfcf09d22a5dd91e640')).hashes },
    candidate: anchor.candidate, endGitStatus: '', harnessHashes: anchor.harnessHashes, environment: anchor.environment,
    workloads: { 'reading-80': { baseline: [], candidate: [], order: [{ warmup: true, versions: ['baseline', 'candidate'] }] } },
    error: 'Synthetic unit: Runtime did not finish healthy and active',
    failure: { workload: 'reading-80', version: 'baseline', round: 0, warmup: true, observation: {
      workload: 'reading-80', phase: 'startup', source: 'scripts/performance/workloads.mjs', originalAssertion: true, browserErrors: [],
      atomic: { kind: 'final-check', requestedSize: 19.2, fontsStatus: 'loaded', capturedAt: 700,
        state: { ready: true, healthy: true, active: true, pending: true, refreshRevision: 1,
          error: null, hostname: 'performance.test', scope: 'all' } }
    } }
  };
  const save = async () => {
    const { sha256 } = await import('../scripts/performance/sources.mjs');
    for (const [name, report, filename, commit, exitCode, start, end] of [
      ['historical', historical, 'historical-report.json', historical.baseline.commit, 1, '2026-10-14T19:00:00.000Z', '2026-10-14T19:00:05.000Z'],
      ['anchor', anchor, 'report.json', baseline, 0, '2026-10-14T19:00:05.000Z', '2026-10-14T19:00:10.000Z']
    ]) {
      const bytes = JSON.stringify(report, null, 2) + '\n';
      const log = 'Synthetic verifier unit command record, not browser execution.\n';
      const output = resolve(evidence, filename);
      await writeFile(output, bytes);
      await writeFile(resolve(evidence, `${name}.log`), log);
      await writeFile(resolve(evidence, `${name}-command.json`), JSON.stringify({ schemaVersion: 1,
        cwd: root, output, argv: ['npm', 'run', 'test:performance', '--', '--base', commit, '--output', output],
        startedAt: start, finishedAt: end, exitCode, signal: null,
        candidateBefore: gitState(root), candidateAfter: gitState(root),
        reportSha256: sha256(bytes), logSha256: sha256(log)
      }, null, 2));
    }
  };
  await save();
  return { ...f, evidence, anchor, historical, save };
}

test('v0.5.1 transition accepts only complete dual evidence and keeps the ordinary selector strict', async t => {
  const { transitionPlan, createTransitionManifest, verifyTransitionEvidence } = await import('../scripts/performance/baseline-transition.mjs');
  const f = await transitionFixture(t);
  assert.equal(releaseBaseline(f.root, f.tag).baseline, f.historical.baseline.commit);
  assert.equal((await transitionPlan(f.root, f.tag)).baseline, f.baseline);
  await assert.rejects(() => verifyReleaseEvidence(f.root, f.tag, f.historical), /not passed/);
  await assert.rejects(() => verifyReleaseEvidence(f.root, f.tag, f.anchor), /wrong release baseline/);
  await createTransitionManifest(f.root, f.tag, f.evidence);
  const manifestPath = resolve(f.evidence, 'transition-manifest.json');
  await assert.doesNotReject(() => verifyTransitionEvidence(f.root, f.tag, manifestPath));
  const manifest = JSON.parse(await readFile(manifestPath));
  assert.equal(manifest.finalCandidateSignoff.kind, 'machine-verification');
  assert.equal(manifest.finalCandidateSignoff.reviewer, undefined);
  await assert.rejects(() => verifyTransitionEvidence(f.root, 'v0.5.2', manifestPath), /only authorized.*reuse/);
  const packagePath = resolve(f.root, 'package.json');
  const next = JSON.parse(await readFile(packagePath));
  next.version = '0.5.2';
  await writeFile(packagePath, JSON.stringify(next));
  git(f.root, 'add', 'package.json');
  git(f.root, 'commit', '--quiet', '-m', 'Synthetic following release');
  git(f.root, 'tag', 'v0.5.2');
  assert.equal(releaseBaseline(f.root, 'v0.5.2').baseline, f.candidate, 'v0.5.2 must select v0.5.1 itself');
});

test('v0.5.1 transition rejects missing state, unknown historical failures, dirty identity and incomplete measurements', async t => {
  const { createTransitionManifest } = await import('../scripts/performance/baseline-transition.mjs');
  const f = await transitionFixture(t);
  const originalHistorical = structuredClone(f.historical), originalAnchor = structuredClone(f.anchor);
  const attacks = [
    ['historical pass relabelling', () => { f.historical.status = 'passed'; }, /remain error/],
    ['appended browser shutdown failure', () => { f.historical.error += '\nBrowser shutdown failed: synthetic browser crash'; }, /browser shutdown failure/],
    ['explicit browser shutdown failure', () => { f.historical.browserShutdownError = 'synthetic close failure'; }, /browser shutdown failure/],
    ['message only', () => { f.historical.failure.observation.atomic = null; }, /pending predicate/],
    ['unhealthy runtime', () => { f.historical.failure.observation.atomic.state.healthy = false; }, /pending predicate/],
    ['wrong refresh provenance', () => { f.historical.failure.observation.atomic.state.refreshRevision = 2; }, /unexpected or undiagnosed/],
    ['missing original assertion', () => { delete f.historical.failure.observation.originalAssertion; }, /original assertion provenance/],
    ['candidate failure', () => { f.historical.failure.version = 'candidate'; }, /first warmup/],
    ['wrong phase', () => { f.historical.failure.observation.phase = 'settings'; }, /phase\/source/],
    ['wrong workload', () => { f.historical.failure.workload = 'reading-400'; }, /phase\/source/],
    ['resource failure', () => { f.historical.failure.observation.browserErrors.push('missing font'); }, /browser errors/],
    ['fonts still loading', () => { f.historical.failure.observation.atomic.fontsStatus = 'loading'; }, /fonts are not loaded/],
    ['missing end stability', () => { delete f.historical.endGitStatus; }, /source stability/],
    ['historical stale candidate', () => { f.historical.candidate.tree = '0'.repeat(40); }, /candidate source/],
    ['historical negative control', () => { f.historical.negativeControl = { durationMs: 1000 }; }, /negative control/],
    ['historical harness mismatch', () => { f.historical.harnessHashes['scripts/test-performance.mjs'] = 'changed'; }, /harness differs/],
    ['historical measured records injected', () => { f.historical.workloads['reading-80'].baseline.push({}); }, /measured baseline/],
    ['anchor runtime mismatch', () => { f.anchor.candidate.hashes['src/content.js'] = 'changed'; }, /runtime hashes differ/],
    ['anchor missing metric', () => { delete f.anchor.workloads['reading-80'].candidate[0]['settings.taskMs']; }, /Missing required metric/],
    ['anchor too few samples', () => { f.anchor.workloads['reading-80'].candidate.pop(); }, /sample count differs/],
    ['anchor missing raw calibration', () => { f.anchor.workloads['conversation-120'].rawResponsiveness.baseline[0].calibration.tasks = []; }, /calibration was not observed/],
    ['anchor raw metric mismatch', () => { f.anchor.workloads['conversation-120'].rawResponsiveness.candidate[0].longTasks[0].duration = 101; }, /Raw responsiveness metric differs/],
    ['anchor injected report', () => { f.anchor.negativeControl = { durationMs: 1000 }; }, /negative-control reports/],
    ['anchor forged comparison', () => { f.anchor.workloads['reading-80'].comparison = []; }, /Stored comparison differs/],
    ['anchor raw slowdown', () => { for (const sample of f.anchor.workloads['reading-80'].candidate) sample['settings.taskMs'] = 1000; }, /Raw performance samples regress/],
    ['different environment', () => { f.anchor.environment.chromium = 'another-browser'; }, /environment mismatch/]
  ];
  for (const [name, attack, message] of attacks) {
    for (const key of Object.keys(f.historical)) delete f.historical[key];
    Object.assign(f.historical, structuredClone(originalHistorical));
    for (const key of Object.keys(f.anchor)) delete f.anchor[key];
    Object.assign(f.anchor, structuredClone(originalAnchor));
    attack();
    await f.save(); // Rehashing cannot make semantically invalid raw records pass.
    await assert.rejects(() => createTransitionManifest(f.root, f.tag, f.evidence), message, name);
  }
});

test('v0.5.1 generated manifest rejects altered artifacts, stale signoff and wrong command exits', async t => {
  const { createTransitionManifest, verifyTransitionEvidence } = await import('../scripts/performance/baseline-transition.mjs');
  const f = await transitionFixture(t);
  await createTransitionManifest(f.root, f.tag, f.evidence);
  const path = resolve(f.evidence, 'transition-manifest.json');
  const original = await readFile(path);
  const manifestAttacks = [
    ['missing final acceptance', m => { delete m.finalCandidateSignoff; }],
    ['false human claim', m => { m.finalCandidateSignoff.kind = 'human-approval'; }],
    ['stale source binding', m => { m.candidate.commit = f.baseline; }],
    ['altered policy binding', m => { m.policySha256 = '0'.repeat(64); }],
    ['missing raw artifact binding', m => { delete m.artifacts['historical-report.json']; }],
    ['stale final acceptance', m => { m.finalCandidateSignoff.binding.artifacts['report.json'] = 'wrong'; }]
  ];
  for (const [name, attack] of manifestAttacks) {
    const changed = JSON.parse(original);
    attack(changed);
    await writeFile(path, JSON.stringify(changed));
    await assert.rejects(() => verifyTransitionEvidence(f.root, f.tag, path), undefined, name);
  }
  await writeFile(path, original);
  await writeFile(resolve(f.evidence, 'historical.log'), 'altered command log');
  await assert.rejects(() => verifyTransitionEvidence(f.root, f.tag, path), /output bytes changed/);
  await f.save();
  const commandPath = resolve(f.evidence, 'historical-command.json');
  const command = JSON.parse(await readFile(commandPath));
  command.exitCode = 0;
  await writeFile(commandPath, JSON.stringify(command));
  await assert.rejects(() => createTransitionManifest(f.root, f.tag, f.evidence), /command exit differs/);
  await f.save();
  await rm(resolve(f.evidence, 'historical-report.json'));
  await assert.rejects(() => verifyTransitionEvidence(f.root, f.tag, path), /ENOENT/);
});

test('v0.5.1 transition rejects moved tags, dirty checkout and changed committed policy', async t => {
  const { transitionPlan } = await import('../scripts/performance/baseline-transition.mjs');
  const f = await transitionFixture(t);
  await writeFile(resolve(f.root, 'src/content.js'), 'dirty runtime');
  await assert.rejects(() => transitionPlan(f.root, f.tag), /clean checkout/);
  git(f.root, 'restore', 'src/content.js');
  git(f.root, 'tag', '--force', 'v0.5.0', f.baseline);
  await assert.rejects(() => transitionPlan(f.root, f.tag), /Historical v0.5.0 tag moved/);
  git(f.root, 'tag', '--force', 'v0.5.0', f.historical.baseline.commit);
  const path = resolve(f.root, 'release/performance-baseline-transition.json');
  const record = JSON.parse(await readFile(path));
  record.anchor.commit = f.candidate;
  await writeFile(path, JSON.stringify(record));
  git(f.root, 'add', 'release/performance-baseline-transition.json');
  git(f.root, 'commit', '--quiet', '-m', 'Attempted policy substitution');
  git(f.root, 'tag', '--force', 'v0.5.1');
  await assert.rejects(() => transitionPlan(f.root, f.tag), /Adopted transition policy changed|Frozen anchor bytes differ/);
});

test('v0.5.1 accepts only the reviewed conversation timeout and rejects earlier measured regressions', async t => {
  const { createTransitionManifest } = await import('../scripts/performance/baseline-transition.mjs');
  const f = await transitionFixture(t);
  Object.assign(f.historical, { error: 'Synthetic unit: Typography did not settle with loaded fonts within 15 seconds',
    workloads: {
      'reading-80': structuredClone(f.anchor.workloads['reading-80']),
      'reading-400': structuredClone(f.anchor.workloads['reading-400']),
      'conversation-120': { baseline: [], candidate: [], order: [{ warmup: true, versions: ['baseline', 'candidate'] }],
        rawResponsiveness: { baseline: [], candidate: [] } }
    } });
  f.historical.failure.workload = 'conversation-120';
  const observation = f.historical.failure.observation;
  observation.workload = 'conversation-120';
  Object.assign(observation.atomic, { kind: 'settle-timeout', loaded: true, stableFrames: 0,
    elapsedMs: 15016.7, firstFontFrameMs: 680, capturedAt: 15017 });
  observation.atomic.state.refreshRevision = 20;
  await f.save();
  await assert.doesNotReject(() => createTransitionManifest(f.root, f.tag, f.evidence));
  for (const sample of f.historical.workloads['reading-80'].candidate) sample['settings.taskMs'] = 1000;
  await f.save();
  await assert.rejects(() => createTransitionManifest(f.root, f.tag, f.evidence), /preceding measured regression/);
  f.historical.workloads['reading-80'] = structuredClone(f.anchor.workloads['reading-80']);
  delete f.historical.workloads['reading-80'].candidate[0]['settings.taskMs'];
  await f.save();
  await assert.rejects(() => createTransitionManifest(f.root, f.tag, f.evidence), /Missing historical preceding metric/);
  f.historical.workloads['reading-80'] = structuredClone(f.anchor.workloads['reading-80']);
  f.historical.workloads['reading-80'].order.shift();
  await f.save();
  await assert.rejects(() => createTransitionManifest(f.root, f.tag, f.evidence), /preceding sampling order differs/);
});
