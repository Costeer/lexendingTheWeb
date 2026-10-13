import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
import test from "node:test";
import { chromium } from "playwright";
import { conversationHtml, instrumentContent } from "./helpers/conversation.mjs";

const prepare = async (page, html, { settings = {}, beforeStart, settle = true, inspect = false } = {}) => {
  await page.route("http://performance.test/**", async (route) => {
    await route.fulfill({ body: await readFile(resolve(`.${new URL(route.request().url()).pathname}`)), contentType: "font/woff2" });
  });
  await page.setContent(html);
  await page.evaluate((settings) => {
    const storage = [], runtime = [];
    globalThis.__settings = { enabled: true, scope: "all", textScale: 100, ...settings };
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
  }, settings);
  for (const name of ["settings", "adaptive-layout", "content"]) {
    if (name === "content") await beforeStart?.(page);
    const path = resolve(process.env.LEXEND_TEST_SOURCE ?? ".", `src/${name}.js`);
    if (inspect && name === "content") await page.addScriptTag({ content: instrumentContent(await readFile(path, "utf8")) });
    else await page.addScriptTag({ path });
  }
  if (!settle) return;
  await page.evaluate(() => document.fonts.ready);
  await page.waitForFunction(() => __state()?.healthy && !__state().pending);
};

test("startup paints loaded Lexend before any full-page layout work", async () => {
  const browser = await chromium.launch({ headless: true });
  try {
    const page = await browser.newPage();
    const beforeStart = (page) => page.evaluate(() => {
      // Hold every scheduled task: the font must not depend on running one.
      globalThis.__tasks = new Map();
      let id = 0;
      globalThis.setTimeout = (callback) => { __tasks.set(++id, callback); return id; };
      globalThis.clearTimeout = (id) => __tasks.delete(id);
      const create = LexendLayout.create;
      globalThis.__layoutWork = 0;
      globalThis.LexendLayout = { create: (options) => {
        const layout = create(options);
        return { ...layout,
          capture: (...args) => { __layoutWork++; return layout.capture(...args); },
          repair: (...args) => { __layoutWork++; return layout.repair(...args); }
        };
      } };
    });
    const html = '<!doctype html><style>body{font:20px/28px Arial}</style><p>Repository description</p><pre>const answer = 42;</pre>';
    await prepare(page, html, { settings: { textScale: 120 }, beforeStart, settle: false });
    const result = await page.evaluate(async () => {
      const family = getComputedStyle(document.querySelector("p")).fontFamily;
      await document.fonts.ready;
      return { family, loaded: document.fonts.check('400 24px "Lexend for the Web"', 'Repository'),
        size: getComputedStyle(document.querySelector("p")).fontSize,
        code: getComputedStyle(document.querySelector("pre")).fontFamily,
        work: __layoutWork, state: __state() };
    });
    assert.match(result.family, /Lexend/);
    assert.equal(result.loaded, true, "bundled glyphs load while layout work is still parked");
    assert.equal(result.size, "24px");
    assert.doesNotMatch(result.code, /Lexend/);
    assert.equal(result.work, 0, "neither baseline capture nor repair blocks the first font application");
    assert.equal(result.state.refreshRevision, 0);
    assert.equal(result.state.pending, true);
    await page.evaluate(() => __update({ enabled: false }));
    assert.equal(await page.locator("p").getAttribute("style"), null);
    assert.equal(await page.evaluate(() => __tasks.size), 0, "pausing cancels the deferred initial repair");

    const paused = await browser.newPage();
    await prepare(paused, html, { settings: { enabled: false }, beforeStart, settle: false });
    assert.doesNotMatch(await paused.locator("p").evaluate((element) => getComputedStyle(element).fontFamily), /Lexend/);
    assert.equal(await paused.evaluate(() => __tasks.size), 0, "disabled startup never queues font application");
  } finally { await browser.close(); }
});

