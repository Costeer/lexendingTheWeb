import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
import test from "node:test";
import { chromium } from "playwright";
import { runtimeScriptPaths } from "../scripts/performance/runtime-resources.mjs";
import { replaceExactlyOnce } from "./helpers/conversation.mjs";

const sourceRoot = resolve(process.env.LEXEND_TEST_SOURCE ?? ".");
const manifest = JSON.parse(await readFile(resolve(sourceRoot, "manifests/manifest.chrome.json"), "utf8"));
const paths = runtimeScriptPaths(manifest), origin = "http://viewport-prefilter.test";
let browser;
test.before(async () => { browser = await chromium.launch({ headless: true }); });
test.after(async () => { await browser?.close(); });

const prepare = async (variant) => {
  const page = await browser.newPage({ viewport: { width: 1000, height: 700 } });
  try {
    await page.route(`${origin}/**`, (route) => readFile(resolve(sourceRoot, new URL(route.request().url()).pathname.slice(1)))
      .then((body) => route.fulfill({ body, contentType: "font/woff2" })));
    await page.setContent(`<!doctype html><style>
      body{margin:0;font:16px/20px Arial}p{margin:0}.pane{width:180px;height:90px;overflow:auto}
      .extent{display:block;width:1000px;height:700px;margin:0}#ordinary-scroll{overflow-anchor:auto!important}
      #editor-scroll{overflow-anchor:auto!important}#readonly-scroll{width:90px;height:40px;overflow:auto;overflow-anchor:auto!important}
      #protected-scroll{overflow-anchor:none}#shadow-host{display:block}
    </style><p id="intro">A normal page remains readable.</p>
    <div class="pane" id="ordinary-scroll"><p class="extent" id="ordinary-extent">Native scrolling prose.</p></div>
    <div class="pane" id="editor-scroll" contenteditable="true" style="overflow-anchor:auto!important"><div class="extent"><div id="readonly-scroll" contenteditable="false" style="overflow-anchor:auto!important"><code class="extent">Editor-owned read-only code.</code></div>Editable draft.</div></div>
    <pre class="pane" id="protected-scroll" style=""><code class="extent" id="protected-extent" style="">Protected code retains its author font.</code></pre>
    <div id="shadow-host"></div><section id="zero-offset-prose">${Array.from({ length: 80 }, (_, i) => `<p id="zero-${i}">An unrelated zero-offset line ${i}.</p>`).join("")}</section>`);
    await page.evaluate(() => {
      const root = document.querySelector("#shadow-host").attachShadow({ mode: "open" });
      root.innerHTML = '<style>.pane{width:180px;height:90px;overflow:auto;overflow-anchor:auto!important}.extent{display:block;width:1000px;height:700px;margin:0;font:16px/20px Arial}p{margin:0}</style><div class="pane" id="shadow-scroll"><p class="extent" id="shadow-extent">Shadow scrolling prose.</p></div><p id="zero-shadow">Unrelated zero-offset shadow prose.</p>';
      globalThis.__root = root;
      // Authored-empty protected styles exercise presence preservation here.
      // Originally absent protected styles at nonzero scroll have a separately
      // retained pre-existing pause regression; this fixture does not fix it.
      globalThis.__expectedBody = document.body.outerHTML;
      globalThis.__expectedRoot = root.innerHTML;
      globalThis.__scanActive = false;
      globalThis.__scanEditorChecks = [];
      globalThis.__scanOffsetReads = [];
      const runtime = [], storage = [];
      globalThis.__settings = { enabled: true, scope: "all", textScale: 120 };
      globalThis.chrome = {
        runtime: { getURL: (path) => `http://viewport-prefilter.test/${path}`, sendMessage: async () => {}, onMessage: { addListener: (fn) => runtime.push(fn) } },
        storage: { sync: { get: async () => __settings }, onChanged: { addListener: (fn) => storage.push(fn) } }
      };
      globalThis.__state = () => {
        let result; runtime.forEach((fn) => fn({ type: "LEXEND_GET_STATE" }, null, (value) => { result = value; })); return result;
      };
      globalThis.__pause = () => {
        __settings.enabled = false; storage.forEach((fn) => fn({ enabled: { newValue: false } }, "sync"));
      };
      globalThis.__find = (id) => document.getElementById(id) ?? __root.getElementById(id);
      globalThis.__scrollView = () => Object.fromEntries([
        "ordinary-scroll", "shadow-scroll", "protected-scroll", "editor-scroll", "readonly-scroll"
      ].map((id) => {
        const element = __find(id);
        return [id, { x: element.scrollLeft, y: element.scrollTop,
          anchor: element.style.getPropertyValue("overflow-anchor"), priority: element.style.getPropertyPriority("overflow-anchor"),
          computedAnchor: getComputedStyle(element).overflowAnchor }];
      }));
    });
    for (const path of paths) {
      let source = await readFile(resolve(sourceRoot, path), "utf8");
      if (path === "src/content.js") {
        await page.evaluate(() => {
          for (const name of ["scrollLeft", "scrollTop"]) {
            const descriptor = Object.getOwnPropertyDescriptor(Element.prototype, name);
            Object.defineProperty(Element.prototype, name, { ...descriptor, get() {
              if (__scanActive) __scanOffsetReads.push({ id: this.id, name });
              return descriptor.get.call(this);
            } });
          }
          const protection = LexendProtection;
          globalThis.LexendProtection = Object.freeze({ ...protection, editorOwned(element) {
            if (__scanActive) __scanEditorChecks.push(element.id);
            return protection.editorOwned(element);
          } });
        });
        if (variant === "without-design-guard") source = replaceExactlyOnce(source,
          "      if (protection.editorDocument()) break;\n", "", "unguarded editable-document offset scan control");
        if (variant === "original-order") source = replaceExactlyOnce(source,
          `        if (!element.style || element === body || element === document.documentElement) return;
        const x = element.scrollLeft, y = element.scrollTop;
        if ((!x && !y) || protection.editorOwned(element)) return;
        nestedScrollers.set(element, { x, y,`,
          `        if (!element.style || element === body || element === document.documentElement || protection.editorOwned(element)
            || (!element.scrollLeft && !element.scrollTop)) return;
        nestedScrollers.set(element, { x: element.scrollLeft, y: element.scrollTop,`, "original viewport guard order control");
        source = replaceExactlyOnce(source,
          "    for (const root of new Set([document.documentElement, ...styledRoots])) {",
          "    __scanActive = true;\n    try {\n    for (const root of new Set([document.documentElement, ...styledRoots])) {", "mark only actual viewport scan entry");
        source = replaceExactlyOnce(source,
          "    // Read every scroll offset before changing styles; interleaving these",
          "    } finally { __scanActive = false; }\n    // Read every scroll offset before changing styles; interleaving these", "mark only actual viewport scan exit");
        source = replaceExactlyOnce(source, "  start().finally(() => {",
          "  globalThis.__viewportProbe = withViewportPreserved;\n  start().finally(() => {", "expose actual viewport wrapper");
      }
      await page.addScriptTag({ content: source });
    }
    await page.evaluate(() => document.fonts.ready);
    await page.waitForFunction(() => __state()?.healthy && !__state().pending && document.fonts.status === "loaded");
    return page;
  } catch (error) { await page.close(); throw error; }
};

