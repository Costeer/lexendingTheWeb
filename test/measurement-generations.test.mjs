import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import { chromium } from "playwright";
import { replaceExactlyOnce } from "./helpers/conversation.mjs";

const source = await readFile(new URL("../src/adaptive-layout.js", import.meta.url), "utf8");
const controls = await readFile(new URL("../src/adaptive-controls.js", import.meta.url), "utf8");
const invalidation = "if (measurements) measurements = freshMeasurements();";
const exposed = (kind = "candidate") => {
  let value = source;
  if (kind === "live-snapshot") value = replaceExactlyOnce(value,
    "fontSize: parseFloat(style.fontSize) || 16, font: style.font,",
    "get fontSize() { return parseFloat(style.fontSize) || 16; }, font: style.font,", "unsafe live snapshot font");
  if (kind === "same-generation") value = replaceExactlyOnce(value, invalidation,
    "if (measurements) Object.assign(measurements, freshMeasurements());", "unsafe retained generation");
  if (kind === "stale") value = replaceExactlyOnce(value, invalidation, "", "unsafe stale measurements");
  if (kind === "no-table-invalidation") value = replaceExactlyOnce(value,
    "table.before(viewport); viewport.append(table);\n          invalidateMeasurements();",
    "table.before(viewport); viewport.append(table);", "unsafe table insertion");
  return replaceExactlyOnce(value, "    const capture = (roots, options) =>",
    `    globalThis.__measure = { withMeasurements, snapshot, styleFor, paintStyleFor, boxFor,
      hasBox, directTextRects, containedRects, write, mark, editorOwned, repairTables,
      generation: () => measurements, baseline: () => baseline };
    const capture = (roots, options) =>`, "test-only measurement closure");
};
let browser;
test.before(async () => { browser = await chromium.launch({ headless: true }); });
test.after(async () => { await browser?.close(); });

const pageFor = async (html, kind = "candidate") => {
  const page = await browser.newPage({ viewport: { width: 800, height: 600 } });
  await page.setContent(html);
  await page.addScriptTag({ content: controls });
  await page.addScriptTag({ content: exposed(kind) });
  await page.evaluate(() => { globalThis.layout = LexendLayout.create(); });
  return page;
};

const dependencies = async (kind) => {
  const page = await pageFor(`<style>
    body{margin:0;font:16px/20px Arial}#trigger{height:20px}
    #mask{width:220px;height:10px}#text{position:relative;top:30px;width:200px;height:20px}
    body:has(#trigger[data-ready=yes]) #text{width:70px}
    #mask[data-clip=yes]{overflow:hidden}
  </style><div id="trigger"></div><div id="mask"><div id="text">Readable glyphs</div></div>`, kind);
  try {
    return await page.evaluate(() => {
      const original = document.body.innerHTML, ids = [];
      const result = __measure.withMeasurements(() => {
        const trigger = document.querySelector("#trigger"), mask = document.querySelector("#mask"), text = document.querySelector("#text");
        const before = __measure.snapshot(text); ids.push(__measure.generation());
        __measure.write(trigger, "height", "70px", "sibling");
        const sibling = __measure.snapshot(text); ids.push(__measure.generation());
        __measure.mark(trigger, "data-ready", "yes");
        const has = __measure.snapshot(text); ids.push(__measure.generation());
        __measure.mark(mask, "data-clip", "yes");
        const clipped = __measure.snapshot(text); ids.push(__measure.generation());
        const escape = __measure.snapshot(text, true);
        return { generationCount: new Set(ids).size, topDelta: sibling.box.top - before.box.top,
          beforeWidth: sibling.box.width, afterWidth: has.box.width, clipped: clipped === null, escape: escape !== null };
      });
      layout.restore();
      return { ...result, restored: document.body.innerHTML === original };
    });
  } finally { await page.close(); }
};
const assertDependencies = (result) => {
  assert.equal(result.topDelta, 50, "sibling geometry must refresh after the style write");
  assert.equal(result.beforeWidth, 200);
  assert.equal(result.afterWidth, 70, ":has marker geometry must refresh");
  assert.equal(result.clipped, true, "ancestor clipping must refresh");
  assert.equal(result.escape, true);
  assert.equal(result.restored, true);
  assert.equal(result.generationCount, 4, "each intervening write needs a distinct generation identity");
};
test("style, :has marker and clipping writes refresh geometry and generation identity", async () => {
  assertDependencies(await dependencies("candidate"));
  const sameGeneration = await dependencies("same-generation"), stale = await dependencies("stale");
  assert.throws(() => assertDependencies(sameGeneration), /distinct generation identity/);
  assert.throws(() => assertDependencies(stale), /sibling geometry/);
});

