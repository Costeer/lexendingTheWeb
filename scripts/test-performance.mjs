import { mkdir, writeFile } from 'node:fs/promises';
import { cpus, platform, release, arch } from 'node:os';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseArgs } from 'node:util';
import { createRequire } from 'node:module';
import { chromium } from 'playwright';
import { compareSamples, policy } from './performance/comparison.mjs';
import { protocol, runWorkload, workloads } from './performance/workloads.mjs';
import { commitFor, gitState, harnessHashes, runtimeSnapshot } from './performance/sources.mjs';

const root = fileURLToPath(new URL('../', import.meta.url));
const { values } = parseArgs({ options: {
  base: { type: 'string', default: 'HEAD' },
  samples: { type: 'string', default: '5' },
  output: { type: 'string', default: 'dist/performance/report.json' },
  'inject-block-ms': { type: 'string' },
  help: { type: 'boolean', default: false }
} });
if (values.help) {
  console.log(`Usage: npm run test:performance -- [--base HEAD] [--samples 5] [--output dist/performance/report.json]
Compare a Git revision with the working tree, serially in pinned Chromium.
Use --base origin/main for committed changes. No Git files or baselines are modified.
Samples must be an integer from 3 to 15; one extra warm-up per version is discarded.
--inject-block-ms 1000 deliberately blocks one measured candidate contention phase.
Use a block above the max-task limit to verify failure; injection evidence is reported.
Exit 0: passed. Exit 1: regression, broken workload, or invalid measurement.
See docs/performance.md for metrics, noise tolerances, and model workflow.`);
} else {
  await main();
}

async function main() {
  const output = resolve(root, values.output);
  const report = { schemaVersion: 2, status: 'error', startedAt: new Date().toISOString(), protocol, policy, workloads: {} };
  let browser, inFlight;
  try {
    const samples = Number(values.samples);
    if (!Number.isInteger(samples) || samples < 3 || samples > 15) throw new Error('--samples must be an integer from 3 to 15');
    const injectedBlockMs = values['inject-block-ms'] === undefined ? 0 : Number(values['inject-block-ms']);
    if (values['inject-block-ms'] !== undefined && (!Number.isInteger(injectedBlockMs) || injectedBlockMs < 50 || injectedBlockMs > 5000)) {
      throw new Error('--inject-block-ms must be an integer from 50 to 5000');
    }
    report.negativeControl = injectedBlockMs ? {
      kind: 'synchronous-block', durationMs: injectedBlockMs, version: 'candidate',
      workload: 'conversation-120', phase: 'responsiveness', sample: samples
    } : null;
    const baseCommit = commitFor(root, values.base);
    // Freeze both sets of source and font bytes before sampling, including any
    // uncommitted candidate edits. Never run git checkout or rewrite a baseline.
    const candidateState = gitState(root);
    const baseline = await runtimeSnapshot(root, baseCommit);
    const candidate = await runtimeSnapshot(root);
    report.samplesPerVersion = samples;
    report.baseline = { ref: values.base, commit: baseCommit, hashes: baseline.hashes };
    report.candidate = { ...candidateState, hashes: candidate.hashes };
    report.harnessHashes = await harnessHashes(root);
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
      if (workload.conversation) runs.rawResponsiveness = { baseline: [], candidate: [] };
      for (let round = 0; round <= samples; round++) {
        const order = round % 2 ? ['candidate', 'baseline'] : ['baseline', 'candidate'];
        runs.order.push({ warmup: round === 0, versions: order });
        for (const label of order) {
          console.log(`${workload.name}: ${round ? `sample ${round}/${samples}` : 'warm-up'} ${label}`);
          inFlight = { workload: workload.name, version: label, round, warmup: round === 0 };
          const measurement = await runWorkload(browser, label === 'baseline' ? baseline : candidate, workload, {
            injectedBlockMs: label === 'candidate' && round === samples ? injectedBlockMs : 0
          });
          if (round) {
            runs[label].push(measurement.metrics);
            if (workload.conversation) runs.rawResponsiveness[label].push(measurement.responsiveness);
          }
        }
      }
      runs.comparison = compareSamples(runs.baseline, runs.candidate);
      for (const row of runs.comparison) {
        if (row.regression || /^(startup.firstFontFrameMs|settings.taskMs|memory.heapBytes|responsiveness.maxLongTaskMs)$/.test(row.metric)) {
          console.log(`${row.regression ? 'FAIL' : 'PASS'} ${workload.name}/${row.metric}: ${row.baseline[row.statistic].toFixed(2)} -> ${row.candidate[row.statistic].toFixed(2)} (${row.statistic}; limit ${row.limit?.toFixed(2) ?? 'diagnostic'})`);
        }
      }
    }
    report.regressions = Object.entries(report.workloads).flatMap(([workload, runs]) =>
      runs.comparison.filter(row => row.regression).map(row => ({ workload, ...row })));
    report.status = report.regressions.length ? 'failed' : 'passed';
    if (report.regressions.length) process.exitCode = 1;
  } catch (error) {
    report.error = error.stack ?? String(error);
    report.failure = { ...inFlight, observation: error.performanceFailure ?? null };
    console.error(report.error);
    process.exitCode = 1;
  } finally {
    try { await browser?.close(); }
    catch (error) {
      report.status = 'error';
      report.browserShutdownError = error.stack ?? String(error);
      report.error = [report.error, `Browser shutdown failed: ${error.stack ?? error}`].filter(Boolean).join('\n');
      process.exitCode = 1;
    }
    report.endGitStatus = gitState(root).gitStatus;
    report.finishedAt = new Date().toISOString();
    await mkdir(dirname(output), { recursive: true });
    await writeFile(output, JSON.stringify(report, null, 2) + '\n');
    console.log(`Performance ${report.status}: ${output}`);
  }
}
