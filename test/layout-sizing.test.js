import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import { chromium } from "playwright";

const source = await readFile(new URL("../src/adaptive-layout.js", import.meta.url), "utf8");
const font = (await readFile(new URL("../assets/fonts/lexend-latin-wght-normal.woff2", import.meta.url))).toString("base64");
let browser;
test.before(async () => { browser = await chromium.launch({ headless: true }); });
test.after(async () => { await browser?.close(); });

const sizes = [
  { width: 1920, height: 1080 }, { width: 1440, height: 900 },
  { width: 1024, height: 768 }, { width: 768, height: 1024 },
  { width: 390, height: 844 }, { width: 320, height: 568 },
  { width: 844, height: 390 }
];

const fixture = ({ grid = false, responsive = false, offset = false, minimum = false } = {}) => `<!doctype html><style>
  @font-face{font-family:TestLexend;src:url(data:font/woff2;base64,${font})}
  html,body{height:100%;margin:0;font:14px Arial;overflow-anchor:none}
  .shell{height:${offset ? "calc(100% - 64px)" : "100%"};${minimum ? "min-height:100%;" : ""}
    ${offset ? "width:70%;margin:0 auto;" : "width:100%;"}
    display:${grid ? "grid;grid-template-rows:60px minmax(80px,1fr) auto minmax(0,1fr) auto" : "flex;flex-direction:column"}}
  .banner{height:64px}header{height:60px;flex-shrink:0}
  .brand{${grid ? "" : "height:calc(100% - 300px);max-height:220px;min-height:80px;flex-shrink:0;"}
    display:flex;align-items:end;justify-content:center}
  .brand svg{height:60px;width:120px}.search{padding:16px;flex-shrink:0;text-align:center}
  .space{flex-grow:1}footer{line-height:14px;padding:15px;flex-shrink:0}p{margin:0}
  .after{height:800px}
  ${responsive ? '@media(max-width:600px){.shell{display:grid;grid-template-rows:60px minmax(80px,1fr) auto minmax(0,1fr) auto}}' : ''}
</style>${offset ? '<div class="banner"></div>' : ""}<div class="shell">
  <header><a>About</a></header><div class="brand"><svg></svg></div>
  <div class="search"><button>Search</button></div><div class="space"></div>
  <footer><p>Location</p><a>Privacy</a></footer></div><div class="after"></div>`;

const prepare = async (options) => {
  const page = await browser.newPage({ viewport: sizes[0] });
  await page.setContent(fixture(options));
  await page.evaluate(() => document.fonts.load('16px TestLexend'));
  await page.addScriptTag({ content: source });
  await page.evaluate(() => {
    const typography = document.createElement('style');
    typography.id = 'typography'; typography.media = 'not all'; document.head.append(typography);
    window.layout = LexendLayout.create({ withStylesDisabled(callback) {
      const media = typography.media; typography.media = 'not all';
      try { return callback(); } finally { typography.media = media; }
    } });
    window.measure = () => {
      const box = (selector) => document.querySelector(selector).getBoundingClientRect().toJSON();
      return { shell: box('.shell'), brand: box('.brand'), footer: box('footer'), search: box('.search'),
        width: document.documentElement.scrollWidth };
    };
  });
  return page;
};

for (const mode of ["flex", "grid", "responsive"]) {
  test(`${mode} page sizing survives viewport, text-size, and scroll changes`, async () => {
    const page = await prepare({ grid: mode === "grid", responsive: mode === "responsive" });
    for (const viewport of [...sizes, sizes[0]]) {
      await page.setViewportSize(viewport);
      for (const scale of [100, 110, 150]) {
        const state = await page.evaluate(({ scale }) => {
          layout.restore(); const css = document.querySelector('#typography'); css.media = 'not all';
          window.scrollTo(0, 0); const before = measure();
          layout.capture(); css.textContent = `a,p,button{font-family:TestLexend!important;font-size:${14 * scale / 100}px!important;line-height:1.6!important;letter-spacing:.02em!important}`;
          css.media = 'all'; layout.repair(); const after = measure();
          window.scrollTo(0, 100); layout.capture(); layout.repair(); const scrolled = measure();
          const scroll = window.scrollY;
          layout.capture(); layout.repair(); const repeated = measure();
          layout.restore(); css.media = 'not all'; window.scrollTo(0, 0);
          return { before, after, scrolled, scroll, repeated, restored: measure(), style: document.querySelector('.shell').getAttribute('style') };
        }, { scale });
        const context = JSON.stringify({ viewport, scale, state });
        assert.ok(state.after.shell.height >= state.before.shell.height - 1, context);
        const growth = Math.max(0, state.after.footer.height - state.before.footer.height)
          + Math.max(0, state.after.search.height - state.before.search.height);
        assert.ok(state.after.brand.height >= state.before.brand.height - growth - 2, context);
        assert.ok(Math.abs(state.scrolled.shell.height - state.after.shell.height) <= 1, context);
        assert.ok(Math.abs(state.scrolled.brand.height - state.after.brand.height) <= 1, context);
        assert.deepEqual(state.repeated, state.scrolled, context);
        assert.ok(state.after.width <= state.before.width, context);
        assert.deepEqual(state.restored, state.before, context);
        assert.equal(state.style, null, context);
      }
    }
    await page.close();
  });
}

for (const options of [{ offset: true }, { minimum: true }, { offset: true, minimum: true }]) {
  test(`${options.offset ? "inset pages below a header" : "full-width pages"}${options.minimum ? " with a minimum height" : ""} preserve allocated child space`, async () => {
    const page = await prepare(options);
    for (const viewport of [sizes[1], sizes[4], sizes[6]]) {
      await page.setViewportSize(viewport);
      const state = await page.evaluate(() => {
        layout.restore(); const css = document.querySelector('#typography'); css.media = 'not all';
        const before = measure(); layout.capture();
        css.textContent = 'a,p,button{font-family:TestLexend!important;font-size:15.4px!important;line-height:1.6!important;letter-spacing:.02em!important}';
        css.media = 'all'; layout.repair(); return { before, after: measure() };
      });
      assert.ok(state.after.shell.height >= state.before.shell.height - 1, JSON.stringify({ viewport, state }));
      assert.ok(state.after.brand.height >= state.before.brand.height - 1, JSON.stringify({ viewport, state }));
    }
    await page.close();
  });
}

test("preserving a fractional page height does not introduce a scrollbar", async () => {
  const page = await prepare();
  await page.setViewportSize({ width: 390, height: 844 });
  const state = await page.evaluate(() => {
    document.querySelector('.after').remove();
    const style = document.createElement('style');
    style.textContent = '.shell{height:calc(100% - .25px)}'; document.head.append(style);
    const before = measure(); layout.capture();
    const css = document.querySelector('#typography');
    css.textContent = 'a,p,button{font-family:TestLexend!important;font-size:15.4px!important;line-height:1.6!important;letter-spacing:.02em!important}';
    css.media = 'all'; layout.repair();
    return { before, after: measure(), scroll: document.documentElement.scrollHeight };
  });
  assert.equal(state.after.shell.height, state.before.shell.height);
  assert.equal(state.after.width, state.before.width);
  assert.equal(state.scroll, 844);
  await page.close();
});
