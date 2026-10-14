import assert from 'node:assert/strict';
import { conversationHtml } from '../../test/helpers/conversation.mjs';
import { measureResponsiveness, responsivenessProtocol } from './responsiveness.mjs';

export const protocol = {
  version: 2,
  viewport: { width: 1280, height: 800 },
  settingsChanges: 6,
  idleMs: 4000,
  streamEdits: 100,
  replacements: 6,
  sampleTimeoutMs: 45000,
  responsiveness: responsivenessProtocol
};

const cards = count => `<!doctype html><style>
  body{font:16px/24px Arial}article{padding:12px}p{max-width:60ch}
  pre{font:14px/20px monospace}
</style><main>${Array.from({ length: count }, (_, i) => `<article><h2>Chapter ${i}</h2>
  <p>Careful typography makes everyday pages easier to read. <a href="#">Follow the details.</a></p>
  <button>Read chapter</button></article>`).join('')}</main>
<pre>${Array.from({ length: 500 }, (_, i) => `<span>const value${i} = ${i};</span>\n`).join('')}</pre>`;

export const workloads = [
  { name: 'reading-80', html: cards(80) },
  { name: 'reading-400', html: cards(400) },
  { name: 'conversation-120', html: conversationHtml(), conversation: true }
];

// Installed before the unmodified runtime. Native reads used by the harness are
// excluded from the counters; production reads in either revision are counted.
function installHarness() {
  const storage = [], runtime = [];
  const nativeStyle = globalThis.getComputedStyle;
  const nativeBox = Element.prototype.getBoundingClientRect;
  const bench = globalThis.__bench = {
    settings: { enabled: true, scope: 'all', textScale: 120, lineHeight: 0, letterSpacing: 0, siteRules: [] },
    styleReads: 0, boxReads: 0
  };
  globalThis.chrome = {
    runtime: {
      getURL: path => `http://performance.test/${path}`,
      sendMessage: async () => {}, onMessage: { addListener: fn => runtime.push(fn) }
    },
    storage: {
      sync: { get: async () => ({ ...bench.settings }) },
      onChanged: { addListener: fn => storage.push(fn) }
    }
  };
  globalThis.getComputedStyle = (...args) => { bench.styleReads++; return nativeStyle(...args); };
  Element.prototype.getBoundingClientRect = function () { bench.boxReads++; return nativeBox.call(this); };
  bench.state = () => {
    let state;
    runtime.forEach(fn => fn({ type: 'LEXEND_GET_STATE' }, null, value => { state = value; }));
    return state;
  };
  bench.update = patch => {
    Object.assign(bench.settings, patch);
    const changes = Object.fromEntries(Object.entries(patch).map(([key, newValue]) => [key, { newValue }]));
    storage.forEach(fn => fn(changes, 'sync'));
  };
  bench.counters = () => ({ styleReads: bench.styleReads, boxReads: bench.boxReads, refreshes: bench.state()?.refreshRevision ?? 0 });
  bench.check = (size = 16 * bench.settings.textScale / 100) => {
    const state = bench.state();
    if (!state?.healthy || !state.active || state.pending) {
      // Failure-only observation of the exact predicate. Keep the assertion and
      // original throw; successful measurements allocate no diagnostic record.
      bench.failure = { kind: 'final-check', state, requestedSize: size,
        fontsStatus: document.fonts.status, capturedAt: performance.now() };
      throw new Error('Runtime did not finish healthy and active');
    }
    for (const element of document.querySelectorAll('main p, main h2, main button, #author-label')) {
      const text = nativeStyle(element);
      if (!text.fontFamily.includes('Lexend') || ((element.tagName === 'P' || element.id === 'author-label')
          && Math.abs(parseFloat(text.fontSize) - size) > 0.03)) {
        throw new Error(`Typography missing or incorrect: ${text.fontFamily}, ${text.fontSize}`);
      }
    }
    for (const host of document.querySelectorAll('.host')) {
      const text = nativeStyle(host.shadowRoot.querySelector('p'));
      if (!text.fontFamily.includes('Lexend') || Math.abs(parseFloat(text.fontSize) - size) > 0.03) {
        throw new Error('Shadow typography missing or incorrectly scaled');
      }
    }
    for (const element of document.querySelectorAll('pre, pre span, pre code')) {
      const code = nativeStyle(element);
      if (code.fontFamily.includes('Lexend') || code.fontSize !== '14px') throw new Error('Protected code changed');
    }
  };
  bench.begin = (selector = 'main p') => {
    const start = performance.now();
    let firstFontFrameMs, stableFrames = 0;
    bench.done = new Promise((resolve, reject) => {
      const frame = () => {
        const state = bench.state();
        if (state && !state.healthy) return reject(new Error('Runtime reported unhealthy state'));
        const element = document.querySelector(selector);
        const style = element && nativeStyle(element);
        const loaded = style?.fontFamily.includes('Lexend')
          && Math.abs(parseFloat(style.fontSize) - 16 * bench.settings.textScale / 100) < 0.03
          && document.fonts.check(`${style.fontSize} "Lexend for the Web"`, 'Reading');
        if (loaded && firstFontFrameMs === undefined) firstFontFrameMs = performance.now() - start;
        stableFrames = loaded && state?.healthy && state.active && !state.pending ? stableFrames + 1 : 0;
        if (stableFrames >= 2) {
          resolve({ firstFontFrameMs, settledMs: performance.now() - start });
        } else if (performance.now() - start > 15000) {
          // Capture the state already read by this failing frame, before reject.
          bench.failure = { kind: 'settle-timeout', state, loaded, stableFrames,
            firstFontFrameMs, elapsedMs: performance.now() - start,
            fontsStatus: document.fonts.status, requestedSize: 16 * bench.settings.textScale / 100,
            capturedAt: performance.now() };
          reject(new Error('Typography did not settle with loaded fonts within 15 seconds'));
        } else requestAnimationFrame(frame);
      };
      requestAnimationFrame(frame);
    });
    // A source error can prevent the caller from awaiting done. Avoid an
    // unhandled rejection while the outer sample timeout closes the context.
    bench.done.catch(() => {});
  };
}

