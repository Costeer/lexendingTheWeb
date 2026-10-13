import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import { chromium } from "playwright";

const source = await readFile(new URL("../src/adaptive-layout.js", import.meta.url), "utf8");
let browser;
test.before(async () => { browser = await chromium.launch({ headless: true }); });
test.after(async () => { await browser?.close(); });
const prepare = async (html, mode = "gentle", css = ".text{font-size:24px!important;line-height:1.4!important}") => {
  const page = await browser.newPage({ viewport: { width: 390, height: 700 } });
  await page.setContent(`<style>body{margin:16px;font:16px/1.2 Arial}p{margin:0}</style>${html}`);
  await page.addScriptTag({ content: source });
  await page.evaluate(({ mode, css }) => {
    window.mode = mode;
    const typography = document.createElement("style"); typography.id = "typography";
    typography.media = "not all"; typography.textContent = css; document.head.append(typography);
    window.layout = LexendLayout.create({ getMode: () => window.mode, withStylesDisabled(callback) {
      const media = typography.media; typography.media = "not all";
      try { return callback(); } finally { typography.media = media; }
    } });
    window.measure = () => [...document.querySelectorAll("[id]:not(style)")].map((e) => ({ id:e.id,
      box:e.getBoundingClientRect().toJSON(), css:e.hasAttribute("style") ? e.style.cssText : null, marker:e.getAttribute("data-lexend-layout-repair") }));
    window.native = measure();
    layout.capture(); typography.media = "all"; window.converted = measure(); layout.repair();
  }, { mode, css });
  return page;
};
const clipped = '<div id="box" style="height:24px;overflow:hidden;width:280px"><p id="text" class="text">A readable caption</p></div><p id="next">Next paragraph</p>';

test("Off performs no geometry reads and leaves typography alone", async () => {
  const page = await prepare(clipped, "off");
  assert.deepEqual(await page.evaluate(() => measure()), await page.evaluate(() => converted));
  assert.equal(await page.locator("#text").evaluate(e => getComputedStyle(e).fontSize), "24px");
  const reads = await page.evaluate(() => {
    let count = 0;
    const read = window.getComputedStyle;
    window.getComputedStyle = (...args) => { count++; return read(...args); };
    layout.capture(); layout.repair(); return count;
  });
  assert.equal(reads, 0);
  await page.close();
});

test("Gentle repair grows a newly clipped flow box and restores exact inline styles", async () => {
  const page = await prepare(clipped);
  const result = await page.evaluate(() => ({ states:measure(), stats:layout.getDiagnostics() }));
  assert.equal(result.stats.changed, 1, JSON.stringify(result));
  assert.ok(result.states[0].box.height > 24);
  assert.equal(result.states[0].marker, "gentle");
  assert.equal(await page.locator("#text").evaluate(e => getComputedStyle(e).fontSize), "24px");
  assert.deepEqual(await page.evaluate(() => { layout.restore(); document.querySelector('#typography').media='not all';return measure(); }), await page.evaluate(() => native));
  await page.close();
});

test("Fit text preserves the box and picks a size between requested and native", async () => {
  const page = await prepare('<div id="box" style="width:125px;overflow:hidden;white-space:nowrap"><span id="text" class="text">Reading labels</span></div>', "fit", '.text{font-size:24px!important}');
  const result = await page.evaluate(() => ({ stats:layout.getDiagnostics(), font:parseFloat(getComputedStyle(document.querySelector('#text')).fontSize), box:document.querySelector('#box').style.cssText }));
  assert.equal(result.stats.changed, 1, JSON.stringify(result));
  assert.ok(result.font >= 16 && result.font < 24, JSON.stringify(result));
  assert.equal(result.box, 'width: 125px; overflow: hidden; white-space: nowrap;');
  await page.close();
});

test("Fit text uses a local original-font exception when font metrics cannot fit", async () => {
  const page = await prepare('<div id="box" style="width:102px;overflow:hidden;white-space:nowrap"><span id="text" class="text">Thin little text</span></div><p id="other" class="text">Ordinary reading</p>', "fit", '.text{font-family:monospace!important;font-size:20px!important;letter-spacing:2px!important}');
  const result = await page.evaluate(() => ({ stats:layout.getDiagnostics(), family:getComputedStyle(document.querySelector('#text')).fontFamily,
    other:getComputedStyle(document.querySelector('#other')).fontFamily, size:getComputedStyle(document.querySelector('#text')).fontSize }));
  assert.equal(result.family, "Arial", JSON.stringify(result));
  assert.equal(result.size, "16px");
  assert.equal(result.other, "monospace");
  await page.close();
});

for (const mode of ["gentle", "fit"]) {
  for (const [name, wrapper] of [
    ["existing clipping", '<div style="height:10px;overflow:hidden">CONTENT</div>'],
    ["ellipsis", '<div style="width:70px;white-space:nowrap;overflow:hidden;text-overflow:ellipsis">CONTENT</div>'],
    ["line clamps", '<div style="display:-webkit-box;-webkit-line-clamp:1;-webkit-box-orient:vertical;overflow:hidden">CONTENT</div>'],
    ["hidden labels", '<div style="visibility:hidden">CONTENT</div>'],
    ["transformed carousel tracks", '<div style="transform:translateX(-30px);height:24px;overflow:hidden">CONTENT</div>'],
    ["protected content", '<div data-lexend-ignore>CONTENT</div>'],
    ["editors", '<div contenteditable=true>CONTENT</div>'],
    ["vertical writing", '<div style="writing-mode:vertical-rl">CONTENT</div>']
  ]) test(`${mode} leaves ${name} unchanged`, async () => {
    const page = await prepare(wrapper.replace('CONTENT',clipped), mode);
    assert.deepEqual(await page.evaluate(() => measure()), await page.evaluate(() => converted));
    assert.equal(await page.locator('[data-lexend-layout-repair]').count(),0);
    await page.close();
  });
}

