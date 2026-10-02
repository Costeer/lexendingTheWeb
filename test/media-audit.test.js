import assert from "node:assert/strict";
import test from "node:test";
import { compareMediaSnapshots } from "../harness/media-audit.js";
import { collectMediaSnapshot } from "../harness/media-audit.js";
import { chromium } from "playwright";

test("imagery cannot silently collapse after typography reflow", () => {
  const image = { id: 1, path: "img", width: 640, height: 360, hidden: false, source: "photo.jpg" };
  assert.deepEqual(compareMediaSnapshots([image], [{ ...image, height: 420 }]), []);
  assert.equal(compareMediaSnapshots([image], [{ ...image, height: 0 }])[0].code, "media-collapsed");
  assert.equal(compareMediaSnapshots([image], [{ ...image, hidden: true }])[0].severity, "review");
  assert.equal(compareMediaSnapshots([image], [{ ...image, source: "next-slide.jpg" }])[0].code, "media-content-change");
  assert.equal(compareMediaSnapshots([image], [{ ...image, width: 100, height: 60 }])[0].code, "media-shrunk");
  assert.deepEqual(compareMediaSnapshots([{ ...image, responsiveSource: "same-picture" }],
    [{ ...image, source: "photo-2x.jpg", responsiveSource: "same-picture" }]), []);
  assert.equal(compareMediaSnapshots([{ ...image, responsiveSource: "same-picture" }],
    [{ ...image, source: "different.jpg", responsiveSource: "different-picture" }])[0].code, "media-content-change");
  assert.deepEqual(compareMediaSnapshots([{ ...image, width: 16, height: 16 }], [{ ...image, height: 0 }]), []);
});

test("deferred rendering is distinct from an actual zero-area image", async () => {
  const browser = await chromium.launch({ headless: true });
  try {
    const page = await browser.newPage();
    await page.setContent(`<style>.deferred{content-visibility:auto;contain-intrinsic-size:500px;margin-top:9000px}</style>
      <img id="photo" width="640" height="480"><div class="deferred"><img id="deferred" width="640" height="480"></div>`);
    const before = await page.evaluate(collectMediaSnapshot);
    assert.equal(before.find((item) => item.path === "img#deferred").hidden, true);
    await page.locator("#photo").evaluate((element) => { element.style.width = "0px"; element.style.height = "0px"; });
    const after = await page.evaluate(collectMediaSnapshot);
    assert.equal(after.find((item) => item.path === "img#photo").hidden, false);
    assert.equal(compareMediaSnapshots(before, after).find((finding) => finding.path === "img#photo").code, "media-collapsed");
  } finally { await browser.close(); }
});


test("paired visible artwork displacement is distinct from scrolling", () => {
  const image = { id: 1, path: "svg", width: 80, height: 80, hidden: false,
    viewport: { x: 100, y: 100, width: 390, height: 844, scrollX: 0, scrollY: 0 } };
  const displaced = { ...image, viewport: { ...image.viewport, x: -100 } };
  assert.equal(compareMediaSnapshots([image], [displaced])[0].code, "media-displaced");
  assert.deepEqual(compareMediaSnapshots([image], [{ ...displaced,
    viewport: { ...displaced.viewport, scrollY: 800 } }]), []);
  const offscreen = { ...image, viewport: { ...image.viewport, y: 1000 } };
  assert.deepEqual(compareMediaSnapshots([offscreen], [displaced]), []);
});


test("independently scrolling body movement is not artwork displacement", async () => {
  const browser = await chromium.launch({ headless: true });
  try {
    const page = await browser.newPage({ viewport: { width: 390, height: 844 } });
    await page.setContent(`<style>html,body{margin:0;height:100%;overflow-y:auto}body{overflow-x:hidden}img{display:block;width:80px;height:80px}.spacer{height:1600px}</style><img id="art"><div class="spacer"></div>`);
    const before = await page.evaluate(collectMediaSnapshot);
    await page.evaluate(() => { document.body.scrollTop = 200; });
    const after = await page.evaluate(collectMediaSnapshot);
    assert.equal(after[0].viewport.scrollY, 200);
    assert.equal(after[0].viewport.y, -200);
    assert.deepEqual(compareMediaSnapshots(before, after), []);
  } finally { await browser.close(); }
});
