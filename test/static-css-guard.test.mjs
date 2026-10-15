import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
import test from "node:test";
import { chromium } from "playwright";
import { runtimeScriptPaths } from "../scripts/performance/runtime-resources.mjs";
import { replaceExactlyOnce } from "./helpers/conversation.mjs";

const sourceRoot = resolve(process.env.LEXEND_TEST_SOURCE ?? ".");
const manifest = JSON.parse(await readFile(resolve(sourceRoot, "manifests/manifest.chrome.json"), "utf8"));
const paths = runtimeScriptPaths(manifest), origin = "http://static-css-guard.test";
let browser;
test.before(async () => { browser = await chromium.launch({ headless: true }); });
test.after(async () => { await browser?.close(); });

const prepare = async ({ masked = false, reaction = false, variant = "candidate" } = {}) => {
  const page = await browser.newPage({ viewport: { width: 1200, height: 800 } });
  try {
    await page.route(`${origin}/**`, (route) => readFile(resolve(sourceRoot, new URL(route.request().url()).pathname.slice(1)))
      .then((body) => route.fulfill({ body, contentType: "font/woff2" })));
    await page.setContent(`<!doctype html><style>
      body{margin:12px;font:16px/20px Arial;--callback-font:25px}p{margin:0}
      #outside-clip{width:150px;height:20px;max-height:20px;overflow:hidden}
      #outside{display:block}#component{display:block;position:relative;width:300px;height:200px;
        contain:strict;overflow:auto;font:16px/20px Arial}
    </style><section id="outside-clip"><p id="outside"${masked ? ' style="font-size:var(--registered-font,16px)!important;line-height:40px!important"' : ""}>Readable outside text needs several complete lines.</p></section><div id="component"></div>`);
    await page.evaluate(({ reaction }) => {
      globalThis.__guardScratchWrites = 0;
      const descriptor = Object.getOwnPropertyDescriptor(CSSStyleDeclaration.prototype, "cssText");
      Object.defineProperty(CSSStyleDeclaration.prototype, "cssText", { ...descriptor, set(value) {
        if (this === globalThis.__guardScratch) __guardScratchWrites++;
        return descriptor.set.call(this, value);
      } });
      globalThis.__regionCalls = 0;
      globalThis.__reactionArmed = false;
      globalThis.__reactionCalls = 0;
      if (reaction) customElements.define("guard-reaction", class extends HTMLElement {
        static get observedAttributes() { return ["data-lexend-text"]; }
        attributeChangedCallback(name, before, after) {
          if (!__reactionArmed || before === after) return;
          __reactionArmed = false;
          __reactionCalls++;
          const outside = document.querySelector("#outside"), authored = __expectedBody.querySelector("#outside");
          for (const element of [outside, authored]) {
            element.style.setProperty("font-size", "var(--callback-font)", "important");
            element.style.setProperty("line-height", "40px", "important");
          }
        }
      });
      const root = document.querySelector("#component").attachShadow({ mode: "open" });
      root.innerHTML = `<style>p,guard-reaction{display:block;margin:0}#clip{height:20px;max-height:20px;overflow:hidden}</style><section id="clip"><${reaction ? "guard-reaction" : "p"} id="stream">Read this reply.</${reaction ? "guard-reaction" : "p"}></section>`;
      globalThis.__root = root;
      for (const element of document.querySelectorAll("[style]")) element.style.cssText = element.style.cssText;
      globalThis.__expectedBody = document.body.cloneNode(true);
      globalThis.__expectedRoot = document.createElement("div");
      __expectedRoot.innerHTML = root.innerHTML;
      const storage = [], runtime = [];
      globalThis.__settings = { enabled: true, scope: "all", textScale: 120 };
      globalThis.chrome = {
        runtime: { getURL: (path) => `http://static-css-guard.test/${path}`, sendMessage: async () => {}, onMessage: { addListener: (fn) => runtime.push(fn) } },
        storage: { sync: { get: async () => __settings }, onChanged: { addListener: (fn) => storage.push(fn) } }
      };
      globalThis.__state = () => {
        let value; runtime.forEach((fn) => fn({ type: "LEXEND_GET_STATE" }, null, (state) => { value = state; })); return value;
      };
      globalThis.__update = (values) => {
        Object.assign(__settings, values);
        const changes = Object.fromEntries(Object.entries(values).map(([key, newValue]) => [key, { newValue }]));
        storage.forEach((fn) => fn(changes, "sync"));
      };
      globalThis.__view = () => {
        const outside = document.querySelector("#outside"), clip = outside.parentElement;
        const range = document.createRange(); range.selectNodeContents(outside);
        return { font: parseFloat(getComputedStyle(outside).fontSize), line: getComputedStyle(outside).lineHeight,
          clip: clip.getBoundingClientRect().toJSON(), text: range.getBoundingClientRect().toJSON(),
          html: outside.outerHTML, root: __root.innerHTML };
      };
    }, { reaction });
    for (const path of paths) {
      let source = await readFile(resolve(sourceRoot, path), "utf8");
      if (path === "src/content.js") {
        await page.evaluate(() => {
          const factory = LexendLayout;
          globalThis.LexendLayout = Object.freeze({ ...factory, create(options) {
            const owner = factory.create(options);
            return Object.freeze({ ...owner, withRegion(...args) { __regionCalls++; return owner.withRegion(...args); } });
          } });
        });
        if (variant === "canonical") source = replaceExactlyOnce(source, "          if (staticInline) continue;",
          "          if (false && staticInline) continue;", "force existing canonical fallback");
        if (variant === "unsafe-raw") source = replaceExactlyOnce(source,
          "          if (staticInline) for (const property of managedElements.get(element)?.properties.values() ?? []) {",
          "          if (false && staticInline) for (const property of managedElements.get(element)?.properties.values() ?? []) {", "unsafe masked-original omission");
        source = replaceExactlyOnce(source, '  const authorStyle = document.createElement("span").style;',
          '  const authorStyle = document.createElement("span").style;\n  globalThis.__guardScratch = authorStyle;', "identify actual canonical native scratch");
        source = replaceExactlyOnce(source, "  start().finally(() => {", `  globalThis.__guardProbe = {
    snapshot: () => snapshotAuthorStylesheets(),
    original: (element, name) => managedElements.get(element)?.properties.get(name)?.value
  };
  start().finally(() => {`, "read-only certificate/original probes");
      }
      await page.addScriptTag({ content: source });
    }
    await page.evaluate(() => document.fonts.ready);
    await page.waitForFunction(() => __state()?.healthy && !__state().pending && document.fonts.status === "loaded");
    return page;
  } catch (error) { await page.close(); throw error; }
};
const grow = async (page, { register = false, arm = false } = {}) => {
  const before = await page.evaluate(({ register, arm }) => {
    if (register) CSS.registerProperty({ name: "--registered-font", syntax: "<length>", inherits: false, initialValue: "25px" });
    __reactionArmed = arm;
    __guardScratchWrites = 0;
    __regionCalls = 0;
    const revision = __state().refreshRevision;
    const addition = " A complete explanation needs more room inside this component.".repeat(4);
    __root.querySelector("#stream").firstChild.data += addition;
    __expectedRoot.querySelector("#stream").firstChild.data += addition;
    return revision;
  }, { register, arm });
  await page.waitForFunction((before) => __state().healthy && !__state().pending && __state().refreshRevision > before
    && document.fonts.status === "loaded", before);
  return page.evaluate(() => ({ view: __view(), canonicalWrites: __guardScratchWrites, regions: __regionCalls, reactions: __reactionCalls }));
};
const pauseExactly = async (page) => {
  const before = await page.evaluate(() => { const before = __state().refreshRevision; __update({ enabled: false }); return before; });
  await page.waitForFunction((before) => __state().healthy && !__state().pending && !__state().active && __state().refreshRevision > before, before);
  assert.deepEqual(await page.evaluate(() => ({ body: document.body.outerHTML, expectedBody: __expectedBody.outerHTML,
    root: __root.innerHTML, expectedRoot: __expectedRoot.innerHTML })),
  await page.evaluate(() => ({ body: __expectedBody.outerHTML, expectedBody: __expectedBody.outerHTML,
    root: __expectedRoot.innerHTML, expectedRoot: __expectedRoot.innerHTML })), "pause preserves exact author markup and declaration priorities");
};
const assertRegisteredTypography = (result) => {
  assert.equal(result.view.font, 30, "registered author variable resolves to 25px native and 30px converted");
  assert.ok(result.view.text.bottom <= result.view.clip.bottom + 1, "larger outside glyphs remain inside their repaired clip");
};