const metricNames = ['TaskDuration', 'LayoutCount', 'RecalcStyleCount'];
async function browserMetrics(client) {
  const metrics = Object.fromEntries((await client.send('Performance.getMetrics')).metrics.map(({ name, value }) => [name, value]));
  for (const key of metricNames) assert(Number.isFinite(metrics[key]), `Missing Chromium metric ${key}`);
  return metrics;
}

export async function runWorkload(browser, version, workload, { injectedBlockMs = 0 } = {}) {
  const context = await browser.newContext({ viewport: protocol.viewport, locale: 'en-US', timezoneId: 'UTC', serviceWorkers: 'block' });
  let timeout;
  try {
    return await Promise.race([
      measure(context, version, workload, injectedBlockMs),
      new Promise((_, reject) => { timeout = setTimeout(() => reject(new Error(`${workload.name} exceeded ${protocol.sampleTimeoutMs} ms`)), protocol.sampleTimeoutMs); })
    ]);
  } finally {
    clearTimeout(timeout);
    await context.close();
  }
}

async function measure(context, version, workload, injectedBlockMs) {
  const page = await context.newPage();
  const errors = [];
  page.on('pageerror', error => errors.push(error.message));
  await page.route('**/*', async route => {
    const url = new URL(route.request().url());
    const asset = version.files.get(url.pathname.slice(1));
    if (url.origin !== 'http://performance.test') return route.abort();
    if (url.pathname === '/') return route.fulfill({ body: workload.html, contentType: 'text/html' });
    if (asset) return route.fulfill({ body: asset, contentType: 'font/woff2' });
    errors.push(`Unexpected resource: ${url.pathname}`);
    await route.abort();
  });
  let phase = 'setup';
  try {
  await page.goto('http://performance.test/');
  await page.evaluate(installHarness);
  const client = await context.newCDPSession(page);
  await client.send('Performance.enable');
  const result = {};
  let responsiveness;
  const snapshot = async () => ({ ...await browserMetrics(client), ...await page.evaluate(() => __bench.counters()) });
  const delta = (before, after) => ({
    taskMs: (after.TaskDuration - before.TaskDuration) * 1000,
    layouts: after.LayoutCount - before.LayoutCount,
    styleRecalculations: after.RecalcStyleCount - before.RecalcStyleCount,
    ...Object.fromEntries(['styleReads', 'boxReads', 'refreshes'].map(key => [key, after[key] - before[key]]))
  });
  const record = (phase, metrics) => {
    for (const [key, value] of Object.entries(metrics)) result[`${phase}.${key}`] = value;
  };
  const measureChange = async (name, action) => {
    phase = name;
    const before = await snapshot();
    await action();
    const timing = await page.evaluate(() => __bench.done);
    const metrics = { ...timing, ...delta(before, await snapshot()) };
    await page.evaluate(() => __bench.check());
    return metrics;
  };

  record('startup', await measureChange('startup', () => page.addScriptTag({ content:
    '__bench.begin();\n' + version.scripts.map(path => `${version.files.get(path).toString('utf8')}\n//# sourceURL=${path}\n`).join('\n')
  })));

  // Measure all six settled updates. Each outer sample gets one aggregate, so
  // rapid operations in a context are not treated as independent browser runs.
  const changes = [];
  for (let i = 0; i < protocol.settingsChanges; i++) {
    changes.push(await measureChange('settings', () => page.evaluate(scale => {
      __bench.begin();
      __bench.update({ textScale: scale });
    }, i % 2 ? 120 : 110)));
  }
  record('settings', Object.fromEntries(Object.keys(changes[0]).map(key => [key, changes.reduce((n, m) => n + m[key], 0) / changes.length])));

  record('insertion', await measureChange('insertion', () => page.evaluate(() => {
    __bench.begin('#inserted');
    document.querySelector('main').insertAdjacentHTML('beforeend', '<article><p id="inserted">New reading content arrives.</p><button>Read more</button></article>');
  })));

  if (workload.conversation) {
    // Observe several cooldowns after settling. A single pending=false sample
    // is insufficient evidence that an author/extension feedback loop stopped.
    phase = 'idle';
    let before = await snapshot();
    await page.waitForTimeout(protocol.idleMs);
    record('idle', delta(before, await snapshot()));
    await page.evaluate(() => __bench.check());

    record('stream', await measureChange('stream', () => page.evaluate(async edits => {
      __bench.begin();
      const text = document.querySelector('main p').firstChild;
      for (let i = 0; i < edits; i++) { text.data += 'word '; await Promise.resolve(); }
    }, protocol.streamEdits)));
    assert(await page.locator('main p').first().evaluate((element, edits) => element.textContent.endsWith('word '.repeat(edits)), protocol.streamEdits), 'Streaming workload did not finish');

    const memory = async () => {
      await client.send('HeapProfiler.collectGarbage');
      return { heapBytes: (await client.send('Runtime.getHeapUsage')).usedSize, domNodes: (await client.send('Memory.getDOMCounters')).nodes };
    };
    let warm;
    before = await snapshot();
    for (let i = 0; i < protocol.replacements; i++) {
      await measureChange('replacement', () => page.evaluate(iteration => {
        __bench.begin();
        document.querySelector('main').innerHTML = Array.from({ length: 120 }, (_, j) =>
          `<article><p>Conversation ${iteration}, reply ${j}. ${'Streamed text. '.repeat(12)}</p><pre>const value = true;</pre><div class="host"></div></article>`).join('');
        document.querySelectorAll('.host').forEach(host => { host.attachShadow({ mode: 'open' }).innerHTML = '<p>Shadow reply</p>'; });
      }, i));
      assert.equal(await page.locator('.host').count(), 120);
      if (i === 1) warm = await memory();
    }
    record('replacement', delta(before, await snapshot()));
    const finalMemory = await memory();
    record('memory', {
      ...finalMemory,
      heapGrowthBytes: Math.max(0, finalMemory.heapBytes - warm.heapBytes),
      nodeGrowth: Math.max(0, finalMemory.domNodes - warm.domNodes)
    });

    phase = 'paused';
    await page.evaluate(() => __bench.update({ enabled: false }));
    before = await snapshot();
    await page.evaluate(() => {
      document.querySelector('main p').textContent = 'Changed while paused';
      __bench.update({ textScale: 130 });
      dispatchEvent(new Event('resize'));
    });
    await page.waitForTimeout(250);
    record('paused', delta(before, await snapshot()));
    const paused = await page.evaluate(() => ({ state: __bench.state(), size: getComputedStyle(document.querySelector('main p')).fontSize }));
    assert.equal(paused.state.active, false);
    assert.equal(paused.state.pending, false);
    assert.equal(paused.size, '16px');
    record('resume', await measureChange('resume', () => page.evaluate(() => { __bench.begin(); __bench.update({ enabled: true }); })));

    // Appended after every existing phase so probe allocations cannot influence
    // the old work/timing/retention gate. This is timed streaming, not the earlier
    // intentionally unchanged microtask burst.
    phase = 'responsiveness';
    responsiveness = await measureResponsiveness(page, injectedBlockMs);
    record('responsiveness', responsiveness.metrics);
  }
  assert.deepEqual(errors, [], 'Browser errors invalidate the measurement');
  return { metrics: result, responsiveness: responsiveness?.raw };
  } catch (error) {
    // Observe only after the original assertion has failed. No timers, runtime
    // listeners, source bytes, settling predicates or successful paths change.
    let atomic;
    try { atomic = await page.evaluate(() => globalThis.__bench?.failure ?? null); }
    catch { atomic = null; }
    error.performanceFailure = { workload: workload.name, phase, atomic,
      browserErrors: [...errors], source: 'scripts/performance/workloads.mjs',
      originalAssertion: true };
    throw error;
  }
}
