import assert from "node:assert/strict";
import test from "node:test";
import { chromium } from "playwright";
import { pageScrollState } from "../harness/scroll.mjs";
import { collectSnapshot, compareSnapshots } from "../harness/audit.js";
import { uncoveredRanges } from "../harness/coverage.mjs";
import { captureScreenshot } from "../harness/run.mjs";
import { motionSettleDelay } from "../harness/motion.mjs";

test("viewport-sized body scrolling captures lower content and keeps logical document coordinates", async () => {
  const browser = await chromium.launch({ headless: true });
  try {
    const page = await browser.newPage({ viewport: { width: 390, height: 844 } });
    await page.setContent(`<style>html,body{margin:0;height:100%;overflow-x:hidden;overflow-y:auto}section{height:844px}p{margin:0;font:20px Arial}</style>
      <section><p>First section</p></section><section><p>Second section</p></section><section><p>Final section</p></section>`);
    const before = await page.evaluate(collectSnapshot, { scope: "all" });
    assert.equal(before.scrollContainer, "body");
    assert.equal(before.elements.length, 3, "primary document scroll does not exclude its offscreen text");
    const tiles = [];
    for (const y of [0, 844, 1688]) {
      const observed = await page.evaluate(pageScrollState, { y });
      assert.equal(observed.container, "body");
      assert.equal(observed.y, y);
      tiles.push({ afterScrollY: observed.y });
    }
    assert.equal(await page.evaluate(() => scrollY), 0);
    assert.deepEqual(uncoveredRanges(tiles, "after", 844, before.height), []);
    const after = await page.evaluate(collectSnapshot, { scope: "all" });
    assert.equal(after.scrollY, 1688);
    const final = after.elements.find((element) => element.text === "Final section");
    assert.equal(final.rect.y, 1688);
    assert.equal(final.documentTextOverflow, 0);
    assert.ok(await page.locator("section:last-child p").evaluate((element) => element.getBoundingClientRect().top < 1));
    await page.setContent(`<style>body{margin:0}main{height:2532px}</style><main>Ordinary document scrolling</main>`);
    const normal = await page.evaluate(pageScrollState, { y: 844 });
    assert.equal(normal.container, "document");
    assert.equal(normal.y, 844);
  } finally {
    await browser.close();
  }
});

test("closed image-backed navigation labels become eligible when revealed", async () => {
  const browser = await chromium.launch({ headless: true });
  try {
    const page = await browser.newPage({ viewport: { width: 390, height: 844 } });
    await page.setContent(`<style>nav{position:fixed;left:-195px;top:0;width:260px}a{display:block;width:260px;height:50px;font:14px Arial;background:url(about:blank) no-repeat right center}</style>
      <nav><a href="/aviation">Marine and Aviation</a></nav><main><p>Visible article text</p></main>`);
    const closed = await page.evaluate(collectSnapshot, { scope: "all" });
    assert.ok(!closed.elements.some((element) => element.text === "Marine and Aviation"));
    assert.ok(closed.limitations.some((limitation) => limitation.reason.includes("Closed fixed navigation")));
    await page.locator("nav").evaluate((element) => { element.style.left = "0"; });
    const open = await page.evaluate(collectSnapshot, { scope: "all" });
    assert.ok(open.elements.some((element) => element.text === "Marine and Aviation" && !element.excluded));
  } finally { await browser.close(); }
});

test("native sprite actions retain a reveal limitation while painted labels stay eligible", async () => {
  const browser = await chromium.launch({ headless: true });
  try {
    const page = await browser.newPage();
    await page.setContent(`<style>#sprite{color:transparent;background-image:url(about:blank);width:24px;height:24px}</style>
      <input id="sprite" type="submit" value="Search"><input type="submit" value="Find articles">`);
    const snapshot = await page.evaluate(collectSnapshot, { scope: "all" });
    assert.ok(!snapshot.elements.some((element) => element.text === "Search"));
    assert.ok(snapshot.limitations.some((limitation) => limitation.reason.includes("Transparent control text")));
    assert.ok(snapshot.elements.some((element) => element.text === "Find articles" && !element.excluded));
  } finally { await browser.close(); }
});

