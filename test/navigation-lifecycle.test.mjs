import assert from "node:assert/strict";
import test from "node:test";
import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
import { chromium } from "playwright";

test("initialization and cached-page restoration ignore stale reads and preserve confirmed preferences", async () => {
  const browser = await chromium.launch();
  try {
    const page = await browser.newPage();
    const errors = [];
    page.on("pageerror", (error) => errors.push(error.message));
    await page.route("http://navigation.test/**", async (route) => {
      await route.fulfill({ body: await readFile(resolve(`.${new URL(route.request().url()).pathname}`)), contentType: "font/woff2" });
    });
    await page.setContent('<!doctype html><style>body{font:20px Arial}</style><p id="text">A restored reading session.</p>');
    await page.evaluate(() => {
      const listeners = [], messages = [];
      globalThis.saved = { enabled: true, scope: "all", textScale: 110 };
      globalThis.deferRead = true;
      globalThis.failRead = false;
      globalThis.chrome = {
        runtime: { getURL: (path) => `http://navigation.test/${path}`, sendMessage: async () => {}, onMessage: { addListener: (fn) => messages.push(fn) } },
        storage: {
          sync: { get: async () => {
            if (failRead) throw new Error("Storage unavailable");
            const snapshot = structuredClone(saved);
            if (deferRead) await new Promise((resolve) => { globalThis.finishRead = resolve; });
            return snapshot;
          } },
          onChanged: { addListener: (fn) => listeners.push(fn) }
        }
      };
      globalThis.restored = () => dispatchEvent(new PageTransitionEvent("pageshow", { persisted: true }));
      globalThis.update = (patch) => {
        Object.assign(saved, patch);
        const changes = Object.fromEntries(Object.entries(patch).map(([key, newValue]) => [key, { newValue }]));
        listeners.forEach((fn) => fn(changes, "sync"));
      };
      globalThis.state = () => {
        let result;
        messages.forEach((fn) => fn({ type: "LEXEND_GET_STATE" }, null, (value) => { result = value; }));
        return result;
      };
    });
    for (const name of ["settings", "adaptive-layout", "content"]) {
      await page.addScriptTag({ path: resolve(`src/${name}.js`) });
    }
    await page.waitForFunction(() => typeof finishRead === "function");
    await page.evaluate(async () => {
      update({ textScale: 120 });
      finishRead();
      deferRead = false;
      await new Promise((resolve) => setTimeout(resolve, 0));
    });
    assert.equal(await page.locator("#text").evaluate((element) => getComputedStyle(element).fontSize), "24px",
      "A late initialization read cannot replace settings received during startup");
    await page.waitForFunction(() => state()?.healthy && !state().pending);
    await page.evaluate(() => document.fonts.ready);
    await page.evaluate(async () => {
      saved.enabled = false;
      dispatchEvent(new PageTransitionEvent("pageshow", { persisted: false }));
      await new Promise((resolve) => setTimeout(resolve, 0));
    });
    assert.equal(await page.evaluate(() => state().active), true, "Ordinary pageshow events do not trigger redundant reloads");
    await page.evaluate(() => restored());
    await page.waitForFunction(() => !state().active);
    assert.equal(await page.locator("#text").getAttribute("style"), null);
    await page.evaluate(() => { saved.enabled = true; saved.textScale = 130; restored(); });
    await page.waitForFunction(() => state().active && getComputedStyle(document.querySelector("#text")).fontSize === "26px");
    await page.evaluate(() => {
      deferRead = true;
      saved.textScale = 80;
      restored();
    });
    await page.waitForFunction(() => typeof finishRead === "function");
    await page.evaluate(async () => {
      update({ textScale: 120 });
      finishRead();
      await new Promise((resolve) => setTimeout(resolve, 0));
    });
    assert.equal(await page.locator("#text").evaluate((element) => getComputedStyle(element).fontSize), "24px",
      "A late storage read cannot overwrite a newer sync event");
    await page.evaluate(async () => {
      deferRead = false;
      failRead = true;
      restored();
      await new Promise((resolve) => setTimeout(resolve, 0));
    });
    assert.equal(await page.locator("#text").evaluate((element) => getComputedStyle(element).fontSize), "24px",
      "Failed restoration reads preserve the last confirmed preferences");
    assert.equal(await page.evaluate(() => state().healthy), true);
    assert.deepEqual(errors, []);
  } finally {
    await browser.close();
  }
});