test("cache scopes retain null snapshots, separate escape modes, per-element pseudo styles and editor ownership", async () => {
  const page = await pageFor(`<style>
    #fixed{position:fixed;top:700px}#first::before{content:'before'}#first::after{content:'after'}
    #second::before{content:'other'}#hidden{display:none}
  </style><div id="fixed">Offscreen text</div><div id="first">Direct text</div><div id="second">Other text</div><div id="hidden">Hidden</div>`);
  try {
    const result = await page.evaluate(() => {
      layout.capture();
      const checks = [], expect = (condition, message) => { if (!condition) throw new Error(message); checks.push(message); };
      const fixed = document.querySelector("#fixed"), first = document.querySelector("#first"), second = document.querySelector("#second");
      let visibility = 0;
      fixed.checkVisibility = () => { visibility++; return true; };
      expect(__measure.generation() === null, "outside scope has no generation");
      expect(__measure.boxFor(first) !== __measure.boxFor(first), "outside boxes are uncached");
      expect(__measure.directTextRects(first) !== __measure.directTextRects(first), "outside text is uncached");
      expect(__measure.snapshot(first) !== __measure.snapshot(first), "outside snapshots are uncached");
      __measure.withMeasurements(() => {
        const generation = __measure.generation();
        expect(__measure.snapshot(fixed) === null && __measure.snapshot(fixed) === null && visibility === 1, "null snapshot cached");
        const escape = __measure.snapshot(fixed, true);
        expect(escape !== null && __measure.snapshot(fixed, true) === escape && visibility === 2, "escape mode has separate cached snapshot");
        expect(__measure.boxFor(first) === __measure.boxFor(first), "boxes cached");
        expect(__measure.directTextRects(first) === __measure.directTextRects(first), "direct text cached");
        expect(__measure.containedRects(first) === __measure.containedRects(first), "contained text cached");
        expect(__measure.containedRects(first).length > 0, "contained cache measures actual text");
        expect(__measure.containedRects(first, true) !== __measure.containedRects(first, true), "native contained text bypasses cache");
        expect(__measure.paintStyleFor(first) === __measure.paintStyleFor(first), "paint properties cached");
        let boxChecks = 0;
        const hidden = document.querySelector("#hidden"); hidden.getClientRects = () => { boxChecks++; return []; };
        expect(!__measure.hasBox(hidden) && !__measure.hasBox(hidden) && boxChecks === 1, "false box visibility cached");
        expect(__measure.styleFor(first, "::before") === __measure.styleFor(first, "::before"), "pseudo style cached");
        expect(__measure.styleFor(first, "::before").content === '"before"' && __measure.styleFor(first, "::after").content === '"after"'
          && __measure.styleFor(second, "::before").content === '"other"', "pseudo maps separate elements and modes");
        expect(__measure.generation() === generation, "reads preserve generation identity");
        const outerBox = __measure.boxFor(first);
        expect(!__measure.editorOwned(first), "initial editor classification");
        first.contentEditable = "true";
        __measure.mark(second, "data-scope", "one");
        expect(!__measure.editorOwned(first), "writes preserve editor ownership cache");
        const outer = __measure.generation();
        try {
          __measure.withMeasurements(() => {
            expect(__measure.generation() !== outer, "nested scope has fresh identity");
            expect(__measure.boxFor(first) !== outerBox, "nested geometry separate");
            expect(__measure.editorOwned(first), "nested entry resets editor ownership");
            throw new Error("expected nested exception");
          });
        } catch (error) { if (error.message !== "expected nested exception") throw error; }
        expect(__measure.generation() === outer, "exception restores previous generation");
        first.contentEditable = "false";
        expect(__measure.editorOwned(first), "nested exit retains existing editor lifetime");
      });
      expect(__measure.generation() === null, "outer exit restores no-cache state");
      __measure.withMeasurements(() => expect(!__measure.editorOwned(first), "new scope resets editor classification"));
      layout.dispose();
      expect(__measure.generation() === null, "dispose clears measurements");
      return checks;
    });
    assert.ok(result.length >= 20);
  } finally { await page.close(); }
});

