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

const prepare = async (variant, { authoredEmpty = false, ownershipFixture = false, bodyScroller = false, frameFixture = false } = {}) => {
  const page = await browser.newPage({ viewport: { width: 1000, height: ownershipFixture ? 2200 : 700 } });
  try {
    await page.route(`${origin}/**`, (route) => readFile(resolve(sourceRoot, new URL(route.request().url()).pathname.slice(1)))
      .then((body) => route.fulfill({ body, contentType: "font/woff2" })));
    await page.setContent(`<!doctype html><style>
      ${bodyScroller ? "html{height:100%;overflow:hidden}body{height:100%;overflow:auto}" : ""}
      body{margin:0;font:16px/20px Arial}p{margin:0}.mask{display:block;position:relative;width:180px;height:100px;overflow:hidden;white-space:nowrap}.mask .extent{position:absolute;left:0;top:0}.strip{display:block;position:sticky;top:0;width:max-content}
      .pane{width:180px;height:90px;overflow:auto}
      .extent{display:block;width:1000px;height:700px;margin:0}#ordinary-scroll{overflow-anchor:auto!important}
      #editor-scroll{overflow-anchor:auto!important}#readonly-scroll{width:90px;height:40px;overflow:auto;overflow-anchor:auto!important}
      #frame-scroll{position:relative;width:240px;height:30px;max-height:30px;overflow:hidden}#frame-scroll iframe{position:absolute;left:0;top:0;width:240px;height:30px;max-height:30px;border:0}#frame-scroll .extent{position:absolute;left:0;top:0}
      #protected-scroll{overflow-anchor:none}#shadow-host{display:block}.extent.clamped{display:none!important}
    </style>${ownershipFixture ? "Body viewport prose. " : ""}<p id="intro">A normal page remains readable.</p>
    <div class="pane" id="ordinary-scroll"><p class="extent" id="ordinary-extent">Native scrolling prose.</p></div>
    <div class="pane" id="editor-scroll" contenteditable="true" style="overflow-anchor:auto!important"><div class="extent"><div id="readonly-scroll" contenteditable="false" style="overflow-anchor:auto!important"><code class="extent">Editor-owned read-only code.</code></div>Editable draft.</div></div>
    <pre class="pane" id="protected-scroll"${authoredEmpty ? ' style=""' : ""}><code class="extent" id="protected-extent"${authoredEmpty ? ' style=""' : ""}>Protected code retains its author font.</code></pre>
    ${ownershipFixture ? `<div class="mask" id="layout-scroll"${authoredEmpty ? ' style=""' : ""}><span class="strip">A long overflowing caption gets a real measured repair and restores.</span><div class="extent"></div></div><div class="mask" id="overlap-scroll"${authoredEmpty ? ' style=""' : ""}>A directly owned caption with overlapping layout and typography.<div class="extent"></div></div>` : ""}
    ${frameFixture ? `<div id="frame-scroll"${authoredEmpty ? ' style=""' : ""}>Frame label<iframe title="Measured caption"></iframe><div class="extent"></div></div>` : ""}
    <div id="shadow-host"></div><section id="zero-offset-prose">${Array.from({ length: 80 }, (_, i) => `<p id="zero-${i}">An unrelated zero-offset line ${i}.</p>`).join("")}</section>`);
    await page.evaluate(({ ownershipFixture, authoredEmpty }) => {
      const root = document.querySelector("#shadow-host").attachShadow({ mode: "open" });
      root.innerHTML = '<style>.pane{width:180px;height:90px;overflow:auto;overflow-anchor:auto!important}.extent{display:block;width:1000px;height:700px;margin:0;font:16px/20px Arial}.extent.clamped{display:none!important}p{margin:0}</style><div class="pane" id="shadow-scroll"><p class="extent" id="shadow-extent">Shadow scrolling prose.</p></div><p id="zero-shadow">Unrelated zero-offset shadow prose.</p>';
      if (ownershipFixture) {
        root.querySelector("style").textContent += ".mask{display:block;position:relative;width:180px;height:100px;overflow:hidden;white-space:nowrap}.mask .extent{position:absolute;left:0;top:0}.strip{display:block;position:sticky;top:0;width:max-content}";
        root.innerHTML += `<pre class="pane" id="shadow-protected"${authoredEmpty ? ' style=""' : ""}><code class="extent">Shadow protected code.</code></pre><div class="mask" id="shadow-layout"${authoredEmpty ? ' style=""' : ""}><span class="strip">A long shadow caption gets a measured repair and restores.</span><div class="extent"></div></div><div class="mask" id="shadow-overlap"${authoredEmpty ? ' style=""' : ""}>A direct shadow caption with overlapping ownership.<div class="extent"></div></div>`;
      }
      globalThis.__root = root;
      globalThis.__expectedBody = document.body.outerHTML;
      globalThis.__expectedRoot = root.innerHTML;
      globalThis.__scanActive = false;
      globalThis.__scanEditorChecks = [];
      globalThis.__scanOffsetReads = [];
      const runtime = [], storage = [];
      globalThis.__settings = { enabled: true, scope: "all", layoutRepair: true, textScale: 120 };
      globalThis.chrome = {
        runtime: { getURL: (path) => `http://viewport-prefilter.test/${path}`, sendMessage: async () => {}, onMessage: { addListener: (fn) => runtime.push(fn) } },
        storage: { sync: { get: async () => __settings }, onChanged: { addListener: (fn) => storage.push(fn) } }
      };
      globalThis.__state = () => {
        let result; runtime.forEach((fn) => fn({ type: "LEXEND_GET_STATE" }, null, (value) => { result = value; })); return result;
      };
      globalThis.__update = (values) => {
        Object.assign(__settings, values);
        storage.forEach((fn) => fn(Object.fromEntries(Object.entries(values).map(([key, newValue]) => [key, { newValue }])), "sync"));
      };
      globalThis.__pause = () => __update({ enabled: false });
      globalThis.__find = (id) => document.getElementById(id) ?? __root.getElementById(id);
      globalThis.__scrollView = () => Object.fromEntries([
        "ordinary-scroll", "shadow-scroll", "protected-scroll", "editor-scroll", "readonly-scroll"
      ].map((id) => {
        const element = __find(id);
        return [id, { x: element.scrollLeft, y: element.scrollTop,
          anchor: element.style.getPropertyValue("overflow-anchor"), priority: element.style.getPropertyPriority("overflow-anchor"),
          computedAnchor: getComputedStyle(element).overflowAnchor }];
      }));
    }, { ownershipFixture, authoredEmpty });
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
        if (variant === "without-observable-author-adoption") source = replaceExactlyOnce(source,
          "        if (property && (typographyProperties || value.value === property.appliedValue\n            && value.priority === property.appliedPriority)) {",
          "        if (property && typographyProperties) {", "unsafe reconciliation drops an observable author edit ending at the applied value");
        if (variant === "without-style-materialization") source = replaceExactlyOnce(source,
          '    for (const element of pendingStyleWrites) element.getAttribute("style");\n', "", "unsafe CSSOM writes left physically absent before author removal");
        if (variant === "without-pending-drain") source = replaceExactlyOnce(source,
          "    adoptStyleMutations(observer.takeRecords());\n    observer.disconnect();\n    try {\n      applyToRoot(document.documentElement);",
          "    observer.disconnect();\n    try {\n      applyToRoot(document.documentElement);", "unsafe observer disconnect that drops queued author provenance");
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
          "  globalThis.__viewportProbe = withViewportPreserved;\n  globalThis.__applyFrame = applyFrameRequirement;\n  globalThis.__owners = (element) => ({ typography: managedElements.get(element)?.hadStyle ?? null, layout: layout?.getStylePresence?.(element) ?? null });\n  start().finally(() => {", "expose actual viewport wrapper and read ownership provenance");
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
    extents.forEach((element) => element.classList.add("clamped"));
    // These native reads force Chromium to apply a genuinely shorter range.
    clamped = __scrollView();
    extents.forEach((element) => element.classList.remove("clamped"));
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

const pauseAndCompare = async (page) => {
  const revision = await page.evaluate(() => { const revision = __state().refreshRevision; __pause(); return revision; });
  await page.waitForFunction((revision) => __state().healthy && !__state().pending && !__state().active && __state().refreshRevision > revision, revision);
  assert.deepEqual(await page.evaluate(() => ({ body: document.body.outerHTML, root: __root.innerHTML })),
    await page.evaluate(() => ({ body: __expectedBody, root: __expectedRoot })), "pause restores exact original document/shadow markup");
};

for (const authoredEmpty of [false, true]) for (const bodyScroller of [false, true]) {
  test(`active recapture retains absent/empty provenance through typography, layout and overlapping scrollers (empty=${authoredEmpty}, body=${bodyScroller})`, async () => {
    const page = await prepare("candidate", { authoredEmpty, bodyScroller, ownershipFixture: true });
    try {
      const before = await page.evaluate(() => {
        const ids = ["ordinary-scroll", "shadow-scroll", "protected-scroll", "layout-scroll", "overlap-scroll", "shadow-protected", "shadow-layout", "shadow-overlap"];
        globalThis.__positions = () => Object.fromEntries(ids.map((id) => { const e = __find(id); return [id, { x: e.scrollLeft, y: e.scrollTop }]; }));
        ids.forEach((id) => __find(id).scrollTo(60, 70));
        (getComputedStyle(document.body).overflowY === "auto" ? document.body : window).scrollTo(0, 300);
        return { positions: __positions(), rootY: scrollY, bodyY: document.body.scrollTop,
          owners: Object.fromEntries(ids.map((id) => [id, __owners(__find(id))])) };
      });
      assert.deepEqual(before.owners["layout-scroll"], { typography: null, layout: authoredEmpty }, "fixture really owns layout without typography");
      assert.deepEqual(before.owners["overlap-scroll"], { typography: authoredEmpty, layout: authoredEmpty }, "fixture really overlaps layout and typography ownership");
      assert.deepEqual(before.owners["protected-scroll"], { typography: authoredEmpty, layout: null }, "protected scroller really owns only typography");
      assert.deepEqual(before.owners["shadow-layout"], { typography: null, layout: authoredEmpty }, "open shadow scroller really owns layout alone");
      assert.deepEqual(before.owners["shadow-overlap"], { typography: authoredEmpty, layout: authoredEmpty }, "open shadow scroller really overlaps ownership");
      assert.deepEqual(before.owners["shadow-protected"], { typography: authoredEmpty, layout: null }, "open shadow protected scroller really owns typography alone");
      for (const [id, position] of Object.entries(before.positions)) assert.ok(position.x > 0 && position.y > 0, `${id} has real nonzero native offsets`);
      assert.ok(bodyScroller ? before.bodyY > 0 : before.rootY > 0, "the primary body/document scroller is genuinely scrolled");
      for (const textScale of [130, 120]) {
        const revision = await page.evaluate((textScale) => { const revision = __state().refreshRevision; __update({ textScale }); return revision; }, textScale);
        await page.waitForFunction((revision) => __state().healthy && !__state().pending && __state().refreshRevision > revision, revision);
        const after = await page.evaluate(() => ({ positions: __positions(), rootY: scrollY, bodyY: document.body.scrollTop,
          owners: Object.fromEntries(Object.keys(__positions()).map((id) => [id, __owners(__find(id))])) }));
        assert.deepEqual(after, before, "active native recapture preserves scroll offsets and every ownership provenance");
      }
      await pauseAndCompare(page);
      assert.deepEqual(await page.evaluate(() => ({ positions: __positions(), rootY: scrollY, bodyY: document.body.scrollTop })),
        { positions: before.positions, rootY: before.rootY, bodyY: before.bodyY }, "pause retains real native scroll offsets as well as exact markup");
    } finally { await page.close(); }
  });
}

test("authored-empty protected styles survive immediate nonzero-scroll pause", async () => {
  const page = await prepare("candidate", { authoredEmpty: true });
  try { assertSemantics(await exercise(page)); await pauseAndCompare(page); }
  finally { await page.close(); }
});

for (const delivered of [false, true]) test(`later author style-presence changes override activation provenance (observer delivered=${delivered})`, async () => {
  for (const authoredEmpty of [false, true]) for (const present of [false, true]) {
    const page = await prepare("candidate", { authoredEmpty, ownershipFixture: true });
    try {
      await page.evaluate(({ present, delivered }) => {
        const expected = new DOMParser().parseFromString(__expectedBody, "text/html").body;
        for (const id of ["protected-scroll", "layout-scroll", "overlap-scroll"]) {
          const element = __find(id), original = expected.querySelector(`#${id}`);
          element.scrollTo(60, 70);
          if (present) { if (delivered) element.setAttribute("style", ""); original.setAttribute("style", ""); }
          else {
            if (delivered) {
              element.removeAttribute("style");
              if (element.hasAttribute("style")) throw new Error("Author removal must establish actual absent style");
            }
            original.removeAttribute("style");
          }
        }
        __expectedBody = expected.outerHTML;
      }, { present, delivered });
      if (delivered) {
        // Observe a real settled active recapture after the author's write.
        const revision = await page.evaluate(() => { const revision = __state().refreshRevision; __update({ textScale: 130 }); return revision; });
        await page.waitForFunction((revision) => __state().healthy && !__state().pending && __state().refreshRevision > revision, revision);
      }
      // Same-task author write/pause must drain the queued records too.
      if (!delivered) await page.evaluate(({ present }) => {
        for (const id of ["protected-scroll", "layout-scroll", "overlap-scroll"]) {
          const element = __find(id);
          if (present) element.setAttribute("style", "");
          else {
            element.removeAttribute("style");
            if (element.hasAttribute("style")) throw new Error("Author removal must establish actual absent style");
          }
        }
        __pause();
      }, { present });
      else await page.evaluate(() => __pause());
      await page.waitForFunction(() => __state().healthy && !__state().active && !__state().pending);
      assert.deepEqual(await page.evaluate(() => ({ body: document.body.outerHTML, root: __root.innerHTML })),
        await page.evaluate(() => ({ body: __expectedBody, root: __expectedRoot })), `author removal or explicitly empty styles win over all original ownership groups (initialEmpty=${authoredEmpty}, present=${present}, delivered=${delivered})`);
    } finally { await page.close(); }
  }
});

test("later author declarations and saved inline anchor values/priorities survive active recapture and pause", async () => {
  const page = await prepare("candidate", { ownershipFixture: true, bodyScroller: true });
  try {
    const before = await page.evaluate(() => {
      const ids = ["ordinary-scroll", "protected-scroll", "shadow-scroll", "layout-scroll", "overlap-scroll"];
      const elements = [document.documentElement, document.body, ...ids.map(__find)];
      elements.forEach((element, i) => {
        element.style.setProperty("overflow-anchor", i % 2 ? "auto" : "none", i % 3 ? "important" : "");
        element.style.setProperty("color", "rgb(12, 34, 56)", "important");
        element.scrollTo(60, 70);
      });
      return elements.map((element) => ({ value: element.style.getPropertyValue("overflow-anchor"), priority: element.style.getPropertyPriority("overflow-anchor"),
        color: element.style.getPropertyValue("color"), colorPriority: element.style.getPropertyPriority("color") }));
    });
    for (const textScale of [130, 120]) {
      const revision = await page.evaluate((textScale) => { const revision = __state().refreshRevision; __update({ textScale }); return revision; }, textScale);
      await page.waitForFunction((revision) => __state().healthy && !__state().pending && __state().refreshRevision > revision, revision);
    }
    await page.evaluate(() => __pause());
    await page.waitForFunction(() => __state().healthy && !__state().active && !__state().pending);
    const after = await page.evaluate(() => [document.documentElement, document.body, ...["ordinary-scroll", "protected-scroll", "shadow-scroll", "layout-scroll", "overlap-scroll"].map(__find)]
      .map((element) => ({ value: element.style.getPropertyValue("overflow-anchor"), priority: element.style.getPropertyPriority("overflow-anchor"),
        color: element.style.getPropertyValue("color"), colorPriority: element.style.getPropertyPriority("color") })));
    assert.deepEqual(after, before, "root/body/nested/shadow saved normal and important author anchors and later unrelated declarations survive");
    assert.equal(await page.evaluate(() => __find("editor-scroll").getAttribute("style")), "overflow-anchor:auto!important", "excluded editor's authored bytes remain untouched");
  } finally { await page.close(); }
});

test("synchronous custom-element callbacks can replace guard anchors and author style presence during installation and cleanup", async () => {
  for (const reaction of ["empty", "absent", "override", "cleanup-empty", "active-override"]) {
    const page = await prepare("candidate");
    try {
      await page.evaluate((reaction) => {
        class ScrollReaction extends HTMLElement {
          static observedAttributes = ["style"];
          attributeChangedCallback() {
            if (!this.armed) return;
            const guarded = this.style.getPropertyValue("overflow-anchor") === "none" && this.style.getPropertyPriority("overflow-anchor") === "important";
            if (reaction === "cleanup-empty" ? guarded : !guarded) return;
            this.armed = false; this.reactions++;
            if (reaction === "absent") this.removeAttribute("style");
            else if (reaction.endsWith("override")) this.style.cssText = "overflow-anchor:auto!important;color:rgb(12,34,56)!important;font-size:17px!important";
            else this.setAttribute("style", "");
          }
        }
        customElements.define("scroll-reaction", ScrollReaction);
        const element = document.createElement("scroll-reaction");
        element.id = "reaction-scroll"; element.className = "mask";
        element.innerHTML = 'A directly owned long caption with real overlapping repairs.<div class="extent"></div>';
        document.body.prepend(element);
      }, reaction);
      await page.waitForFunction(() => __state().healthy && !__state().pending
        && __owners(__find("reaction-scroll")).typography === false && __owners(__find("reaction-scroll")).layout === false);
      const before = await page.evaluate((reaction) => {
        const element = __find("reaction-scroll");
        element.scrollTo(60, 70); element.armed = true; element.reactions = 0;
        const before = { x: element.scrollLeft, y: element.scrollTop, revision: __state().refreshRevision };
        if (reaction === "active-override") __update({ textScale: 130 }); else __pause();
        return before;
      }, reaction);
      if (reaction === "active-override") {
        await page.waitForFunction((revision) => __state().healthy && !__state().pending && __state().refreshRevision > revision, before.revision);
        assert.ok(Math.abs(await page.evaluate(() => parseFloat(getComputedStyle(__find("reaction-scroll")).fontSize)) - 22.1) < 0.01,
          "active recapture converts the callback's new authored 17px baseline at 130%");
        const revision = await page.evaluate(() => { const revision = __state().refreshRevision; __update({ textScale: 120 }); return revision; });
        await page.waitForFunction((revision) => __state().healthy && !__state().pending && __state().refreshRevision > revision, revision);
        await page.evaluate(() => __pause());
      }
      await page.waitForFunction(() => __state().healthy && !__state().active && !__state().pending);
      const result = await page.evaluate(() => {
        const element = __find("reaction-scroll");
        return { error: __state().error ?? null, after: { x: element.scrollLeft, y: element.scrollTop },
          reactions: element.reactions, present: element.hasAttribute("style"), css: element.style.cssText,
          anchor: element.style.getPropertyValue("overflow-anchor"), priority: element.style.getPropertyPriority("overflow-anchor"),
          size: element.style.getPropertyValue("font-size"), sizePriority: element.style.getPropertyPriority("font-size") };
      });
      assert.equal(result.error, null);
      assert.equal(result.reactions, 1, `${reaction} executes an actual synchronous attributeChangedCallback`);
      assert.ok(before.x > 0 && before.y > 0);
      assert.deepEqual(result.after, { x: before.x, y: before.y }, "callback keeps real native scroll positions");
      assert.equal(result.present, reaction !== "absent", "callback's absent/empty style presence wins over guard provenance");
      assert.equal(result.anchor, reaction.endsWith("override") ? "auto" : "", "later author anchor override survives guard cleanup");
      assert.equal(result.priority, reaction.endsWith("override") ? "important" : "");
      if (!reaction.endsWith("override")) assert.equal(result.css, "");
      else {
        assert.equal(result.size, "17px", "pause retains callback's latest author font after active recapture");
        assert.equal(result.sizePriority, "important");
      }
    } finally { await page.close(); }
  }
});


test("shadow discovery drains queued authored-empty style provenance before disconnecting, and the unsafe disconnect loses it", async () => {
  const results = [];
  for (const variant of ["candidate", "without-pending-drain"]) {
    const page = await prepare(variant);
    try {
      await page.evaluate(() => {
        // Use an already connected host so no earlier insertion has queued
        // observer delivery ahead of discovery's microtask.
        __find("ordinary-scroll").attachShadow({ mode: "open" });
        __find("protected-scroll").setAttribute("style", "");
      });
      await page.evaluate(() => __pause());
      await page.waitForFunction(() => __state().healthy && !__state().active && !__state().pending);
      results.push(await page.evaluate(() => __find("protected-scroll").getAttribute("style")));
    } finally { await page.close(); }
  }
  assert.equal(results[0], "", "later author explicitly empty style survives discovery and pause");
  assert.equal(results[1], null, "unsafe real disconnect demonstrably loses the author's presence");
  assert.throws(() => assert.equal(results[1], ""), /AssertionError/, "the same assertion rejects the unsafe runtime control");
});


for (const authoredEmpty of [false, true]) test(`frame clipping ownership overlaps typography without contaminating style presence (empty=${authoredEmpty})`, async () => {
  const page = await prepare("candidate", { authoredEmpty, frameFixture: true });
  try {
    const repaired = await page.evaluate(() => {
      const frame = document.querySelector("#frame-scroll iframe"), element = __find("frame-scroll");
      __applyFrame(frame, { viewportHeight: 30, baselineHeight: 30, requiredHeight: 130 });
      element.scrollTo(60, 70);
      return { frameHeight: frame.getBoundingClientRect().height, clipHeight: element.clientHeight,
        typography: __owners(element).typography, x: element.scrollLeft, y: element.scrollTop };
    });
    assert.equal(repaired.frameHeight, 130, "the actual qualifying measured frame grows");
    assert.ok(repaired.clipHeight >= 130, "the real independent frame ledger owns its clipping ancestor's height");
    assert.equal(repaired.typography, authoredEmpty, "the clipping ancestor simultaneously owns typography");
    assert.ok(repaired.x > 0 && repaired.y > 0, "the overlapping frame ancestor is really scrolled");
    const revision = await page.evaluate(() => { const revision = __state().refreshRevision; __update({ textScale: 130 }); return revision; });
    await page.waitForFunction((revision) => __state().healthy && !__state().pending && __state().refreshRevision > revision, revision);
    await pauseAndCompare(page);
    assert.deepEqual(await page.evaluate(() => ({ x: __find("frame-scroll").scrollLeft, y: __find("frame-scroll").scrollTop })),
      { x: repaired.x, y: repaired.y }, "recapture and frame/typography disposal retain native offsets");
  } finally { await page.close(); }
});


test("owned CSSOM styles materialize before authors remove them, and the unsafe runtime exposes native empty attributes", async () => {
  const results = [];
  for (const variant of ["candidate", "without-style-materialization"]) {
    const page = await prepare(variant);
    try {
      const authored = await page.evaluate(() => {
        const element = __find("protected-scroll"); element.scrollTo(60, 70);
        element.removeAttribute("style");
        const value = element.getAttribute("style"); __pause(); return value;
      });
      await page.waitForFunction(() => __state().healthy && !__state().active && !__state().pending);
      const paused = await page.evaluate(() => __find("protected-scroll").getAttribute("style"));
      assert.equal(paused, authored, "guard cleanup preserves the author's actual native result");
      results.push(authored);
    } finally { await page.close(); }
  }
  assert.equal(results[0], null, "natural author removeAttribute really produces absence after owned writes are materialized");
  assert.equal(results[1], "", "unsafe writes demonstrably leave the lazy native empty-attribute path");
  assert.throws(() => assert.equal(results[1], null), /AssertionError/, "the same absence assertion rejects the unsafe runtime");
});


test("observable author edits ending at Lexend's applied value survive pause, and the unsafe reconciler loses them", async () => {
  const results = [];
  for (const variant of ["candidate", "without-observable-author-adoption"]) {
    const page = await prepare(variant);
    try {
      const applied = await page.evaluate(() => {
        const element = __find("ordinary-extent"), value = element.style.getPropertyValue("font-size");
        element.style.setProperty("font-size", "30px", "important");
        element.style.setProperty("font-size", value, "important");
        return value;
      });
      assert.ok(parseFloat(applied) > 16, "the fixture first applied real scaled typography");
      await page.evaluate(() => __pause());
      await page.waitForFunction(() => __state().healthy && !__state().active && !__state().pending);
      results.push({ applied, ...await page.evaluate(() => ({
        value: __find("ordinary-extent").style.getPropertyValue("font-size"),
        priority: __find("ordinary-extent").style.getPropertyPriority("font-size")
      })) });
    } finally { await page.close(); }
  }
  const assertLatestAuthor = (result) => {
    assert.equal(result.value, result.applied, "observable latest authored value survives pause even when it equals the prior Lexend value");
    assert.equal(result.priority, "important");
  };
  assertLatestAuthor(results[0]);
  assert.equal(results[1].value, "", "unsafe reconciliation demonstrably restores the obsolete absent author declaration");
  assert.throws(() => assertLatestAuthor(results[1]), /observable latest authored value/, "the same author-state assertion rejects the unsafe runtime");
});