test("incoming branches get fonts before timers while preserving author families and clone restoration", async () => {
  const browser = await chromium.launch({ headless: true });
  try {
    const page = await browser.newPage();
    await prepare(page, `<!doctype html><style>
      body {font:20px/28px Arial} #incoming {font-size:1.2em}
      #incoming::before {content:'x';font-family:TestIcons}
      h2,code,[data-lexend-ignore] {font:inherit}
    </style><div id="parent">Repository description</div><main>${"<p>Existing page content</p>".repeat(200)}</main>`,
    { settings: { scope: "body", textScale: 120 } });
    const result = await page.evaluate(async () => {
      globalThis.__tasks = new Map();
      let id = 0;
      globalThis.setTimeout = (callback) => { __tasks.set(++id, callback); return id; };
      globalThis.clearTimeout = (id) => __tasks.delete(id);
      const revision = __state().refreshRevision;
      const existingChanges = [];
      const existingObserver = new MutationObserver((records) => existingChanges.push(...records));
      existingObserver.observe(document.querySelector("main"), { attributes: true, subtree: true });
      document.querySelector("#parent").insertAdjacentHTML("beforeend", `<span id="incoming">New navigation label
        <code>const answer = 42;</code><span data-lexend-ignore>Original prose</span>
        <h2>Original heading</h2><span id="shadow"></span></span>`);
      document.querySelector("#shadow").attachShadow({ mode: "open" }).innerHTML = '<span>New shadow label</span>';
      await Promise.resolve();
      const incoming = document.querySelector("#incoming");
      const family = (element, pseudo = null) => getComputedStyle(element, pseudo).fontFamily;
      const fonts = [incoming, incoming.querySelector("code"), incoming.querySelector("[data-lexend-ignore]"), incoming.querySelector("h2")].map((element) => family(element));
      const pseudo = family(incoming, "::before");
      const shadow = family(document.querySelector("#shadow").shadowRoot.querySelector("span"));
      const clone = incoming.cloneNode(true);
      clone.id = "cloned-label";
      document.querySelector("#parent").append(clone);
      await Promise.resolve();
      const clonedFont = family(clone);
      const state = __state();
      const existingWrites = existingChanges.length;
      existingObserver.disconnect();
      __update({ enabled: false });
      return { fonts, pseudo, shadow, clonedFont, revision, state, existingWrites, tasks: __tasks.size,
        originalStyle: incoming.getAttribute("style"), cloneStyle: clone.getAttribute("style"),
        restored: [family(incoming), family(clone)], markers: document.querySelectorAll('[data-lexend-font],[data-lexend-original-typography]').length };
    });
    assert.match(result.fonts[0], /Lexend/);
    assert.deepEqual(result.fonts.slice(1), ["Arial", "Arial", "Arial"], "code, opt-outs, and excluded headings inherit author families");
    assert.equal(result.pseudo, "TestIcons");
    assert.match(result.shadow, /Lexend/);
    assert.equal(result.clonedFont.match(/Lexend for the Web/g)?.length, 1, "clones recover the author family before conversion");
    assert.equal(result.state.refreshRevision, result.revision, "new text does not trigger a synchronous full-page repair");
    assert.equal(result.state.pending, true);
    assert.equal(result.state.healthy, true);
    assert.equal(result.existingWrites, 0, "incoming text never rewrites the existing page to find its author family");
    assert.equal(result.tasks, 0);
    assert.equal(result.originalStyle, null);
    assert.equal(result.cloneStyle, null);
    assert.deepEqual(result.restored, ["Arial", "Arial"]);
    assert.equal(result.markers, 0);
  } finally { await browser.close(); }
});

