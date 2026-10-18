// Reproducible synthetic profile, never an authenticated ChatGPT capture.
import { chromium } from 'playwright';
import { readFile, mkdir, writeFile, mkdtemp, rm } from 'node:fs/promises';
import { resolve, join } from 'node:path';
import { tmpdir } from 'node:os';
import { conversationHtml, instrumentContent } from '../test/helpers/conversation.mjs';

const output = resolve(process.env.LEXEND_PROFILE_OUT ?? '/tmp/lexend-conversation-profile');
const sourceRoot = resolve(process.env.LEXEND_PROFILE_SOURCE ?? '.');
const enabled = process.env.LEXEND_ENABLED !== 'false';
const duration = Number(process.env.LEXEND_PROFILE_MS ?? 12000);
const cycles = Number(process.env.LEXEND_PROFILE_CYCLES ?? 12);
const extensionPaths = JSON.parse(process.env.LEXEND_PROFILE_EXTENSIONS ?? '[]');
if (!Number.isFinite(duration) || duration < 6000 || duration > 120000) throw new Error('Profile duration must be 6000–120000ms');
if (!Number.isInteger(cycles) || cycles < 0 || cycles > 100) throw new Error('Profile cycles must be 0–100');
await mkdir(output, { recursive: true });
const profileDir = await mkdtemp(join(tmpdir(), 'lexend-profile-'));
let browser, context;
try {
  if (extensionPaths.length) {
    context = await chromium.launchPersistentContext(profileDir, { channel: 'chromium', headless: true,
      args: [`--disable-extensions-except=${extensionPaths.join(',')}`, `--load-extension=${extensionPaths.join(',')}`] });
    browser = context.browser();
  } else {
    browser = await chromium.launch({ headless: true });
    context = await browser.newContext();
  }
  const page = await context.newPage();
  await page.setViewportSize({ width: 1280, height: 800 });
  page.setDefaultTimeout(15000);
  const client = await context.newCDPSession(page);
  const browserClient = await browser.newBrowserCDPSession();
  await client.send('Performance.enable');
  await page.route('http://conversation.test/**', async route => {
    const path = new URL(route.request().url()).pathname;
    await route.fulfill(path === '/' ? { body: conversationHtml(), contentType: 'text/html' }
      : { body: await readFile(resolve(`.${path}`)), contentType: 'font/woff2' });
  });
  await page.goto('http://conversation.test/');
  await page.evaluate(enabled => {
    const listeners = [], messages = [];
    globalThis.__settings = { enabled, scope: 'all', textScale: 100, lineHeight: 0, letterSpacing: 0, siteRules: [] };
    globalThis.chrome = {
      runtime: { getURL: path => `http://conversation.test/${path}`, sendMessage: async () => {}, onMessage: { addListener: fn => messages.push(fn) } },
      storage: { sync: { get: async () => __settings }, onChanged: { addListener: fn => listeners.push(fn) } }
    };
    globalThis.__state = () => { let result; messages.forEach(fn => fn({ type: 'LEXEND_GET_STATE' }, null, value => { result = value; })); return result; };
    globalThis.__update = values => {
      Object.assign(__settings, values);
      listeners.forEach(fn => fn(Object.fromEntries(Object.entries(values).map(([key, newValue]) => [key, { newValue }])), 'sync'));
    };
  }, enabled);
  const metrics = async () => {
    const performance = Object.fromEntries((await client.send('Performance.getMetrics')).metrics.map(m => [m.name, m.value]));
    const renderers = (await browserClient.send('SystemInfo.getProcessInfo')).processInfo.filter(p => p.type === 'renderer');
    let rssKiB = 0;
    for (const p of renderers) {
      try { rssKiB += Number((await readFile(`/proc/${p.id}/status`, 'utf8')).match(/^VmRSS:\s+(\d+)/m)?.[1] ?? 0); } catch { /* Process exited or non-Linux host. */ }
    }
    return { wall: Date.now(), ...performance, rendererCpuSeconds: renderers.reduce((n, p) => n + p.cpuTime, 0), rendererRssKiB: rssKiB };
  };
  const samples = [{ phase: 'before-startup', metrics: await metrics() }];
  await client.send('Profiler.enable');
  await client.send('Profiler.start');
  await client.send('Tracing.start', { categories: 'devtools.timeline,v8,disabled-by-default-devtools.timeline', transferMode: 'ReturnAsStream' });
  for (const name of ['settings', 'adaptive-controls', 'adaptive-layout', 'content']) {
    let source = await readFile(resolve(sourceRoot, `src/${name}.js`), 'utf8');
    if (name === 'content') {
      source = instrumentContent(source);
      if (process.env.LEXEND_STYLE_SAMPLES === 'true') source = source.replace('__probe.deliveries++;', `__probe.deliveries++;
        for (const m of mutations) if (m.attributeName === 'style') {
          __probe.styleSamples ??= [];
          __probe.styleSamples.push({old:m.oldValue, current:m.target.getAttribute('style')});
          if (__probe.styleSamples.length > 16) __probe.styleSamples.shift();
        }`);
    }
    await page.addScriptTag({ content: source + '\n//# sourceURL=lexend/' + name + '.js' });
  }
  const probe = () => page.evaluate(() => ({ state: __state(), ...__probe, collections: __collections(), authorWrites: __authorWrites }));
  samples.push({ phase: 'startup', metrics: await metrics(), probe: await probe() });
  for (let i = 0; i < Math.ceil(duration / 2000); i++) {
    await page.waitForTimeout(2000);
    samples.push({ phase: 'idle', metrics: await metrics(), probe: await probe() });
  }
  const profile = (await client.send('Profiler.stop')).profile;
  await writeFile(resolve(output, 'cpu.cpuprofile'), JSON.stringify(profile));
  const done = new Promise(resolve => client.once('Tracing.tracingComplete', resolve));
  await client.send('Tracing.end');
  const { stream } = await done;
  let trace = '';
  for (;;) { const chunk = await client.send('IO.read', { handle: stream }); trace += chunk.data; if (chunk.eof) break; }
  await client.send('IO.close', { handle: stream });
  await writeFile(resolve(output, 'trace.json'), trace);
  // Isolate retention from the deliberate feedback workload, then replace
  // conversation trees without retaining the old elements in the harness.
  await page.evaluate(() => __authorObserver.disconnect());
  await page.waitForFunction(() => !__state().pending);
  const memory = [];
  const memorySample = async phase => {
    await client.send('HeapProfiler.collectGarbage');
    memory.push({ phase, heap: await client.send('Runtime.getHeapUsage'), dom: await client.send('Memory.getDOMCounters'),
      metrics: await metrics(), collections: (await probe()).collections });
  };
  await memorySample('before-replacement');
  for (let i = 0; i < cycles; i++) {
    await page.evaluate(i => {
      document.querySelector('main').innerHTML = Array.from({ length: 120 }, (_, j) =>
        `<article><p>Conversation ${i}, reply ${j}. ${'Streamed text. '.repeat(12)}</p><pre>const value = true;</pre><div class="host"></div></article>`).join('');
      document.querySelectorAll('.host').forEach(host => { host.attachShadow({ mode: 'open' }).innerHTML = '<p>Shadow reply</p>'; });
    }, i);
    await page.waitForFunction(() => !__state().pending);
    if (i === Math.floor(cycles / 2) - 1 || i === cycles - 1) await memorySample(`replacement-${i + 1}`);
  }
  // Existing text changes must not repeatedly rediscover its whole subtree.
  const streaming = await page.evaluate(async () => {
    const main = document.querySelector('main');
    main.prepend(document.createTextNode('Streaming status: '));
    await Promise.resolve();
    const before = structuredClone(__probe);
    for (let i = 0; i < 100; i++) { main.firstChild.data += 'word '; await Promise.resolve(); }
    return { before, after: structuredClone(__probe) };
  });
  await page.waitForFunction(() => !__state().pending);
  await memorySample('after-stream');
  if (process.env.LEXEND_HEAP_SNAPSHOT === 'true') {
    let chunks = '';
    client.on('HeapProfiler.addHeapSnapshotChunk', ({ chunk }) => { chunks += chunk; });
    await client.send('HeapProfiler.takeHeapSnapshot', { reportProgress: false });
    await writeFile(resolve(output, 'heap.heapsnapshot'), chunks);
  }
  const summary = { sourceRoot, enabled, browser: browser.version(), extensionPaths, settings: await page.evaluate(() => __settings),
    extensionEvidence: await page.evaluate(() => ({ darkReader: document.documentElement.getAttribute('data-darkreader-mode'),
      stylus: Boolean(document.querySelector('style.stylus')) })), samples, memory, streaming };
  await writeFile(resolve(output, 'summary.json'), JSON.stringify(summary, null, 2));
  console.log(JSON.stringify({ output, refreshes: samples.at(-1).probe.calls.refresh, memory, streaming }, null, 2));
} finally {
  await browser?.close();
  await rm(profileDir, { recursive: true, force: true });
}