test("document scrolling does not report viewport seams as new paragraph clipping", async () => {
  const browser = await chromium.launch({ headless: true });
  try {
    const page = await browser.newPage({ viewport: { width: 390, height: 844 } });
    await page.setContent(`<style>html{overflow-x:hidden}body{margin:0}main{padding-top:820px}p{margin:0;font:24px/1.6 Arial}footer{height:300px}</style>
      <main><p>Every word remains reachable by scrolling the document.</p></main><footer></footer>`);
    const top = await page.evaluate(collectSnapshot, { scope: "all" });
    const paragraph = top.elements.find((element) => element.tag === "p");
    assert.ok(paragraph, "an initially partial paragraph remains auditable");
    assert.equal(paragraph.clippingY, 0);
    await page.evaluate(() => scrollTo(0, 400));
    const scrolled = await page.evaluate(collectSnapshot, { scope: "all" });
    assert.equal(scrolled.elements.find((element) => element.tag === "p").clippingY, 0);
    await page.locator("main").evaluate((element) => { element.style.cssText = "height:40px;padding-top:0;overflow:hidden"; });
    const clipped = await page.evaluate(collectSnapshot, { scope: "all" });
    assert.ok(clipped.elements.find((element) => element.tag === "p").clippingY > 1, "nested author clipping is still measured");
  } finally { await browser.close(); }
});

test("automatically skipped geometry is deferred until its text is painted", async () => {
  const browser = await chromium.launch({ headless: true });
  try {
    const page = await browser.newPage({ viewport: { width: 390, height: 844 } });
    await page.setContent(`<style>body{margin:0}header{height:6000px}section{content-visibility:auto;contain-intrinsic-size:auto 50px}p{font:20px Arial}</style>
      <header></header><section><p>Deferred text needs a painted geometry comparison.</p></section><footer style="height:1000px"></footer>`);
    await page.waitForTimeout(50);
    const skipped = await page.evaluate(collectSnapshot, { scope: "all" });
    assert.ok(!skipped.elements.some((element) => element.tag === "p"));
    assert.ok(skipped.limitations.some((limitation) => limitation.reason.includes("Automatic rendering skips")));
    await page.locator("section").scrollIntoViewIfNeeded();
    await page.waitForTimeout(50);
    const painted = await page.evaluate(collectSnapshot, { scope: "all" });
    assert.ok(painted.elements.some((element) => element.tag === "p" && !element.excluded));
  } finally { await browser.close(); }
});

test("fixed link leading is distinct from a clipped native action hit area", async () => {
  const browser = await chromium.launch({ headless: true });
  try {
    const page = await browser.newPage({ viewport: { width: 390, height: 844 } });
    await page.setContent(`<style>body{margin:0}footer{position:fixed;bottom:0;height:22px}
      a span{display:block;font:12px/28px Arial}button{position:fixed;right:0;bottom:-4px;height:40px;font:12px Arial}</style>
      <footer><a href="#"><span>On Air Now</span></a></footer><button><span>Native action</span></button>`);
    const snapshot = await page.evaluate(collectSnapshot, { scope: "all" });
    const link = snapshot.elements.find((element) => element.text === "On Air Now");
    assert.ok(link.rect.y + link.rect.height > 844, "the line box includes offscreen leading");
    assert.equal(link.fixedControlOverflow, 0, "every painted label glyph remains visible");
    const button = snapshot.elements.find((element) => element.text === "Native action");
    assert.ok(button.fixedControlOverflow >= 4, "a descendant label cannot excuse the native hit area");
  } finally { await browser.close(); }
});