const exercise = async (page) => page.evaluate(() => {
  for (const id of ["ordinary-scroll", "shadow-scroll", "protected-scroll", "editor-scroll", "readonly-scroll"]) {
    __find(id).scrollTo({ left: 70, top: 110, behavior: "instant" });
  }
  window.scrollTo(0, 300);
  const before = __scrollView(), pageY = scrollY, editor = __find("editor-scroll").outerHTML;
  const watcher = new MutationObserver(() => {});
  watcher.observe(__find("editor-scroll"), { attributes: true, childList: true, characterData: true, subtree: true });
  __scanEditorChecks = [];
  let clamped;
  const error = __viewportProbe(() => {
    const extents = ["ordinary-extent", "shadow-extent", "protected-extent"].map(__find);
    const originals = extents.map((element) => element.getAttribute("style"));
    extents.forEach((element) => { element.style.display = "none"; });
    // These native reads force Chromium to apply a genuinely shorter range.
    clamped = __scrollView();
    extents.forEach((element, i) => {
      if (originals[i] === null) element.removeAttribute("style"); else element.setAttribute("style", originals[i]);
    });
  });
  const editorMutations = watcher.takeRecords().length;
  watcher.disconnect();
  return { error: error?.message ?? null, before, clamped, after: __scrollView(), pageY, finalPageY: scrollY,
    editor, finalEditor: __find("editor-scroll").outerHTML, editorMutations, checks: __scanEditorChecks };
});