test("animated labels restore their font guards in a bounded number of style recalculations", async () => {
  const browser = await chromium.launch({ headless: true });
  try {
    const page = await browser.newPage();
    await prepare(page, '<!doctype html><style>body{font:16px/24px Arial}p{transition:all .2s;margin:0}</style>'
      + Array.from({ length: 200 }, (_, i) => `<p>Readable label ${i}</p>`).join(""));
    const client = await page.context().newCDPSession(page);
    await client.send("Performance.enable");
    const recalculations = async () => (await client.send("Performance.getMetrics")).metrics.find(({ name }) => name === "RecalcStyleCount").value;
    const before = await recalculations();
    await page.evaluate(() => __update({ textScale: 110 }));
    const count = await recalculations() - before;
    assert.ok(count < 20, `refresh forced ${count} style recalculations for 200 animated labels`);
    assert.equal(await page.locator("p").first().evaluate((element) => getComputedStyle(element).fontSize), "17.6px");
    assert.equal(await page.evaluate(() => __state().healthy), true);
  } finally { await browser.close(); }
});

test("repeated and reverted attribute assignments do not rebuild an unchanged page", async () => {
  const browser = await chromium.launch({ headless: true });
  try {
    const page = await browser.newPage();
    await prepare(page, '<!doctype html><style>body{font:16px/24px Arial}.larger{font-size:30px}</style><p class="label">Live label</p>');
    const before = await page.evaluate(() => __state().refreshRevision);
    const pending = await page.evaluate(async () => {
      const element = document.querySelector("p"), style = element.getAttribute("style");
      for (let i = 0; i < 100; i++) {
        element.setAttribute("class", "label");
        element.setAttribute("style", style);
        element.className = "larger";
        element.className = "label";
      }
      await Promise.resolve();
      return __state().pending;
    });
    assert.equal(pending, false, "no automatic pass is queued for a batch with unchanged final attributes");
    assert.equal(await page.evaluate(() => __state().refreshRevision), before);
    await page.evaluate(() => {
      const element = document.querySelector("p");
      element.className = "label";
      element.className = "larger";
    });
    await page.waitForFunction((revision) => __state().refreshRevision > revision && !__state().pending, before);
    assert.equal(await page.locator("p").evaluate((element) => getComputedStyle(element).fontSize), "30px", "a genuine change later in the same batch still gets measured");
  } finally { await browser.close(); }
});

test("responsive navigation measurements settle across observer deliveries instead of restarting typography", async () => {
  const browser = await chromium.launch({ headless: true });
  try {
    const page = await browser.newPage();
    await prepare(page, `<!doctype html><style>
      body {font:16px/24px Arial} nav[aria-hidden=true] span {font-size:30px}
    </style><nav><a href="#content"><span>Repository navigation</span></a></nav><main id="content">Page content</main>
    <script>
      // Model responsive navigation that temporarily updates accessibility
      // state whenever the extension changes the label's typography. The
      // second update arrives in a later frame, not the same mutation batch.
      globalThis.__navObserver = new MutationObserver(() => {
        document.querySelector('nav').setAttribute('aria-hidden', 'true');
        requestAnimationFrame(() => document.querySelector('nav').removeAttribute('aria-hidden'));
      });
      __navObserver.observe(document.querySelector('nav span'), {attributes:true, attributeFilter:['style']});
    </script>`);
    await page.waitForTimeout(150); // allow the author's deferred accessibility measurement to finish
    await page.waitForFunction(() => !__state().pending);
    const revision = await page.evaluate(() => __state().refreshRevision);
    await page.waitForTimeout(500);
    assert.equal(await page.evaluate(() => __state().refreshRevision), revision, "restoring typography must not perpetually restart navigation measurement");
    assert.equal(await page.evaluate(() => __state().pending), false);
    await page.locator("nav a").click();
    await page.waitForFunction(() => !__state().pending);
    const clickedRevision = await page.evaluate(() => __state().refreshRevision);
    await page.waitForTimeout(500);
    assert.equal(await page.evaluate(() => __state().refreshRevision), clickedRevision, "clicking navigation also settles");
    await page.evaluate(() => {
      __navObserver.disconnect();
      document.querySelector("nav").setAttribute("aria-hidden", "true");
    });
    await page.waitForFunction((revision) => __state().refreshRevision > revision && !__state().pending, clickedRevision);
    assert.equal(await page.locator("nav span").evaluate((element) => getComputedStyle(element).fontSize), "30px", "persistent aria-hidden changes still update author-dependent styling");
    await page.evaluate(async () => {
      const nav = document.querySelector("nav");
      nav.removeAttribute("aria-hidden");
      await Promise.resolve();
      nav.setAttribute("aria-hidden", "true");
      document.querySelector("main").innerHTML = "<p>New page after navigation</p>";
    });
    await page.waitForFunction(() => !__state().pending && document.querySelector("main p").hasAttribute("data-lexend-text"));
    assert.equal(await page.evaluate(() => __state().healthy), true, "a reverted accessibility change cannot swallow a real page update");
  } finally { await browser.close(); }
});

