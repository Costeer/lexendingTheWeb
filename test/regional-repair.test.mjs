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

const prepare = async ({ components = 1, unsupported = null, forceFull = false, guardProbe = false, traceRegions = false, reactionProbe = null } = {}) => {
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
      ${reactionProbe === "style-presence" ? "#distant[style] #distant-0{font-size:25px!important;line-height:40px!important}" : ""}
      ${reactionProbe === "checkbox" ? "#reaction-checkbox:checked + #distant #distant-0{font-size:25px!important;line-height:40px!important}" : ""}
      ${reactionProbe === "hash" ? "#distant-0:target{font-size:25px!important;line-height:40px!important}" : ""}
      ${reactionProbe === "escaped-selector" ? "#distant:l\\61ng(en) #distant-0{font-size:25px!important;line-height:40px!important}" : ""}
      ${reactionProbe === "font-membership" ? '#distant-0{font-family:"Regional Membership",Arial}' : ""}
      .component{display:block;position:relative;width:300px;height:200px;
        contain:strict;overflow:auto;font:16px/20px Arial;margin-top:12px}
    </style>${reactionProbe === "checkbox" ? '<input id="reaction-checkbox" type="checkbox" hidden>' : ""}
    ${reactionProbe === "native-value" ? '<input id="reaction-value" value="Original author value">' : ""}
    <main id="distant"${reactionProbe === "escaped-selector" ? ' lang="fr"' : ""}>${Array.from({ length: 60 }, (_, i) =>
      `<section class="distant-clip"><p class="distant-text" id="distant-${i}">Readable label number ${i} with a complete explanation.</p></section>`).join("")}</main>
    ${Array.from({ length: components }, (_, i) => `<div class="component" id="component-${i}"></div>`).join("")}`);
    await page.evaluate(({ components, unsupported, text, reactionProbe }) => {
      globalThis.__roots = [];
      if (reactionProbe) {
        globalThis.__reactionArmed = false;
        globalThis.__reactionCount = 0;
        globalThis.__reactionLog = [];
        customElements.define("regional-reaction", class extends HTMLElement {
          static get observedAttributes() { return ["data-lexend-text"]; }
          attributeChangedCallback(name, oldValue, newValue) {
            if (!__reactionArmed || oldValue === newValue) return;
            __reactionArmed = false;
            __reactionCount++;
            const outside = document.querySelector("#distant-0");
            const record = { kind: reactionProbe, name, oldValue, newValue, connected: this.isConnected,
              insideRegional: globalThis.__insideRegional === true };
            if (reactionProbe === "direct-style") {
              const authored = __authorBody.querySelector("#distant-0");
              outside.style.setProperty("font-size", "25px", "important");
              authored.style.setProperty("font-size", "25px", "important");
              outside.style.setProperty("line-height", "40px", "important");
              authored.style.setProperty("line-height", "40px", "important");
              const addition = " The page reaction preserves this newly authored text as well.";
              outside.firstChild.data += addition;
              authored.firstChild.data += addition;
            }
            if (reactionProbe === "style-presence") {
              const target = document.querySelector("#distant");
              record.outsideOldStyle = target.getAttribute("style");
              target.setAttribute("style", "");
              __authorBody.querySelector("#distant").setAttribute("style", "");
              record.outsideNewStyle = target.getAttribute("style");
            }
            if (reactionProbe === "cssom") {
              const sheet = document.querySelector("#author-style").sheet;
              sheet.insertRule("#distant-0{font-size:25px!important;line-height:40px!important}", sheet.cssRules.length);
            }
            if (reactionProbe === "finished-animation") {
              const animation = outside.parentElement.animate([{ width: "90px" }, { width: "90px" }],
                { duration: 0, fill: "forwards" });
              animation.finish();
              globalThis.__reactionAnimation = animation;
              record.animationState = animation.playState;
            }
            if (reactionProbe === "internal-mutations") {
              const child = document.createElement("p");
              child.id = "reaction-new";
              child.textContent = "New page-owned text added by the synchronous custom-element reaction.";
              __roots[0].querySelector("#clip").append(child);
              __authorRoots[0].querySelector("#clip").append(child.cloneNode(true));
            }
            if (reactionProbe === "checkbox") {
              const checkbox = document.querySelector("#reaction-checkbox");
              record.checkedBefore = checkbox.checked;
              record.checkedAttributeBefore = checkbox.getAttribute("checked");
              checkbox.checked = true;
              __authorBody.querySelector("#reaction-checkbox").checked = true;
              record.checkedAfter = checkbox.checked;
              record.checkedAttributeAfter = checkbox.getAttribute("checked");
            }
            if (reactionProbe === "native-value") {
              const input = document.querySelector("#reaction-value");
              record.valueBefore = input.value;
              record.valueAttributeBefore = input.getAttribute("value");
              input.value = "Retained author value";
              __authorBody.querySelector("#reaction-value").value = input.value;
              record.valueAfter = input.value;
              record.valueAttributeAfter = input.getAttribute("value");
            }
            if (reactionProbe === "hash") {
              record.hashBefore = location.hash;
              location.hash = "distant-0";
              record.hashAfter = location.hash;
            }
            if (reactionProbe === "escaped-selector") {
              const target = document.querySelector("#distant");
              record.selectorMatchedBefore = target.matches(":l\\61ng(en)");
              target.lang = "en";
              __authorBody.querySelector("#distant").lang = "en";
              record.selectorMatchedAfter = target.matches(":l\\61ng(en)");
            }
            if (reactionProbe === "font-membership") {
              record.fontMemberBefore = document.fonts.has(__reactionFont);
              record.fontStatusBefore = __reactionFont.status;
              document.fonts.add(__reactionFont);
              record.fontMemberAfter = document.fonts.has(__reactionFont);
              record.fontStatusAfter = __reactionFont.status;
            }
            __reactionLog.push(record);
          }
        });
      }
      for (let i = 0; i < components; i++) {
        const host = document.getElementById(`component-${i}`);
        const root = host.attachShadow({ mode: "open" });
        const tag = reactionProbe ? "regional-reaction" : "p";
        root.innerHTML = `<style id="component-author-style">p{margin:0}#clip{height:20px;max-height:20px;overflow:hidden}
          #stream{display:block}</style><section id="clip"><${tag} id="stream">${text}</${tag}></section>`;
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
      if (unsupported === "outside-slots") {
        const host = document.createElement("div");
        host.id = "outside-slot-host";
        host.style.cssText = "display:block;width:300px;height:120px;contain:strict;overflow:auto;font:16px/20px Arial";
        host.innerHTML = '<span id="outside-assigned-label">A real manually assigned label in a separate component.</span>';
        document.body.append(host);
        const root = host.attachShadow({ mode: "open", slotAssignment: "manual" });
        root.innerHTML = '<style>slot{display:block}</style><slot></slot>';
        root.querySelector("slot").assign(host.firstElementChild);
        globalThis.__outsideSlotRoot = root;
        globalThis.__outsideSlotAuthor = root.innerHTML;
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
      globalThis.__reactionOutside = () => {
        const element = document.querySelector("#distant-0"), clip = element.parentElement;
        const range = document.createRange();
        range.selectNodeContents(element);
        return { size: __native.style(element).fontSize, clip: __native.box.call(clip).toJSON(),
          text: [...__native.rangeRects.call(range)].map((box) => box.toJSON()), content: element.textContent,
          style: element.getAttribute("style"), mainStyle: document.querySelector("#distant").getAttribute("style") };
      };
    }, { components, unsupported, text, reactionProbe });
    for (const path of scriptPaths) {
      let source = await readFile(resolve(sourceRoot, path), "utf8");
      if (forceFull && path === "src/content.js") {
        source = replaceExactlyOnce(source,
          "    const regionalRoots = regionalMutationRoots(needsRefresh);",
          "    const regionalRoots = null;", "forced full routing regional negative control");
      }
      await page.addScriptTag({ content: source });
      if (traceRegions && path === "src/adaptive-layout.js") await page.evaluate(() => {
        const api = LexendLayout;
        globalThis.__regionalCalls = [];
        globalThis.__insideRegional = false;
        globalThis.LexendLayout = Object.freeze({ ...api, create(options) {
          const owner = api.create(options);
          if (typeof owner.withRegion !== "function") throw new Error("Regional callback probe requires the actual ownership API");
          return Object.freeze({ ...owner, withRegion(root, callback) {
            const record = { startedAt: performance.now() };
            const previous = __insideRegional;
            __insideRegional = true;
            try { return owner.withRegion(root, callback); }
            finally {
              record.finishedAt = performance.now();
              record.content = root.querySelector("#stream")?.textContent;
              __regionalCalls.push(record);
              __insideRegional = previous;
            }
          } });
        } });
      });
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
  for (const unsupported of ["containment", "slot", "outside-slots", "nested-shadow", "light-child", "editor", "dir-auto", "managed-ancestor", "protected"]) {
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
      if (unsupported === "outside-slots") {
        assertExpanded(result.roots[0], initial.roots[0]);
        assert.deepEqual(await page.evaluate(() => ({
          manual: __outsideSlotRoot.slotAssignment,
          assigned: __outsideSlotRoot.querySelector("slot").assignedNodes().map((node) => node.id),
          painted: __native.rects.call(document.querySelector("#outside-assigned-label")).length > 0
        })), { manual: "manual", assigned: ["outside-assigned-label"], painted: true },
        "the unrelated discovered root has a real rendered manual slot assignment");
      }
      await assertRestored(page);
      if (unsupported === "outside-slots") assert.equal(await page.evaluate(() => __outsideSlotRoot.innerHTML),
        await page.evaluate(() => __outsideSlotAuthor), "pause also restores the unrelated manual-slot shadow root exactly");
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

test("regional text deliveries keep one fixed deadline and urgent global changes upgrade it", async () => {
  const { page, initial } = await prepare({ traceRegions: true });
  const token = "New words. ";
  try {
    const result = await page.evaluate(async (token) => {
      const nativeTimeout = setTimeout.bind(globalThis), nativeClear = clearTimeout.bind(globalThis);
      const nativeNow = performance.now.bind(performance);
      // Move beyond the completed startup's measured cooldown. A controlled
      // advancing clock makes deadline postponement visible without depending
      // on the host's speed. Actual queued runtime callbacks remain unchanged.
      let clock = nativeNow() + 10_000, nextId = 100_000;
      const tasks = new Map(), scheduled = [], canceled = [], observations = [];
      const describe = (task) => ({ id: task.id, delay: task.delay, due: task.due });
      performance.now = () => clock;
      globalThis.setTimeout = (callback, delay = 0, ...args) => {
        const task = { id: ++nextId, delay, due: clock + delay, callback: () => callback(...args) };
        tasks.set(task.id, task);
        scheduled.push(describe(task));
        return task.id;
      };
      globalThis.clearTimeout = (id) => { canceled.push(id); tasks.delete(id); };
      const runNext = async () => {
        const task = [...tasks.values()].sort((a, b) => a.due - b.due)[0];
        if (!task) throw new Error("No actual runtime callback was queued");
        tasks.delete(task.id);
        clock = task.due;
        task.callback();
        await Promise.resolve();
      };
      const snapshot = () => ({ reads: { ...__reads }, roots: __roots.map((_, i) => __inspectRoot(i)), state: __state() });
      try {
        for (let i = 0; i < 20; i++) {
          __append(0, token);
          await Promise.resolve();
          observations.push({ pending: __state().pending, tasks: [...tasks.values()].map(describe) });
          clock++;
        }
        const localScheduled = scheduled.slice(), localRevision = __state().refreshRevision;
        await runNext();
        const first = snapshot(), firstCalls = __regionalCalls.slice(), localRemaining = tasks.size;
        __resetReads();
        __append(0, "Final words. ");
        await Promise.resolve();
        const beforeUpgrade = [...tasks.values()].map(describe), scheduleOffset = scheduled.length;
        const html = '<section class="distant-clip"><p class="distant-text" id="urgent-new">New global reading content</p></section>';
        document.querySelector("#distant").insertAdjacentHTML("beforeend", html);
        __authorBody.querySelector("#distant").insertAdjacentHTML("beforeend", html);
        await Promise.resolve();
        const afterUpgrade = [...tasks.values()].map(describe), upgradeScheduled = scheduled.slice(scheduleOffset);
        await runNext();
        return { observations, localScheduled, localRevision, first, firstCalls, localRemaining,
          beforeUpgrade, afterUpgrade, upgradeScheduled, canceled, final: snapshot(), finalRemaining: tasks.size,
          insertedFont: __native.style(document.querySelector("#urgent-new")).fontFamily };
      } finally {
        globalThis.setTimeout = nativeTimeout;
        globalThis.clearTimeout = nativeClear;
        performance.now = nativeNow;
      }
    }, token);
    assert.equal(result.localScheduled.length, 1, "twenty observer deliveries schedule only one regional callback");
    assert.equal(result.localScheduled[0].delay, 100, "regional text uses the existing 100 ms coalescing window");
    for (const observation of result.observations) {
      assert.equal(observation.pending, true);
      assert.deepEqual(observation.tasks, result.localScheduled, "incoming tokens never postpone the original deadline");
    }
    assert.equal(result.localRevision, initial.state.refreshRevision, "capturing incoming tokens does not run repair synchronously");
    assert.equal(result.firstCalls.length, 1, "the actual callback completes one regional ownership transaction");
    assert.equal(result.first.state.refreshRevision, initial.state.refreshRevision + 1);
    assert.equal(result.first.state.healthy, true);
    assert.equal(result.first.state.pending, false);
    assert.equal(result.localRemaining, 0);
    assert.equal(result.first.roots[0].content, text + token.repeat(20));
    assertExpanded(result.first.roots[0], initial.roots[0]);
    assertLocalWork(result.first);
    assert.equal(result.beforeUpgrade.length, 1);
    assert.equal(result.beforeUpgrade[0].delay, 100);
    assert.equal(result.afterUpgrade.length, 1);
    assert.equal(result.upgradeScheduled.length, 1);
    assert.equal(result.afterUpgrade[0].delay, 0, "urgent child-list work replaces the regional wait with an immediate task");
    assert.notEqual(result.afterUpgrade[0].id, result.beforeUpgrade[0].id);
    assert.ok(result.canceled.includes(result.beforeUpgrade[0].id), "the earlier regional timer is canceled");
    assert.ok(result.final.reads.styles > 0 && result.final.reads.ranges > 0, "the urgent callback performs the full global repair");
    assert.equal(result.final.state.healthy, true);
    assert.equal(result.final.state.pending, false);
    assert.equal(result.finalRemaining, 0);
    assert.equal(result.final.roots[0].content, text + token.repeat(20) + "Final words. ");
    assert.match(result.insertedFont, /Lexend/);
    await assertRestored(page);
  } finally { await page.close(); }
});

test("real timed text arrivals coalesce and complete regional repairs before the stream ends", async () => {
  const { page, initial } = await prepare({ traceRegions: true });
  const token = "Stream words. ", edits = 24, intervalMs = 30;
  try {
    const stream = await page.evaluate(async ({ token, edits, intervalMs }) => {
      globalThis.__regionalNativeNow = performance.now.bind(performance);
      // Keep the native clock advancing and all browser timers real. The fixed
      // offset only expires the startup cooldown before this focused stream.
      performance.now = () => __regionalNativeNow() + 10_000;
      const startedAt = performance.now(), arrivals = [];
      await new Promise((done) => {
        for (let i = 0; i < edits; i++) setTimeout(() => {
          __append(0, token);
          arrivals.push({ index: i, scheduledAt: startedAt + (i + 1) * intervalMs, deliveredAt: performance.now() });
          if (arrivals.length === edits) done();
        }, (i + 1) * intervalMs);
      });
      return { startedAt, arrivals };
    }, { token, edits, intervalMs });
    await settleAfter(page, initial.state.refreshRevision);
    const result = await inspect(page), calls = await page.evaluate(() => __regionalCalls);
    assert.equal(stream.arrivals.length, edits, "every native timed edit is delivered");
    assert.ok(stream.arrivals.at(-1).deliveredAt - stream.arrivals[0].deliveredAt > 100,
      "the real arrivals span multiple coalescing windows");
    assert.ok(calls.length > 0 && calls.length < edits,
      `the actual stream completes bounded coalesced work, rather than one repair for each of ${edits} edits (got ${calls.length})`);
    assert.ok(calls.some((call) => call.finishedAt < stream.arrivals.at(-1).deliveredAt
      && call.content !== text + token.repeat(edits)), "regional repair makes progress before the final native arrival");
    assert.equal(result.state.refreshRevision - initial.state.refreshRevision, calls.length);
    assert.equal(result.state.healthy, true);
    assert.equal(result.state.pending, false);
    assert.equal(result.roots[0].content, text + token.repeat(edits), "the final coalesced repair retains every delivered token");
    assertExpanded(result.roots[0], initial.roots[0]);
    assertLocalWork(result);
    assert.deepEqual(result.distant, initial.distant);
    await assertRestored(page);
  } finally {
    await page.evaluate(() => { if (globalThis.__regionalNativeNow) performance.now = __regionalNativeNow; });
    await page.close();
  }
});

test("synchronous custom-element reactions cannot escape a regional transaction before paint", async () => {
  const forceFull = process.env.LEXEND_REACTION_FORCE_FULL === "1";
  for (const reactionProbe of ["direct-style", "style-presence", "cssom", "finished-animation", "internal-mutations"]) {
    const { page, initial } = await prepare({ reactionProbe, forceFull, traceRegions: true });
    try {
      const before = await page.evaluate(() => __reactionOutside());
      assert.equal(await page.evaluate(() => __reactionCount), 0, "startup reactions remain unarmed");
      if (reactionProbe === "style-presence") assert.equal(before.mainStyle, null,
        "the author selector starts with a genuinely absent style attribute");
      await page.evaluate((value) => {
        globalThis.__reactionPaints = [];
        globalThis.__watchReactionPaints = true;
        const sample = () => {
          __reactionPaints.push({ count: __reactionCount, outside: __reactionOutside() });
          if (__watchReactionPaints) requestAnimationFrame(sample);
        };
        requestAnimationFrame(sample);
        __reactionArmed = true;
        __append(0, value);
      }, addition);
      await settleAfter(page, initial.state.refreshRevision);
      await page.evaluate(() => new Promise((done) => requestAnimationFrame(() => requestAnimationFrame(done))));
      const result = await inspect(page);
      const reaction = await page.evaluate(() => {
        __watchReactionPaints = false;
        const added = __roots[0].querySelector("#reaction-new");
        return { count: __reactionCount, log: __reactionLog, outside: __reactionOutside(), paints: __reactionPaints,
          added: added && { family: __native.style(added).fontFamily, size: __native.style(added).fontSize,
            content: added.textContent }, animationState: globalThis.__reactionAnimation?.playState, regionalCalls: __regionalCalls };
      });
      assert.equal(reaction.count, 1, `${reactionProbe}: a real native attribute reaction must execute once`);
      assert.equal(reaction.log[0].connected, true);
      assert.equal(reaction.log[0].name, "data-lexend-text");
      assert.equal(reaction.log[0].oldValue, "");
      assert.equal(reaction.log[0].newValue, null, "the page callback synchronously answers actual runtime marker removal");
      if (forceFull) {
        assert.equal(reaction.regionalCalls.length, 0, "the diagnostic full-routing control bypasses regional transactions");
        assert.equal(reaction.log[0].insideRegional, false);
      } else {
        assert.ok(reaction.regionalCalls.length > 0,
          `the actual page callback must exercise a regional transaction; ${JSON.stringify({ reactionProbe, log: reaction.log, reads: result.reads })}`);
        assert.equal(reaction.log[0].insideRegional, true, "the native reaction actually executes while regional ownership is active");
      }
      const expectedSize = ["direct-style", "style-presence", "cssom"].includes(reactionProbe) ? "30px" : "19.2px";
      assert.equal(reaction.outside.size, expectedSize,
        `${reactionProbe}: outside author metrics must be recaptured and converted; ${JSON.stringify({ log: reaction.log, outside: reaction.outside })}`);
      if (reactionProbe !== "internal-mutations") assert.ok(reaction.outside.clip.height > before.clip.height + 20,
        `${reactionProbe}: actual outside clipping must be repaired using the changed author metrics`);
      const assertOutsideFits = (outside) => {
        for (const box of outside.text) assert.ok(box.top >= outside.clip.top - 2 && box.bottom <= outside.clip.bottom + 2,
          `${reactionProbe}: reacted outside glyphs remain inside their repaired clipping surface; ${JSON.stringify({ forceFull, outside, log: reaction.log, regionalCalls: reaction.regionalCalls })}`);
      };
      assertOutsideFits(reaction.outside);
      assert.ok(result.reads.styles > 0 && result.reads.ranges > 0,
        `${reactionProbe}: the reaction invalidates the region and actually measures the full page`);
      assertExpanded(result.roots[0], initial.roots[0]);
      if (reactionProbe === "direct-style") {
        assert.match(reaction.outside.content, /newly authored text as well\.$/);
        assert.match(reaction.outside.style, /font-size:\s*30px\s*!important/);
      }
      if (reactionProbe === "style-presence") {
        assert.equal(reaction.log[0].outsideOldStyle, null);
        assert.equal(reaction.log[0].outsideNewStyle, "", "empty author style presence must not collapse into absence");
      }
      if (reactionProbe === "finished-animation") {
        assert.equal(reaction.log[0].animationState, "finished");
        assert.equal(reaction.animationState, "finished", "the page's filled finished effect remains in force");
        assert.equal(reaction.outside.clip.width, 90);
      }
      if (reactionProbe === "internal-mutations") {
        assert.ok(reaction.added, "the custom callback actually inserts new internal author content");
        assert.match(reaction.added.family, /Lexend/);
        assert.equal(reaction.added.size, "19.2px");
      }
      const reactedPaints = reaction.paints.filter((paint) => paint.count > 0);
      assert.ok(reactedPaints.length > 0, "observe painted frames after the actual page callback");
      for (const paint of reactedPaints) {
        assert.equal(paint.outside.size, expectedSize, `${reactionProbe}: no reacted frame paints unconverted outside typography`);
        assertOutsideFits(paint.outside);
      }
      await assertRestored(page);
      if (reactionProbe === "direct-style") assert.equal(await page.locator("#distant-0").evaluate((element) =>
        [element.style.getPropertyValue("font-size"), element.style.getPropertyPriority("font-size")].join("/")), "25px/important");
    } finally { await page.close(); }
  }
});

test("native checkbox, value and target state changes cannot escape a page reaction", async () => {
  const forceFull = process.env.LEXEND_REACTION_FORCE_FULL === "1";
  for (const reactionProbe of ["checkbox", "native-value", "hash", "escaped-selector", "font-membership"]) {
    const { page, initial } = await prepare({ reactionProbe, forceFull, traceRegions: true });
    try {
      if (reactionProbe === "font-membership") {
        const face = await page.evaluate(async () => {
          globalThis.__reactionFont = new FontFace("Regional Membership", 'url("http://regional-repair.test/author-transition.woff2")');
          await __reactionFont.load();
          globalThis.__reactionFontEvents = 0;
          document.fonts.addEventListener("loadingdone", (event) => {
            if (event.fontfaces.includes(__reactionFont)) __reactionFontEvents++;
          });
          return { status: __reactionFont.status, member: document.fonts.has(__reactionFont) };
        });
        assert.deepEqual(face, { status: "loaded", member: false }, "preload the real font without changing the document's font membership");
      }
      const before = await page.evaluate(() => __reactionOutside());
      assert.equal(await page.evaluate(() => __reactionCount), 0, "startup leaves the native state reaction unarmed");
      await page.evaluate((value) => {
        globalThis.__nativeStatePaints = [];
        globalThis.__watchNativeStatePaints = true;
        const sample = () => {
          __nativeStatePaints.push({ count: __reactionCount, outside: __reactionOutside() });
          if (__watchNativeStatePaints) requestAnimationFrame(sample);
        };
        requestAnimationFrame(sample);
        __reactionArmed = true;
        __append(0, value);
      }, addition);
      await settleAfter(page, initial.state.refreshRevision);
      await page.evaluate(() => new Promise((done) => requestAnimationFrame(() => requestAnimationFrame(done))));
      const result = await inspect(page);
      const reaction = await page.evaluate(() => {
        __watchNativeStatePaints = false;
        return { count: __reactionCount, log: __reactionLog, outside: __reactionOutside(),
          paints: __nativeStatePaints, regionalCalls: __regionalCalls };
      });
      assert.equal(reaction.count, 1, `${reactionProbe}: a real page custom-element callback changes native state once`);
      const record = reaction.log[0];
      assert.equal(record.name, "data-lexend-text");
      assert.equal(record.oldValue, "");
      assert.equal(record.newValue, null);
      assert.equal(record.connected, true);
      const witnessedState = ["native-value", "font-membership"].includes(reactionProbe);
      const expectedSize = witnessedState ? "19.2px" : "30px";
      assert.equal(reaction.outside.size, expectedSize,
        `${reactionProbe}: native state selectors must receive fresh converted metrics; ${JSON.stringify({ forceFull, record, outside: reaction.outside, regionalCalls: reaction.regionalCalls })}`);
      if (!witnessedState) assert.ok(reaction.outside.clip.height > before.clip.height + 20,
        `${reactionProbe}: the native state change requires actual new outside clipping repair`);
      const assertOutsideFits = (outside) => {
        for (const box of outside.text) assert.ok(box.top >= outside.clip.top - 2 && box.bottom <= outside.clip.bottom + 2,
          `${reactionProbe}: native-state glyphs remain inside their repaired surface; ${JSON.stringify(outside)}`);
      };
      assertOutsideFits(reaction.outside);
      assert.ok(result.reads.styles > 0 && result.reads.ranges > 0,
        `${reactionProbe}: native page state changes require a complete measured fallback`);
      if (forceFull || !witnessedState) {
        assert.equal(reaction.regionalCalls.length, 0, `${reactionProbe}: volatile selectors conservatively select a full repair`);
        assert.equal(record.insideRegional, false);
      } else {
        assert.ok(reaction.regionalCalls.length > 0, `${reactionProbe}: the fixture actually exercises the regional native state witness`);
        assert.equal(record.insideRegional, true);
      }
      if (reactionProbe === "checkbox") {
        assert.equal(record.checkedBefore, false);
        assert.equal(record.checkedAfter, true);
        assert.equal(record.checkedAttributeBefore, null);
        assert.equal(record.checkedAttributeAfter, null, "native checked state changes without an attribute mutation");
      }
      if (reactionProbe === "native-value") {
        assert.equal(record.valueBefore, "Original author value");
        assert.equal(record.valueAfter, "Retained author value");
        assert.equal(record.valueAttributeBefore, "Original author value");
        assert.equal(record.valueAttributeAfter, "Original author value", "native input value changes without an attribute mutation");
      }
      if (reactionProbe === "hash") {
        assert.equal(record.hashBefore, "");
        assert.equal(record.hashAfter, "#distant-0");
      }
      if (reactionProbe === "escaped-selector") {
        assert.equal(record.selectorMatchedBefore, false);
        assert.equal(record.selectorMatchedAfter, true, "the browser actually parses and activates the escaped author selector");
      }
      if (reactionProbe === "font-membership") {
        assert.equal(record.fontMemberBefore, false);
        assert.equal(record.fontMemberAfter, true);
        assert.equal(record.fontStatusBefore, "loaded");
        assert.equal(record.fontStatusAfter, "loaded");
        assert.equal(await page.evaluate(() => __reactionFontEvents), 0,
          "adding the already decoded face must exercise membership checking without a loadingdone event");
      }
      assertExpanded(result.roots[0], initial.roots[0]);
      const reactedPaints = reaction.paints.filter((paint) => paint.count > 0);
      assert.ok(reactedPaints.length > 0);
      for (const paint of reactedPaints) {
        assert.equal(paint.outside.size, expectedSize, `${reactionProbe}: every reacted frame has the correct outside typography`);
        assertOutsideFits(paint.outside);
      }
      await assertRestored(page);
      if (reactionProbe === "checkbox") assert.equal(await page.locator("#reaction-checkbox").evaluate((element) => element.checked), true,
        "pause preserves the author's checked state");
      if (reactionProbe === "native-value") assert.deepEqual(await page.locator("#reaction-value").evaluate((element) =>
        ({ value: element.value, defaultValue: element.defaultValue, attribute: element.getAttribute("value") })),
      { value: "Retained author value", defaultValue: "Original author value", attribute: "Original author value" },
      "pause preserves the dirty input value and exact author default");
      if (reactionProbe === "hash") assert.equal(await page.evaluate(() => location.hash), "#distant-0");
      if (reactionProbe === "escaped-selector") assert.equal(await page.locator("#distant").getAttribute("lang"), "en");
      if (reactionProbe === "font-membership") assert.equal(await page.evaluate(() => document.fonts.has(__reactionFont)), true,
        "pause retains the page's added native font face");
    } finally { await page.close(); }
  }
});

const controlledBudgetCase = async (page, duration, forceFull) => page.evaluate(async ({ duration, forceFull, addition }) => {
  const nativeTimeout = setTimeout.bind(globalThis), nativeClear = clearTimeout.bind(globalThis);
  const nativeNow = performance.now.bind(performance), controls = LexendControls;
  let clock = nativeNow() + 10_000, nextId = 200_000, repairs = 0;
  const tasks = new Map(), canceled = [];
  const describe = (task) => ({ id: task.id, delay: task.delay, due: task.due });
  const pending = () => [...tasks.values()].map(describe);
  const state = () => ({ reads: { ...__reads }, roots: __roots.map((_, i) => __inspectRoot(i)), state: __state() });
  performance.now = () => clock;
  globalThis.setTimeout = (callback, delay = 0, ...args) => {
    const task = { id: ++nextId, delay, due: clock + delay, callback: () => callback(...args) };
    tasks.set(task.id, task); return task.id;
  };
  globalThis.clearTimeout = (id) => { canceled.push(id); tasks.delete(id); };
  globalThis.LexendControls = { ...controls, repair(context) {
    controls.repair(context);
    // Execute all real repair work and then attribute a controlled elapsed
    // duration to that actual call. No budget/scheduling function is exposed.
    repairs++;
    clock += duration;
  } };
  const runNext = async () => {
    const task = [...tasks.values()].sort((a, b) => a.due - b.due)[0];
    if (!task) throw new Error("The actual runtime scheduled no callback");
    tasks.delete(task.id);
    clock = Math.max(clock, task.due);
    const started = clock, before = repairs;
    task.callback();
    await Promise.resolve();
    return { task: describe(task), started, finished: clock, repairs: repairs - before };
  };
  try {
    __append(0, addition);
    await Promise.resolve();
    const initialTasks = pending(), firstRun = await runNext(), first = state();
    const firstRegions = __regionalCalls.length;
    __resetReads();
    __append(0, " More words. ");
    await Promise.resolve();
    const following = pending();
    if (forceFull) {
      const secondRun = await runNext();
      return { duration, initialTasks, firstRun, first, firstRegions, following, secondRun,
        final: state(), finalRegions: __regionalCalls.length, remaining: tasks.size };
    }
    const observations = [];
    for (let i = 0; i < 5; i++) {
      clock++;
      __append(0, " Extra words. ");
      await Promise.resolve();
      observations.push(pending());
    }
    const upgradedAt = clock;
    const html = '<section class="distant-clip"><p class="distant-text" id="budget-new">New global reading content</p></section>';
    document.querySelector("#distant").insertAdjacentHTML("beforeend", html);
    __authorBody.querySelector("#distant").insertAdjacentHTML("beforeend", html);
    await Promise.resolve();
    const upgraded = pending(), globalRun = await runNext(), afterGlobal = state();
    const globalRegions = __regionalCalls.length;
    __append(0, " Final words. ");
    await Promise.resolve();
    const afterGlobalTasks = pending(), finalRun = await runNext();
    return { duration, initialTasks, firstRun, first, firstRegions, following, observations,
      upgradedAt, upgraded, canceled, globalRun, afterGlobal, globalRegions, afterGlobalTasks, finalRun,
      final: state(), finalRegions: __regionalCalls.length, remaining: tasks.size,
      insertedFont: __native.style(document.querySelector("#budget-new")).fontFamily };
  } finally {
    globalThis.setTimeout = nativeTimeout;
    globalThis.clearTimeout = nativeClear;
    performance.now = nativeNow;
    globalThis.LexendControls = controls;
  }
}, { duration, forceFull, addition });

const assertBudgetTime = (actual, expected, label) => assert.ok(Math.abs(actual - expected) < 0.001,
  `${label}: expected ${expected}ms, got ${actual}ms`);

test("successful regional repairs retain four times their measured work below and across 50 ms", async () => {
  for (const duration of [20, 40, 49, 50, 51]) {
    const { page, initial } = await prepare({ traceRegions: true });
    try {
      const result = await controlledBudgetCase(page, duration, false);
      assert.equal(result.firstRegions, 1, `${duration}ms: an actual regional ownership transaction completed`);
      assert.equal(result.firstRun.repairs, 1);
      assert.equal(result.globalRun.repairs, 1);
      assert.equal(result.finalRun.repairs, 1);
      assert.equal(result.globalRegions, 1, "the urgent callback really routes through global ownership");
      assert.equal(result.finalRegions, 2, "a real regional repair resumes after the global transaction");
      assertLocalWork(result.first);
      assertExpanded(result.first.roots[0], initial.roots[0]);
      assertExpanded(result.final.roots[0], initial.roots[0]);
      assert.equal(result.final.roots[0].content, text + addition + " More words. " + " Extra words. ".repeat(5) + " Final words. ");
      assert.ok(result.afterGlobal.reads.styles > 0 && result.afterGlobal.reads.ranges > 0);
      assert.match(result.insertedFont, /Lexend/);
      assert.equal(result.final.state.healthy, true);
      assert.equal(result.final.state.pending, false);
      assert.equal(result.remaining, 0);
      await assertRestored(page);
      assert.equal(result.initialTasks.length, 1);
      assert.equal(result.initialTasks[0].delay, 100);
      assert.equal(result.following.length, 1);
      assertBudgetTime(result.following[0].delay, Math.max(100, duration * 4), `${duration}ms regional cooldown`);
      for (const observation of result.observations) assert.deepEqual(observation, result.following,
        `${duration}ms: incoming edits cannot postpone the fixed regional deadline`);
      assert.equal(result.upgraded.length, 1);
      assert.notEqual(result.upgraded[0].id, result.following[0].id);
      assert.ok(result.canceled.includes(result.following[0].id));
      assertBudgetTime(result.upgraded[0].due, result.firstRun.finished + duration * 4,
        `${duration}ms: urgent global work honors the regional cooldown`);
      assert.ok(result.upgraded[0].due <= result.following[0].due, "urgent work may advance, never postpone, the deadline");
      assertBudgetTime(result.globalRun.started, result.upgraded[0].due, "the actual global callback runs at the retained budget deadline");
      assert.equal(result.afterGlobalTasks.length, 1);
      assertBudgetTime(result.afterGlobalTasks[0].delay, Math.max(100, duration > 50 ? duration * 4 : 0),
        `${duration}ms: completing global work restores the unchanged global threshold rule`);
    } finally { await page.close(); }
  }
});

test("full repairs preserve the existing zero-through-50 ms and four-times-above-50 ms budget", async () => {
  for (const duration of [20, 40, 49, 50, 51]) {
    const { page, initial } = await prepare({ traceRegions: true, forceFull: true });
    try {
      const result = await controlledBudgetCase(page, duration, true);
      assert.equal(result.firstRegions, 0);
      assert.equal(result.finalRegions, 0);
      assert.equal(result.firstRun.repairs, 1);
      assert.equal(result.secondRun.repairs, 1);
      assert.ok(result.first.reads.styles > 0 && result.first.reads.ranges > 0, "the control actually repairs the full document");
      assertExpanded(result.first.roots[0], initial.roots[0]);
      assertExpanded(result.final.roots[0], initial.roots[0]);
      assert.equal(result.final.roots[0].content, text + addition + " More words. ");
      assert.equal(result.final.state.healthy, true);
      assert.equal(result.final.state.pending, false);
      assert.equal(result.remaining, 0);
      await assertRestored(page);
      assert.equal(result.initialTasks.length, 1);
      assert.equal(result.initialTasks[0].delay, 0, "existing full character-data work remains urgent");
      assert.equal(result.following.length, 1);
      const expected = duration > 50 ? duration * 4 : 0;
      assertBudgetTime(result.following[0].delay, expected, `${duration}ms unchanged full-repair cooldown`);
      assertBudgetTime(result.secondRun.started, result.firstRun.finished + expected,
        `${duration}ms actual full callback uses the unchanged threshold`);
    } finally { await page.close(); }
  }
});
