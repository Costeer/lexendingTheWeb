import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import { chromium } from "playwright";
import { replaceExactlyOnce } from "./helpers/conversation.mjs";

const layoutSource = await readFile(new URL("../src/adaptive-layout.js", import.meta.url), "utf8");
const controlsSource = await readFile(new URL("../src/adaptive-controls.js", import.meta.url), "utf8");
const stalePositionSource = replaceExactlyOnce(layoutSource,
  "const position = styleFor(panel).position;", "const position = before.position;", "stale panel eligibility negative control");
const explanation = "This explanation describes personal information, optional storage, and the choices available to visitors. Larger typography adds enough lines to displace controls that originally fit inside this viewport. Further details explain how to review optional choices before making a decision.";
let browser;
test.before(async () => { browser = await chromium.launch({ headless: true }); });
test.after(async () => { await browser?.close(); });

const inspectPanel = async ({ kind, source = layoutSource }) => {
  const page = await browser.newPage({ viewport: { width: 390, height: 600 } });
  try {
    let target = page;
    if (kind === "embedded-absolute") {
      await page.setContent('<iframe style="width:390px;height:600px;border:0"></iframe>');
      target = page.frames()[1];
    }
    const absolute = kind.endsWith("absolute");
    await target.setContent(`<!doctype html><style>
      body{margin:0;font:16px/20px Arial}#trigger{height:1px}
      #panel{position:${absolute ? "absolute" : "relative"};${absolute ? "bottom:0;" : ""}width:340px;height:${absolute ? 360 : 240}px;overflow:hidden;background:white}
      p{margin:12px}button{margin:12px;font:inherit;padding:8px}
      body:has(#trigger[data-stage-ready="yes"]) #panel{position:fixed;bottom:0;left:0}
    </style><div id="trigger"></div><section id="panel"${kind === "relative-dialog" ? ' role="dialog"' : ""}>
      <p>${explanation}</p><button>Reject optional storage</button></section>`);
    await target.addScriptTag({ content: controlsSource });
    await target.addScriptTag({ content: source });
    return await target.evaluate((kind) => {
      const original = document.body.innerHTML;
      const panel = document.querySelector("#panel"), button = panel.querySelector("button");
      const beforePosition = getComputedStyle(panel).position;
      if (kind === "has-transition") {
        const controls = LexendControls;
        globalThis.LexendControls = { ...controls, repair(context) {
          controls.repair(context);
          // This real earlier repair-stage write invalidates cached styles.
          // The author selector changes another captured branch's position.
          context.mark(document.querySelector("#trigger"), "data-stage-ready", "yes");
        } };
      }
      const typography = document.createElement("style");
      typography.textContent = "p,button{font-size:30px!important;line-height:1.6!important}";
      typography.media = "not all";
      document.head.append(typography);
      const layout = LexendLayout.create({ withStylesDisabled(callback) {
        const previous = typography.media;
        typography.media = "not all";
        try { return callback(); } finally { typography.media = previous; }
      } });
      layout.capture();
      typography.media = "all";
      layout.repair();
      const box = panel.getBoundingClientRect();
      button.focus();
      const action = button.getBoundingClientRect();
      const state = { beforePosition, position: getComputedStyle(panel).position,
        marker: panel.getAttribute("data-lexend-layout-repair"), overflow: getComputedStyle(panel).overflowY,
        panel: box.toJSON(), action: action.toJSON(), scrollHeight: panel.scrollHeight,
        clientHeight: panel.clientHeight, viewportHeight: innerHeight, embedded: window !== window.top };
      layout.restore();
      typography.media = "not all";
      return { ...state, original, restored: document.body.innerHTML };
    }, kind);
  } finally { await page.close(); }
};

const assertBounded = (state, limit) => {
  assert.ok(state.panel.height <= limit + 1, `panel exceeds its viewport bound: ${JSON.stringify(state)}`);
  assert.ok(state.panel.top >= -1 && state.panel.bottom <= state.viewportHeight + 1,
    `panel escapes the viewport: ${JSON.stringify(state)}`);
  assert.ok(state.action.top >= state.panel.top - 1 && state.action.bottom <= state.panel.bottom + 1,
    `focused action is unreachable: ${JSON.stringify(state)}`);
  assert.match(state.marker ?? "", /bounded-panel/);
  assert.equal(state.overflow, "auto");
  assert.equal(state.restored, state.original, "restoration retains exact author markup and styles");
};

test("panel eligibility uses current position after an earlier repair changes author :has styling", async () => {
  const candidate = await inspectPanel({ kind: "has-transition" });
  const stale = await inspectPanel({ kind: "has-transition", source: stalePositionSource });
  assert.equal(candidate.beforePosition, "relative");
  assert.equal(candidate.position, "fixed");
  assertBounded(candidate, 300);
  assert.equal(stale.position, "fixed", "the negative control reaches the same author style transition");
  assert.throws(() => assertBounded(stale, 300), /bound|viewport|unreachable/,
    "a stale baseline-position prefilter must fail the actual geometry assertion");
});

test("panel eligibility preserves relative dialogs and distinguishes embedded absolute panels", async () => {
  const dialog = await inspectPanel({ kind: "relative-dialog" });
  assert.equal(dialog.position, "relative");
  assertBounded(dialog, 568);
  const embedded = await inspectPanel({ kind: "embedded-absolute" });
  assert.equal(embedded.embedded, true);
  assert.equal(embedded.position, "absolute");
  assertBounded(embedded, 568);
  const topLevel = await inspectPanel({ kind: "top-absolute" });
  assert.equal(topLevel.embedded, false);
  assert.equal(topLevel.position, "absolute");
  assert.doesNotMatch(topLevel.marker ?? "", /bounded-panel/,
    "absolute page content does not receive the embedded-panel viewport constraint");
  assert.equal(topLevel.restored, topLevel.original);
});
