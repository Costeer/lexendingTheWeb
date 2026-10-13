import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
import test from "node:test";
import { chromium } from "playwright";
import { instrumentContent } from "./helpers/conversation.mjs";

let browser;
test.before(async () => { browser = await chromium.launch({ headless: true }); });
test.after(async () => { await browser?.close(); });
const prepare = async (html, { before, inspect = false } = {}) => {
  const page = await browser.newPage();
  await page.route("http://runtime.test/**", async (route) => route.fulfill({
    body: await readFile(resolve(`.${new URL(route.request().url()).pathname}`)), contentType: "font/woff2"
  }));
  await page.setContent(html);
  await page.evaluate(() => {
    const storage = [], runtime = [];
    globalThis.__settings = { enabled: true, scope: "all", textScale: 110 };
    globalThis.chrome = {
      runtime: { getURL: (path) => `http://runtime.test/${path}`, sendMessage: async () => {}, onMessage: { addListener: (fn) => runtime.push(fn) } },
      storage: { sync: { get: async () => __settings }, onChanged: { addListener: (fn) => storage.push(fn) } }
    };
    globalThis.__update = (values) => {
      Object.assign(__settings, values);
      const changes = Object.fromEntries(Object.entries(values).map(([key, newValue]) => [key, { newValue }]));
      storage.forEach((fn) => fn(changes, "sync"));
    };
    globalThis.__state = () => { let result; runtime.forEach((fn) => fn({ type: "LEXEND_GET_STATE" }, null, (value) => { result = value; })); return result; };
  });
  await before?.(page);
  for (const name of ["shadow-discovery", "settings", "adaptive-controls", "adaptive-layout", "content"]) {
    let source = await readFile(resolve(`src/${name}.js`), "utf8");
    if (inspect && name === "content") source = instrumentContent(source);
    if (inspect && name === "adaptive-layout") {
      const anchor = "    const capture = (roots, options) =>";
      assert.equal(source.split(anchor).length, 2, "layout ownership probe must match exactly once");
      source = source.replace(anchor, `    globalThis.__layoutCollections = () => ({ baseline: baseline.size, text: textElements.size,
        descendants: descendants.size, pseudo: pseudoBaseline.size, tickers: maskedTickers.size,
        panels: panelReservations.size, scrollOwners: viewportScrollOwners.size, frame: frameQualification ? 1 : 0,
        edits: edits.size, attributes: attributes.size, wrappers: tableWrappers.size, scrollOffsets: maskedScrollOffsets.size,
        stylePresence: originalStylePresence.size });\n${anchor}`);
    }
    await page.addScriptTag({ content: source });
  }
  await page.evaluate(() => document.fonts.ready);
  await page.waitForFunction(() => __state()?.healthy && !__state().pending);
  return page;
};
const settled = (page) => page.waitForFunction(() => __state().healthy && !__state().pending);

