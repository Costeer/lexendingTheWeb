import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
import test from "node:test";
import { chromium } from "playwright";

const prepare = async (context, saved = { enabled: true, scope: "all", textScale: 120 }, fontResponse) => {
  const page = await context.newPage();
  await page.route("http://startup.test/**", fontResponse ?? (async (route) => {
    await route.fulfill({ body: await readFile(resolve(`.${new URL(route.request().url()).pathname}`)), contentType: "font/woff2" });
  }));
  await page.setContent('<!doctype html><style>body{font:20px/30px Arial}p{margin:0}</style><p id="text">Read without waiting for a second font swap.</p><strong>Bold reading text</strong><code>Native code</code>');
  await page.evaluate(() => new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve))));
  await page.evaluate((saved) => {
    const changes = [], messages = [];
    globalThis.saved = saved;
    globalThis.chrome = {
      runtime: { getURL: (path) => `http://startup.test/${path}`, sendMessage: async () => {}, onMessage: { addListener: (fn) => messages.push(fn) } },
      storage: { sync: { get: async () => saved }, onChanged: { addListener: (fn) => changes.push(fn) } }
    };
    globalThis.state = () => {
      let result;
      messages.forEach((fn) => fn({ type: "LEXEND_GET_STATE" }, null, (value) => { result = value; }));
      return result;
    };
    globalThis.update = (patch) => {
      Object.assign(saved, patch);
      changes.forEach((fn) => fn(Object.fromEntries(Object.entries(patch).map(([key, newValue]) => [key, { newValue }])), "sync"));
    };
    const create = LexendLayout.create;
    globalThis.fontReadyAtCapture = [];
    globalThis.fontFrameBeforeRepair = false;
    globalThis.repairFrames = [];
    LexendLayout = { create: (options) => {
      const layout = create(options);
      return { ...layout, capture: (...args) => {
        requestAnimationFrame(() => {
          fontFrameBeforeRepair = getComputedStyle(document.querySelector("#text")).fontFamily.includes("Lexend") && state().pending;
        });
        fontReadyAtCapture.push(document.fonts.check('400 20px "Lexend for the Web"', "Read")
          && document.fonts.check('700 20px "Lexend for the Web"', "Bold"));
        return layout.capture(...args);
      }, repair: (...args) => {
        repairFrames.push(fontFrameBeforeRepair);
        return layout.repair(...args);
      } };
    } };
  }, saved);
  // Real content scripts run without adding a page <script> or load event.
  await page.evaluate(source => (0, eval)(source), await readFile(resolve("src/content.js"), "utf8"));
  return page;
};

let browser;
test.before(async () => { browser = await chromium.launch(); });
test.after(async () => { await browser?.close(); });

// Install the shared modules before preparing the stub and instrumenting capture.
const createContext = browser => browser.newContext().then(async context => {
  await context.addInitScript({ path: resolve("src/settings.js") });
  await context.addInitScript({ path: resolve("src/adaptive-controls.js") });
  await context.addInitScript({ path: resolve("src/adaptive-layout.js") });
  return context;
});

test("cold startup loads regular and bold reading metrics before one layout repair", async () => {
  const context = await createContext(browser);
  try {
    const page = await prepare(context);
    await page.waitForFunction(() => state()?.healthy && !state().pending && state().refreshRevision > 0);
    await page.evaluate(() => document.fonts.ready);
    await page.waitForTimeout(150);
    assert.deepEqual(await page.evaluate(() => fontReadyAtCapture), [true], "loaded bundled faces do not trigger a redundant full-page repair");
    assert.equal(await page.evaluate(() => state().refreshRevision), 1);
    assert.deepEqual(await page.evaluate(() => repairFrames), [true], "converted text gets a rendering frame before the heavy layout repair");
    assert.equal(await page.locator("#text").evaluate(element => getComputedStyle(element).fontSize), "24px");
    assert.match(await page.locator("code").evaluate(element => getComputedStyle(element).fontFamily), /monospace/);
  } finally { await context.close(); }
});

