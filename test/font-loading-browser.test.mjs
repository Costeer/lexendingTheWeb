import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
import test from "node:test";
import { chromium } from "playwright";

const origin = "http://font-loading.test";
const latin = "assets/fonts/lexend-latin-wght-normal.woff2";
const extended = "assets/fonts/lexend-latin-ext-wght-normal.woff2";
const fixture = `<!doctype html><script>
  globalThis.__fontEvents = [];
  globalThis.__faceIds = new WeakMap();
  globalThis.__nextFaceId = 0;
  globalThis.__faceId = (face) => {
    if (!__faceIds.has(face)) __faceIds.set(face, ++__nextFaceId);
    return __faceIds.get(face);
  };
  document.fonts.addEventListener("loadingdone", (event) => __fontEvents.push({
    trusted: event.isTrusted,
    faces: event.fontfaces.map((face) => ({ id: __faceId(face), family: face.family, status: face.status }))
  }));
</script><style id="author-style">
  @font-face { font-family: "Author Fixture"; src: url("${origin}/author-initial.woff2") format("woff2"); font-weight: 400; font-style: normal; font-display: swap; }
  @layer author {
    body { font: 20px/28px "Author Fixture", sans-serif; margin: 12px; }
    main { width: 340px; }
    p { margin: 0; }
    p.larger { font-size: 24px; }
    #panel { height: 44px; overflow: hidden; }
  }
</style><main id="content" style="padding: 3px;">
  <div id="panel"><p id="prose" style="margin-left: 3px;">A readable author label with enough words to wrap onto another line.</p></div>
  <div id="author-probe" data-lexend-ignore>Āuthor font metrics</div>
  <p id="footer">Following content</p>
</main>`;

const prepare = async (page, { delayed = false, html = fixture } = {}) => {
  const requests = [];
  let releaseFont;
  const blocked = delayed ? new Promise((resolveFont) => { releaseFont = resolveFont; }) : null;
  await page.route(`${origin}/**`, async (route) => {
    const pathname = new URL(route.request().url()).pathname;
    requests.push(pathname);
    if (pathname === "/author-initial.woff2") await blocked;
    const path = pathname === "/author-initial.woff2" ? latin
      : pathname === "/author-replacement.woff2" || pathname === "/author-script.woff2" ? extended
        : pathname.slice(1);
    await route.fulfill({ body: await readFile(resolve(path)), contentType: "font/woff2", headers: { "Access-Control-Allow-Origin": "*" } });
  });
  await page.setContent(html, { waitUntil: "domcontentloaded" });
  await page.evaluate(() => {
    globalThis.__authorMarkup = document.querySelector("main").cloneNode(true);
    globalThis.__initialFontLoad = document.fonts.load('400 20px "Author Fixture"', "A");
    const storage = [], runtime = [];
    globalThis.__settings = { enabled: true, layoutRepair: true, scope: "all", textScale: 120 };
    globalThis.chrome = {
      runtime: {
        getURL: (path) => `http://font-loading.test/${path}`,
        sendMessage: async () => {},
        onMessage: { addListener: (fn) => runtime.push(fn) }
      },
      storage: { sync: { get: async () => __settings }, onChanged: { addListener: (fn) => storage.push(fn) } }
    };
    globalThis.__update = (values) => {
      Object.assign(__settings, values);
      storage.forEach((fn) => fn(Object.fromEntries(Object.entries(values).map(([key, newValue]) => [key, { newValue }])), "sync"));
    };
    globalThis.__state = () => {
      let state;
      runtime.forEach((fn) => fn({ type: "LEXEND_GET_STATE" }, null, (value) => { state = value; }));
      return state;
    };
  });
  if (!delayed) await page.evaluate(() => __initialFontLoad);
  else await page.waitForFunction(() => document.fonts.status === "loading");
  for (const name of ["settings", "adaptive-controls", "adaptive-layout", "refresh-scheduler", "content"]) {
    await page.addScriptTag({ path: resolve(process.env.LEXEND_TEST_SOURCE ?? ".", `src/${name}.js`) });
  }
  return { requests, releaseFont };
};

const settle = async (page, revision = -1, { fonts = true } = {}) => {
  if (fonts) await page.evaluate(() => document.fonts.ready);
  await page.waitForFunction((previous) => {
    const state = __state();
    return state?.ready && state.healthy && state.active && !state.pending && state.refreshRevision > previous;
  }, revision, { timeout: 5_000 });
};

