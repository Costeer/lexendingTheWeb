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
    for (const name of ["settings", "adaptive-controls", "adaptive-layout", "content"]) {
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
    await page.evaluate(() => {
      saved = { enabled: false, scope: "all", textScale: 130, lineHeight: 1.8,
        siteRules: [{ hostname: "saved.example", enabled: false }] };
      restored();
    });
    await page.waitForFunction(() => typeof finishRead === "function");
    await page.evaluate(async () => { update({ theme: "dark" }); finishRead();
      await new Promise((resolve) => setTimeout(resolve, 0)); });
    assert.equal(await page.evaluate(() => state().active), false,
      "A theme event during cached restore must preserve the saved pause and untouched snapshot");
    assert.equal(await page.evaluate(() => state().scope), "all");
    await page.evaluate(() => { deferRead = false; saved.enabled = true; saved.textScale = 120; restored(); });
    await page.waitForFunction(() => state().active && getComputedStyle(document.querySelector("#text")).fontSize === "24px");
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


test("startup reconciles complete saved snapshots with events and stays passive on failed reads", async () => {
  const browser = await chromium.launch();
  try {
    const scenarios = [
      { saved: { enabled: false, scope: "all", textScale: 130, lineHeight: 1.8, letterSpacing: .08,
        siteRules: [{ hostname: "saved.example", enabled: false }] },
        events: [{ theme: { newValue: "dark" } }], active: false, scope: "all", size: "20px" },
      { saved: { enabled: true, scope: "all", textScale: 130, lineHeight: 1.8, letterSpacing: .08,
        siteRules: [{ hostname: "startup.test", enabled: false }] },
        events: [{ theme: { newValue: "dark" } }, { theme: { newValue: "light" } }], active: false, scope: "all", size: "20px" },
      { saved: { enabled: false, scope: "all", textScale: 130, lineHeight: 1.8, letterSpacing: .08 },
        events: [{ enabled: {} }, { textScale: { newValue: 120 } }, { scope: {} }], active: true, scope: "body", size: "24px" },
      { saved: { disabledSites: ["startup.test"], siteRules: [], scope: "all", textScale: 130 },
        events: [{ siteRules: {} }, { theme: { newValue: "dark" } }], active: false, scope: "all", size: "20px" },
      { saved: { enabled: false, scope: "all", textScale: 130 }, fail: true,
        events: [{ theme: { newValue: "dark" } }], active: false, size: "20px" }
    ];
    for (const scenario of scenarios) {
      const page = await browser.newPage();
      const errors = [];
      page.on("pageerror", (error) => errors.push(error.message));
      await page.route("http://startup.test/**", async (route) => {
        const path = new URL(route.request().url()).pathname;
        await route.fulfill(path.startsWith("/assets/")
          ? { body: await readFile(resolve(`.${path}`)), contentType: "font/woff2" }
          : { body: '<!doctype html><style>body{font:20px Arial}</style><p id="text">Saved preferences survive startup.</p>', contentType: "text/html" });
      });
      await page.goto("http://startup.test/");
      await page.evaluate(({ saved, fail }) => {
        const listeners = [], messages = [];
        globalThis.notifications = [];
        globalThis.chrome = {
          runtime: { getURL: (path) => `http://startup.test/${path}`, sendMessage: async (message) => { notifications.push(message); },
            onMessage: { addListener: (fn) => messages.push(fn) } },
          storage: { sync: { get: async () => {
            const snapshot = structuredClone(saved);
            await new Promise((resolve) => { globalThis.finishRead = resolve; });
            if (fail) throw new Error("Storage unavailable");
            return snapshot;
          } }, onChanged: { addListener: (fn) => listeners.push(fn) } }
        };
        globalThis.update = (changes) => listeners.forEach((fn) => fn(changes, "sync"));
        globalThis.state = () => { let result;
          messages.forEach((fn) => fn({ type: "LEXEND_GET_STATE" }, null, (value) => { result = value; }));
          return result;
        };
      }, scenario);
      for (const name of ["settings", "adaptive-controls", "adaptive-layout", "content"]) {
        await page.addScriptTag({ path: resolve(`src/${name}.js`) });
      }
      assert.equal(await page.evaluate(() => state().ready), false);
      await page.evaluate((events) => events.forEach(update), scenario.events);
      assert.equal(await page.evaluate(() => state().active), false, "Partial events cannot activate a page before its read");
      assert.equal(await page.locator("#text").getAttribute("style"), null);
      await page.evaluate(() => finishRead());
      await page.waitForFunction(() => !state().pending);
      const state = await page.evaluate(() => state());
      assert.equal(state.ready, !scenario.fail);
      assert.equal(state.active, scenario.active);
      const lastNotification = await page.evaluate(() => notifications.filter((message) => message.type === "LEXEND_STATE").at(-1));
      assert.equal(lastNotification.ready, state.ready);
      assert.equal(lastNotification.pending, false, "Toolbar must receive the settled state");
      assert.equal(lastNotification.active, state.active);
      if (scenario.scope) assert.equal(state.scope, scenario.scope);
      assert.equal(await page.locator("#text").evaluate((node) => getComputedStyle(node).fontSize), scenario.size);
      if (scenario.fail) {
        assert.equal(state.healthy, false);
        assert.equal(state.error, "SETTINGS_LOAD_FAILED");
        await page.evaluate(() => update({ enabled: { newValue: true } }));
        assert.equal(await page.evaluate(() => state().active), false, "Later partial events do not recover a missing snapshot");
      }
      assert.deepEqual(errors, []);
      await page.close();
    }
  } finally { await browser.close(); }
});