test("size-observed navigation does not unfold its menu because of layout repair", async () => {
  const browser = await chromium.launch({ headless: true });
  try {
    const page = await browser.newPage();
    await prepare(page, `<!doctype html><style>
      body{font:16px/20px Arial}nav{display:flex;height:40px}
      .nav-item{display:flex;align-items:center;height:32px;box-sizing:border-box;padding:6px}
      .nav-item[aria-hidden]{visibility:hidden}
    </style><nav><a class="nav-item" href="#content"><span>Repository</span></a></nav>
    <div id="menu"></div><main id="content">Content</main><script>
      const item=document.querySelector('.nav-item');
      new ResizeObserver(()=>{
        const overflow=item.getBoundingClientRect().height>33;
        if(item.hasAttribute('aria-hidden')===overflow)return;
        item.toggleAttribute('aria-hidden',overflow);
        document.querySelector('#menu').innerHTML=overflow?'<button>Repository menu item</button>':'';
      }).observe(item);
    </script>`);
    for (const layoutMode of ['off','gentle','fit']) {
      await page.evaluate(layoutMode=>__update({layoutMode,textScale:120}),layoutMode);
      await page.waitForFunction(()=>!__state().pending);
      await page.waitForTimeout(150);
      await page.waitForFunction(()=>!__state().pending);
      const revision=await page.evaluate(()=>__state().refreshRevision);
      await page.waitForTimeout(250);
      assert.equal(await page.locator('.nav-item').evaluate(e=>e.getBoundingClientRect().height),32);
      assert.equal(await page.locator('#menu button').count(),0);
      assert.equal(await page.evaluate(()=>__state().refreshRevision),revision);
    }
    await page.evaluate(()=>__update({enabled:false}));
    assert.equal(await page.locator('.nav-item').getAttribute('style'),null);
  } finally {await browser.close();}
});