test("editor boundaries preserve serialization, inherited typography, selection, typing, composition and undo", async () => {
  const forms = ['contenteditable="true"', 'contenteditable', 'contenteditable="plaintext-only"'];
  const page = await prepare(`<!doctype html><style>
    body {font:20px/20px Arial}.editor{height:20px;width:180px;overflow:auto}.mixed{font:inherit}
  </style><p id="reading">Reading outside editors</p><section class="mixed">Mixed parent text
  ${forms.map((form, i) => `<div class="editor" id="editor${i}" ${form}><span>Editable words</span><b contenteditable="false">Read-only island</b><button>Long editor action</button></div>`).join("")}
  <div id="editorShadow" contenteditable="true"></div></section><div id="component"></div>`, {
    before: (page) => page.evaluate(() => {
      document.querySelector("#editorShadow").attachShadow({ mode: "open" }).innerHTML = '<span>Shadow within editor</span>';
      document.querySelector("#component").attachShadow({ mode: "open" }).innerHTML = '<div contenteditable="true"><span>Shadow editor</span></div>';
      globalThis.__editors = [...document.querySelectorAll(".editor,#editorShadow"), document.querySelector("#component").shadowRoot.firstElementChild];
      globalThis.__originalEditors = __editors.map((e) => e.outerHTML);
      globalThis.__originalShadow = document.querySelector("#editorShadow").shadowRoot.innerHTML;
      globalThis.__editorAttributes = [];
      globalThis.__editorObserver = new MutationObserver((records) => __editorAttributes.push(...records.map((r) => ({ name: r.attributeName, id: r.target.id }))));
      for (const editor of __editors) __editorObserver.observe(editor, { attributes: true, subtree: true });
      __editorObserver.observe(document.querySelector("#editorShadow").shadowRoot, { attributes: true, subtree: true });
    })
  });
  const initial = await page.evaluate(() => ({ html: __editors.map((e) => e.outerHTML), original: __originalEditors,
    shadow: document.querySelector("#editorShadow").shadowRoot.innerHTML, originalShadow: __originalShadow,
    heights: [...document.querySelectorAll(".editor")].map((e) => e.getBoundingClientRect().height),
    sizes: [...document.querySelectorAll(".editor")].map((e) => getComputedStyle(e).fontSize), attributes: __editorAttributes,
    reading: getComputedStyle(document.querySelector("#reading")).fontSize }));
  assert.deepEqual(initial.html, initial.original);
  assert.equal(initial.shadow, initial.originalShadow);
  assert.deepEqual(initial.heights, [20, 20, 20]);
  assert.deepEqual(initial.sizes, ["20px", "20px", "20px"]);
  assert.deepEqual(initial.attributes, []);
  assert.equal(initial.reading, "22px");
  await page.locator("#editor0 span").click();
  await page.evaluate(() => {
    const text = document.querySelector("#editor0 span").firstChild, selection = getSelection();
    selection.setBaseAndExtent(text, 2, text, 6);
    __update({ textScale: 150 });
  });
  await settled(page);
  assert.deepEqual(await page.evaluate(() => ({ text: getSelection().toString(), anchor: getSelection().anchorOffset, focus: getSelection().focusOffset })), { text: "itab", anchor: 2, focus: 6 });
  await page.keyboard.type("typed");
  const typed = await page.locator("#editor0").innerHTML();
  await page.evaluate(() => __update({ enabled: false }));
  await page.evaluate(() => __update({ enabled: true }));
  await settled(page);
  assert.equal(await page.locator("#editor0").innerHTML(), typed);
  await page.keyboard.press("Control+z");
  assert.equal(await page.locator("#editor0").innerHTML(), await page.evaluate(() => { const e=document.createElement("div");e.innerHTML=__originalEditors[0];return e.firstChild.innerHTML; }));
  const client = await page.context().newCDPSession(page);
  await client.send("Input.imeSetComposition", { text: "に", selectionStart: 1, selectionEnd: 1 });
  const composing = await page.locator("#editor0").innerHTML();
  await page.evaluate(() => __update({ textScale: 120 }));
  await settled(page);
  assert.equal(await page.locator("#editor0").innerHTML(), composing, "a refresh does not replace the composing text node");
  await client.send("Input.insertText", { text: "日本" });
  assert.match(await page.locator("#editor0").textContent(), /日本/);
  assert.deepEqual(await page.evaluate(() => __editorAttributes), [], "even temporary style/marker writes serialize into editor state");
  await page.close();
});

test("designMode documents remain author-owned", async () => {
  const page = await prepare('<!doctype html><style>body{font:20px Arial}</style><p>Editable document</p>', {
    before: (page) => page.evaluate(() => { document.designMode = "on"; globalThis.__body = document.body.outerHTML; })
  });
  assert.equal(await page.evaluate(() => document.body.outerHTML), await page.evaluate(() => __body));
  assert.equal(await page.locator("p").evaluate((e) => getComputedStyle(e).fontSize), "20px");
  assert.equal(await page.locator('[id^="lexend-the-web-"]').count(), 0);
  await page.evaluate(() => __update({ textScale: 150 }));
  await settled(page);
  assert.equal(await page.evaluate(() => document.body.outerHTML), await page.evaluate(() => __body));
  await page.close();
});


