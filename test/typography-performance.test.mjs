import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
import test from "node:test";
import { chromium } from "playwright";

test("large pages reuse measurements, preserve protected branches, and rest while paused", async () => {
  const browser = await chromium.launch({ headless: true });
  try {
    const page = await browser.newPage({ viewport: { width: 1280, height: 800 } });
    await page.route("http://performance.test/**", async (route) => {
      const path = new URL(route.request().url()).pathname;
      await route.fulfill({ body: await readFile(resolve(`.${path}`)), contentType: "font/woff2" });
    });
    await page.setContent(`<!doctype html><style>
      body {font:16px/24px Arial} article {padding:12px} p {max-width:60ch}
      #rhythm {font:20px/1.4 Arial;letter-spacing:1px}
      #rhythm::before {content:"Read on. ";font:10px/16px Arial;letter-spacing:2px}
      #native-line {line-height:normal} #ignored {font:18px/27px Georgia;letter-spacing:2px}
      #ignored span {font-size:1.5em} #editor {font:14px/21px monospace}
      #editor span:nth-child(2) {font-size:1.2em} #host {font-size:12px}
    </style><p id="rhythm">Room between the lines.</p><p id="native-line">Natural font metrics.</p>
    <div id="ignored" data-lexend-ignore>Author text <span id="relative">Relative text</span><div id="host"></div></div>
    <main>${Array.from({ length: 80 }, (_, i) => `<article><h2>Chapter ${i}</h2><p>Careful typography makes everyday pages easier to read. <a href="#rhythm">Follow the details.</a></p><button>Read chapter</button></article>`).join("")}</main>
    <pre id="editor">${Array.from({ length: 500 }, (_, i) => `<span>const value${i} = ${i};</span>\n`).join("")}</pre>`);
    await page.evaluate(() => {
      document.getElementById("host").attachShadow({ mode: "open" }).innerHTML = '<p style="font-size:1.5em">Protected shadow text</p>';
      globalThis.__settings = { enabled: false, scope: "all", textScale: 120 };
      const storage = [], runtime = [];
      globalThis.chrome = {
        runtime: { getURL: (path) => `http://performance.test/${path}`, sendMessage: async () => {}, onMessage: { addListener: (fn) => runtime.push(fn) } },
        storage: { sync: { get: async () => __settings }, onChanged: { addListener: (fn) => storage.push(fn) } }
      };
      globalThis.__update = (values) => {
        Object.assign(__settings, values);
        const changes = Object.fromEntries(Object.entries(values).map(([key, newValue]) => [key, { newValue }]));
        storage.forEach((fn) => fn(changes, "sync"));
      };
      globalThis.__state = () => { let state; runtime.forEach((fn) => fn({ type: "LEXEND_GET_STATE" }, null, (value) => { state = value; })); return state; };
      globalThis.__metrics = (element, pseudo = null) => {
        const css = getComputedStyle(element, pseudo);
        return { family: css.fontFamily, size: css.fontSize, line: css.lineHeight, spacing: css.letterSpacing };
      };
      globalThis.__protected = () => [document.querySelector("#relative"), document.querySelector("#editor span:nth-child(2)"), document.querySelector("#host").shadowRoot.querySelector("p")].map((element) => __metrics(element));
      const nativeStyle = getComputedStyle;
      globalThis.__styleReads = 0;
      globalThis.getComputedStyle = (...args) => { __styleReads++; return nativeStyle(...args); };
    });
    const original = await page.evaluate(() => __protected());
    for (const name of ["settings", "adaptive-controls", "adaptive-layout", "content"]) await page.addScriptTag({ path: resolve(`src/${name}.js`) });
    await page.evaluate(() => __update({ enabled: true }));
    await page.evaluate(() => document.fonts.ready);
    await page.waitForFunction(() => __state()?.healthy && !__state().pending);
    assert.deepEqual(await page.evaluate(() => __protected()), original, "relative and shadow descendants inherit their protected boundary unchanged");
    const rhythm = await page.evaluate(() => [__metrics(document.querySelector("#rhythm")), __metrics(document.querySelector("#rhythm"), "::before")]);
    assert.equal(rhythm[0].size, "24px");
    assert.equal(rhythm[0].line, "33.6px");
    assert.equal(rhythm[0].spacing, "1.2px");
    assert.equal(rhythm[1].size, "12px");
    assert.equal(rhythm[1].line, "19.2px");
    assert.equal(rhythm[1].spacing, "2.4px");
    assert.equal(await page.locator("#native-line").evaluate((element) => getComputedStyle(element).lineHeight), "normal");
    const measured = await page.evaluate(() => {
      __styleReads = 0;
      __update({ textScale: 110 });
      return { reads: __styleReads, state: __state() };
    });
    // A work budget rather than a wall-clock assertion: the old implementation
    // performs over 100,000 reads for this page, regardless of machine speed.
    assert.ok(measured.reads < 20000, `a complete refresh used ${measured.reads} computed-style reads`);
    assert.equal(measured.state.healthy, true);
    await page.evaluate(() => __update({ textScale: 120 }));
    assert.deepEqual(await page.evaluate(() => __protected()), original, "cached measurements never compound text scaling across refreshes");
    await page.evaluate(() => __update({ lineHeight: 1.8, letterSpacing: .04 }));
    assert.equal(await page.locator("#rhythm").evaluate((element) => getComputedStyle(element).lineHeight), "43.2px", "an explicit line height still takes priority");
    await page.waitForFunction(() => !__state().pending);
    const noOp = await page.evaluate(() => {
      const before = __state().refreshRevision;
      __styleReads = 0;
      __update({ theme: "dark", siteRules: [{ hostname: "elsewhere.example", enabled: false }] });
      return { before, after: __state().refreshRevision, reads: __styleReads };
    });
    assert.equal(noOp.after, noOp.before);
    assert.equal(noOp.reads, 0, "theme and unrelated site rules do no page layout work");
    await page.evaluate(() => __update({ enabled: false }));
    const pausedRevision = await page.evaluate(() => __state().refreshRevision);
    await page.evaluate(() => {
      __styleReads = 0;
      document.querySelector("#rhythm").textContent = "New words while paused.";
      document.querySelector("#relative").style.fontSize = "2em";
      document.querySelector("#host").shadowRoot.querySelector("p").textContent = "New shadow words";
      __update({ textScale: 130 });
      dispatchEvent(new Event("resize"));
      document.querySelector("button").focus();
    });
    await page.waitForTimeout(200);
    const paused = await page.evaluate(() => ({ revision: __state().refreshRevision, reads: __styleReads, pending: __state().pending }));
    assert.equal(paused.revision, pausedRevision);
    assert.equal(paused.reads, 0, "paused pages do not run typography or layout reads");
    assert.equal(paused.pending, false);
    await page.evaluate(() => __update({ enabled: true }));
    assert.match(await page.locator("#rhythm").evaluate((element) => getComputedStyle(element).fontFamily), /Lexend/);
    assert.equal(await page.locator("#rhythm").evaluate((element) => getComputedStyle(element).fontSize), "26px", "resume uses preferences changed while paused");
    assert.equal(await page.locator("#relative").evaluate((element) => getComputedStyle(element).fontSize), "36px", "resume remeasures author changes made while paused");
    await page.evaluate(() => __update({ enabled: false }));
    assert.equal(await page.locator("#rhythm").getAttribute("style"), null);
    assert.equal(await page.locator("#relative").getAttribute("style"), "font-size: 2em;");
  } finally {
    await browser.close();
  }
});
