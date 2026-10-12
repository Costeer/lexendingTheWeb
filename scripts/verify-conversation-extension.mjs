import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { createHash } from 'node:crypto';
import { mkdtemp, readFile, rm, mkdir, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { resolve, join } from 'node:path';
import { chromium } from 'playwright';
import { conversationHtml } from '../test/helpers/conversation.mjs';

const extension = resolve('dist/chrome');
const output = resolve(process.env.LEXEND_VERIFY_OUT ?? '/tmp/lexend-extension-verification');
const profile = await mkdtemp(join(tmpdir(), 'lexend-verify-'));
const paths = [extension, ...JSON.parse(process.env.LEXEND_EXTRA_EXTENSION_PATHS ?? '[]')];
const server = createServer((request, response) => {
  response.writeHead(200, { 'content-type': 'text/html' });
  response.end(conversationHtml());
});
await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
let context;
try {
  context = await chromium.launchPersistentContext(profile, {
    ...(process.env.LEXEND_CHROMIUM_EXECUTABLE ? { executablePath: process.env.LEXEND_CHROMIUM_EXECUTABLE } : { channel: 'chromium' }),
    headless: true, viewport: { width: 1280, height: 800 },
    args: [`--disable-extensions-except=${paths.join(',')}`, `--load-extension=${paths.join(',')}`]
  });
  const worker = context.serviceWorkers().find(w => w.url().endsWith('/src/background.js'))
    ?? await context.waitForEvent('serviceworker', w => w.url().endsWith('/src/background.js'));
  const hashes = {};
  for (const name of ['settings', 'adaptive-controls', 'adaptive-layout', 'content']) {
    const path = `src/${name}.js`;
    const sourceHash = createHash('sha256').update(await readFile(resolve(path))).digest('hex');
    const loadedHash = await worker.evaluate(async path => {
      const bytes = await (await fetch(chrome.runtime.getURL(path))).arrayBuffer();
      return [...new Uint8Array(await crypto.subtle.digest('SHA-256', bytes))].map(n => n.toString(16).padStart(2, '0')).join('');
    }, path);
    assert.equal(loadedHash, sourceHash, `loaded ${path} matches this checkout, independently of version number`);
    hashes[path] = loadedHash;
  }
  await worker.evaluate(() => chrome.storage.sync.set({ enabled: true, scope: 'all', textScale: 120, lineHeight: 0, letterSpacing: 0, siteRules: [] }));
  const page = await context.newPage();
  const state = () => worker.evaluate(async () => {
    for (const tab of await chrome.tabs.query({})) {
      try {
        const result = await chrome.tabs.sendMessage(tab.id, { type: 'LEXEND_GET_STATE' }, { frameId: 0 });
        if (result?.hostname === '127.0.0.1') return result;
      } catch { /* Blank and extension tabs have no content script. */ }
    }
    return null;
  });
  const settle = async () => {
    const deadline = Date.now() + 15000;
    while (Date.now() < deadline) { const s = await state(); if (s?.healthy && !s.pending) return s; await page.waitForTimeout(100); }
    throw new Error('Installed extension failed to settle');
  };
  const url = `http://127.0.0.1:${server.address().port}/`;
  await page.goto(url);
  await page.evaluate(() => document.fonts.ready);
  await page.waitForTimeout(2000);
  const before = await settle();
  await page.waitForTimeout(10000);
  const after = await state();
  assert.equal(after.refreshRevision, before.refreshRevision);
  assert.equal(after.pending, false);
  assert.equal(after.healthy, true);
  const typography = await page.locator('#author-label').evaluate(e => ({ family: getComputedStyle(e).fontFamily, size: getComputedStyle(e).fontSize }));
  assert.match(typography.family, /Lexend/);
  assert.equal(typography.size, '19.2px');
  await page.evaluate(() => document.querySelector('main').insertAdjacentHTML('beforeend', '<p id="stream">Incoming response <code>const preserved = true;</code></p>'));
  await page.waitForFunction(() => getComputedStyle(document.querySelector('#stream')).fontFamily.includes('Lexend'), null, { timeout: 1000 });
  assert.doesNotMatch(await page.locator('#stream code').evaluate(e => getComputedStyle(e).fontFamily), /Lexend/);
  await page.getByRole('textbox', { name: 'Message' }).fill('Typing remains responsive');
  await settle();
  await worker.evaluate(() => chrome.storage.sync.set({ enabled: false }));
  await page.waitForFunction(() => !getComputedStyle(document.querySelector('#author-label')).fontFamily.includes('Lexend'));
  assert.equal(await page.locator('#author-label').getAttribute('data-lexend-retained'), null);
  await worker.evaluate(() => chrome.storage.sync.set({ enabled: true }));
  await page.waitForFunction(() => getComputedStyle(document.querySelector('#author-label')).fontFamily.includes('Lexend'));
  await settle();
  await page.goto(url + '?conversation=next');
  await page.waitForFunction(() => getComputedStyle(document.querySelector('#author-label')).fontFamily.includes('Lexend'));
  await settle();
  const result = { browser: context.browser().version(), extension, hashes, before, after, typography,
    darkReader: await page.evaluate(() => document.documentElement.getAttribute('data-darkreader-mode')),
    checks: ['built source hashes', 'idle across 10 seconds', 'typography during style contention', 'streaming', 'protected code', 'typing', 'pause/resume', 'conversation navigation'] };
  await mkdir(output, { recursive: true });
  await writeFile(join(output, 'verification.json'), JSON.stringify(result, null, 2));
  console.log(JSON.stringify(result, null, 2));
} finally {
  await context?.close();
  await new Promise(resolve => server.close(resolve));
  await rm(profile, { recursive: true, force: true });
}