const assertStaticBudget = (result) => assert.equal(result.canonicalWrites, 0,
  "the actual detached native canonical scratch receives no cssText assignments for static regional work");

test("static inline styles avoid native canonical scratch parsing while preserving canonical geometry and pause", async () => {
  const candidate = await prepare(), canonical = await prepare({ variant: "canonical" });
  try {
    const fast = await grow(candidate), full = await grow(canonical);
    assert.ok(fast.regions > 0 && full.regions > 0, "both variants execute real regional ownership transactions");
    assertStaticBudget(fast);
    assert.ok(full.canonicalWrites > 0, "forced existing normalization demonstrably parses its native scratch");
    assert.throws(() => assertStaticBudget(full), /native canonical scratch/, "the unchanged work budget rejects the real canonical control");
    assert.deepEqual(fast.view, full.view);
    const lexicalCases = async (page) => page.evaluate(() => {
      const cases = [
        "font-size:16px;/* harmless author comment */line-height:40px",
        "font-size:var(/* author token */ --guard-font,16px)",
        "font-size:v\\61 r(--guard-font,16px)",
        "--unused:v/**/ar(--guard-font);font-size:16px",
        `content:'"';font-size:16px`,
        `font-family:'A"B';font-size:16px`,
        ...[0, 1, 9, 10, 13, 31, 127].map((code) => `content:"${String.fromCharCode(code)}";font-size:16px`)
      ];
      return cases.map((cssText) => {
        const element = document.createElement("aside");
        element.setAttribute("style", cssText); document.body.append(element);
        __guardScratchWrites = 0;
        const result = { canonical: element.style.cssText, eligible: __guardProbe.snapshot() !== null,
          writes: __guardScratchWrites };
        element.remove(); return result;
      });
    });
    const lexicalFast = await lexicalCases(candidate), lexicalFull = await lexicalCases(canonical);
    assert.deepEqual(lexicalFast.map(({ canonical, eligible }) => ({ canonical, eligible })),
      lexicalFull.map(({ canonical, eligible }) => ({ canonical, eligible })), "comments, escapes, quote normalization and C0/DEL strings retain exact old canonical decisions");
    assert.ok(lexicalFast.every(({ writes }) => writes > 0), "unsupported lexical inputs really use the native canonical scratch");
    await pauseExactly(candidate); await pauseExactly(canonical);
  } finally { await candidate.close(); await canonical.close(); }
});

test("masked original var() keeps full fallback after native registration; raw-only control fails the same typography assertion", async () => {
  const candidate = await prepare({ masked: true }), broken = await prepare({ masked: true, variant: "unsafe-raw" });
  try {
    assert.match(await candidate.evaluate(() => __guardProbe.original(document.querySelector("#outside"), "font-size")), /var\(/);
    const correct = await grow(candidate, { register: true }), unsafe = await grow(broken, { register: true });
    assertRegisteredTypography(correct);
    assert.equal(correct.regions, 0, "the saved dynamic author original prevents partial entry");
    assert.ok(unsafe.regions > 0, "the intentionally raw-only variant actually executes the unsafe partial path");
    assert.throws(() => assertRegisteredTypography(unsafe), /registered author variable/, "the unchanged semantic assertion rejects ignoring masked originals");
    await pauseExactly(candidate);
  } finally { await candidate.close(); await broken.close(); }
});
