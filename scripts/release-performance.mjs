import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { parseArgs } from 'node:util';
import { releaseBaseline, verifyReleaseEvidence } from './performance/release-gate.mjs';

const root = fileURLToPath(new URL('../', import.meta.url));
try {
  const { values, positionals } = parseArgs({ allowPositionals: true, options: {
    tag: { type: 'string' }, report: { type: 'string' }
  } });
  if (!values.tag || positionals.length !== 1 || !['baseline', 'verify'].includes(positionals[0])) {
    throw new Error('Usage: node scripts/release-performance.mjs baseline|verify --tag vX.Y.Z [--report path]');
  }
  if (positionals[0] === 'baseline') console.log(releaseBaseline(root, values.tag).baseline);
  else {
    if (!values.report) throw new Error('--report is required to verify performance evidence');
    const report = JSON.parse(await readFile(values.report, 'utf8'));
    const verified = await verifyReleaseEvidence(root, values.tag, report);
    console.log(`Release performance verified: ${verified.tag} (${verified.candidate}) against ${verified.baseline}`);
  }
} catch (error) {
  console.error(error.message);
  process.exitCode = 1;
}