const stablePaints = async (page) => {
  // Several real animation frames span the old font-loading/refresh cycle.
  // Read native FontFace identities and geometry; do not synthesize font events
  // or replace the runtime's scheduler to make the page appear settled.
  const samples = await page.evaluate(async () => {
    const sample = () => ({
      revision: __state().refreshRevision,
      pending: __state().pending,
      faces: [...document.fonts].filter((face) => face.family.replace(/["']/g, "") === "Author Fixture").map(__faceId),
      geometry: ["panel", "prose", "author-probe", "footer"].map((id) => {
        const element = document.getElementById(id), rect = element.getBoundingClientRect();
        return [rect.x, rect.y, rect.width, rect.height, getComputedStyle(element).fontSize];
      })
    });
    const result = [sample()], started = performance.now();
    do {
      await new Promise(requestAnimationFrame);
      result.push(sample());
    } while (performance.now() - started < 700);
    return result;
  });
  assert.ok(samples.length >= 3, "inspect multiple painted frames");
  assert.ok(samples[0].faces.length > 0, "the native CSS FontFace remains registered");
  assert.ok(samples.every((sample) => !sample.pending), "font completion does not perpetually requeue layout work");
  assert.deepEqual([...new Set(samples.map(({ revision }) => revision))], [samples[0].revision], "refresh revision stays stable across font-loading cycles");
  for (const sample of samples) {
    assert.deepEqual(sample.faces, samples[0].faces, "author CSS FontFace objects are not recreated by measurement");
    assert.deepEqual(sample.geometry, samples[0].geometry, "painted layout stops rearranging");
  }
};

test("preloaded author fonts keep their native identities and painted layout settles after real changes", async () => {
  const browser = await chromium.launch({ headless: true });
  try {
    const page = await browser.newPage();
    const { requests } = await prepare(page);
    await settle(page);
    assert.ok(requests.includes("/author-initial.woff2"), "the valid author font was fetched before extension startup");
    assert.equal(await page.locator("#prose").evaluate((element) => getComputedStyle(element).fontSize), "24px");
    await stablePaints(page);
    const before = await page.evaluate(() => __state().refreshRevision);
    await page.evaluate(() => {
      for (const root of [document.querySelector("main"), __authorMarkup]) {
        const prose = root.querySelector("#prose");
        prose.className = "larger";
        prose.append(" Genuine new author text changes the layout.");
      }
    });
    await settle(page, before);
    assert.equal(await page.locator("#prose").evaluate((element) => getComputedStyle(element).fontSize), "28.8px", "the genuine class change is remeasured at 120 percent");
    await stablePaints(page);
    await page.evaluate(() => __update({ enabled: false }));
    await page.waitForFunction(() => !__state().active && !__state().pending);
    assert.equal(await page.locator("main").evaluate((element) => element.outerHTML), await page.evaluate(() => __authorMarkup.outerHTML), "pause restores the exact author DOM including its later class and text changes");
  } finally { await browser.close(); }
});

test("a delayed real author font completion still requests fresh layout metrics", async () => {
  const browser = await chromium.launch({ headless: true });
  try {
    const page = await browser.newPage();
    const { requests, releaseFont } = await prepare(page, { delayed: true });
    await settle(page, -1, { fonts: false });
    const before = await page.evaluate(() => __state().refreshRevision);
    assert.ok(requests.includes("/author-initial.woff2"));
    assert.equal(await page.evaluate(() => [...document.fonts].find((face) => face.family.includes("Author Fixture")).status), "loading");
    releaseFont();
    await page.evaluate(() => __initialFontLoad);
    await settle(page, before);
    assert.ok(await page.evaluate(() => __fontEvents.some((event) => event.trusted && event.faces.some((face) => face.family.includes("Author Fixture") && face.status === "loaded"))), "a native loadingdone event reports the newly decoded author font");
    await stablePaints(page);
  } finally { await browser.close(); }
});

test("same-descriptor author source replacement and script-created FontFace both refresh and settle", async () => {
  const browser = await chromium.launch({ headless: true });
  try {
    const page = await browser.newPage();
    const { requests } = await prepare(page);
    await settle(page);
    const beforeCss = await page.evaluate(() => {
      // CSS rules and FontFace constructors serialize the same family with
      // different quoting; compare its actual name and all metric descriptors.
      globalThis.__descriptors = (face) => [face.family.replace(/["']/g, ""), face.style, face.weight, face.stretch, face.unicodeRange];
      const rule = [...document.querySelector("#author-style").sheet.cssRules].find((rule) => rule instanceof CSSFontFaceRule);
      globalThis.__cssBefore = [...document.fonts].find((face) => face.family.includes("Author Fixture"));
      const revision = __state().refreshRevision;
      rule.style.setProperty("src", 'url("http://font-loading.test/author-replacement.woff2") format("woff2")');
      globalThis.__replacementLoad = document.fonts.load('400 20px "Author Fixture"', "Ā");
      return revision;
    });
    await page.evaluate(() => __replacementLoad);
    await settle(page, beforeCss);
    assert.ok(requests.includes("/author-replacement.woff2"), "CSSOM source replacement actually fetched the distinct valid font");
    const replacement = await page.evaluate(() => {
      const face = [...document.fonts].find((candidate) => candidate.family.includes("Author Fixture"));
      return { before: __descriptors(__cssBefore), after: __descriptors(face), changed: face !== __cssBefore,
        nativeEvent: __fontEvents.some((event) => event.trusted && event.faces.some((entry) => entry.id === __faceId(face) && entry.status === "loaded")) };
    });
    assert.deepEqual(replacement.after, replacement.before, "family and descriptors are unchanged, so they cannot identify immutable author metrics");
    assert.equal(replacement.changed, true, "CSSOM replacement registers a genuinely new native face");
    assert.equal(replacement.nativeEvent, true);
    await stablePaints(page);

    const beforeScript = await page.evaluate(() => {
      const revision = __state().refreshRevision;
      globalThis.__scriptFace = new FontFace("Author Fixture", 'url("http://font-loading.test/author-script.woff2")', { weight: "400", style: "normal" });
      document.fonts.add(__scriptFace);
      globalThis.__scriptLoad = __scriptFace.load();
      return revision;
    });
    await page.evaluate(() => __scriptLoad);
    await settle(page, beforeScript);
    assert.ok(requests.includes("/author-script.woff2"), "the script-created face also fetched a real distinct source URL");
    const script = await page.evaluate(() => ({
      descriptors: __descriptors(__scriptFace), original: __descriptors(__cssBefore),
      present: document.fonts.has(__scriptFace),
      nativeEvent: __fontEvents.some((event) => event.trusted && event.faces.some((entry) => entry.id === __faceId(__scriptFace) && entry.status === "loaded"))
    }));
    assert.deepEqual(script.descriptors, script.original);
    assert.equal(script.present, true);
    assert.equal(script.nativeEvent, true, "the real FontFaceSet event, rather than a DOM edit, requests another measurement");
    await stablePaints(page);
  } finally { await browser.close(); }
});

test("ongoing author animation never paints repaired labels at their unrepaired height", async () => {
  const browser = await chromium.launch({ headless: true });
  try {
    const page = await browser.newPage();
    await prepare(page, { html: `<!doctype html><style>
      body { font: 20px/24px Arial; margin: 12px; }
      #panel { width: 220px; height: 24px; max-height: 24px; overflow: hidden; }
      #label { display: block; }
      #carousel { position: absolute; top: 300px; left: 10px; }
      p { margin: 0; }
    </style><main><div id="panel"><span id="label">Continue reading</span></div>
      <p id="after">Following page content</p><div id="carousel">Independent animated content</div></main>` });
    await settle(page);
    const result = await page.evaluate(async () => {
      const geometry = () => ["panel", "label", "after"].map((id) => {
        const element = document.getElementById(id), box = element.getBoundingClientRect();
        const range = document.createRange();
        range.selectNodeContents(element);
        return { box: [box.x, box.y, box.width, box.height],
          text: [...range.getClientRects()].map((rect) => [rect.x, rect.y, rect.width, rect.height]) };
      });
      const initial = geometry(), repair = document.getElementById("panel").getAttribute("data-lexend-layout-repair");
      const before = __state().refreshRevision, frames = [];
      let ticks = 0;
      const animation = setInterval(() => {
        document.getElementById("carousel").style.transform = `translateX(${++ticks % 17}px)`;
      }, 20);
      const started = performance.now();
      try {
        do {
          await new Promise(requestAnimationFrame);
          frames.push(geometry());
        } while (performance.now() - started < 700);
      } finally { clearInterval(animation); }
      return { initial, repair, frames, ticks, refreshes: __state().refreshRevision - before };
    });
    assert.ok(result.initial[0].box[3] > 24, "the fixture actually requires and receives a height repair");
    assert.match(result.repair ?? "", /expand|wrap/, "the expanded height belongs to the layout repair");
    assert.ok(result.ticks >= 3, "a real author animation continues throughout observation");
    assert.ok(result.refreshes >= 2, "observe multiple genuine refreshes rather than a parked scheduler");
    assert.ok(result.frames.length >= 3);
    for (const frame of result.frames) assert.deepEqual(frame, result.initial, "every painted frame retains repaired label and following-content geometry");
    await settle(page);
  } finally { await browser.close(); }
});