test("body overflow propagated to the viewport uses viewport bounds while contained bodies still clip", async () => {
  const browser = await chromium.launch({ headless: true });
  try {
    const page = await browser.newPage({ viewport: { width: 390, height: 844 } });
    await page.setContent(`<style>html{overflow:visible}body{margin:20px;overflow-x:hidden}
      span{display:inline-block;margin-left:300px;font:20px Arial}</style><span>Visible</span>`);
    const painted = await page.evaluate(collectSnapshot, { scope: "all" });
    const text = painted.elements.find((element) => element.text === "Visible");
    assert.equal(text.clippingX, 0);
    const state = await page.locator("span").evaluate((element) => {
      const r=element.getBoundingClientRect(), body=document.body.getBoundingClientRect();
      return {right:r.right,bodyRight:body.right,hit:document.elementFromPoint(r.right-1,r.top+5)===element};
    });
    assert.ok(state.right > state.bodyRight && state.right < 390);
    assert.equal(state.hit, true, "text outside the body margin box is actually painted");
    await page.locator("body").evaluate((element) => { element.style.contain="paint"; });
    const contained = await page.evaluate(collectSnapshot, { scope: "all" });
    assert.ok(contained.elements.find((element) => element.text === "Visible").clippingX > 1);
    await page.locator("body").evaluate((element) => { element.style.contain="none"; });
    await page.locator("html").evaluate((element) => { element.style.overflowX="hidden"; });
    const nested = await page.evaluate(collectSnapshot, { scope: "all" });
    assert.ok(nested.elements.find((element) => element.text === "Visible").clippingX > 1, "a nonpropagating body remains a clipping ancestor");
  } finally { await browser.close(); }
});

test("short positioning transitions settle before reveal measurements while continuous motion stays bounded", async () => {
  const browser = await chromium.launch({ headless: true });
  try {
    const page = await browser.newPage();
    await page.setContent(`<style>div{position:fixed;left:-200px;transition:left .4s}div.open{left:0}@keyframes forever{to{transform:rotate(360deg)}}aside{animation:forever 1s infinite}</style><div>Revealed label</div><aside></aside>`);
    await page.locator("div").evaluate((element) => { getComputedStyle(element).left; element.classList.add("open"); });
    const delay = await page.evaluate(motionSettleDelay, 150);
    assert.ok(delay > 150 && delay <= 550);
    await page.waitForTimeout(delay);
    assert.equal(await page.locator("div").evaluate((element) => element.getBoundingClientRect().left), 0);
    assert.equal(await page.evaluate(motionSettleDelay, 150), 150, "infinite decorative motion does not add a wait");
  } finally { await browser.close(); }
});

test("small action words newly split across lines require a repair even without clipping", async () => {
  const browser = await chromium.launch({ headless: true });
  try {
    const page = await browser.newPage();
    await page.setContent(`<style>button{width:56px;padding:0;border:0}span{display:block;font:16px Arial;overflow-wrap:anywhere}</style><button><span>MENU</span></button>`);
    const before = await page.evaluate(collectSnapshot, { scope: "all" });
    await page.locator("span").evaluate((element) => { element.style.fontSize="22.4px"; });
    const after = await page.evaluate(collectSnapshot, { scope: "all" });
    const comparison = compareSnapshots(before, after, { textScale: 140, lineHeight: 0, letterSpacing: 0 });
    assert.ok(comparison.findings.some((finding) => finding.code === "new-action-word-break" && finding.text === "MENU"));
    assert.equal(after.elements.find((element) => element.text === "MENU").clipping, 0);
    await page.locator("button").evaluate((element) => { element.style.width="88px"; });
    const repaired = await page.evaluate(collectSnapshot, { scope: "all" });
    assert.ok(!compareSnapshots(before, repaired, { textScale: 140, lineHeight: 0, letterSpacing: 0 }).findings.some((finding) => finding.code === "new-action-word-break"));
  } finally { await browser.close(); }
});


