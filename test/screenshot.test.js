import assert from "node:assert/strict";
import test from "node:test";
import { chromium } from "playwright";
import { captureScreenshot } from "../harness/screenshot.mjs";
import { collectSnapshot, compareSnapshots } from "../harness/audit.js";

test("stalled author fonts retain bounded native screenshots with explicit incomplete evidence", async () => {
  const browser = await chromium.launch({ headless: true });
  try {
    const page = await browser.newPage({ viewport: { width: 300, height: 200 } });
    let fontRequest;
    await page.route("https://fonts.example/slow.woff2", (route) => { fontRequest = route; });
    await page.setContent(`<style>@font-face{font-family:Slow;src:url(https://fonts.example/slow.woff2)}body{margin:0;font:16px Slow,Arial}.tail{height:1200px}</style><p>Readable fallback while waiting</p><div class="tail"></div>`, { waitUntil: "domcontentloaded" });
    await page.waitForFunction(() => document.fonts.status === "loading");
    const notices = [];
    const options = { timeout: 100, onFontWaitFallback: (notice) => notices.push(notice) };
    const viewport = await captureScreenshot(page, options);
    assert.equal(viewport.readUInt32BE(16), 300);
    assert.equal(viewport.readUInt32BE(20), 200);
    const full = await captureScreenshot(page, { ...options, fullPage: true });
    assert.ok(full.readUInt32BE(20) >= 1200);
    const clipped = await captureScreenshot(page, { ...options,
      fullPage: true, clip: { x: 0, y: 0, width: 300, height: 600 } });
    assert.equal(clipped.readUInt32BE(20), 600);
    assert.equal(notices.length, 3);
    const snapshot = await page.evaluate(collectSnapshot);
    assert.equal(snapshot.fontsPending, true);
    assert.ok(snapshot.limitations.some((item) => /fonts are still loading/.test(item.reason)));
    assert.ok(compareSnapshots(snapshot, snapshot, { scope: "all", textScale: 100, lineHeight: 0, letterSpacing: 0 })
      .findings.some((item) => item.code === "font-state-pending" && item.severity === "review"));
    await fontRequest.abort();
  } finally { await browser.close(); }
});

// Real sites can stall the screenshot compositor without a font-wait log.
// Exercise protocol recovery against an actual painted page and retain failure
// semantics for errors that are not readiness timeouts.
test("busy screenshot recovery retains native paint and never hides independent failures", async () => {
  const browser = await chromium.launch({ headless: true });
  try {
    const page = await browser.newPage({ viewport: { width: 320, height: 240 } });
    await page.setContent('<p>Native readable text</p>');
    const notices = [];
    page.screenshot = async () => { throw new Error('page.screenshot: Timeout 5000ms exceeded. Call log: taking page screenshot'); };
    const bitmap = await captureScreenshot(page, { onFontWaitFallback: (notice) => notices.push(notice) });
    assert.equal(bitmap.readUInt32BE(16), 320);
    assert.equal(bitmap.readUInt32BE(20), 240);
    assert.match(notices[0].reason, /screenshot readiness remains incomplete/);
    page.screenshot = async () => { throw new Error('Target page closed'); };
    await assert.rejects(captureScreenshot(page), /Target page closed/);
    assert.equal(notices.length, 1);
  } finally { await browser.close(); }
});