test("expensive refreshes leave input time during continuous text updates without starving the last update", async () => {
  const browser = await chromium.launch({ headless: true });
  try {
    const page = await browser.newPage();
    await prepare(page, '<!doctype html><style>body{font:16px/24px Arial}</style><main><p>Initial feed</p></main>');
    // Use a controlled clock and task queue, so the work budget is independent
    // of machine speed. Each author-font measurement consumes 100ms of clock
    // time without burning CPU or making the regression test itself janky.
    const result = await page.evaluate(async () => {
      let now = 0, id = 0, captures = 0;
      const tasks = new Map();
      performance.now = () => now;
      globalThis.setTimeout = (callback, delay = 0) => { tasks.set(++id, { callback, due: now + delay }); return id; };
      globalThis.clearTimeout = (id) => tasks.delete(id);
      const nativeStyle = getComputedStyle;
      let charged = false;
      globalThis.getComputedStyle = (...args) => {
        if (!charged) { charged = true; now += 100; captures++; }
        return nativeStyle(...args);
      };
      const runNext = () => {
        const [id, task] = [...tasks].sort((a, b) => a[1].due - b[1].due)[0];
        tasks.delete(id);
        now = Math.max(now, task.due);
        charged = false;
        task.callback();
      };
      __update({ textScale: 110 });
      const initial = __state().refreshRevision;
      const main = document.querySelector("main");
      main.style.color = "red";
      await Promise.resolve();
      main.innerHTML = "<p>First incoming caption</p>";
      await Promise.resolve();
      const immediateFont = getComputedStyle(main.firstElementChild).fontFamily;
      const firstDelay = Math.min(...[...tasks.values()].map((task) => task.due)) - now;
      const pending = __state().pending;
      for (let i = 0; i < 100; i++) {
        now += 10;
        main.innerHTML = `<p>Incoming caption ${i}</p>`;
        await Promise.resolve();
        if ([...tasks.values()].some((task) => task.due <= now)) runNext();
      }
      const during = __state().refreshRevision - initial;
      while (tasks.size) { runNext(); await Promise.resolve(); }
      const final = __state();
      const converted = main.firstElementChild.hasAttribute("data-lexend-text");
      // Explicit preference changes must bypass any automatic cooldown and
      // cancel an already queued repair when pausing the extension.
      main.innerHTML = "<p>Last caption</p>";
      await Promise.resolve();
      __update({ enabled: false });
      return { firstDelay, immediateFont, pending, during, captures, final, converted, paused: __state(), tasks: tasks.size };
    });
    assert.ok(result.firstDelay >= 400, "urgent text must respect the measured expensive-refresh budget");
    assert.match(result.immediateFont, /Lexend/, "fonts apply before the expensive-page repair cooldown expires");
    assert.equal(result.pending, true);
    assert.ok(result.during > 0 && result.during <= 3, `100 feed updates caused ${result.during} repairs during the stream`);
    assert.equal(result.converted, true, "the final inserted text is converted after the burst");
    assert.equal(result.final.pending, false);
    assert.equal(result.final.healthy, true);
    assert.equal(result.paused.active, false);
    assert.equal(result.paused.pending, false);
    assert.equal(result.tasks, 0);
  } finally { await browser.close(); }
});

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
      const nativeBox = Element.prototype.getBoundingClientRect;
      globalThis.__boxReads = 0;
      Element.prototype.getBoundingClientRect = function () { __boxReads++; return nativeBox.call(this); };
    });
    const original = await page.evaluate(() => __protected());
    for (const name of ["settings", "adaptive-layout", "content"]) await page.addScriptTag({ path: resolve(`src/${name}.js`) });
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
    await page.evaluate(() => {
      __styleReads = 0;
      __boxReads = 0;
      __update({ textScale: 110 });
    });
    await page.waitForFunction(() => !__state().pending);
    const measured = await page.evaluate(() => ({ reads: __styleReads, boxes: __boxReads, state: __state() }));
    // A work budget rather than a wall-clock assertion: the old implementation
    // performs over 100,000 reads for this page, regardless of machine speed.
    assert.ok(measured.reads < 7000, `a complete refresh used ${measured.reads} computed-style reads`);
    assert.ok(measured.boxes < 3500, `a complete refresh used ${measured.boxes} bounding-box reads`);
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


