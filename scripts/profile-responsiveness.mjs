// Separate instrumented diagnostic pass: never a latency/performance gate.
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { readFile, writeFile, mkdir } from 'node:fs/promises';
import { cpus, platform, release } from 'node:os';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseArgs } from 'node:util';
import { createRequire } from 'node:module';
import { chromium } from 'playwright';
import { conversationHtml } from '../test/helpers/conversation.mjs';
import { instrumentPhaseSource, installPhaseProfile } from './performance/phase-profile.mjs';
import { workloads } from './performance/workloads.mjs';
import { runtimeScriptPaths } from './performance/runtime-resources.mjs';

const root = fileURLToPath(new URL('../', import.meta.url));
const { values } = parseArgs({ options: {
  'source-ref': { type: 'string' }, output: { type: 'string', default: 'dist/performance/phases.json' },
  workload: { type: 'string', default: 'conversation-120' }
} });
const output = resolve(root, values.output);
const report = { schemaVersion: 1, status: 'error', diagnosticOnly: true, startedAt: new Date().toISOString(),
  interpretation: 'Inclusive times overlap; never sum them. Self time subtracts only nested instrumented phases, includes uninstrumented work and probe overhead. These instrumented timings are not comparable to the unmodified-source gate. Scheduling reasons describe accepted queue requests; mixed mutation batches can have multiple reasons and requests can coalesce or revert before a refresh.',
  containerEvidence: 'Each bounded record describes an actual repairContainers invocation, ordered within its repairLayout call. Numeric cache generations identify cache objects through a WeakMap; reports retain no cache or DOM objects. Before/after cumulative counters and per-invocation deltas distinguish centralized style and marker invalidations from other invalidation calls. Invocation ordinals are not fixed source checkpoint labels if a future implementation skips a checkpoint. Overflow fails this diagnostic.',
  protocol: { viewport: { width: 1280, height: 800 }, turns: 120, settingsChanges: 6,
    streamEdits: 100, streamIntervalMs: 20, protectedCodeEditEvery: 5, feedback: true }, samples: [] };
