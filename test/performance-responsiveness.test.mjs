import assert from 'node:assert/strict';
import test from 'node:test';
import { chromium } from 'playwright';
import { measureResponsiveness, responsivenessProtocol } from '../scripts/performance/responsiveness.mjs';
import { conversationHtml } from './helpers/conversation.mjs';

// Test the browser detector independently of runtime instrumentation. The full
// CLI comparison separately runs this phase with both real runtime revisions.
test('native task detector records a timed stream, actual observer writes, and a synchronous block', async () => {
  const browser = await chromium.launch();
  try {
    const page = await browser.newPage();
    await page.setContent(conversationHtml({ turns: 2 }));
    await page.evaluate(() => {
      globalThis.__bench = {
        begin() { this.done = new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve))); },
        check() {}
      };
    });
    const { metrics, raw } = await measureResponsiveness(page, 120);
    assert(metrics.maxLongTaskMs >= 120, 'a real synchronous task must reach the native detector');
    assert(raw.calibration.tasks.length > 0);
    assert(raw.longTasks.every(task => task.startTime >= raw.startTime), 'calibration is outside the measured window');
    assert.equal(raw.stream.length, responsivenessProtocol.edits);
    assert(raw.stream.at(-1).deliveredAt - raw.stream[0].deliveredAt >= 2000,
      'the stream must span timer turns rather than a microtask burst');
    assert(raw.authorWrites >= responsivenessProtocol.edits);
    assert(raw.observerDeliveries >= responsivenessProtocol.edits);
    assert(raw.longTasks.some(task => task.startTime <= raw.injectedBlock.startTime
      && task.startTime + task.duration >= raw.injectedBlock.endTime - 2));
  } finally { await browser.close(); }
});

test('unsupported or silently inactive task detectors fail closed', async () => {
  const browser = await chromium.launch();
  try {
    const page = await browser.newPage();
    await page.evaluate(() => { globalThis.PerformanceObserver = { supportedEntryTypes: [] }; });
    await assert.rejects(measureResponsiveness(page), /Long Tasks observation is unavailable/);
    await page.evaluate(() => {
      globalThis.PerformanceObserver = class {
        static supportedEntryTypes = ['longtask'];
        observe() {}
        takeRecords() { return []; }
        disconnect() {}
      };
    });
    await assert.rejects(measureResponsiveness(page), /positive control was not observed/);
    const invalidTarget = await browser.newPage();
    await invalidTarget.setContent(conversationHtml({ turns: 2 }));
    await invalidTarget.locator('main p').first().evaluate(element => { element.innerHTML = '<span>Wrapped text</span>'; });
    await assert.rejects(measureResponsiveness(invalidTarget), /text-node target/,
      'writing an arbitrary .data property on an element cannot count as a streamed DOM edit');
  } finally { await browser.close(); }
});

test('the final settling task is captured before the observer is disconnected', async () => {
  const browser = await chromium.launch();
  try {
    const page = await browser.newPage();
    await page.setContent(conversationHtml({ turns: 2 }));
    await page.evaluate(() => {
      globalThis.__bench = {
        begin() {
          this.done = new Promise(resolve => requestAnimationFrame(() => {
            const startTime = performance.now();
            while (performance.now() - startTime < 100) { /* Simulated final synchronous repair. */ }
            globalThis.__finalBlock = { startTime, endTime: performance.now() };
            resolve();
          }));
        },
        check() {}
      };
    });
    const { raw } = await measureResponsiveness(page);
    const block = await page.evaluate(() => __finalBlock);
    assert.equal(raw.injectedBlock, null);
    assert(raw.longTasks.some(task => task.startTime <= block.startTime
      && task.startTime + task.duration >= block.endTime - 2),
    'a long task ending in the promise-resolution turn must survive the final drain');
  } finally { await browser.close(); }
});