test("entering editable and multiline boundaries restores existing shadow ownership", async () => {
  const page = await prepare('<!doctype html><style>body{font:20px Arial}</style><section id="host"></section><div role="textbox" id="multiline">Author text</div>', {
    before: (page) => page.evaluate(() => {
      document.querySelector("#host").attachShadow({ mode: "open" }).innerHTML = '<p>Previously converted shadow text</p>';
      globalThis.__originalRoot = document.querySelector("#host").shadowRoot.innerHTML;
    })
  });
  await page.evaluate(() => {
    document.querySelector("#host").contentEditable = "true";
  });
  await settled(page);
  assert.equal(await page.locator("#host").evaluate((e) => e.shadowRoot.innerHTML), await page.evaluate(() => __originalRoot));
  assert.equal(await page.locator("#host").getAttribute("style"), null);
  await page.locator("#multiline").evaluate((e) => e.setAttribute("aria-multiline", "true"));
  await settled(page);
  assert.equal(await page.locator("#multiline").getAttribute("style"), null);
  assert.equal(await page.locator("#multiline").getAttribute("data-lexend-text"), null);
  assert.equal(await page.locator("#multiline").evaluate((e) => getComputedStyle(e).fontSize), "20px");
  await page.locator("#multiline").evaluate((e) => e.removeAttribute("aria-multiline"));
  await page.waitForFunction(() => getComputedStyle(document.querySelector("#multiline")).fontSize === "22px" && !__state().pending);
  await page.locator("#host").evaluate((e) => e.removeAttribute("contenteditable"));
  await page.waitForFunction(() => document.querySelector("#host").shadowRoot.querySelector('[data-lexend-text]') && !__state().pending);
  await page.evaluate(() => {
    const editor = document.createElement("aside"); editor.contentEditable = "true";
    document.body.append(editor); editor.append(document.querySelector("#host"));
  });
  await settled(page);
  assert.equal(await page.locator("#host").evaluate((e) => e.shadowRoot.innerHTML), await page.evaluate(() => __originalRoot), "moving an owned root into an editor also releases its styles");
  await page.close();
});


test("class churn inside an established editor keeps the scheduled geometry fallback", async () => {
  const page = await prepare('<!doctype html><p>Outside prose</p><div contenteditable="true"><span>Highlighted text</span></div>', { inspect: true });
  const work = await page.evaluate(async () => {
    // Hold deadlines to separate observer work from the scheduler. Neither
    // token classes nor classes on the editor boundary may run a full pass.
    globalThis.setTimeout = () => 999;
    globalThis.clearTimeout = () => {};
    const before = __probe.calls.refresh?.count ?? 0;
    for (let i = 0; i < 30; i++) {
      document.querySelector('[contenteditable] span').className = `token-${i}`;
      document.querySelector('[contenteditable]').className = `editor-${i}`;
      await new Promise((resolve) => requestAnimationFrame(resolve));
    }
    return { passes: (__probe.calls.refresh?.count ?? 0) - before, pending: __state().pending };
  });
  assert.equal(work.passes, 0);
  assert.equal(work.pending, true, "geometry retains the scheduled conservative fallback");
  await page.close();
});

test("editor text changes still invalidate authored selectors affecting neighboring prose", async () => {
  const page = await prepare(`<!doctype html><style>body{font:20px Arial}section:has([contenteditable] span:empty) p{font-size:40px}</style>
    <section><div contenteditable="true"><span>Editor input</span></div><p>Neighboring prose</p></section>`);
  assert.equal(await page.locator("p").evaluate((e) => getComputedStyle(e).fontSize), "22px");
  await page.locator("[contenteditable] span").evaluate((e) => { e.textContent = ""; });
  await page.waitForFunction(() => getComputedStyle(document.querySelector("p")).fontSize === "44px" && !__state().pending);
  assert.equal(await page.locator("[contenteditable]").innerHTML(), "<span></span>");
  await page.close();
});

test("designMode transitions synchronously restore author serialization and resume typography", async () => {
  const page = await prepare('<!doctype html><style>body{font:20px Arial}</style><p>Document editor</p>', {
    before: (page) => page.evaluate(() => { globalThis.__body = document.body.outerHTML; })
  });
  const state = await page.evaluate(() => {
    document.designMode = "on";
    return { body: document.body.outerHTML, expected: __body, styles: document.querySelectorAll('[id^="lexend-the-web-"]').length };
  });
  assert.equal(state.body, state.expected, "native designMode setter returns after existing ownership is released");
  assert.equal(state.styles, 0);
  await page.evaluate(() => { document.designMode = "off"; });
  await settled(page);
  assert.equal(await page.locator("p").evaluate((e) => getComputedStyle(e).fontSize), "22px");
  await page.close();
});