let browser;
try {
  assert(['conversation-120', 'reading-400'].includes(values.workload), '--workload must be conversation-120 or reading-400');
  const conversation = values.workload === 'conversation-120';
  report.protocol.workload = values.workload;
  if (!conversation) Object.assign(report.protocol, { turns: null, readingCards: 400, streamEdits: 0, feedback: false });
  const git = (...args) => execFileSync('git', args, { cwd: root, maxBuffer: 20 * 1024 * 1024 });
  const hash = bytes => createHash('sha256').update(bytes).digest('hex');
  const commit = git('rev-parse', '--verify', '--end-of-options', `${values['source-ref'] ?? 'HEAD'}^{commit}`).toString().trim();
  const read = path => values['source-ref'] ? git('show', `${commit}:${path}`) : readFile(resolve(root, path));
  const manifestPath = 'manifests/manifest.chrome.json';
  const manifestBytes = await read(manifestPath), manifest = JSON.parse(manifestBytes);
  const scripts = runtimeScriptPaths(manifest);
  const files = new Map([[manifestPath, manifestBytes]]);
  for (const path of new Set([...scripts, ...manifest.web_accessible_resources.flatMap(entry => entry.resources)])) {
    assert(/^(src|assets)\/[a-zA-Z0-9_./-]+$/.test(path) && !path.split('/').includes('..'), `Unsupported resource ${path}`);
    files.set(path, await read(path));
  }
  const transformed = new Map(scripts.map(path => [path, `${instrumentPhaseSource(path, files.get(path).toString())}\n//# sourceURL=phase-profile/${path}`]));
  report.source = { commit, ref: values['source-ref'] ?? null, workingTree: !values['source-ref'],
    gitStatus: git('status', '--porcelain=v1').toString(),
    hashes: Object.fromEntries([...files].map(([path, bytes]) => [path, hash(bytes)])),
    instrumentedHashes: Object.fromEntries([...transformed].map(([path, source]) => [path, hash(source)])) };
  report.harnessHashes = Object.fromEntries(await Promise.all(['scripts/profile-responsiveness.mjs',
    'scripts/performance/runtime-resources.mjs',
    'scripts/performance/phase-profile.mjs', 'test/helpers/conversation.mjs', 'scripts/performance/workloads.mjs',
    'scripts/performance/responsiveness.mjs'].map(async path => [path, hash(await readFile(resolve(root, path)))])));
  report.environment = { node: process.version, playwright: createRequire(import.meta.url)('playwright/package.json').version,
    platform: platform(), release: release(), cpu: cpus()[0]?.model, logicalCpus: cpus().length };
  browser = await chromium.launch({ headless: true });
  report.environment.chromium = browser.version();
  const context = await browser.newContext({ viewport: report.protocol.viewport, serviceWorkers: 'block' });
  const page = await context.newPage(), errors = [];
  page.on('pageerror', error => errors.push(error.message));
  await page.route('**/*', route => {
    const url = new URL(route.request().url()), bytes = files.get(url.pathname.slice(1));
    if (url.origin !== 'http://profile.test') return route.abort();
    if (url.pathname === '/') return route.fulfill({ body: conversation ? conversationHtml() : workloads.find(workload => workload.name === 'reading-400').html, contentType: 'text/html' });
    return bytes ? route.fulfill({ body: bytes, contentType: 'font/woff2' }) : route.abort();
  });
  await page.goto('http://profile.test');
  await page.evaluate(() => {
    const listeners = [], messages = [];
    globalThis.__settings = { enabled: true, scope: 'all', textScale: 120, lineHeight: 0, letterSpacing: 0, siteRules: [] };
    globalThis.chrome = {
      runtime: { getURL: path => `http://profile.test/${path}`, sendMessage: async () => {}, onMessage: { addListener: fn => messages.push(fn) } },
      storage: { sync: { get: async () => ({ ...__settings }) }, onChanged: { addListener: fn => listeners.push(fn) } }
    };
    globalThis.__state = () => { let result; messages.forEach(fn => fn({ type: 'LEXEND_GET_STATE' }, null, value => { result = value; })); return result; };
    globalThis.__update = patch => {
      Object.assign(__settings, patch);
      listeners.forEach(fn => fn(Object.fromEntries(Object.entries(patch).map(([key, newValue]) => [key, { newValue }])), 'sync'));
    };
  });
  await page.evaluate(installPhaseProfile);
  for (const source of transformed.values()) await page.addScriptTag({ content: source });
  const settle = async () => {
    await page.waitForFunction(() => __state()?.healthy && !__state().pending, null, { timeout: 30000 });
    assert.deepEqual(errors, [], 'Profile runtime errors');
  };
  const sample = async phase => {
    const current = await page.evaluate(() => ({ profile: __phaseProfile.snapshot(), authorWrites: globalThis.__authorWrites ?? 0 }));
    const previous = report.samples.at(-1);
    const phaseDelta = Object.fromEntries(Object.entries(current.profile.phases).map(([name, value]) => {
      const before = previous?.profile.phases[name];
      return [name, Object.fromEntries(['count', 'inclusiveMs', 'selfMs'].map(key => [key, value[key] - (before?.[key] ?? 0)]))];
    }));
    report.samples.push({ phase, ...current, phaseDelta, authorWritesDelta: current.authorWrites - (previous?.authorWrites ?? 0) });
  };
  await settle();
  await page.evaluate(() => document.fonts.ready);
  await settle();
  await sample('startup');
  for (let i = 0; i < report.protocol.settingsChanges; i++) {
    await page.evaluate(scale => __update({ textScale: scale }), i % 2 ? 120 : 110);
    await settle();
  }
  await sample('settings');
  // Timed tasks, not a microtask burst: protected code still invalidates outside
  // geometry and the author observer remains enabled throughout this phase.
  if (conversation) report.stream = await page.evaluate(async ({ streamEdits, streamIntervalMs, protectedCodeEditEvery }) => {
    const text = document.querySelector('main p').firstChild, code = document.querySelector('main pre code').firstChild;
    const times = [], started = performance.now();
    for (let i = 0; i < streamEdits; i++) {
      await new Promise(resolve => setTimeout(resolve, streamIntervalMs));
      text.data += ' word';
      if (i % protectedCodeEditEvery === 0) code.data += '\nconst added = true;';
      times.push(performance.now() - started);
    }
    return { edits: times.length, timesMs: times, durationMs: performance.now() - started };
  }, report.protocol);
  await settle();
  if (conversation) await sample('timed-stream');
  report.behavior = await page.evaluate(() => {
    const p = getComputedStyle(document.querySelector('main p')), code = getComputedStyle(document.querySelector('main pre code') ?? document.querySelector('pre'));
    return { state: __state(), readingFont: p.fontFamily, readingSize: p.fontSize, codeFont: code.fontFamily, codeSize: code.fontSize,
      fontsLoaded: document.fonts.check('19.2px "Lexend for the Web"', 'Reading'), authorWrites: globalThis.__authorWrites ?? 0 };
  });
  assert(report.behavior.readingFont.includes('Lexend') && report.behavior.readingSize === '19.2px');
  assert(!report.behavior.codeFont.includes('Lexend') && report.behavior.codeSize === '14px');
  assert(report.behavior.fontsLoaded);
  const final = report.samples.at(-1).profile;
  for (const phase of ['content.refresh', 'content.measureTypography', 'content.collectNestedScrollers', 'layout.captureBaseline', 'layout.repairLayout']) {
    assert(final.phases[phase]?.count > 0 && final.phases[phase].inclusiveMs > 0, `Inactive phase probe ${phase}`);
  }
  assert.equal(final.containerPasses.dropped, 0, 'Container diagnostic overflowed its bounded record buffer');
  assert.equal(final.containerPasses.records.length, final.phases['layout.repairContainers']?.count,
    'Container invocation evidence differs from the exact phase counter');
  assert(final.containerPasses.records.length > 0 && final.containerPasses.records.every(record =>
    record.completed && record.repairId !== null && record.invocationInRepair > 0), 'Missing complete container repair evidence');
  if (conversation) {
    assert(final.schedulingReasons['mutation:characterData'] > 0, 'Missing stream reason probe');
    assert(report.samples.at(-1).authorWritesDelta > 0, 'Author observer did not contend during timed streaming');
  }
  await page.evaluate(() => __update({ enabled: false }));
  await settle();
  report.paused = await page.evaluate(() => ({ state: __state(), font: getComputedStyle(document.querySelector('main p')).fontFamily }));
  assert(!report.paused.state.active && !report.paused.font.includes('Lexend'), 'Pause did not restore author typography');
  report.status = 'passed';
} catch (error) {
  report.error = error.stack ?? String(error); process.exitCode = 1;
} finally {
  await browser?.close();
  report.finishedAt = new Date().toISOString();
  await mkdir(dirname(output), { recursive: true });
  await writeFile(output, JSON.stringify(report, null, 2) + '\n');
  console.log(`${report.status}: ${output}`);
  if (report.error) console.error(report.error);
}
