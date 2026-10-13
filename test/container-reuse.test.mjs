import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
import test from "node:test";
import { chromium } from "playwright";
import { replaceExactlyOnce } from "./helpers/conversation.mjs";

const layoutSource = await readFile(new URL("../src/adaptive-layout.js", import.meta.url), "utf8");
const controlsSource = await readFile(new URL("../src/adaptive-controls.js", import.meta.url), "utf8");
const skip = "if (measurements !== null && measurements === settledContainerMeasurements) return;";
const settle = "settledContainerMeasurements = before !== null && before === measurements ? before : null;";
const variant = (kind) => {
  let source = layoutSource;
  if (kind === "full") source = replaceExactlyOnce(source, skip, "", "forced original checkpoints");
  if (kind === "settle-writes") source = replaceExactlyOnce(source, settle,
    "settledContainerMeasurements = measurements;", "unsafe write-producing settlement");
  if (kind === "ignore-invalidations") source = replaceExactlyOnce(source, skip,
    "if (settledContainerMeasurements !== null) return;", "unsafe intervening invalidation reuse");
  return replaceExactlyOnce(source, "    const repairContainers = () => {",
    "    const repairContainers = () => {\n      globalThis.__containerPasses++;", "actual container invocation counter");
};
let browser;
test.before(async () => { browser = await chromium.launch({ headless: true }); });
test.after(async () => { await browser?.close(); });

// This differential test uses the full runtime, including real font loading,
// settings changes, mutation delivery, and pause restoration. The only probe
// counts actual container invocations; it does not decide whether one is safe.
const runtimeReading = async (kind) => {
  const page = await browser.newPage({ viewport: { width: 1000, height: 800 } });
  try {
    await page.route("http://reuse.test/**", (route) => readFile(resolve(`.${new URL(route.request().url()).pathname}`))
      .then((body) => route.fulfill({ body, contentType: "font/woff2" })));
    await page.setContent(`<!doctype html><style>
      body{font:16px/20px Arial}article{width:340px;height:44px;overflow:hidden;margin-bottom:12px}
      p{margin:0}pre{font:14px/20px monospace}
    </style><main>${Array.from({ length: 8 }, (_, i) => `<article id="card${i}"${i === 0 ? ' style="height: 44px !important; color: rgb(12, 34, 56);"' : ""}>
      <p>Careful typography helps readers follow a longer passage without losing its meaning.</p></article>`).join("")}</main>
    <pre><code>const untouched = true;</code></pre><div contenteditable="true">Editable author content</div>`);
    await page.evaluate(() => {
      globalThis.__containerPasses = 0;
      const storage = [], runtime = [];
      globalThis.__settings = { enabled: false, scope: "all", textScale: 120 };
      globalThis.chrome = {
        runtime: { getURL: (path) => `http://reuse.test/${path}`, sendMessage: async () => {}, onMessage: { addListener: (fn) => runtime.push(fn) } },
        storage: { sync: { get: async () => __settings }, onChanged: { addListener: (fn) => storage.push(fn) } }
      };
      globalThis.__update = (values) => {
        Object.assign(__settings, values);
        const changes = Object.fromEntries(Object.entries(values).map(([key, newValue]) => [key, { newValue }]));
        storage.forEach((fn) => fn(changes, "sync"));
      };
      globalThis.__state = () => {
        let value; runtime.forEach((fn) => fn({ type: "LEXEND_GET_STATE" }, null, (state) => { value = state; })); return value;
      };
      globalThis.__view = () => [...document.querySelectorAll("article,p,pre,code,[contenteditable]")].map((element) => {
        const css = getComputedStyle(element), box = element.getBoundingClientRect();
        const range = document.createRange(); range.selectNodeContents(element);
        return { html: element.outerHTML, box: box.toJSON(), text: range.getBoundingClientRect().toJSON(),
          height: element.clientHeight, scroll: element.scrollHeight,
          font: css.fontFamily, size: css.fontSize, line: css.lineHeight, spacing: css.letterSpacing };
      });
      globalThis.__original = document.body.innerHTML;
    });
    for (const name of ["settings", "adaptive-controls", "adaptive-layout", "content"]) {
      await page.addScriptTag({ content: name === "adaptive-layout" ? variant(kind)
        : await readFile(new URL(`../src/${name}.js`, import.meta.url), "utf8") });
    }
    await page.waitForFunction(() => __state()?.ready && !__state().pending);
    const states = [], passes = [];
    const change = async (values, grow = false) => {
      const previous = await page.evaluate(({ values, grow }) => {
        const previous = { revision: __state().refreshRevision, passes: __containerPasses };
        if (grow) document.querySelector("p").append(" More text arrives during a later refresh.");
        else __update(values);
        return previous;
      }, { values, grow });
      await page.waitForFunction((revision) => __state().healthy && !__state().pending && __state().refreshRevision > revision, previous.revision);
      await page.evaluate(() => document.fonts.ready);
      states.push(await page.evaluate(() => __view()));
      passes.push(await page.evaluate((before) => __containerPasses - before, previous.passes));
    };
    await change({ enabled: true });
    await change({ textScale: 150 });
    await change(null, true);
    // The added author text is expected to survive pausing.
    const expectedPaused = await page.evaluate(() => {
      const root = document.createElement("div"); root.innerHTML = __original;
      root.querySelector("p").append(" More text arrives during a later refresh.");
      return root.innerHTML;
    });
    await change({ enabled: false });
    const paused = await page.evaluate(() => document.body.innerHTML);
    assert.equal(paused, expectedPaused, "pause restores exact author markup and inline priorities");
    await change({ enabled: true, textScale: 130 });
    return { states, passes };
  } finally { await page.close(); }
};