test("classified state and disclosure changes refresh authored typography and coalesce reverted states", async () => {
  const page = await prepare(`<!doctype html><style>
    body{font:20px/20px Arial}#state[data-state=large]{font-size:40px}
    details p{height:20px;width:160px;overflow:hidden;margin:0}
  </style><p id="state">Stateful prose</p><details><summary>Open disclosure</summary><p>Long disclosure text wraps and needs more space.</p></details>`, { inspect: true });
  const original = await page.evaluate(() => __state().refreshRevision);
  await page.evaluate(() => document.querySelector("#state").dataset.state = "large");
  await page.waitForFunction((revision) => __state().refreshRevision > revision && !__state().pending, original);
  assert.equal(await page.locator("#state").evaluate((e) => getComputedStyle(e).fontSize), "44px");
  await page.evaluate(() => document.querySelector("details").open = true);
  await page.waitForFunction(() => document.querySelector("details p").getBoundingClientRect().height > 20 && !__state().pending);
  const revision = await page.evaluate(() => __state().refreshRevision);
  await page.evaluate(async () => {
    const element = document.querySelector("#state");
    element.dataset.state = "small";
    await new Promise((resolve) => requestAnimationFrame(resolve));
    element.dataset.state = "large";
    element.dataset.unrelatedCounter = "1";
    document.querySelector("details").open = false;
    document.querySelector("details").open = true;
  });
  await page.waitForTimeout(300);
  await settled(page);
  assert.equal(await page.evaluate(() => __state().refreshRevision), revision, "reverted final state and unrelated data attributes do not recapture");
  assert.equal(await page.locator("#state").evaluate((e) => getComputedStyle(e).fontSize), "44px");
  await page.close();
});

test("pause disposes captured and root ownership, skips paused typography reads and rediscovers replacement roots", async () => {
  const page = await prepare('<!doctype html><style>body{font:20px Arial}</style><main id="components"></main>', {
    inspect: true, before: (page) => page.evaluate(() => {
      for (let i = 0; i < 30; i++) {
        const host = document.createElement("div");
        host.attachShadow({ mode: "open" }).innerHTML = '<p>Shadow reading text</p>';
        document.querySelector("main").append(host);
      }
    })
  });
  const active = await page.evaluate(() => ({ roots: __collections().styledRoots, baseline: __layoutCollections().baseline }));
  assert.equal(active.roots, 31);
  assert.ok(active.baseline >= 30);
  await page.evaluate(() => {
    __update({ enabled: false });
    globalThis.__removedRoots = [...document.querySelectorAll("main > div")].map((host) => new WeakRef(host.shadowRoot));
    document.querySelector("main").remove();
    globalThis.__reads = 0;
    const original = getComputedStyle;
    globalThis.getComputedStyle = (...args) => { __reads++; return original(...args); };
    const host = document.createElement("div"); host.id = "replacement";
    host.attachShadow({ mode: "open" }).innerHTML = '<p>Replacement shadow reading</p>';
    document.body.append(host);
    dispatchEvent(new Event("resize"));
    host.dispatchEvent(new Event("lexend-open-shadow-root", { bubbles: true, composed: true }));
    host.dispatchEvent(new Event("contentvisibilityautostatechange", { bubbles: true }));
    host.dispatchEvent(new Event("animationend", { bubbles: true }));
  });
  await page.waitForTimeout(250);
  const client = await page.context().newCDPSession(page);
  await client.send("HeapProfiler.collectGarbage");
  const paused = await page.evaluate(() => ({ roots: __collections(), layout: __layoutCollections(), reads: __reads,
    retainedRootsAfterGC: __removedRoots.filter((reference) => reference.deref()).length }));
  assert.ok(Object.values(paused.roots).every((n) => n === 0), JSON.stringify(paused.roots));
  assert.ok(Object.values(paused.layout).every((n) => n === 0), JSON.stringify(paused.layout));
  assert.equal(paused.reads, 0);
  assert.equal(paused.retainedRootsAfterGC, 0, "removed shadow roots become collectible after pause disposes runtime ownership");
  await page.evaluate(() => __update({ enabled: true }));
  await settled(page);
  assert.match(await page.locator("#replacement").evaluate((e) => getComputedStyle(e.shadowRoot.querySelector("p")).fontFamily), /Lexend/);
  assert.equal(await page.evaluate(() => __collections().styledRoots), 2);
  await page.close();
});