test("a slow font cannot delay fallback conversion or resume a paused page", async () => {
  const context = await createContext(browser);
  let release;
  const held = new Promise(resolve => { release = resolve; });
  try {
    const page = await prepare(context, undefined, async route => {
      await held;
      await route.fulfill({ body: await readFile(resolve(`.${new URL(route.request().url()).pathname}`)), contentType: "font/woff2" });
    });
    await page.waitForFunction(() => state()?.healthy && !state().pending && state().refreshRevision > 0);
    assert.equal(await page.locator("#text").evaluate(element => getComputedStyle(element).fontSize), "24px", "conversion proceeds while font delivery is still blocked");
    await page.evaluate(() => update({ enabled: false }));
    release();
    await page.evaluate(() => document.fonts.ready);
    await page.waitForTimeout(150);
    assert.equal(await page.evaluate(() => state().active), false);
    assert.equal(await page.locator("#text").getAttribute("style"), null);
  } finally { release(); await context.close(); }
});

test("a newer pause during preloading wins over the initial settings read", async () => {
  const context = await createContext(browser);
  let release;
  const held = new Promise(resolve => { release = resolve; });
  try {
    const page = await prepare(context, undefined, async route => {
      await held;
      await route.fulfill({ body: await readFile(resolve(`.${new URL(route.request().url()).pathname}`)), contentType: "font/woff2" });
    });
    await page.evaluate(() => update({ enabled: false }));
    release();
    await page.waitForFunction(() => state()?.pending === false);
    await page.waitForTimeout(150);
    assert.equal(await page.evaluate(() => state().active), false);
    assert.equal(await page.locator("#text").getAttribute("style"), null);
  } finally { release(); await context.close(); }
});

test("failed bundled-font delivery retains healthy fallback conversion", async () => {
  const context = await createContext(browser);
  try {
    const page = await prepare(context, undefined, route => route.abort());
    await page.waitForFunction(() => state()?.pending === false && state().refreshRevision > 0);
    assert.equal(await page.evaluate(() => state().healthy), true);
    assert.equal(await page.locator("#text").evaluate(element => getComputedStyle(element).fontSize), "24px");
    await page.evaluate(() => update({ enabled: false }));
    assert.equal(await page.locator("#text").getAttribute("style"), null);
  } finally { await context.close(); }
});

test("paused startup does no reading-font requests or layout capture", async () => {
  const context = await createContext(browser);
  try {
    const requests = [];
    context.on("request", request => requests.push(request.url()));
    const page = await prepare(context, { enabled: false });
    await page.waitForFunction(() => state()?.pending === false);
    assert.deepEqual(requests, []);
    assert.deepEqual(await page.evaluate(() => fontReadyAtCapture), []);
    assert.equal(await page.locator("#text").getAttribute("style"), null);
  } finally { await context.close(); }
});

test("rapid settings changes cancel older deferred repairs and preserve intervening scroll", async () => {
  const context = await createContext(browser);
  try {
    const page = await prepare(context);
    await page.waitForFunction(() => state()?.pending === false && state().refreshRevision > 0);
    await page.evaluate(() => {
      const spacer = document.createElement("div");
      spacer.style.height = "5000px";
      document.body.append(spacer);
    });
    await page.waitForFunction(() => !state().pending);
    const immediate = await page.evaluate(() => {
      const before = repairFrames.length;
      update({ textScale: 140 });
      update({ textScale: 80 });
      const pending = state().pending;
      scrollTo(0, 900);
      return { before, pending, size: getComputedStyle(document.querySelector("#text")).fontSize };
    });
    assert.equal(immediate.pending, true);
    assert.equal(immediate.size, "16px", "the newest font size applies in the preference event's task");
    await page.waitForFunction(() => !state().pending);
    assert.equal(await page.evaluate(() => repairFrames.length), immediate.before + 1, "only the latest native baseline is repaired");
    assert.equal(await page.evaluate(() => scrollY), 900, "the repair keeps the user's position from after the font conversion");
    await page.evaluate(() => { update({ textScale: 130 }); update({ enabled: false }); });
    await page.waitForTimeout(150);
    assert.equal(await page.evaluate(() => state().pending), false);
    assert.equal(await page.locator("#text").getAttribute("style"), null, "an obsolete scheduled repair cannot restore paused overrides");
  } finally { await context.close(); }
});
