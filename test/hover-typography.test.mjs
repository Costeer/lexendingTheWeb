import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
import test from "node:test";
import { chromium } from "playwright";

test("hover rerenders retain converted typography before paint and preserve new author baselines", async () => {
  const browser = await chromium.launch({ headless: true });
  try {
    const page = await browser.newPage({ viewport: { width: 900, height: 700 } });
    const warnings = [];
    page.on("console", message => {
      if (message.type() === "warning" && message.text().includes("could not refresh")) warnings.push(message.text());
    });
    await page.route("http://hover.test/**", async route => {
      const path = new URL(route.request().url()).pathname;
      await route.fulfill({ body: await readFile(resolve(`.${path}`)), contentType: "font/woff2" });
    });
    await page.setContent(`<!doctype html><style>
      body {margin:0;font:16px/24px Arial} aside {width:240px;position:fixed}
      #collapse {position:absolute;left:240px;top:180px;width:40px;height:40px}
      #tip {position:fixed;left:290px;top:185px;background:#253858;color:white;padding:8px}
      main {margin-left:320px} p {margin:0}
    </style><aside><p id="home">Home</p><p id="balances">Balances</p>
      <p id="protected" data-lexend-ignore>Protected label</p>
      <button id="collapse" aria-label="Collapse navigation">‹</button></aside>
      <main><p id="description">Readable page description</p></main>`);
    await page.evaluate(() => {
      globalThis.__settings = {enabled:true,scope:"all",textScale:110,lineHeight:1.6,letterSpacing:.02};
      globalThis.__storage = [];
      globalThis.__runtime = [];
      globalThis.chrome = {runtime:{getURL:path=>`http://hover.test/${path}`,sendMessage:async()=>{},onMessage:{addListener:f=>__runtime.push(f)}},
        storage:{sync:{get:async()=>__settings},onChanged:{addListener:f=>__storage.push(f)}}};
      globalThis.__state = () => {let result;__runtime.forEach(f=>f({type:"LEXEND_GET_STATE"},null,value=>{result=value;}));return result;};
      globalThis.__update = values => {
        Object.assign(__settings, values);
        const changes = Object.fromEntries(Object.entries(values).map(([key,newValue])=>[key,{newValue}]));
        __storage.forEach(f=>f(changes,"sync"));
      };
      globalThis.__frames = [];
      globalThis.__sampleFrames = false;
      const sample = () => {
        if (__sampleFrames) __frames.push(...["home","balances","description"].map(id=>{
          const css=getComputedStyle(document.getElementById(id));
          return {id,family:css.fontFamily,size:parseFloat(css.fontSize),phase:globalThis.__phase};
        }));
        requestAnimationFrame(sample);
      };
      requestAnimationFrame(sample);
      const rerender = hovering => {
        for (const id of ["home","balances"]) document.getElementById(id).style.cssText = hovering
          ? "font-family:Georgia!important;font-size:18px!important;background-color:rgb(240, 244, 248)"
          : "";
        if (hovering) {
          const tip=document.createElement("div");tip.id="tip";tip.role="tooltip";tip.textContent="Collapse";document.body.append(tip);
        } else document.getElementById("tip")?.remove();
      };
      const action=document.getElementById("collapse");
      action.addEventListener("mouseenter",()=>rerender(true));
      action.addEventListener("mouseleave",()=>rerender(false));
    });
    for (const name of ["settings","adaptive-controls","adaptive-layout","content"]) await page.addScriptTag({path:resolve(`src/${name}.js`)});
    await page.waitForFunction(()=>__state()?.healthy&&!__state().pending);
    await page.evaluate(()=>document.fonts.ready);
    await page.waitForTimeout(150);
    await page.evaluate(()=>{__frames=[];__sampleFrames=true;});
    for (let i=0;i<5;i++) {
      await page.evaluate(i=>{globalThis.__phase=`pointer cycle ${i}`;},i);
      await page.locator("#collapse").hover();
      // Frameworks can rewrite inline styles again while an existing tooltip
      // remains mounted; that style-only batch used to wait 100ms to recover.
      await page.waitForFunction(()=>__state().healthy&&!__state().pending);
      await page.evaluate(()=>{
        document.getElementById("home").style.cssText="font-family:Georgia!important;font-size:18px!important;background-color:rgb(240, 244, 248)";
      });
      await page.waitForTimeout(50);
      const hover = await page.locator("#home").evaluate(e=>({family:getComputedStyle(e).fontFamily,size:parseFloat(getComputedStyle(e).fontSize)}));
      assert.match(hover.family,/Lexend/,"style-only hover rerenders cannot leave the sidebar in its author font");
      await page.waitForFunction(()=>__state().healthy&&!__state().pending);
      assert.ok(Math.abs((await page.locator("#home").evaluate(e=>parseFloat(getComputedStyle(e).fontSize)))-19.8)<.02);
      assert.match(await page.locator("#tip").evaluate(e=>getComputedStyle(e).fontFamily),/Lexend/);
      await page.mouse.move(700,600);
      await page.waitForFunction(()=>!document.getElementById("tip")&&__state().healthy&&!__state().pending);
      assert.ok(Math.abs((await page.locator("#home").evaluate(e=>parseFloat(getComputedStyle(e).fontSize)))-17.6)<.02);
    }
    await page.evaluate(()=>{
      globalThis.__phase="continuous inline writes";
      globalThis.__styleLoop=setInterval(()=>{
        document.getElementById("home").style.cssText="font-family:Georgia!important;font-size:18px!important;background-color:rgb(240, 244, 248)";
      },16);
    });
    await page.waitForTimeout(250);
    await page.evaluate(()=>clearInterval(__styleLoop));
    await page.waitForFunction(()=>__state().healthy&&!__state().pending);
    const frames = await page.evaluate(()=>{__sampleFrames=false;return __frames;});
    assert.ok(frames.length>20,"native pointer cycles sampled multiple painted frames");
    assert.ok(frames.every(frame=>frame.family.includes("Lexend")),`every painted sidebar and page frame retains converted typography: ${JSON.stringify(frames.filter(frame=>!frame.family.includes("Lexend")))}`);
    assert.deepEqual(warnings,[]);
    // Pausing immediately after another author write must restore that new
    // baseline even before the deferred global geometry refresh executes.
    await page.evaluate(()=>{document.getElementById("home").style.cssText="font-family:Georgia!important;font-size:21px!important;color:rgb(12, 34, 56)";});
    await page.evaluate(()=>__update({enabled:false}));
    const paused = await page.locator("#home").evaluate(e=>({family:getComputedStyle(e).fontFamily,size:parseFloat(getComputedStyle(e).fontSize),color:getComputedStyle(e).color}));
    assert.deepEqual(paused,{family:"Georgia",size:21,color:"rgb(12, 34, 56)"});
    assert.equal(await page.locator("#protected").getAttribute("style"),null);
    await page.evaluate(()=>__update({enabled:true}));
    const feedbackWrites = await page.evaluate(async()=>{
      const element=document.getElementById("home");
      let writes=0;
      const author=new MutationObserver(()=>{
        if (element.style.fontFamily.includes("Lexend")) {
          writes++;
          element.style.setProperty("font-family","Georgia","important");
        }
      });
      author.observe(element,{attributes:true,attributeFilter:["style"]});
      element.style.setProperty("font-family","Arial","important");
      await new Promise(resolve=>setTimeout(resolve,30));
      author.disconnect();
      return writes;
    });
    assert.ok(feedbackWrites>0&&feedbackWrites<=2,"a competing author observer cannot trap the browser in a microtask write loop");
    await page.waitForFunction(()=>__state().healthy&&!__state().pending);
    const counterValues = await page.locator("#description").evaluate(e=>{
      const context=document.createElement("canvas").getContext("2d");
      const css=getComputedStyle(e);
      context.font=css.font||`${css.fontStyle} ${css.fontWeight} ${css.fontSize} ${css.fontFamily}`;
      const values=Array.from({length:10},(_,digit)=>`Running total: ${digit}${digit}.${digit}${digit}%`);
      for(const first of values)for(const second of values)if(first!==second&&Math.abs(context.measureText(first).width-context.measureText(second).width)<=.01)return[first,second];
      return null;
    });
    assert.ok(counterValues,"the loaded font supplies distinct equal-width numeric states");
    await page.locator("#description").evaluate((e,value)=>{e.textContent=value;},counterValues[0]);
    await page.waitForFunction(()=>__state().healthy&&!__state().pending);
    const revision = await page.evaluate(()=>__state().refreshRevision);
    for (let i=0;i<30;i++) {
      await page.locator("#description").evaluate((e,{i,value})=>{
        if(i%2)e.firstChild.data=value;
        else e.textContent=value;
      },{i,value:counterValues[i%2]});
    }
    await page.waitForTimeout(150);
    assert.equal(await page.evaluate(()=>__state().refreshRevision),revision,"fitting numeric animation does not repeatedly restore typography across the whole page");
    await page.locator("#description").evaluate(e=>{e.style.cssText="width:70px;height:24px;overflow:hidden;white-space:nowrap";e.textContent="Total: 1";});
    await page.waitForFunction(()=>__state().healthy&&!__state().pending);
    const clippedRevision=await page.evaluate(()=>__state().refreshRevision);
    await page.locator("#description").evaluate(e=>{e.textContent="Total: "+"1234567890".repeat(20);});
    await page.waitForFunction((revision)=>__state().refreshRevision>revision&&!__state().pending,clippedRevision);
    assert.match(await page.locator("#description").evaluate(e=>getComputedStyle(e).fontFamily),/Lexend/);
    assert.equal(await page.evaluate(()=>__state().healthy),true,"numeric growth crossing a native clip still receives a complete repair");
  } finally {
    await browser.close();
  }
});
