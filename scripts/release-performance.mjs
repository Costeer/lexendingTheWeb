import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { spawn } from 'node:child_process';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseArgs } from 'node:util';
import { releaseBaseline, verifyReleaseEvidence } from './performance/release-gate.mjs';
import { createTransitionManifest, transitionPlan, transitionReviewBinding, transitionTag, verifyTransitionEvidence } from './performance/baseline-transition.mjs';
import { gitState, sha256 } from './performance/sources.mjs';

const root = fileURLToPath(new URL('../', import.meta.url));
try {
  const { values, positionals } = parseArgs({ allowPositionals: true, options: {
    tag: { type: 'string' }, report: { type: 'string' }, manifest: { type: 'string' }, directory: { type: 'string' }
  } });
  const command = positionals[0];
  if (!values.tag || positionals.length !== 1 || !['baseline', 'plan', 'collect-transition', 'collect-negative-control', 'review-binding', 'seal-transition', 'verify'].includes(command)) {
    throw new Error('Usage: node scripts/release-performance.mjs baseline|plan|collect-transition|collect-negative-control|review-binding|seal-transition|verify --tag vX.Y.Z [--report path | --manifest path | --directory path]');
  }
  if (command === 'baseline') console.log(releaseBaseline(root, values.tag).baseline);
  else if (command === 'plan') {
    const plan = values.tag === transitionTag ? await transitionPlan(root, values.tag) : releaseBaseline(root, values.tag);
    console.log(JSON.stringify({ kind: plan.kind ?? 'ordinary', baseline: plan.baseline, historical: plan.historical ?? null }));
  } else if (command === 'collect-transition') {
    if (!values.directory) throw new Error('--directory is required');
    const plan = await transitionPlan(root, values.tag);
    const directory = resolve(root, values.directory);
    await mkdir(directory, { recursive: true });
    // Preserve the original full command and unsuccessful result. Do not run a
    // replacement fixture, retry until a desired error, or convert its status.
    await collect(directory, 'historical', plan.historical, 'historical-report.json');
    await collect(directory, 'anchor', plan.baseline, 'report.json');
  } else if (command === 'collect-negative-control') {
    if (!values.directory) throw new Error('--directory is required');
    const plan = await transitionPlan(root, values.tag);
    const directory = resolve(root, values.directory);
    await mkdir(directory, { recursive: true });
    // Validation only: write the actual injected command into a COPY of a
    // positive bundle, so both publishing verifiers must reject it.
    await collect(directory, 'anchor', plan.baseline, 'report.json', true);
  } else if (command === 'review-binding' || command === 'seal-transition') {
    if (!values.directory) throw new Error('--directory is required');
    const directory = resolve(root, values.directory);
    const result = command === 'review-binding'
      ? await transitionReviewBinding(root, values.tag, directory)
      : await createTransitionManifest(root, values.tag, directory);
    console.log(JSON.stringify(result, null, 2));
  } else {
    let verified;
    if (values.tag === transitionTag) {
      if (values.report) throw new Error('v0.5.1 requires --manifest with original dual reports; an individual report cannot authorize the transition');
      verified = await verifyTransitionEvidence(root, values.tag, values.manifest);
    } else {
      if (values.manifest) throw new Error('The transition manifest cannot be reused for another release');
      if (!values.report) throw new Error('--report is required to verify performance evidence');
      verified = await verifyReleaseEvidence(root, values.tag, JSON.parse(await readFile(values.report, 'utf8')));
    }
    console.log(`Release performance verified: ${verified.tag} (${verified.candidate}) against ${verified.baseline}`);
    if (verified.kind) console.log('v0.5.1-only transition; historical report remains unsuccessful; 19 commits lack numerical coverage against v0.5.0.');
  }
} catch (error) {
  console.error(error.message);
  process.exitCode = 1;
}

async function collect(directory, name, baseline, filename, negativeControl = false) {
  const output = resolve(directory, filename);
  const argv = ['npm', 'run', 'test:performance', '--', '--base', baseline, '--output', output];
  if (negativeControl) argv.push('--inject-block-ms', '1000');
  const record = { schemaVersion: 1, startedAt: new Date().toISOString(), cwd: root,
    candidateBefore: gitState(root), argv, output };
  const chunks = [];
  const result = await new Promise((accept, reject) => {
    const child = spawn(argv[0], argv.slice(1), { cwd: root, stdio: ['ignore', 'pipe', 'pipe'] });
    const capture = chunk => { chunks.push(chunk); process.stdout.write(chunk); };
    child.stdout.on('data', capture);
    child.stderr.on('data', capture);
    child.on('error', reject);
    child.on('close', (exitCode, signal) => accept({ exitCode, signal }));
  });
  const log = Buffer.concat(chunks);
  Object.assign(record, result, { finishedAt: new Date().toISOString(), candidateAfter: gitState(root),
    reportSha256: sha256(await readFile(output)), logSha256: sha256(log) });
  await writeFile(resolve(directory, `${name}.log`), log);
  await writeFile(resolve(directory, `${name}-command.json`), JSON.stringify(record, null, 2) + '\n');
  // Collection preserves both records. A separate verifier classifies the
  // historical error and refuses any candidate/anchor/error/negative control.
}
