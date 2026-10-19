import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';
import { chromium } from 'playwright';
import { contentProbeAnchors, instrumentContent, replaceExactlyOnce } from './helpers/conversation.mjs';

const root = new URL('../', import.meta.url);
const source = await readFile(new URL('src/content.js', root), 'utf8');

test('every content probe rejects absent and duplicate anchors', () => {
  assert.doesNotThrow(() => instrumentContent(source));
  for (const [name, needle] of Object.entries(contentProbeAnchors)) {
    assert.throws(() => instrumentContent(source.replace(needle, '/* removed anchor */')),
      new RegExp(`Cannot instrument ${name}: expected exactly one match, found 0`));
    assert.throws(() => instrumentContent(`${source}\n${needle}`),
      new RegExp(`Cannot instrument ${name}: expected exactly one match, found 2`));
  }
  const whitespaceDrift = source.replace(contentProbeAnchors.incomingNodes,
    contentProbeAnchors.incomingNodes.replace('    try', '\n    try'));
  assert.throws(() => instrumentContent(whitespaceDrift), /Cannot instrument incomingNodes/);
});

test('incoming counter detects a new branch and rejects restored expensive text scanning', async () => {
  const browser = await chromium.launch();
  try {
    const broken = replaceExactlyOnce(source,
      'if (parent && !managedElements.has(parent)) incoming.add(parent);',
      'if (parent) incoming.add(parent);', 'historical expensive text scanning');
    for (const [label, runtime] of [['current', source], ['expensive control', broken]]) {
      const page = await browser.newPage();
      try {
        await page.route('http://instrumentation.test/**', async route => {
          const path = new URL(route.request().url()).pathname.slice(1);
          await route.fulfill({ body: await readFile(new URL(path, root)), contentType: 'font/woff2' });
        });
        await page.setContent('<!doctype html><style>body{font:16px Arial}</style><main>Streaming: '
          + '<p>Existing reply</p>'.repeat(200) + '</main>');
        await page.evaluate(() => {
          const messages = [];
          globalThis.chrome = {
            runtime: { getURL: path => `http://instrumentation.test/${path}`, sendMessage: async () => {},
              onMessage: { addListener: fn => messages.push(fn) } },
            storage: { sync: { get: async () => ({ enabled: true, scope: 'all', textScale: 100 }) },
              onChanged: { addListener() {} } }
          };
          globalThis.__state = () => {
            let result;
            messages.forEach(fn => fn({ type: 'LEXEND_GET_STATE' }, null, value => { result = value; }));
            return result;
          };
        });
        for (const name of ['settings', 'adaptive-controls', 'adaptive-layout', 'refresh-scheduler']) {
          await page.addScriptTag({ content: await readFile(new URL(`src/${name}.js`, root), 'utf8') });
        }
        await page.addScriptTag({ content: instrumentContent(runtime) });
        await page.evaluate(() => document.fonts.ready);
        await page.waitForFunction(() => __state()?.healthy && !__state().pending);
        const result = await page.evaluate(async () => {
          // Isolate immediate classification from the scheduled layout repair.
          globalThis.setTimeout = () => 1;
          globalThis.clearTimeout = () => {};
          const main = document.querySelector('main');
          const before = __probe.incomingNodes;
          for (let i = 0; i < 10; i++) { main.firstChild.data += 'word '; await Promise.resolve(); }
          const streamingVisits = __probe.incomingNodes - before;
          const beforeBranch = __probe.incomingNodes;
          main.insertAdjacentHTML('beforeend', '<p id="new-reply">New reply <code>const value = true;</code></p>');
          await Promise.resolve();
          return {
            streamingVisits, branchVisits: __probe.incomingNodes - beforeBranch,
            family: getComputedStyle(document.querySelector('#new-reply')).fontFamily,
            code: getComputedStyle(document.querySelector('#new-reply code')).fontFamily
          };
        });
        assert.equal(result.branchVisits, 2, `${label}: newly inserted elements must exercise the counter`);
        assert.match(result.family, /Lexend/);
        assert.doesNotMatch(result.code, /Lexend/);
        const noRepeatedScanning = () => assert.equal(result.streamingVisits, 0,
          'existing-text edits must not repeatedly scan the conversation subtree');
        if (label === 'current') noRepeatedScanning();
        else {
          assert.equal(result.streamingVisits, 2010, 'the broken source must actually visit the existing replies');
          assert.throws(noRepeatedScanning, { name: 'AssertionError' }, 'the normal regression assertion rejects the broken source');
        }
      } finally { await page.close(); }
    }
  } finally { await browser.close(); }
});
