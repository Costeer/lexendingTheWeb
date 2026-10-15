import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
import test from "node:test";
import { chromium } from "playwright";
import { runtimeScriptPaths } from "../scripts/performance/runtime-resources.mjs";
import { replaceExactlyOnce } from "./helpers/conversation.mjs";

const origin = "http://regional-repair.test";
const sourceRoot = resolve(process.env.LEXEND_TEST_SOURCE ?? ".");
const manifest = JSON.parse(await readFile(resolve(sourceRoot, "manifests/manifest.chrome.json"), "utf8"));
const scriptPaths = runtimeScriptPaths(manifest);
const text = "Read this reply. ";
const addition = "A longer explanation needs several complete lines inside this component. ".repeat(5);
let browser;
test.before(async () => { browser = await chromium.launch({ headless: true }); });
test.after(async () => { await browser?.close(); });

const prepare = async ({ components = 1, unsupported = null, forceFull = false, guardProbe = false } = {}) => {
  const page = await browser.newPage({ viewport: { width: 1280, height: 800 } });
  try {
    await page.route(`${origin}/**`, async (route) => {
      const pathname = new URL(route.request().url()).pathname;
      const path = pathname === "/author-transition.woff2"
        ? "assets/fonts/lexend-latin-wght-normal.woff2" : pathname.slice(1);
      await route.fulfill({ body: await readFile(resolve(sourceRoot, path)), contentType: "font/woff2" });
    });
    await page.setContent(`<!doctype html><style id="author-style">
      body{margin:12px;font:16px/20px Arial}p{margin:0}
      #distant{display:grid;grid-template-columns:repeat(6,180px);gap:8px}
      .distant-clip{height:20px;max-height:20px;overflow:hidden}
      .distant-text{display:block}.larger .distant-text{font-size:24px}
      .component{display:block;position:relative;width:300px;height:200px;
        contain:strict;overflow:auto;font:16px/20px Arial;margin-top:12px}
    </style><main id="distant">${Array.from({ length: 60 }, (_, i) =>
      `<section class="distant-clip"><p class="distant-text" id="distant-${i}">Readable label number ${i} with a complete explanation.</p></section>`).join("")}</main>
    ${Array.from({ length: components }, (_, i) => `<div class="component" id="component-${i}"></div>`).join("")}`);
    await page.evaluate(({ components, unsupported, text }) => {
      globalThis.__roots = [];
      for (let i = 0; i < components; i++) {
        const host = document.getElementById(`component-${i}`);
        const root = host.attachShadow({ mode: "open" });
        root.innerHTML = `<style id="component-author-style">p{margin:0}#clip{height:20px;max-height:20px;overflow:hidden}
          #stream{display:block}</style><section id="clip"><p id="stream">${text}</p></section>`;
        if (unsupported === "containment") host.style.contain = "layout paint";
        if (unsupported === "slot") root.append(document.createElement("slot"));
        if (unsupported === "nested-shadow") {
          const nested = document.createElement("div");
          root.append(nested);
          nested.attachShadow({ mode: "open" }).innerHTML = "<p>Nested reply</p>";
        }
        if (unsupported === "editor") {
          const editor = document.createElement("div");
          editor.contentEditable = "true";
          editor.textContent = "Author editor";
          root.append(editor);
        }
        if (unsupported === "dir-auto") host.dir = "auto";
        if (unsupported === "light-child") host.append(document.createElement("span"));
        __roots.push(root);
      }
      if (unsupported === "managed-ancestor") document.body.prepend(document.createTextNode("Owned body text. "));
      if (unsupported === "protected") {
        const code = document.createElement("pre");
        code.textContent = "const preserved = true;";
        __roots[0].append(code);
      }
      globalThis.__authorBody = document.body.cloneNode(true);
      globalThis.__authorRoots = __roots.map((root) => {
        const fragment = document.createDocumentFragment();
        fragment.append(...[...root.childNodes].map((node) => node.cloneNode(true)));
        return fragment;
      });
      const storage = [], runtime = [];
      globalThis.__settings = { enabled: true, scope: "all", textScale: 120 };
      globalThis.chrome = {
        runtime: { getURL: (path) => `${location.protocol === "http:" ? location.origin : "http://regional-repair.test"}/${path}`,
          sendMessage: async () => {}, onMessage: { addListener: (fn) => runtime.push(fn) } },
        storage: { sync: { get: async () => __settings }, onChanged: { addListener: (fn) => storage.push(fn) } }
      };
      globalThis.__update = (patch) => {
        Object.assign(__settings, patch);
        storage.forEach((fn) => fn(Object.fromEntries(Object.entries(patch).map(([key, newValue]) => [key, { newValue }])), "sync"));
      };
      globalThis.__state = () => {
        let value;
        runtime.forEach((fn) => fn({ type: "LEXEND_GET_STATE" }, null, (state) => { value = state; }));
        return value;
      };
      const style = getComputedStyle.bind(globalThis), box = Element.prototype.getBoundingClientRect;
      const rects = Element.prototype.getClientRects, rangeRects = Range.prototype.getClientRects;
      globalThis.__native = { style, box, rects, rangeRects };
      globalThis.__reads = { styles: 0, boxes: 0, rects: 0, ranges: 0 };
      const distant = (node) => {
        const element = node instanceof Element ? node : node?.parentElement;
        return !!element?.closest("#distant");
      };
      globalThis.getComputedStyle = function (element, ...args) {
        if (distant(element)) __reads.styles++;
        return style.call(this, element, ...args);
      };
      Element.prototype.getBoundingClientRect = function () {
        if (distant(this)) __reads.boxes++;
        return box.call(this);
      };
      Element.prototype.getClientRects = function () {
        if (distant(this)) __reads.rects++;
        return rects.call(this);
      };
      Range.prototype.getClientRects = function () {
        if (distant(this.commonAncestorContainer)) __reads.ranges++;
        return rangeRects.call(this);
      };
      globalThis.__resetReads = () => { for (const key of Object.keys(__reads)) __reads[key] = 0; };
      globalThis.__distantGeometry = () => [0, 1, 30, 59].map((i) => {
        const element = document.getElementById(`distant-${i}`), parent = element.parentElement;
        return [parent, element].map((item) => {
          const b = __native.box.call(item);
          return [b.x, b.y, b.width, b.height];
        });
      });
      globalThis.__append = (index, value) => {
        __roots[index].querySelector("#stream").firstChild.data += value;
        __authorRoots[index].querySelector("#stream").firstChild.data += value;
      };
      globalThis.__inspectRoot = (index) => {
        const root = __roots[index], clip = root.querySelector("#clip"), stream = root.querySelector("#stream");
        const b = __native.box.call(clip), range = document.createRange();
        range.selectNodeContents(stream);
        return { clip: b.toJSON(), text: [...__native.rangeRects.call(range)].map((r) => r.toJSON()),
          family: __native.style(stream).fontFamily, size: __native.style(stream).fontSize,
          marker: clip.getAttribute("data-lexend-layout-repair"),
          content: stream.textContent, hostStyle: root.host.getAttribute("style") };
      };
    }, { components, unsupported, text });
    for (const path of scriptPaths) {
      let source = await readFile(resolve(sourceRoot, path), "utf8");
      if (forceFull && path === "src/content.js") {
        source = replaceExactlyOnce(source,
          "    const regionalRoots = regionalMutationRoots(needsRefresh);",
          "    const regionalRoots = null;", "forced full routing regional negative control");
      }
      await page.addScriptTag({ content: source });
      if (guardProbe && path === "src/adaptive-layout.js") await page.evaluate(() => {
        const controls = LexendControls;
        globalThis.__guardAttempts = 0;
        globalThis.__guardArmed = false;
        globalThis.LexendControls = { ...controls, repair(context) {
          controls.repair(context);
          if (__guardArmed) {
            __guardArmed = false;
            __guardAttempts++;
            context.write(document.querySelector("#distant-0"), "min-height", "77px", "test-outside-write");
          }
        } };
      });
    }
    await page.evaluate(() => document.fonts.ready);
    await page.waitForFunction(() => __state()?.healthy && !__state().pending);
    const initial = await page.evaluate(() => ({ reads: { ...__reads }, roots: __roots.map((_, i) => __inspectRoot(i)),
      distant: __distantGeometry(), state: __state() }));
    assert.ok(initial.reads.styles > 0 && initial.reads.boxes > 0 && initial.reads.ranges > 0,
      "initial global repair must exercise each distant work counter");
    await page.evaluate(() => __resetReads());
    return { page, initial };
  } catch (error) { await page.close(); throw error; }
};