test("no-write reuse preserves full-runtime geometry, typography, growth and exact pause restoration", async (t) => {
  const candidate = await runtimeReading("candidate"), full = await runtimeReading("full");
  assert.deepEqual(candidate.states, full.states);
  for (const i of [0, 1, 2, 4]) {
    assert.ok(candidate.passes[i] > 0, "every new refresh reevaluates containers");
    assert.ok(candidate.passes[i] < full.passes[i], `refresh ${i}: ${JSON.stringify({ candidate: candidate.passes, full: full.passes })}`);
  }
  assert.equal(candidate.passes[3], 0, "pause does not repair the page");
  assert.match(candidate.states[0][1].font, /Lexend/);
  assert.ok(candidate.states[1][0].box.height > candidate.states[0][0].box.height);
  t.diagnostic(JSON.stringify({ candidatePasses: candidate.passes, forcedFullPasses: full.passes }));
});

// One synchronous repair is isolated here so a later content refresh cannot
// conceal an unsafe skipped checkpoint. Author :has selectors couple otherwise
// separate branches. The controls-stage hook uses the same supplied write/mark
// API as real controls and keeps the actual controls implementation in place.
const dependencyFixture = async (kind, mutation) => {
  const page = await browser.newPage({ viewport: { width: 1000, height: 800 } });
  try {
    const condition = mutation === "container" ? '#trigger[data-lexend-layout-repair~="expand"]'
      : mutation === "style" ? '#trigger[style*="padding-top"]' : '#trigger[data-stage-ready="yes"]';
    await page.setContent(`<!doctype html><style>
      body{font:16px/20px Arial}p{margin:0}#trigger{width:200px;${mutation === "container" ? "height:20px;overflow:hidden" : "height:1px"}}
      #target{width:240px;height:70px;overflow:hidden;margin-top:20px}
      body:has(${condition}) #target{width:70px}
    </style><div id="trigger">${mutation === "container" ? "<p>Trigger</p>" : ""}</div>
    <div id="target"><p>A readable target with several words.</p></div>`);
    await page.evaluate(() => { globalThis.__containerPasses = 0; });
    await page.addScriptTag({ content: controlsSource });
    await page.addScriptTag({ content: variant(kind) });
    return await page.evaluate((mutation) => {
      const original = document.body.innerHTML;
      if (mutation !== "container") {
        const controls = LexendControls;
        globalThis.LexendControls = { ...controls, repair(context) {
          controls.repair(context);
          const trigger = document.querySelector("#trigger");
          if (mutation === "style") context.write(trigger, "padding-top", "1px", "stage-dependency");
          else context.mark(trigger, "data-stage-ready", "yes");
        } };
      }
      const typography = document.createElement("style");
      typography.textContent = "p{font-size:20px;line-height:28px}";
      typography.media = "not all"; document.head.append(typography);
      const layout = LexendLayout.create({ withStylesDisabled(callback) {
        const previous = typography.media; typography.media = "not all";
        try { return callback(); } finally { typography.media = previous; }
      } });
      layout.capture(); typography.media = "all"; layout.repair();
      const target = document.querySelector("#target"), paragraph = target.querySelector("p");
      const range = document.createRange(); range.selectNodeContents(paragraph);
      const targetBox = target.getBoundingClientRect(), textBox = range.getBoundingClientRect();
      const state = { passes: __containerPasses, target: targetBox.toJSON(), text: textBox.toJSON(),
        scrollHeight: target.scrollHeight, clientHeight: target.clientHeight,
        targetStyle: target.getAttribute("style"), trigger: document.querySelector("#trigger").outerHTML };
      layout.restore(); typography.media = "not all";
      return { ...state, original, restored: document.body.innerHTML };
    }, mutation);
  } finally { await page.close(); }
};
const assertNoClipping = (state) => {
  assert.ok(state.text.bottom <= state.target.bottom + 1, `text remains clipped: ${JSON.stringify(state)}`);
  assert.ok(state.scrollHeight <= state.clientHeight + 1, `unreachable overflow remains: ${JSON.stringify(state)}`);
};