const tableInsertion = async (kind) => {
  const page = await pageFor(`<style>table{width:200px}table.wide{width:1100px}td{white-space:nowrap}</style>
    <table><tr><td>Readable table content</td></tr></table>`, kind);
  try {
    return await page.evaluate(() => {
      const table = document.querySelector("table"), original = document.body.innerHTML;
      layout.capture(); table.className = "wide";
      const before = Element.prototype.before, tabIndex = Object.getOwnPropertyDescriptor(HTMLElement.prototype, "tabIndex");
      let generationBeforeInsertion, changedBeforeAnyWrapperStyle = false;
      Element.prototype.before = function (...nodes) {
        if (this === table) generationBeforeInsertion = __measure.generation();
        return before.apply(this, nodes);
      };
      Object.defineProperty(HTMLElement.prototype, "tabIndex", { ...tabIndex, set(value) {
        if (this.contains(table)) changedBeforeAnyWrapperStyle = generationBeforeInsertion !== __measure.generation();
        return tabIndex.set.call(this, value);
      } });
      try { __measure.withMeasurements(__measure.repairTables); }
      finally {
        Element.prototype.before = before;
        Object.defineProperty(HTMLElement.prototype, "tabIndex", tabIndex);
      }
      const inserted = table.parentElement !== document.body;
      layout.restore(); table.removeAttribute("class");
      return { inserted, changedBeforeAnyWrapperStyle, restored: document.body.innerHTML === original };
    });
  } finally { await page.close(); }
};
test("table insertion invalidates before later style writes can hide its missing generation change", async () => {
  const candidate = await tableInsertion("candidate"), unsafe = await tableInsertion("no-table-invalidation");
  assert.deepEqual(candidate, { inserted: true, changedBeforeAnyWrapperStyle: true, restored: true });
  assert.deepEqual(unsafe, { inserted: true, changedBeforeAnyWrapperStyle: false, restored: true });
});

const glyphs = async (skipRepair = false) => {
  const page = await pageFor(`<style>body{font:16px/20px Arial}article{width:160px;height:40px;overflow:hidden}p{margin:0}
    pre{font:14px/20px monospace}.icon{font-family:monospace}</style><article><p>Native readable glyphs become larger.</p></article>
    <pre><code>const native = '→ ✓';</code></pre><span class="icon" aria-hidden="true">↗</span><div contenteditable="true">Native editor</div>`);
  try {
    return await page.evaluate((skipRepair) => {
      const view = () => [...document.querySelectorAll("p,code,.icon,[contenteditable]")].map(element => {
        const css = getComputedStyle(element), range = document.createRange(); range.selectNodeContents(element);
        return { text: element.textContent, font: css.fontFamily, size: css.fontSize, box: range.getBoundingClientRect().toJSON() };
      });
      const native = view(), original = document.body.innerHTML;
      layout.capture();
      const typography = document.createElement("style"); typography.textContent = "p{font-size:24px;line-height:32px}"; document.head.append(typography);
      if (!skipRepair) layout.repair();
      const repaired = view();
      const article = document.querySelector("article"), range = document.createRange(); range.selectNodeContents(article.querySelector("p"));
      const geometry = { box: article.getBoundingClientRect().toJSON(), text: range.getBoundingClientRect().toJSON(),
        scrollHeight: article.scrollHeight, clientHeight: article.clientHeight };
      layout.restore(); typography.remove();
      return { native, repaired, geometry, restored: view(), exactMarkup: document.body.innerHTML === original };
    }, skipRepair);
  } finally { await page.close(); }
};
test("measurement scopes preserve native glyphs, repair geometry and exact restoration", async () => {
  const candidate = await glyphs(), unrepaired = await glyphs(true);
  const assertReadingGeometry = ({ geometry }) => {
    assert.ok(geometry.text.bottom <= geometry.box.bottom + 1, "enlarged reading glyphs remain clipped");
    assert.ok(geometry.scrollHeight <= geometry.clientHeight + 1, "enlarged reading glyphs have unreachable overflow");
  };
  assertReadingGeometry(candidate);
  assert.throws(() => assertReadingGeometry(unrepaired), /clipped|unreachable/, "the same geometry assertion rejects omitted repair");
  assert.deepEqual(candidate.restored, candidate.native);
  const glyphShape = values => values.slice(1).map(({ text, font, size, box }) => ({ text, font, size, width: box.width, height: box.height }));
  assert.deepEqual(glyphShape(candidate.repaired), glyphShape(candidate.native), "protected native glyphs keep typography and dimensions");
  assert.equal(candidate.repaired[0].size, "24px");
  assert.equal(candidate.exactMarkup, true);
});