const settleAfter = (page, revision) => page.waitForFunction((previous) => {
  const state = __state();
  return state?.healthy && !state.pending && state.refreshRevision > previous;
}, revision, { timeout: 10_000 });
const inspect = (page) => page.evaluate(() => ({ reads: { ...__reads }, roots: __roots.map((_, i) => __inspectRoot(i)),
  distant: __distantGeometry(), state: __state() }));
const assertLocalWork = (result) => assert.deepEqual(result.reads, { styles: 0, boxes: 0, rects: 0, ranges: 0 },
  "an eligible regional repair must not measure the unrelated repaired page");
const assertExpanded = (result, before) => {
  assert.match(result.family, /Lexend/);
  assert.equal(result.size, "19.2px");
  assert.ok(result.clip.height > before.clip.height + 20, "the edit requires a real new clipping repair");
  assert.ok(result.text.length >= 3, "the changed text actually wraps onto multiple native lines");
  for (const box of result.text) assert.ok(box.top >= result.clip.top - 2 && box.bottom <= result.clip.bottom + 2,
    "all changed text remains inside its repaired clipping surface");
};
const assertRestored = async (page) => {
  await page.evaluate(() => __update({ enabled: false }));
  await page.waitForFunction(() => !__state().active && !__state().pending);
  const restored = await page.evaluate(() => ({ body: document.body.innerHTML, expectedBody: __authorBody.innerHTML,
    roots: __roots.map((root) => root.innerHTML), expectedRoots: __authorRoots.map((root) => {
      const container = document.createElement("div");
      container.append(root.cloneNode(true));
      return container.innerHTML;
    }) }));
  assert.equal(restored.body, restored.expectedBody, "pause restores exact author light DOM and style priorities");
  assert.deepEqual(restored.roots, restored.expectedRoots, "pause restores exact authored shadow contents after regional repair");
};