test("a write-producing container pass cannot settle an earlier :has-dependent branch", async (t) => {
  const candidate = await dependencyFixture("candidate", "container");
  const full = await dependencyFixture("full", "container");
  const broken = await dependencyFixture("settle-writes", "container");
  assertNoClipping(candidate); assertNoClipping(full);
  assert.deepEqual(candidate.target, full.target);
  assert.equal(candidate.restored, candidate.original);
  assert.throws(() => assertNoClipping(broken), /clipped|overflow/, "the geometry assertion rejects unsafe write-producing settlement");
  t.diagnostic(JSON.stringify({ candidatePasses: candidate.passes, brokenPasses: broken.passes,
    candidateHeight: candidate.clientHeight, brokenHeight: broken.clientHeight, brokenScrollHeight: broken.scrollHeight }));
});

for (const mutation of ["style", "marker"]) {
  test(`intervening ${mutation} writes invalidate no-write reuse through author :has dependencies`, async (t) => {
    const candidate = await dependencyFixture("candidate", mutation);
    const full = await dependencyFixture("full", mutation);
    const broken = await dependencyFixture("ignore-invalidations", mutation);
    assertNoClipping(candidate); assertNoClipping(full);
    assert.deepEqual(candidate.target, full.target);
    assert.equal(candidate.restored, candidate.original);
    assert.throws(() => assertNoClipping(broken), /clipped|overflow/, "geometry must reject stale reuse, independent of counters");
    if (mutation === "marker") assert.doesNotMatch(candidate.trigger, /style=/, "the marker case has no style write on its trigger");
    t.diagnostic(JSON.stringify({ candidatePasses: candidate.passes, brokenPasses: broken.passes,
      candidateHeight: candidate.clientHeight, brokenHeight: broken.clientHeight, brokenScrollHeight: broken.scrollHeight }));
  });
}