const assertSemantics = (result) => {
  assert.equal(result.error, null);
  for (const id of ["ordinary-scroll", "shadow-scroll", "protected-scroll"]) {
    assert.ok(result.before[id].x > 0 && result.before[id].y > 0, `${id} has real native offsets`);
    assert.equal(result.clamped[id].x, 0, `${id} really clamps horizontal offset inside the callback`);
    assert.equal(result.clamped[id].y, 0, `${id} really clamps vertical offset inside the callback`);
  }
  assert.deepEqual(result.after, result.before, "native offsets and author overflow-anchor values/priorities are restored in document and shadow roots");
  assert.equal(result.finalPageY, result.pageY, "document viewport is preserved");
  assert.equal(result.finalEditor, result.editor, "the editor owns its exact saved serialization including its read-only island");
  assert.equal(result.editorMutations, 0, "nonzero editor-owned scrollers receive no temporary guard writes");
  assert.ok(result.checks.includes("ordinary-scroll") && result.checks.includes("shadow-scroll"), "nonzero ordinary and discovered shadow scrollers still receive the real ownership check");
  assert.ok(result.checks.includes("editor-scroll") && result.checks.includes("readonly-scroll"), "nonzero editor-owned scrollers remain checked and excluded");
};
const assertWork = (result) => assert.equal(result.checks.filter((id) => /^zero-/.test(id)).length, 0,
  "zero-offset document/shadow prose does not call the real editor ownership ancestry check during viewport scanning");

test("viewport prefilter skips zero-offset editor ancestry work while retaining native scroll restoration and exact author/editor state", async () => {
  const candidate = await prepare("candidate"), original = await prepare("original-order");
  try {
    const fast = await exercise(candidate), control = await exercise(original);
    assertSemantics(fast); assertSemantics(control);
    assertWork(fast);
    assert.ok(control.checks.some((id) => /^zero-/.test(id)), "original order demonstrably checks unrelated zero-offset prose");
    assert.throws(() => assertWork(control), /zero-offset document\/shadow prose/, "the unchanged work assertion rejects the original production guard order");
    for (const page of [candidate, original]) {
      const revision = await page.evaluate(() => { const revision = __state().refreshRevision; __pause(); return revision; });
      await page.waitForFunction((revision) => __state().healthy && !__state().pending && !__state().active && __state().refreshRevision > revision, revision);
      assert.deepEqual(await page.evaluate(() => ({ body: document.body.outerHTML, root: __root.innerHTML })),
        await page.evaluate(() => ({ body: __expectedBody, root: __expectedRoot })), "pause restores exact original document/shadow markup and priorities");
    }
  } finally { await candidate.close(); await original.close(); }
});

const assertEditableBudget = (result) => assert.equal(result.offsetReads.length, 0,
  "designMode viewport collection reads no nested native scroll offsets");

test("designMode viewport collection skips native scroll reads and preserves exact editor serialization", async () => {
  const candidate = await prepare("candidate"), unguarded = await prepare("without-design-guard");
  try {
    const results = [];
    for (const page of [candidate, unguarded]) {
      results.push(await page.evaluate(() => {
        __scanEditorChecks = []; __scanOffsetReads = [];
        document.designMode = "on";
        const transition = { checks: __scanEditorChecks, offsetReads: __scanOffsetReads };
        const body = document.body.outerHTML, root = __root.innerHTML;
        __scanEditorChecks = []; __scanOffsetReads = [];
        const watcher = new MutationObserver(() => {});
        watcher.observe(document.documentElement, { subtree: true, attributes: true, childList: true, characterData: true });
        const error = __viewportProbe(() => {});
        const mutations = watcher.takeRecords().length; watcher.disconnect();
        return { editing: document.designMode, transition, checks: __scanEditorChecks, offsetReads: __scanOffsetReads,
          error: error?.message ?? null, mutations, body, root, afterBody: document.body.outerHTML, afterRoot: __root.innerHTML,
          expectedBody: __expectedBody, expectedRoot: __expectedRoot };
      }));
    }
    for (const result of results) {
      assert.equal(result.editing, "on", "actual native designMode is enabled through the real MAIN bridge");
      assert.equal(result.error, null);
      assert.equal(result.body, result.expectedBody, "native designMode setter releases typography before returning");
      assert.equal(result.root, result.expectedRoot, "native designMode setter restores exact shadow author markup");
      assert.equal(result.afterBody, result.body, "viewport transaction preserves exact editor-owned body serialization");
      assert.equal(result.afterRoot, result.root, "viewport transaction preserves exact editor-owned shadow serialization");
      assert.equal(result.mutations, 0, "editable document receives no temporary viewport guard writes");
    }
    assertEditableBudget(results[0]);
    assertEditableBudget(results[0].transition);
    assert.equal(results[0].checks.length, 0, "editable collection bypasses nested ownership checks too");
    assert.ok(results[1].offsetReads.length > 0 && results[1].transition.offsetReads.length > 0,
      "zero-first control demonstrably reads native offsets during both designMode transition and direct viewport work");
    assert.throws(() => assertEditableBudget(results[1]), /designMode viewport collection/, "the unchanged editable budget rejects the real unguarded control");
  } finally { await candidate.close(); await unguarded.close(); }
});