test("an isolated changed region repairs new clipping without measuring or repainting unrelated repairs", async () => {
  const { page, initial } = await prepare();
  try {
    await page.evaluate((value) => {
      globalThis.__painted = [];
      globalThis.__watchPaints = true;
      const sample = () => {
        __painted.push(__distantGeometry());
        if (__watchPaints) requestAnimationFrame(sample);
      };
      requestAnimationFrame(sample);
      __append(0, value);
    }, addition);
    await settleAfter(page, initial.state.refreshRevision);
    await page.evaluate(() => new Promise((done) => requestAnimationFrame(() => requestAnimationFrame(done))));
    const result = await inspect(page);
    assertExpanded(result.roots[0], initial.roots[0]);
    assertLocalWork(result);
    assert.deepEqual(result.distant, initial.distant);
    const paints = await page.evaluate(() => { __watchPaints = false; return __painted; });
    assert.ok(paints.length >= 3, "observe actual painted frames throughout the queued repair");
    for (const paint of paints) assert.deepEqual(paint, initial.distant, "existing repairs never paint at their unrepaired geometry");
    await assertRestored(page);
  } finally { await page.close(); }
});

test("the regional work assertion rejects an actual forced full-refresh control", async () => {
  const { page, initial } = await prepare({ forceFull: true });
  try {
    await page.evaluate((value) => __append(0, value), addition);
    await settleAfter(page, initial.state.refreshRevision);
    const result = await inspect(page);
    assertExpanded(result.roots[0], initial.roots[0]);
    assert.ok(result.reads.styles > 0 && result.reads.boxes > 0 && result.reads.ranges > 0,
      "the control actually performs distant baseline and geometry work");
    assert.throws(() => assertLocalWork(result), { name: "AssertionError" },
      "the unchanged work assertion must fail for full routing, not a script or settlement error");
    await assertRestored(page);
  } finally { await page.close(); }
});