test("conversation style feedback settles across cooldowns while fonts, streaming and author changes survive", { timeout: 30000 }, async () => {
  const browser = await chromium.launch();
  try {
    const page = await browser.newPage();
    await prepare(page, conversationHtml(), { settings: { textScale: 120 }, settle: false });
    await page.evaluate(() => document.fonts.ready);
    // Do not wait for pending=false first: the broken implementation never
    // settles. Observe several real cooldowns, including a delayed restart.
    await page.waitForTimeout(1500);
    const before = await page.evaluate(() => __state());
    await page.waitForTimeout(4000);
    const after = await page.evaluate(() => __state());
    assert.equal(after.pending, false, "author restoration must not perpetually queue full-page work");
    assert.equal(after.refreshRevision, before.refreshRevision, "an idle conversation stays idle across cooldowns");
    assert.equal(after.healthy, true);
    const typography = await page.locator("#author-label").evaluate(element => ({
      family: getComputedStyle(element).fontFamily, size: getComputedStyle(element).fontSize
    }));
    assert.match(typography.family, /Lexend/);
    assert.equal(typography.size, "19.2px", "the competing style owner does not remove converted sizing");
    await page.evaluate(() => {
      const clone = document.querySelector("#author-label").cloneNode(true);
      clone.id = "cloned-action";
      document.querySelector("main").append(clone);
    });
    await page.waitForFunction(() => !__state().pending);
    assert.equal(await page.locator("#cloned-action").getAttribute("data-lexend-retained"), null,
      "a clone cannot inherit the contested element's private stylesheet rule");
    assert.equal(await page.locator("#cloned-action").evaluate(e => getComputedStyle(e).fontSize), "19.2px");
    const incoming = await page.evaluate(async () => {
      document.querySelector("main").insertAdjacentHTML("beforeend", '<article id="stream"><p>Incoming reply</p><pre>const preserved = true;</pre></article>');
      await Promise.resolve();
      return getComputedStyle(document.querySelector("#stream p")).fontFamily;
    });
    assert.match(incoming, /Lexend/, "streamed content receives Lexend before scheduled layout work");
    await page.getByRole("textbox", { name: "Message" }).fill("Typing remains responsive");
    await page.evaluate(() => scrollTo(0, 300));
    await page.waitForFunction(() => !__state().pending);
    assert.doesNotMatch(await page.locator("#stream pre").evaluate(e => getComputedStyle(e).fontFamily), /Lexend/);
    const revision = await page.evaluate(() => {
      const revision = __state().refreshRevision;
      __authorStyle = "font-size: 22px; color: rgb(56, 34, 12);";
      document.querySelector("#author-label").style.cssText = __authorStyle;
      return revision;
    });
    await page.waitForFunction(revision => __state().refreshRevision > revision && !__state().pending, revision);
    assert.equal(await page.locator("#author-label").evaluate(e => getComputedStyle(e).fontSize), "26.4px", "genuine author changes still get a new baseline");
    await page.evaluate(() => __update({ enabled: false }));
    const paused = await page.locator("#author-label").evaluate(e => ({ style: e.style.cssText, marker: e.hasAttribute("data-lexend-retained"), family: getComputedStyle(e).fontFamily }));
    assert.equal(paused.style, "font-size: 22px; color: rgb(56, 34, 12);");
    assert.equal(paused.marker, false);
    assert.equal(paused.family, "Arial");
    assert.equal(await page.locator("#cloned-action").getAttribute("style"), "color: rgb(12, 34, 56);");
    await page.evaluate(() => __update({ enabled: true }));
    await page.waitForFunction(() => !__state().pending);
    assert.match(await page.locator("#author-label").evaluate(e => getComputedStyle(e).fontFamily), /Lexend/);
  } finally { await browser.close(); }
});