for (const [name, style] of [["grid", "display:grid;grid-template-columns:280px 40px"], ["flex", "display:flex"],
  ["fixed", "position:fixed;top:10px"], ["scrolling", "height:100px;overflow:auto"], ["containment", "contain:layout"]]) {
  test(`Gentle repair preserves ${name} structures`, async () => {
    const page = await prepare(`<section id="shell" style="${style}">${clipped}</section>`);
    assert.deepEqual(await page.evaluate(() => measure()), await page.evaluate(() => converted));
    await page.close();
  });
}

test("a trial that introduces clipping in an outer container is rolled back", async () => {
  const page = await prepare(`<section id="outer" style="height:40px;overflow:hidden">${clipped}</section>`);
  assert.equal(await page.locator('#box').evaluate(e => e.style.height),'24px');
  assert.equal(await page.locator('[data-lexend-layout-repair]').count(),0);
  assert.ok((await page.evaluate(() => layout.getDiagnostics())).reverted > 0);
  await page.close();
});

test("a trial that overlaps positioned artwork is rolled back", async () => {
  const page = await prepare(`<section style="position:relative">${clipped}<div id="art" style="position:absolute;top:25px;width:280px;height:20px"></div></section>`);
  assert.equal(await page.locator('#box').evaluate(e => e.style.height),'24px');
  assert.equal(await page.locator('[data-lexend-layout-repair]').count(),0);
  await page.close();
});

test("repeated captures, resize, mode switches and pause do not accumulate styles", async () => {
  const page = await prepare(clipped);
  const first = await page.evaluate(() => measure());
  for (let i=0;i<5;i++) await page.evaluate(() => layout.refresh());
  assert.deepEqual(await page.evaluate(() => measure()),first);
  for (const mode of ['fit','gentle','off','fit','off']) await page.evaluate(mode => { window.mode=mode;layout.refresh(); },mode);
  assert.deepEqual(await page.evaluate(() => measure()),await page.evaluate(() => converted));
  await page.setViewportSize({width:800,height:600});
  await page.evaluate(() => {window.mode='gentle';layout.refresh();layout.restore();});
  assert.equal(await page.locator('#box').evaluate(e=>e.style.height),'24px');
  assert.equal(await page.locator('#text').getAttribute('style'),null);
  await page.close();
});

test("restoring preserves a later author update to an owned property", async () => {
  const page = await prepare(clipped);
  await page.evaluate(() => {document.querySelector('#box').style.setProperty('height','90px','important');layout.restore();});
  assert.equal(await page.locator('#box').evaluate(e=>e.style.height),'90px');
  assert.equal(await page.locator('#box').evaluate(e=>e.style.maxHeight),'');
  await page.close();
});

test("deferred repairs ignore a stale mode and changed text", async () => {
  const page = await prepare(clipped,'off');
  await page.evaluate(() => {mode='gentle';layout.capture();mode='off';layout.repair();});
  assert.equal(await page.locator('[data-lexend-layout-repair]').count(),0);
  await page.evaluate(() => {mode='gentle';layout.capture();document.querySelector('#text').textContent='New content';layout.repair();});
  assert.equal(await page.locator('[data-lexend-layout-repair]').count(),0);
  await page.close();
});

test("RTL text is measured on both edges without changing writing direction", async () => {
  const page = await prepare('<div id="box" dir="rtl" style="width:95px;white-space:nowrap;overflow:hidden"><span id="text" class="text">سارة أحمد</span></div>', 'fit');
  const result = await page.locator('#text').evaluate(e=>({direction:getComputedStyle(e).direction,size:parseFloat(getComputedStyle(e).fontSize)}));
  assert.equal(result.direction,'rtl');
  assert.ok(result.size>=16);
  assert.equal(await page.locator('#box').evaluate(e=>e.style.width),'95px');
  await page.close();
});

test("Gentle repair does not turn visible glyph overhang into fixed heights", async () => {
  const page = await prepare('<p class="text" id="text" style="height:20px;overflow:visible">Visible glyphs</p>');
  assert.equal(await page.locator('#text').evaluate(e=>e.style.height),'20px');
  assert.equal(await page.locator('[data-lexend-layout-repair]').count(),0);
  await page.close();
});

test("repaired clones shed both height and typography overrides before a new capture", async () => {
  const page = await prepare(clipped);
  await page.evaluate(()=>{const copy=document.querySelector('#box').cloneNode(true);copy.id='copy';copy.firstElementChild.id='copy-text';document.body.append(copy);mode='off';layout.restore();});
  assert.equal(await page.locator('#copy').evaluate(e=>e.style.height),'24px');
  assert.equal(await page.locator('[data-lexend-original-layout],[data-lexend-layout-repair]').count(),0);
  await page.close();
});