const retainedValues = async (kind) => {
  const page = await pageFor(`<style>
    #text{position:relative;top:7px;height:24px;width:240px;font:16px/20px Arial;color:rgb(10,20,30);transform:none}
  </style><div id="text">Historical snapshot text</div>`, kind);
  try {
    return await page.evaluate(() => {
      const element = document.querySelector("#text"), original = document.body.innerHTML;
      layout.capture();
      const baseline = __measure.baseline().get(element);
      const result = __measure.withMeasurements(() => {
        const retained = __measure.snapshot(element);
        const generation = __measure.generation();
        __measure.write(element, "top", "31px", "history");
        __measure.write(element, "height", "48px", "history");
        __measure.write(element, "font-size", "28px", "history");
        __measure.write(element, "color", "rgb(80, 90, 100)", "history");
        __measure.write(element, "transform", "translateX(3px)", "history");
        // Deliberately read historical fields for the first time after writes.
        // Memoizing live getters on first access must fail these assertions.
        const historical = (state) => ({ fontSize: state.fontSize, color: state.color, transform: state.transform,
          height: state.box.height });
        const fresh = __measure.snapshot(element);
        return { baseline: { ...historical(baseline), top: baseline.authoredTop, authoredHeight: baseline.authoredHeight },
          retained: historical(retained), fresh: historical(fresh), newGeneration: generation !== __measure.generation(),
          freshIdentity: fresh !== retained };
      });
      layout.restore();
      return { ...result, restored: document.body.innerHTML === original };
    });
  } finally { await page.close(); }
};
const assertRetainedValues = (result) => {
  const historical = { fontSize: 16, color: "rgb(10, 20, 30)", transform: "none", height: 24 };
  assert.deepEqual(result.baseline, { ...historical, top: 7, authoredHeight: 24 }, "baseline fields must retain pre-write values");
  assert.deepEqual(result.retained, historical, "retained current fields must retain pre-write values");
  assert.deepEqual(result.fresh, { fontSize: 28, color: "rgb(80, 90, 100)", transform: "matrix(1, 0, 0, 1, 3, 0)", height: 48 });
  assert.equal(result.newGeneration, true);
  assert.equal(result.freshIdentity, true);
  assert.equal(result.restored, true);
};
test("baseline and retained snapshots preserve unread values across writes while fresh snapshots update", async () => {
  const candidate = await retainedValues("candidate");
  assertRetainedValues(candidate);
  const unsafe = await retainedValues("live-snapshot");
  assert.throws(() => assertRetainedValues(unsafe), /baseline fields/);
  assert.throws(() => assertRetainedValues({ ...unsafe, baseline: candidate.baseline }), /retained current fields/);
});