test("live screenshots preserve delayed author animation rather than inventing a different state", async () => {
  const browser = await chromium.launch({ headless: true });
  try {
    const page = await browser.newPage({ viewport: { width: 200, height: 200 } });
    await page.setContent(`<style>body{margin:0;background:white}.art{width:100px;height:100px;background:blue;opacity:0}</style><div class="art"></div>`);
    const hiddenState = await captureScreenshot(page);
    await page.addStyleTag({ content: `@keyframes reveal{from{opacity:0}to{opacity:1}}.art{animation:reveal 1s 3600s forwards}` });
    assert.equal(await page.locator(".art").evaluate((e) => getComputedStyle(e).opacity), "0");
    assert.deepEqual(await captureScreenshot(page), hiddenState,
      "the bitmap matches the author visibility that the immediately adjacent audit observes");
    const forcedState = await page.screenshot({ animations: "disabled" });
    assert.notDeepEqual(forcedState, hiddenState,
      "fast-forwarding invents the completed state rather than preserving the native delay");
    assert.equal(await page.locator(".art").evaluate((e) => getComputedStyle(e).opacity), "1");
  } finally { await browser.close(); }
});


test("transparent closed select artwork is not mistaken for unconverted painted text", async () => {
  const browser = await chromium.launch({ headless: true });
  try {
    const page = await browser.newPage();
    await page.setContent(`<style>select{color:transparent;appearance:none;width:24px;height:24px;background:none}input{color:transparent}input::placeholder{color:black}</style><p>Libra</p><div><svg width="24" height="24" aria-hidden="true"><path d="M0 0L12 12L24 0"/></svg><select aria-label="Change sign"><option>Libra</option></select></div><input placeholder="Visible prompt">`);
    const snapshot = await page.evaluate(collectSnapshot);
    assert.ok(snapshot.elements.some((e) => e.text === "Libra" && e.tag === "p"));
    assert.ok(!snapshot.elements.some((e) => e.tag === "select"));
    assert.ok(snapshot.elements.some((e) => e.tag === "input" && e.text === "Visible prompt"));
    assert.ok(snapshot.limitations.some((e) => /revealed native choices/.test(e.reason)));
  } finally { await browser.close(); }
});

test("painted fixed dialogs escape empty flow portals while contained and closed portals remain excluded", async () => {
  const browser = await chromium.launch({ headless: true });
  try {
    const page = await browser.newPage({ viewport: { width: 390, height: 844 } });
    await page.setContent(`<style>body{margin:0}.portal{width:0;height:0;overflow:hidden}.dialog{position:fixed;left:20px;top:20px;width:300px;padding:10px;background:white}p{font:16px Arial;margin:0}</style><div class="portal"><section class="dialog"><p>Painted consent explanation</p><button>Reject</button></section></div>`);
    assert.equal(await page.locator('p').evaluate(e=>document.elementFromPoint(50,35)===e),true);
    const painted = await page.evaluate(collectSnapshot, { scope: "all" });
    assert.ok(painted.elements.some(e=>e.text==='Painted consent explanation'&&!e.excluded));
    assert.ok(painted.elements.some(e=>e.text==='Reject'&&!e.excluded));
    assert.equal(painted.elements.find(e=>e.text==='Painted consent explanation').clipping,0);
    await page.locator('.portal').evaluate(e=>e.style.transform='translateZ(0)');
    assert.equal(await page.locator('p').evaluate(e=>document.elementFromPoint(50,35)===e),false);
    const contained = await page.evaluate(collectSnapshot, { scope: "all" });
    assert.ok(!contained.elements.some(e=>e.text==='Painted consent explanation'));
    await page.locator('.portal').evaluate(e=>e.style.transform='none');
    await page.locator('.dialog').evaluate(e=>e.style.position='static');
    const closed = await page.evaluate(collectSnapshot, { scope: "all" });
    assert.ok(!closed.elements.some(e=>e.text==='Painted consent explanation'));
  } finally { await browser.close(); }
});