test("two eligible shadow regions coalesce while retaining independent ownership and exact restoration", async () => {
  const { page, initial } = await prepare({ components: 2 });
  try {
    await page.evaluate((value) => { __append(0, value); __append(1, value); }, addition);
    await settleAfter(page, initial.state.refreshRevision);
    const first = await inspect(page);
    first.roots.forEach((root, i) => assertExpanded(root, initial.roots[i]));
    assertLocalWork(first);
    await page.evaluate((value) => { __resetReads(); __append(1, value); }, addition);
    await settleAfter(page, first.state.refreshRevision);
    const second = await inspect(page);
    assertLocalWork(second);
    assert.deepEqual(second.roots[0], first.roots[0], "repairing another region preserves the first region's repaired state");
    assert.ok(second.roots[1].clip.height > first.roots[1].clip.height);
    await assertRestored(page);
  } finally { await page.close(); }
});

test("a mixed local edit and global author mutation cannot downgrade the pending global refresh", async () => {
  for (const localFirst of [true, false]) {
    const { page, initial } = await prepare();
    try {
      await page.evaluate(({ value, localFirst }) => {
        const author = () => {
          document.querySelector("#distant").classList.add("larger");
          __authorBody.querySelector("#distant").classList.add("larger");
        };
        if (localFirst) { __append(0, value); author(); }
        else { author(); __append(0, value); }
      }, { value: addition, localFirst });
      await settleAfter(page, initial.state.refreshRevision);
      const result = await inspect(page);
      assert.ok(result.reads.styles > 0 && result.reads.ranges > 0, "mixed mutations require the full-page fallback");
      assert.equal(await page.evaluate(() => __native.style(document.querySelector("#distant-0")).fontSize), "28.8px");
      assertExpanded(result.roots[0], initial.roots[0]);
      await assertRestored(page);
    } finally { await page.close(); }
  }
});

test("unsupported containment, slots, roots, light children, editors and inherited owners use the global path", async () => {
  for (const unsupported of ["containment", "slot", "nested-shadow", "light-child", "editor", "dir-auto", "managed-ancestor", "protected"]) {
    const { page, initial } = await prepare({ unsupported });
    try {
      await page.evaluate((value) => __append(0, value), addition);
      await settleAfter(page, initial.state.refreshRevision);
      const result = await inspect(page);
      assert.ok(result.reads.styles > 0 && result.reads.ranges > 0,
        `${unsupported} must retain conservative global invalidation`);
      assert.equal(result.state.healthy, true);
      if (unsupported === "editor") assert.equal(await page.evaluate(() => __roots[0].querySelector("[contenteditable]").outerHTML),
        '<div contenteditable="true">Author editor</div>');
      if (unsupported === "protected") assert.doesNotMatch(await page.evaluate(() => __native.style(__roots[0].querySelector("pre")).fontFamily), /Lexend/);
      await assertRestored(page);
    } finally { await page.close(); }
  }
});

