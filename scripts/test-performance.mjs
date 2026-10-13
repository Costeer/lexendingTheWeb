import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { cpus, platform, release, arch } from 'node:os';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseArgs } from 'node:util';
import { createRequire } from 'node:module';
import { chromium } from 'playwright';
import { compareSamples, policy } from './performance/comparison.mjs';
import { protocol, runWorkload, workloads } from './performance/workloads.mjs';

const root = fileURLToPath(new URL('../', import.meta.url));
const { values } = parseArgs({ options: {
  base: { type: 'string', default: 'HEAD' },
  samples: { type: 'string', default: '5' },
  output: { type: 'string', default: 'dist/performance/report.json' },
  help: { type: 'boolean', default: false }
} });
if (values.help) {
  console.log(`Usage: npm run test:performance -- [--base HEAD] [--samples 5] [--output dist/performance/report.json]
Compare a Git revision with the working tree, serially in pinned Chromium.
Use --base origin/main for committed changes. No Git files or baselines are modified.
Samples must be an integer from 3 to 15; one extra warm-up per version is discarded.
Exit 0: passed. Exit 1: regression, broken workload, or invalid measurement.
See docs/performance.md for metrics, noise tolerances, and model workflow.`);
} else {
  await main();
}

async function main() {
  const output = resolve(root, values.output);
  const report = { schemaVersion: 1, status: 'error', startedAt: new Date().toISOString(), protocol, policy, workloads: {} };
  let browser;
  try {
    const samples = Number(values.samples);
    if (!Number.isInteger(samples) || samples < 3 || samples > 15) throw new Error('--samples must be an integer from 3 to 15');
    const git = (...args) => execFileSync('git', args, { cwd: root, maxBuffer: 20 * 1024 * 1024 });
    const baseCommit = git('rev-parse', '--verify', '--end-of-options', `${values.base}^{commit}`).toString().trim();
    const hash = bytes => createHash('sha256').update(bytes).digest('hex');
    const loadVersion = async committed => {
      const read = path => committed ? git('show', `${baseCommit}:${path}`) : readFile(resolve(root, path));
      const manifestPath = 'manifests/manifest.chrome.json';
      const manifestBytes = await read(manifestPath);
      const manifest = JSON.parse(manifestBytes);
      const scripts = manifest.content_scripts[0].js;
      if (manifest.content_scripts.length !== 1 || manifest.content_scripts[0].css?.length) {
        throw new Error('Update the benchmark loader to cover the changed content-script manifest');
      }
      const resources = manifest.web_accessible_resources.flatMap(entry => entry.resources);
      const files = new Map([[manifestPath, manifestBytes]]);
      for (const path of new Set([...scripts, ...resources])) {
        if (!/^(src|assets)\/[a-zA-Z0-9_./-]+$/.test(path) || path.split('/').includes('..')) {
          throw new Error(`Unsupported runtime resource path: ${path}`);
        }
        files.set(path, await read(path));
      }
      return { scripts, files, hashes: Object.fromEntries([...files].map(([path, bytes]) => [path, hash(bytes)])) };
    };
    // Freeze both sets of source and font bytes before sampling, including any
    // uncommitted candidate edits. Never run git checkout or rewrite a baseline.
    const baseline = await loadVersion(true);
    const candidate = await loadVersion(false);
    report.samplesPerVersion = samples;
    report.baseline = { ref: values.base, commit: baseCommit, hashes: baseline.hashes };
    report.candidate = {
      commit: git('rev-parse', 'HEAD').toString().trim(),
      gitStatus: git('status', '--porcelain=v1').toString(), hashes: candidate.hashes
    };
    const harnessFiles = ['scripts/test-performance.mjs', 'scripts/performance/workloads.mjs', 'scripts/performance/comparison.mjs', 'test/helpers/conversation.mjs'];
    report.harnessHashes = Object.fromEntries(await Promise.all(harnessFiles.map(async path => [path, hash(await readFile(resolve(root, path)))])));
    report.environment = {
      node: process.version, playwright: createRequire(import.meta.url)('playwright/package.json').version,
      platform: platform(), release: release(), arch: arch(), cpu: cpus()[0]?.model, logicalCpus: cpus().length
    };
    browser = await chromium.launch({ headless: true });
    report.environment.chromium = browser.version();
    console.log(`Comparing ${baseCommit.slice(0, 12)} with the working tree; ${samples} samples + 1 warm-up per version/workload.`);
    console.log('Run on an otherwise idle machine; do not run other tests alongside this benchmark.');
    for (const workload of workloads) {
      const runs = report.workloads[workload.name] = { baseline: [], candidate: [], order: [] };
      for (let round = 0; round <= samples; round++) {
        const order = round % 2 ? ['candidate', 'baseline'] : ['baseline', 'candidate'];
        runs.order.push({ warmup: round === 0, versions: order });
        for (const label of order) {
          console.log(`${workload.name}: ${round ? `sample ${round}/${samples}` : 'warm-up'} ${label}`);
          const metrics = await runWorkload(browser, label === 'baseline' ? baseline : candidate, workload);
          if (round) runs[label].push(metrics);
        }
      }
      runs.comparison = compareSamples(runs.baseline, runs.candidate);
      for (const row of runs.comparison) {
        if (row.regression || /^(startup.firstFontFrameMs|settings.taskMs|memory.heapBytes)$/.test(row.metric)) {
          console.log(`${row.regression ? 'FAIL' : 'PASS'} ${workload.name}/${row.metric}: ${row.baseline.median.toFixed(2)} -> ${row.candidate.median.toFixed(2)} (limit ${row.limit?.toFixed(2) ?? 'diagnostic'})`);
        }
      }
    }
    report.regressions = Object.entries(report.workloads).flatMap(([workload, runs]) =>
      runs.comparison.filter(row => row.regression).map(row => ({ workload, ...row })));
    report.status = report.regressions.length ? 'failed' : 'passed';
    if (report.regressions.length) process.exitCode = 1;
  } catch (error) {
    report.error = error.stack ?? String(error);
    console.error(report.error);
    process.exitCode = 1;
  } finally {
    await browser?.close();
    report.finishedAt = new Date().toISOString();
    await mkdir(dirname(output), { recursive: true });
    await writeFile(output, JSON.stringify(report, null, 2) + '\n');
    console.log(`Performance ${report.status}: ${output}`);
  }
}
