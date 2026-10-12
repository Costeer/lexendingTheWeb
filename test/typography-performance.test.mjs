import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
import test from "node:test";
import { chromium } from "playwright";

const prepare = async (page, html) => {
  await page.route("http://performance.test/**", async (route) => {
    await route.fulfill({ body: await readFile(resolve(`.${new URL(route.request().url()).pathname}`)), contentType: "font/woff2" });
  });
  await page.setContent(html);
  await page.evaluate(() => {
    const storage = [], runtime = [];
    globalThis.__settings = { enabled: true, scope: "all", textScale: 100 };
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
  });
  for (const name of ["settings", "adaptive-controls", "adaptive-layout", "content"]) await page.addScriptTag({ path: resolve(`src/${name}.js`) });
  await page.evaluate(() => document.fonts.ready);
  await page.waitForFunction(() => __state()?.healthy && !__state().pending);
};

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

test("size-observed navigation and its overflow menu keep a stable hidden footprint", async () => {
  const browser = await chromium.launch({ headless: true });
  try {
    const page = await browser.newPage();
    await prepare(page, `<!doctype html><style>
      body {font:16px/20px Arial} nav {display:flex;height:40px}
      .nav-item {display:flex;align-items:center;height:32px;box-sizing:border-box;padding:6px}
      .nav-item[aria-hidden] {visibility:hidden}
    </style><nav><a class="nav-item" href="#content"><span>Repository</span></a></nav>
    <div id="menu"></div><main id="content">Page content</main>
    <script>
      const item = document.querySelector('.nav-item');
      globalThis.__navObserver = new ResizeObserver(() => {
        const overflow = item.getBoundingClientRect().height > 33;
        if (item.hasAttribute('aria-hidden') === overflow) return;
        item.toggleAttribute('aria-hidden', overflow);
        document.querySelector('#menu').innerHTML = overflow ? '<button>Repository menu item</button>' : '';
      });
      __navObserver.observe(item);
    </script>`);
    await page.evaluate(() => __update({ textScale: 120 }));
    await page.waitForFunction(() => !__state().pending && document.querySelector('.nav-item').hasAttribute('aria-hidden')
      && document.querySelector('#menu button')?.hasAttribute('data-lexend-text'));
    const revision = await page.evaluate(() => __state().refreshRevision);
    await page.waitForTimeout(500);
    assert.equal(await page.evaluate(() => __state().refreshRevision), revision, "hidden links must not alternate between native and repaired heights");
    const height = await page.locator('.nav-item').evaluate(element => element.getBoundingClientRect().height);
    await page.locator('#menu button').click();
    await page.evaluate(() => { document.querySelector('main').innerHTML = '<p>New page content after a click</p>'; });
    await page.waitForFunction(() => !__state().pending && document.querySelector('main p').hasAttribute('data-lexend-text'));
    const clickedRevision = await page.evaluate(() => __state().refreshRevision);
    await page.waitForTimeout(500);
    assert.equal(await page.evaluate(() => __state().refreshRevision), clickedRevision, "menu clicks and page changes settle without restarting navigation measurement");
    assert.equal(await page.locator('.nav-item').evaluate(element => element.getBoundingClientRect().height), height);
    await page.evaluate(() => __update({ enabled: false }));
    await page.waitForFunction(() => !document.querySelector('.nav-item').hasAttribute('aria-hidden'));
    assert.equal(await page.locator('.nav-item').getAttribute('style'), null, "pause restores even retained hidden repairs");
    assert.equal(await page.locator('.nav-item').evaluate(element => element.getBoundingClientRect().height), 32);
    assert.equal(await page.evaluate(() => __state().healthy), true);
  } finally { await browser.close(); }
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
      return { firstDelay, pending, during, captures, final, converted, paused: __state(), tasks: tasks.size };
    });
    assert.ok(result.firstDelay >= 400, "urgent text must respect the measured expensive-refresh budget");
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
