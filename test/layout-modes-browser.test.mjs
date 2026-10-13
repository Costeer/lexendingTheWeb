import assert from "node:assert/strict";
import { cp, mkdtemp, rm } from "node:fs/promises";
import { join, resolve } from "node:path";
import { tmpdir } from "node:os";
import { createServer } from "node:http";
import test from "node:test";
import { chromium } from "playwright";

// A real installed extension: storage changes, content worlds, shadow roots,
// frames and the Settings UI all run their production code.
test("installed modes switch live, preserve site choices, and restore all owned styles", async () => {
  const temporary = await mkdtemp(join(tmpdir(), "lexend-modes-"));
  const extensionPath = join(temporary, "extension");
  for (const file of ["src", "assets", "shared.css", "options.html", "options.css", "options-desktop.css", "options.js", "popup.html", "popup.css", "popup.js"])
    await cp(resolve(file), join(extensionPath, file), { recursive: true });
  await cp(resolve("manifests/manifest.chrome.json"), join(extensionPath, "manifest.json"));
  const server = createServer((request, response) => {
    response.setHeader("content-type", "text/html");
    response.end(`<!doctype html><style>body{margin:16px;font:16px/20px Arial}p{margin:0}.box{height:24px;overflow:hidden;width:280px}.fitbox{width:125px;overflow:hidden;white-space:nowrap}iframe{height:60px;width:260px;border:0}.protected{height:24px;overflow:hidden}.space{height:1800px}</style>
      <div class="box" id="box"><p id="caption">A readable caption</p></div>
      <div class="fitbox" id="fitbox"><span id="label">Reading labels</span></div>
      <p id="prose">Ordinary reading text is still Lexend.</p><h1 id="heading">Original heading</h1>
      <div class="protected" data-lexend-ignore><p id="ignored">Original typography</p></div>
      <div id="shadow"></div><button id="focus">Keep focus</button>
      ${request.url === '/frame' ? '' : `<iframe src="http://localhost:${server.address().port}/frame"></iframe>`}<div class="space"></div>
      <script>document.querySelector('#shadow').attachShadow({mode:'open'}).innerHTML='<style>:host{display:block}p{margin:0;font:16px/20px Arial}.box{height:24px;overflow:hidden;width:280px}</style><div class="box"><p>Shadow caption</p></div>';</script>`);
  });
  await new Promise(resolve => server.listen(0, "0.0.0.0", resolve));
  let context;
  try {
    context = await chromium.launchPersistentContext(join(temporary, "profile"), { channel:"chromium", headless:true,
      args:[`--disable-extensions-except=${extensionPath}`, `--load-extension=${extensionPath}`] });
    const worker = context.serviceWorkers()[0] ?? await context.waitForEvent("serviceworker");
    const patch = changes => worker.evaluate(changes => chrome.storage.sync.set(changes), changes);
    const page = await context.newPage();
    await page.goto(`http://127.0.0.1:${server.address().port}/`);
    const state = () => worker.evaluate(async () => {
      const tabs = await chrome.tabs.query({});
      for (const tab of tabs) {
        try { const state = await chrome.tabs.sendMessage(tab.id, {type:'LEXEND_GET_STATE'}, {frameId:0});
          if (state.hostname === '127.0.0.1') return state;
        } catch {}
      }
      return {};
    });
    const settled = async mode => {
      await assertEventually(async () => { const s = await state(); return s.layoutMode === mode && !s.pending && s.healthy; });
    };
    await settled('off');
    await patch({textScale:140,lineHeight:1.6}); await settled('off');
    assert.equal(await page.locator('#box').evaluate(e=>e.clientHeight),24);
    assert.equal(await page.locator('[data-lexend-layout-repair]').count(),0);
    assert.match(await page.locator('#prose').evaluate(e=>getComputedStyle(e).fontFamily),/Lexend/);
    const normalSize = await page.locator('#prose').evaluate(e=>getComputedStyle(e).fontSize);
    await patch({layoutMode:'gentle'}); await settled('gentle');
    assert.ok(await page.locator('#box').evaluate(e=>e.clientHeight)>24);
    assert.equal(await page.locator('#caption').evaluate(e=>getComputedStyle(e).fontSize),normalSize);
    assert.ok(await page.locator('#shadow').evaluate(e=>e.shadowRoot.querySelector('.box').clientHeight)>24);
    await patch({layoutMode:'fit'}); await settled('fit');
    assert.equal(await page.locator('#box').evaluate(e=>e.clientHeight),24);
    const fitted = await page.locator('#label').evaluate(e=>({font:parseFloat(getComputedStyle(e).fontSize),family:getComputedStyle(e).fontFamily}));
    assert.ok(fitted.font>=16 && fitted.font<=22.4);
    assert.equal(await page.locator('#label').getAttribute('data-lexend-layout-repair'),'fit');
    assert.equal(await page.locator('#prose').evaluate(e=>getComputedStyle(e).fontSize),normalSize);
    assert.equal(await page.locator('#ignored').evaluate(e=>getComputedStyle(e).fontSize),'16px');
    assert.doesNotMatch(await page.locator('#heading').evaluate(e=>getComputedStyle(e).fontFamily),/Lexend/);
    assert.equal(await page.locator('iframe').evaluate(e=>e.clientHeight),60);
    const child = page.frames().find(frame=>frame.url().endsWith('/frame'));
    assert.match(await child.locator('#prose').evaluate(e=>getComputedStyle(e).fontFamily),/Lexend/);

    // A later unrelated inline author mutation must not promote fitted type
    // into a new native baseline, including clones of repaired labels/boxes.
    await page.locator('#label').evaluate(e=>{e.style.color='red';const copy=e.cloneNode(true);copy.id='clone';e.parentElement.after(copy);});
    await assertEventually(async()=>!(await state()).pending);
    for(const layoutMode of ['gentle','fit','off']) { await patch({layoutMode});await settled(layoutMode); }
    assert.equal(await page.locator('[data-lexend-layout-repair],[data-lexend-original-layout]').count(),0);
    assert.equal(await page.locator('#label').evaluate(e=>getComputedStyle(e).fontSize),normalSize);
    assert.equal(await page.locator('#label').evaluate(e=>e.style.color),'red');
    assert.equal(await page.locator('#clone').evaluate(e=>getComputedStyle(e).fontSize),normalSize);
    assert.equal(await page.locator('#box').getAttribute('style'),null);

    await patch({siteRules:[{hostname:'127.0.0.1',includeSubdomains:false,enabled:null,scope:null,layoutMode:'fit'}]});
    await settled('fit');
    await patch({layoutMode:'gentle'});await settled('fit');
    await patch({enabled:false});
    await assertEventually(async()=>!(await state()).active && !(await state()).pending);
    assert.equal(await page.locator('#box').getAttribute('style'),null);
    assert.equal(await page.locator('#label').evaluate(e=>getComputedStyle(e).fontSize),'16px');
    await patch({enabled:true});await settled('fit');
    await page.reload();await settled('fit');

    // Use the actual extension Settings page and background writer.
    const options = await context.newPage();
    await options.goto(worker.url().replace('/src/background.js','/options.html'));
    await options.locator('#layout-mode').selectOption('off');
    await assertEventually(async()=>await worker.evaluate(async()=> (await chrome.storage.sync.get('layoutMode')).layoutMode)==='off');
    await settled('fit'); // this site's explicit choice wins over the default
    assert.match(await options.locator('#rule-list').textContent(),/Layout: Fit text/);
    await patch({siteRules:[]});await settled('off');
  } finally {
    await context?.close();await new Promise(resolve=>server.close(resolve));await rm(temporary,{recursive:true,force:true});
  }
});

async function assertEventually(check) {
  for(let attempt=0;attempt<100;attempt++) {
    if(await check()) return;
    await new Promise(resolve=>setTimeout(resolve,50));
  }
  assert.fail('The installed extension did not reach the expected state within 5 seconds.');
}