test("host typography, CSSOM, viewport, settings and real font invalidations supersede local work", async () => {
  for (const invalidation of ["host-font", "stylesheet", "shadow-stylesheet", "owned-stylesheet", "resize", "settings", "font"]) {
    const { page, initial } = await prepare();
    try {
      await page.evaluate(({ value, invalidation }) => {
        __append(0, value);
        if (invalidation === "host-font") {
          __roots[0].host.style.setProperty("font-size", "24px", "important");
          __authorBody.querySelector("#component-0").style.setProperty("font-size", "24px", "important");
        }
        // CSSOM writes have no DOM MutationRecord. Regional eligibility must
        // still notice that the author metrics have changed elsewhere.
        if (invalidation === "stylesheet") {
          const sheet = document.querySelector("#author-style").sheet;
          sheet.insertRule(".distant-text{font-size:25px}", sheet.cssRules.length);
        }
        if (invalidation === "shadow-stylesheet") {
          const sheet = __roots[0].querySelector("#component-author-style").sheet;
          sheet.insertRule("#stream{font-size:21px}", sheet.cssRules.length);
        }
        if (invalidation === "owned-stylesheet") {
          // The page can access an extension-owned style element. Its ID is
          // not evidence that the CSSOM is unchanged or still extension-only.
          const sheet = document.querySelector("#lexend-the-web-styles").sheet;
          sheet.insertRule(".distant-text{font-size:25px!important}", sheet.cssRules.length);
        }
        if (invalidation === "settings") __update({ textScale: 130 });
        if (invalidation === "font") {
          const face = new FontFace("Regional Author", 'url("http://regional-repair.test/author-transition.woff2")');
          globalThis.__fontCompleted = false;
          document.fonts.addEventListener("loadingdone", (event) => {
            if (event.isTrusted && event.fontfaces.includes(face) && face.status === "loaded") __fontCompleted = true;
          });
          document.fonts.add(face);
          globalThis.__authorFontLoad = face.load();
        }
      }, { value: addition, invalidation });
      if (invalidation === "resize") await page.setViewportSize({ width: 1260, height: 780 });
      if (invalidation === "font") await page.evaluate(() => __authorFontLoad);
      await settleAfter(page, initial.state.refreshRevision);
      if (invalidation === "font") await page.waitForFunction(() => __fontCompleted && __reads.styles > 0 && !__state().pending);
      const result = await inspect(page);
      assert.ok(result.reads.styles > 0 && result.reads.ranges > 0, `${invalidation} must force a full refresh`);
      if (invalidation === "settings") assert.equal(result.roots[0].size, "20.8px");
      if (invalidation === "host-font") assert.equal(result.roots[0].size, "28.8px");
      if (invalidation === "stylesheet") assert.equal(await page.evaluate(() => __native.style(document.querySelector("#distant-0")).fontSize), "30px");
      if (invalidation === "shadow-stylesheet") assert.equal(result.roots[0].size, "25.2px");
      if (invalidation === "owned-stylesheet") {
        assert.equal(await page.evaluate(() => __native.style(document.querySelector("#distant-0")).fontSize), "30px");
        assert.ok(result.distant[0][0][3] > initial.distant[0][0][3] + 20,
          "the global fallback repairs the unrelated surface using its new author font metrics");
      }
      await assertRestored(page);
    } finally { await page.close(); }
  }
});

test("pausing a queued region and entering an editor release every prior ownership group", async () => {
  const { page, initial } = await prepare({ components: 2 });
  try {
    await page.evaluate((value) => { __append(0, value); __append(1, value); }, addition);
    await settleAfter(page, initial.state.refreshRevision);
    await page.evaluate((value) => {
      __append(0, value);
      __roots[1].querySelector("#clip").contentEditable = "true";
      __authorRoots[1].querySelector("#clip").contentEditable = "true";
    }, addition);
    await page.waitForFunction(() => !__state().pending
      && !__roots[1].querySelector("#stream").hasAttribute("data-lexend-font"));
    assert.equal(await page.evaluate(() => __roots[1].querySelector("#clip").outerHTML),
      await page.evaluate(() => __authorRoots[1].querySelector("#clip").outerHTML),
      "newly editable markup serializes with its exact author styles and text");
    await page.evaluate((value) => __append(0, value), addition);
    await assertRestored(page);
  } finally { await page.close(); }
});

test("a regional attempt that writes outside its boundary falls back and remains fully restorable", async () => {
  const { page, initial } = await prepare({ guardProbe: true });
  try {
    await page.evaluate((value) => { __guardArmed = true; __append(0, value); }, addition);
    await settleAfter(page, initial.state.refreshRevision);
    const result = await inspect(page);
    assert.equal(await page.evaluate(() => __guardAttempts), 1, "the test actually attempts the unsafe cross-boundary write");
    assert.ok(result.reads.styles > 0 && result.reads.ranges > 0, "the rejected write must trigger the complete fallback");
    assert.equal(await page.locator("#distant-0").evaluate((element) => element.style.minHeight), "",
      "the rejected regional write never reaches the unrelated author element");
    assertExpanded(result.roots[0], initial.roots[0]);
    await assertRestored(page);
  } finally { await page.close(); }
});