test("streaming existing text does not repeatedly rediscover the conversation subtree", async () => {
  const browser = await chromium.launch();
  try {
    const page = await browser.newPage();
    await prepare(page, '<!doctype html><style>body{font:16px/24px Arial}</style><main>Streaming status: '
      + '<p>Existing reply</p>'.repeat(200) + '</main>', { inspect: true });
    const result = await page.evaluate(async () => {
      // Hold the repair deadline to isolate synchronous observer work.
      globalThis.__tasks = new Map();
      let id = 0;
      globalThis.setTimeout = callback => { __tasks.set(++id, callback); return id; };
      globalThis.clearTimeout = id => __tasks.delete(id);
      const main = document.querySelector('main');
      const before = __probe.incomingNodes;
      for (let i = 0; i < 100; i++) { main.firstChild.data += 'word '; await Promise.resolve(); }
      const visited = __probe.incomingNodes - before;
      // Replacing a text node is also an existing-font update, but a new
      // element still requires classification before the queued repair.
      main.firstChild.replaceWith(document.createTextNode('Reply completed. '));
      await Promise.resolve();
      const replacedVisits = __probe.incomingNodes - before;
      main.insertAdjacentHTML('beforeend', '<p id="new">New reply <code>const preserved = true;</code></p>');
      await Promise.resolve();
      const family = getComputedStyle(document.querySelector('#new')).fontFamily;
      const code = getComputedStyle(document.querySelector('#new code')).fontFamily;
      const pending = __state().pending;
      __update({ enabled: false });
      return { visited, replacedVisits, family, code, pending, tasks: __tasks.size };
    });
    assert.equal(result.visited, 0, "100 tokens in existing text must not scan all 200 replies 100 times");
    assert.equal(result.replacedVisits, 0);
    assert.match(result.family, /Lexend/);
    assert.doesNotMatch(result.code, /Lexend/);
    assert.equal(result.pending, true, "the final layout repair remains scheduled");
    assert.equal(result.tasks, 0, "pause cancels the outstanding work");
  } finally { await browser.close(); }
});

test("temporary theme declarations coalesce across deliveries without hiding persistent changes", { timeout: 20000 }, async () => {
  const browser = await chromium.launch();
  try {
    const page = await browser.newPage();
    await prepare(page, conversationHtml({ feedback: false }), { settle: false, beforeStart: page => page.evaluate(() => {
      const label = document.querySelector('#author-label');
      // Model a theme observer that recalculates temporary inline variables
      // after typography writes, then restores its final style next frame.
      // Real Dark Reader was also exercised separately by the profiler.
      const observer = new MutationObserver(records => {
        if (!records.some(m => !m.oldValue?.includes('--lexend-family')) || !label.style.getPropertyValue('--lexend-family')) return;
        observer.disconnect();
        label.style.setProperty('--theme-text', '#ddd');
        requestAnimationFrame(() => {
          label.style.removeProperty('--theme-text');
          observer.observe(label, { attributes: true, attributeFilter: ['style'], attributeOldValue: true });
        });
      });
      observer.observe(label, { attributes: true, attributeFilter: ['style'], attributeOldValue: true });
    }) });
    await page.waitForTimeout(1500);
    const revision = await page.evaluate(() => __state().refreshRevision);
    await page.waitForTimeout(3000);
    assert.equal(await page.evaluate(() => __state().refreshRevision), revision);
    assert.equal(await page.evaluate(() => __state().pending), false);
    await page.evaluate(async () => {
      const label = document.querySelector('#author-label');
      label.style.setProperty('--theme-text', '#ddd');
      await Promise.resolve();
      label.style.removeProperty('--theme-text');
      label.style.fontSize = '25px';
    });
    await page.waitForFunction(revision => __state().refreshRevision > revision && !__state().pending, revision);
    assert.equal(await page.locator('#author-label').evaluate(e => getComputedStyle(e).fontSize), '25px');
  } finally { await browser.close(); }
});

test("contested animated typography keeps native baselines across preferences and pause", async () => {
  const browser = await chromium.launch();
  try {
    const page = await browser.newPage();
    await prepare(page, conversationHtml({ turns: 1 }).replace('p {margin:0}', '#author-label {transition:all .2s} p {margin:0}'));
    for (const textScale of [120, 110, 130]) {
      await page.evaluate(textScale => __update({ textScale }), textScale);
      await page.waitForFunction(() => !__state().pending);
      assert.equal(await page.locator('#author-label').evaluate(e => parseFloat(getComputedStyle(e).fontSize)), 16 * textScale / 100);
    }
    await page.evaluate(() => __update({ enabled: false }));
    assert.equal(await page.locator('#author-label').evaluate(e => getComputedStyle(e).fontSize), '16px');
    assert.equal(await page.locator('#author-label').getAttribute('style'), 'color: rgb(12, 34, 56);');
  } finally { await browser.close(); }
});
