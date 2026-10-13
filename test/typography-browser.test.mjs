import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
import test from "node:test";
import { chromium } from "playwright";

// This tests the content script itself without rebuilding the concurrently used
// extension bundle. Actual website compatibility remains a screenshot review.
test("typography preserves protected content and refreshes atomic inherited baselines", async () => {
  const browser = await chromium.launch({ headless: true });
  try {
    const page = await browser.newPage({ viewport: { width: 1000, height: 800 } });
    const refreshWarnings = [];
    page.on("console", (message) => { if (message.type()==="warning" && message.text().includes("could not refresh")) refreshWarnings.push(message.text()); });
    await page.route("http://lexend.test/**", async (route) => {
      const pathname = new URL(route.request().url()).pathname;
      await route.fulfill({ body: await readFile(resolve(`.${pathname}`)), contentType: "font/woff2" });
    });
    await page.setContent(`<!doctype html><style>
      body {font: 20px/1.25 Arial;letter-spacing:1px}
      h2 {font:inherit}
      #relative {font-size:1.2em}
      #unknown-glyph,#mixed-glyph {font-family:ArbitraryTypeface}
      #unknown-pseudo::before {font-family:ArbitraryTypeface;content:"\\e842"}
      #unknown-alt-pseudo::after {font-family:ArbitraryTypeface;content:"\\e842" / "Navigate"}
      #mixed-alt-pseudo::after {font-family:ArbitraryTypeface;content:"\\e842 Caption / text" / "Accessible caption"}
      #symbol {font-family:CC; font-size:24px;line-height:normal;letter-spacing:0}
      #editor {font-family:Consolas,monospace;font-size:15px;line-height:normal;letter-spacing:0}
      #generic-code {font-family:ExampleMono;font-size:15px;line-height:normal;letter-spacing:0}
      #ordinary-font-name {font-family:Monotype,Arial}
      #arabic-label {display:block;direction:rtl;width:67px;overflow:hidden;font:14px/24px Arial;letter-spacing:0}
      #pseudo::before {font-family:CC;content:'cb';font-size:24px;letter-spacing:0}
      #badge {display:inline-block;width:124px;height:38px;color:transparent;font:13px/19.5px Arial;background:url("data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' width='124' height='38'%3E%3Crect width='124' height='38'/%3E%3C/svg%3E")}
      #gradient {color:transparent;background:linear-gradient(red,blue);background-clip:text}
      #skip {position:absolute;clip:rect(1px,1px,1px,1px);width:40px;height:38px;overflow:hidden;font:18px/1.1 Arial}
      #skip:focus {clip:auto;width:auto;height:auto;overflow:visible}
      #drawer {position:fixed;left:-195px;top:0}
      #drawer-label {display:block;width:260px;padding:20px 45px 20px 20px;box-sizing:border-box;font:19px Arial;letter-spacing:0;background:url("data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' width='30' height='30'%3E%3Crect width='30' height='30'/%3E%3C/svg%3E") no-repeat right center}
      #transition {font-size:22.4px;transition:all 2s}
      #delayed-instant {font:500 16px/16px Arial;transition:all 0s .5s}
      #delayed-tooltip::after {content:"Search by image";font:13px/17px Arial;position:absolute;top:0;left:0;transition:all 0s .5s}
      #animated-tooltip::before {content:"Learn more";font:13px/17px Arial;transition:font-size .4s ease,color .2s linear .1s}
      .inherited-control {font:16px/21px Arial;width:230px}
      .inherited-wrapper {transition:all .00001s}
      #inherited-label {transition:opacity .00001s}
      #mixed-transition {font-size:22.4px;transition:font-size 2s ease,color .4s linear .1s,transform .8s ease-in .2s}
      html :where([style*="border-top-color"]) {border-top-style:solid}
      html :where([style*="border-left-width"]) {border-left-style:solid}
      @media(max-width:600px) {body {font-size:18px} #relative {font-size:1.5em}}
    </style><div id=parent>Parent words <span id=relative>Nested relative words</span>
      <code id=inline-code style="font:inherit;letter-spacing:inherit">Inline code</code>
      <h2 id=heading>Unchanged heading <span id=heading-child>and nested title</span></h2>
      <svg><text id=svg-text>Vector label</text></svg>
    </div><nav id=drawer><a id=drawer-label href="#parent">Marine &amp; Aviation</a></nav><a id=skip href="#parent">Skip to main content</a><div class=with-icon id=wrapper>Ordinary wrapper prose</div>
    <p id=priority style="font-family:Georgia!important;font-size:19px!important;line-height:1.2!important;letter-spacing:2px!important">Author important prose</p><div data-icon=arrow id=data-icon>Ordinary icon wrapper label</div>
    <a href="#"><span id=badge>Image replacement label</span></a><span id=gradient>Painted gradient label</span><span id=symbol>cba</span><div id=editor contenteditable=true>const answer = 42;</div>
    <div id=generic-code>const genericFont = true;</div><span id=ordinary-font-name>Ordinary named-family prose</span><span id=arabic-label>سارة أحمد</span>
    <span id=unknown-glyph>\ue842</span><span id=mixed-glyph>\ue842 Ordinary caption</span><span id=unknown-pseudo>Caption after unknown symbol</span><span id=unknown-alt-pseudo>Accessible icon alternative</span><span id=mixed-alt-pseudo>Mixed icon caption</span><span id=aria-prose aria-hidden=true>Visible decorative prose</span><p id=transition>Text with animated typography</p><a href="#parent"><span id=delayed-instant>Log In</span><svg width=10 height=15><path d="M0 0L10 8L0 15"/></svg></a><p id=mixed-transition>Mapped color and transform transitions</p><span id=pseudo>Generated icon and prose</span><h1 id=fit-title style="font-size:20px;width:180px;overflow-wrap:anywhere">ACCESSIBILITY</h1><div id=shadow-host></div><button id=delayed-tooltip aria-label="Search by image"></button><span id=animated-tooltip>Hover action</span><button class=inherited-control id=inherited-control><div class=inherited-wrapper id=inherited-wrapper><div class=inherited-wrapper><span id=inherited-label>For You</span></div></div></button>`);
    await page.evaluate(() => {
      const shadow = document.querySelector("#shadow-host").attachShadow({ mode: "open" });
      shadow.innerHTML = '<style>p {font:18px/1.4 Arial;letter-spacing:0} code {font:inherit}</style><p id=shadow-text>Shadow prose <code id=shadow-code>code()</code></p>';
      globalThis.__settings = { layoutMode: "gentle", enabled: false, scope: "body", textScale: 110, lineHeight: 1.6, letterSpacing: 0.02 };
      globalThis.__listeners = [];
      globalThis.__runtimeListeners = [];
      globalThis.chrome = {
        runtime: { getURL: (path) => `http://lexend.test/${path}`, sendMessage: async () => {}, onMessage: { addListener: (fn) => globalThis.__runtimeListeners.push(fn) } },
        storage: { sync: { get: async () => globalThis.__settings }, onChanged: { addListener: (fn) => globalThis.__listeners.push(fn) } }
      };
      globalThis.__update = (values) => {
        Object.assign(globalThis.__settings, values);
        const changes = Object.fromEntries(Object.entries(values).map(([key,newValue]) => [key,{newValue}]));
        globalThis.__listeners.forEach((fn) => fn(changes,"sync"));
      };
      globalThis.__metrics = (id, pseudo = null) => {
        const node = document.getElementById(id) ?? document.getElementById("shadow-host").shadowRoot.getElementById(id);
        const style = getComputedStyle(node, pseudo);
        return {family:style.fontFamily,size:parseFloat(style.fontSize),line:style.lineHeight,spacing:style.letterSpacing};
      };
      globalThis.__state = () => {let state;__runtimeListeners.forEach((fn) => fn({type:"LEXEND_GET_STATE"},null,(value) => {state=value;}));return state;};
    });
    const protectedIds = ["inline-code", "heading", "heading-child", "symbol", "editor", "generic-code", "svg-text", "shadow-code", "badge", "unknown-glyph", "skip", "drawer-label"];
    const baseline = await page.evaluate((ids) => Object.fromEntries(ids.map((id) => [id,__metrics(id)])), protectedIds);
    const baselineUnknownPseudo = await page.evaluate(() => __metrics("unknown-pseudo", "::before"));
    const baselineAlternativePseudo = await page.evaluate(() => __metrics("unknown-alt-pseudo", "::after"));
    const baselinePseudo = await page.evaluate(() => __metrics("pseudo", "::before"));
    const badgeHeight = await page.locator("#badge").evaluate((element) => element.getBoundingClientRect().height);
    await page.addScriptTag({ path: resolve("src/settings.js") });
    await page.addScriptTag({ path: resolve("src/adaptive-layout.js") });
    await page.evaluate(() => {
      const create = globalThis.LexendLayout.create;
      globalThis.LexendLayout = {create: (options) => {
        const controller = create(options), repair=controller.repair;
        return {...controller,repair:(...args) => {if(globalThis.__failLayout)throw new Error("Injected layout failure");return repair(...args);}};
      }};
    });
    await page.addScriptTag({ path: resolve("src/content.js") });
    await page.evaluate(() => __update({enabled:true}));
    await page.waitForFunction(() => document.querySelector("#relative").hasAttribute("data-lexend-text"));
    await page.waitForFunction(() => document.querySelector("#arabic-label").hasAttribute("data-lexend-text"));
    const converted = await page.evaluate(() => Object.fromEntries(["parent","relative","wrapper","data-icon","shadow-text","priority","gradient","aria-prose","mixed-glyph","ordinary-font-name"].map((id) => [id,__metrics(id)])));
    for (const style of Object.values(converted)) assert.match(style.family, /Lexend for the Web/);
    const arabic = await page.evaluate(() => __metrics("arabic-label"));
    assert.match(arabic.family, /Lexend for the Web/);
    assert.ok(Math.abs(arabic.size - 15.4) < 0.02);
    assert.equal(await page.locator("#arabic-label").evaluate((element) => element.style.getPropertyValue("letter-spacing")), "0px", "joined Arabic text remains untracked after scaling");
    assert.ok(Math.abs(converted.priority.size - 20.9) < 0.02);
    assert.equal(converted.priority.line,"33.44px");
    assert.ok(Math.abs(converted.parent.size - 22) < 0.02);
    assert.ok(Math.abs(converted.relative.size - 26.4) < 0.02, "nested em text is scaled once");
    assert.ok(Math.abs(converted["shadow-text"].size - 19.8) < 0.02);
    const protectedWithFallback = { ...baseline, "unknown-glyph": {
      ...baseline["unknown-glyph"], family: `${baseline["unknown-glyph"].family}, "Lexend Nerd Symbols"`
    } };
    assert.deepEqual(await page.evaluate((ids) => Object.fromEntries(ids.map((id) => [id,__metrics(id)])), protectedIds), protectedWithFallback);
    assert.deepEqual(await page.evaluate(() => __metrics("pseudo","::before")), baselinePseudo);
    assert.deepEqual(await page.evaluate(() => __metrics("unknown-pseudo","::before")), { ...baselineUnknownPseudo, family: `${baselineUnknownPseudo.family}, "Lexend Nerd Symbols"` });
    assert.deepEqual(await page.evaluate(() => __metrics("unknown-alt-pseudo","::after")), { ...baselineAlternativePseudo, family: `${baselineAlternativePseudo.family}, "Lexend Nerd Symbols"` },"accessible alternative content does not corrupt a pure painted icon");
    assert.match((await page.evaluate(() => __metrics("mixed-alt-pseudo","::after"))).family,/Lexend for the Web.*ArbitraryTypeface/,"painted mixed caption including slash still converts");
    assert.match((await page.evaluate(() => __metrics("mixed-glyph"))).family,/Lexend for the Web.*ArbitraryTypeface/);
    assert.equal(await page.locator("#badge").evaluate((element) => element.getBoundingClientRect().height),badgeHeight);
    assert.deepEqual(await page.locator("#transition").evaluate((element) => ({top:getComputedStyle(element).borderTopWidth,left:getComputedStyle(element).borderLeftWidth})),{top:"0px",left:"0px"},"transition expansion does not trigger author style-substring border rules");
    await page.locator("#skip").focus();
    await page.waitForFunction(() => /Lexend/.test(__metrics("skip").family));
    assert.ok(Math.abs((await page.evaluate(() => __metrics("skip"))).size-19.8)<0.02,"revealed focused skip link converts");
    await page.locator("#skip").evaluate((element) => element.blur());
    await page.waitForFunction(() => !/Lexend/.test(__metrics("skip").family));
    assert.deepEqual(await page.evaluate(() => __metrics("skip")),baseline.skip,"hidden skip-link paint state retains original metrics");
    await page.locator("#drawer").evaluate((element) => {element.style.left="0px";});
    await page.waitForFunction(() => /Lexend/.test(__metrics("drawer-label").family));
    await page.locator("#drawer").evaluate((element) => {element.style.removeProperty("left");});
    await page.waitForFunction(() => !/Lexend/.test(__metrics("drawer-label").family));
    assert.deepEqual(await page.evaluate(() => __metrics("drawer-label")),baseline["drawer-label"],"closed icon rail label remains outside the viewport");
    await page.locator("#drawer").evaluate((element) => {
      element.style.left="-800px";
      element.style.transition="left .45s linear";
    });
    await page.waitForTimeout(600);
    await page.locator("#drawer").evaluate((element) => {element.style.left="0px";});
    await page.waitForTimeout(160);
    assert.ok(!/Lexend/.test((await page.evaluate(() => __metrics("drawer-label"))).family),"early refresh sees a moving rail's label still offscreen");
    await page.waitForFunction(() => /Lexend/.test(__metrics("drawer-label").family));
    assert.ok(Math.abs((await page.evaluate(() => __metrics("drawer-label"))).size-20.9)<0.02,"movement completion converts newly visible prose without another page mutation");
    await page.locator("#drawer").evaluate((element) => {element.style.removeProperty("transition");element.style.removeProperty("left");});
    await page.waitForFunction(() => !/Lexend/.test(__metrics("drawer-label").family));

    const mappedTransition = await page.locator("#mixed-transition").evaluate((element) => {
      const style=getComputedStyle(element);
      return {property:style.transitionProperty,duration:style.transitionDuration,delay:style.transitionDelay,timing:style.transitionTimingFunction};
    });
    assert.deepEqual(mappedTransition,{property:"color, transform",duration:"0.4s, 0.8s",delay:"0.1s, 0.2s",timing:"linear, ease-in"});
    await page.locator("#mixed-transition").evaluate((element) => {element.style.color="red";element.style.transform="translateX(10px)";});
    await page.waitForTimeout(30);
    const animations = await page.locator("#mixed-transition").evaluate((element) => element.getAnimations().map((animation) => animation.transitionProperty));
    assert.ok(animations.includes("color") && animations.includes("transform"),"nonfont transitions remain real running CSS transitions");
    for (let index=0;index<20;index++) {
      await page.evaluate((value) => { document.body.dataset.refresh=String(value);document.querySelector("#wrapper").textContent=`Ordinary wrapper prose ${value}`;window.scrollTo(0,value%2?50:0); },index);
      await page.waitForTimeout(130);
      assert.ok(Math.abs((await page.evaluate(() => __metrics("transition"))).size-24.64)<0.02,"font transitions do not turn interpolated sizes into larger baselines");
      assert.ok(Math.abs((await page.evaluate(() => __metrics("delayed-instant"))).size-17.6)<0.02,"zero-duration delayed typography does not compound on DOM and scroll refreshes");
      assert.ok(Math.abs((await page.evaluate(() => __metrics("inherited-label"))).size-17.6)<0.02,"nontext wrapper transitions do not retain a parent's converted font as the next label baseline");
      for (const [id,pseudo] of [["delayed-tooltip","::after"],["animated-tooltip","::before"]]) {
        assert.ok(Math.abs((await page.evaluate(([id,pseudo])=>__metrics(id,pseudo),[id,pseudo])).size-14.3)<0.02,"generated tooltip typography stays once-scaled through repeated refreshes");
      }
    }
    const remainingTransitions = await page.locator("#transition").evaluate((element) => getComputedStyle(element).transitionProperty);
    assert.ok(remainingTransitions.includes("opacity") && remainingTransitions.includes("transform"));
    assert.ok(!remainingTransitions.split(",").map((value)=>value.trim()).includes("font-size"));
    assert.equal(await page.locator("#inherited-wrapper").evaluate(element => element.style.getPropertyValue("font-size")), "", "wrapper owns transition suppression without a font-size override");
    await page.locator("#inherited-wrapper").evaluate(element => {
      element.style.fontSize="18px";
      element.style.transitionProperty="font-size, color";
      element.style.transitionDuration=".00001s, .4s";
      element.style.transitionDelay="0s, .1s";
    });
    await page.waitForFunction(() => Math.abs(__metrics("inherited-label").size-19.8)<.02);
    await page.evaluate(() => {
      const clone=document.querySelector("#inherited-control").cloneNode(true);
      clone.id="inherited-clone";
      clone.querySelector("#inherited-wrapper").id="inherited-clone-wrapper";
      clone.querySelector("#inherited-label").id="inherited-clone-label";
      document.body.append(clone);
    });
    await page.waitForFunction(() => Math.abs(__metrics("inherited-clone-label").size-19.8)<.02);
    await page.waitForTimeout(150);
    assert.ok(Math.abs((await page.evaluate(() => __metrics("inherited-clone-label"))).size-19.8)<.02,"cloned inherited wrapper restores its authored branch before the first baseline capture");
    await page.evaluate(() => {
      document.querySelector("#relative").style.fontSize = "30px";
      const p = document.createElement("p"); p.id = "dynamic";p.textContent="Dynamically inserted prose";
      document.body.append(p);
      const shadow = document.querySelector("#shadow-host").shadowRoot;
      const extra = document.createElement("p"); extra.id="dynamic-shadow";extra.textContent="New shadow text";shadow.append(extra);
    });
    await page.waitForFunction(() => Math.abs(__metrics("relative").size-33)<0.02 && /Lexend/.test(__metrics("dynamic-shadow").family));
    await page.evaluate(() => {
      const cloned = document.querySelector("#wrapper").cloneNode(true);
      cloned.id="cloned";document.body.append(cloned);
    });
    await page.waitForFunction(() => Math.abs(__metrics("cloned").size-22)<0.02);
    // Wait for observer refresh to recover its original, unscaled author state.
    await page.waitForTimeout(150);
    assert.ok(Math.abs((await page.evaluate(() => __metrics("cloned"))).size-22)<0.02);
    await page.evaluate(() => __update({textScale:120}));
    assert.ok(Math.abs((await page.evaluate(() => __metrics("relative"))).size - 36) < 0.02);
    await page.evaluate(() => { document.querySelector("#relative").style.removeProperty("font-size"); });
    await page.setViewportSize({ width: 500, height: 800 });
    await page.waitForFunction(() => Math.abs(__metrics("relative").size - 32.4)<0.02);
    assert.equal((await page.evaluate(() => __metrics("heading"))).size,18, "body scope heading tracks page responsive styles");
    await page.evaluate(() => {
      const spacer=document.createElement("div");spacer.style.height="6000px";document.body.append(spacer);
      const end=document.createElement("p");end.textContent="Long-page last paragraph";document.body.append(end);
    });
    await page.waitForTimeout(150);
    await page.evaluate(() => window.scrollTo(0,4500));
    const stableY = await page.evaluate(() => scrollY);
    await page.evaluate(() => {document.querySelector("#wrapper").textContent="Ordinary wrapper prose 20";});
    await page.waitForTimeout(150);
    assert.ok(Math.abs((await page.evaluate(() => scrollY))-stableY)<2,"refresh preserves the viewport on a long scrolled page");
    await page.evaluate(() => window.scrollTo(0,0));
    await page.evaluate(() => __update({scope:"all"}));
    assert.match((await page.evaluate(() => __metrics("heading-child"))).family,/Lexend/);
    assert.ok(Math.abs((await page.evaluate(() => __metrics("heading"))).size - 21.6)<0.02);

    await page.evaluate(() => document.fonts.ready);
    await page.waitForTimeout(150);
    assert.equal(await page.locator("#fit-title").getAttribute("data-lexend-layout-repair"), null, "Gentle mode leaves naturally wrapping headings alone");
    const fittedSize = await page.evaluate(() => __metrics("fit-title").size);
    await page.evaluate(() => {
      const cloned = document.querySelector("#fit-title").cloneNode(true);
      cloned.id="fit-clone";document.body.append(cloned);
    });
    await page.waitForTimeout(150);
    assert.ok(Math.abs((await page.evaluate(() => __metrics("fit-clone"))).size-fittedSize)<0.05, "cloned fitted heading starts from original authored size, not an already fitted size");
    await page.evaluate(() => {
      const table=document.createElement("table");table.id="keyboard-table";
      table.style.cssText="font:20px Arial;letter-spacing:0;border-collapse:collapse";
      table.innerHTML='<tr><td style="white-space:nowrap">MMMMMMMMMMMMMM</td><td style="white-space:nowrap">MMMMMMMMMMMMMM</td></tr>';
      const region=document.createElement("div");region.id="author-table-region";
      region.setAttribute("role","region");region.tabIndex=0;region.style.overflowX="auto";
      region.append(table);document.body.append(region);
      table.scrollIntoView({block:"center"});
    });
    await page.waitForTimeout(150);
    const tableDiagnostic = await page.locator("#keyboard-table").evaluate((table) => ({box:table.getBoundingClientRect().toJSON(),font:getComputedStyle(table.firstChild.firstChild.firstChild).font,repair:table.dataset.lexendLayoutRepair,state:__state(),bodyScroll:document.body.scrollTop}));
    assert.equal(await page.locator("#keyboard-table").evaluate((table) => table.parentElement.getAttribute("role")),"region",JSON.stringify(tableDiagnostic));
    await page.locator("#keyboard-table").evaluate((table) => table.parentElement.focus());
    await page.keyboard.press("ArrowRight");
    await page.keyboard.press("ArrowRight");
    await page.waitForTimeout(200);
    const tableX = await page.locator("#keyboard-table").evaluate((table) => table.parentElement.scrollLeft);
    assert.ok(tableX>5,"keyboard ArrowRight scrolls enlarged table: "+JSON.stringify(await page.locator("#keyboard-table").evaluate(table=>({scroll:table.parentElement.scrollLeft,width:table.parentElement.clientWidth,extent:table.parentElement.scrollWidth,active:document.activeElement.tagName,focus:document.activeElement===table.parentElement,rect:table.getBoundingClientRect().toJSON(),style:table.parentElement.style.cssText,state:__state()}))));
    await page.evaluate(() => {document.querySelector("#wrapper").textContent="Focused table region survives refresh";});
    await page.waitForTimeout(150);
    assert.equal(await page.locator("#keyboard-table").evaluate((table) => document.activeElement===table.parentElement),true,"native table wrapper retains keyboard focus");
    assert.ok(Math.abs((await page.locator("#keyboard-table").evaluate((table) => table.parentElement.scrollLeft))-tableX)<1,"native table wrapper retains keyboard scroll offset");
    await page.evaluate(() => {
      document.documentElement.style.height=`${innerHeight}px`;
      document.documentElement.style.overflow="hidden";
      document.body.style.height=`${innerHeight}px`;
      document.body.style.overflowY="auto";
      document.body.style.overflowAnchor="auto";
    });
    await page.waitForTimeout(150);
    await page.evaluate(() => {document.body.scrollTop=4500;});
    const bodyY = await page.evaluate(() => document.body.scrollTop);
    assert.ok(bodyY>4000,"fixture uses the full-viewport body scrollbar");
    await page.evaluate(() => {document.querySelector("#wrapper").textContent="Ordinary wrapper prose 21";});
    await page.waitForTimeout(150);
    assert.ok(Math.abs((await page.evaluate(() => document.body.scrollTop))-bodyY)<2,"refresh preserves primary body scroll position");
    assert.equal(await page.evaluate(() => document.body.style.overflowAnchor),"auto","body scroll anchoring restores its authored value");
    assert.equal(await page.evaluate(() => __state().healthy),true);
    await page.evaluate(() => {globalThis.__failLayout=true;__update({textScale:125});});
    await page.waitForFunction(() => !__state().pending);
    assert.deepEqual(await page.evaluate(() => ({healthy:__state().healthy,error:__state().error})),{healthy:false,error:"Injected layout failure"},"runtime state reports actual failed refresh");
    assert.match((await page.evaluate(() => __metrics("wrapper"))).family,/Lexend/,"applied typography remains available while repair failure is retried");
    await page.evaluate(() => __update({textScale:125}));
    await page.waitForFunction(() => !__state().pending);
    assert.equal(refreshWarnings.length,1,"repeated same repair error warns once");
    await page.evaluate(() => {globalThis.__failLayout=false;document.querySelector("#wrapper").textContent="Recovered observer refresh";});
    await page.waitForFunction(() => __state().healthy);
    assert.equal(await page.evaluate(() => __state().error),null,"only completed successful refresh clears runtime failure");
    const nestedBaseline = await page.evaluate(() => {
      const scroller=document.createElement("div");scroller.id="nested-scroll";
      scroller.style.cssText="width:220px;overflow:auto;font:20px Arial;letter-spacing:0";
      const text=document.createElement("span");text.style.whiteSpace="nowrap";text.textContent="MMMMMMMMMMMM";
      scroller.append(text);document.body.append(scroller);
      return {width:scroller.clientWidth,scrollWidth:scroller.scrollWidth};
    });
    assert.equal(nestedBaseline.width,nestedBaseline.scrollWidth,"author baseline fits inside nested viewport");
    await page.waitForTimeout(150);
    const nestedX = await page.locator("#nested-scroll").evaluate((element) => {element.scrollLeft=element.scrollWidth-element.clientWidth;return element.scrollLeft;});
    assert.ok(nestedX>10,"converted text creates a real horizontal scroll range");
    await page.evaluate(() => {document.querySelector("#wrapper").textContent="Scrolled tab label remains reachable";});
    await page.waitForTimeout(150);
    assert.ok(Math.abs((await page.locator("#nested-scroll").evaluate((element) => element.scrollLeft))-nestedX)<1,"temporary author baseline cannot clamp nested horizontal scroll position");
    await page.waitForTimeout(150);
    await page.evaluate(() => {
      globalThis.__ownMutations=0;
      globalThis.__watcher=new MutationObserver((records) => { globalThis.__ownMutations+=records.length; });
      globalThis.__watcher.observe(document,{subtree:true,attributes:true,childList:true});
    });
    await page.waitForTimeout(250);
    assert.equal(await page.evaluate(() => __ownMutations),0,"quiet page does not enter a self-mutation refresh loop");
    await page.evaluate(() => { __watcher.disconnect();__update({enabled:false}); });
    await page.waitForTimeout(20);
    assert.equal((await page.evaluate(() => __metrics("inherited-label"))).size,18,"authored wrapper font update survives extension disable");
    assert.equal((await page.evaluate(() => __metrics("inherited-clone-label"))).size,18,"cloned wrapper retains its original authored font");
    assert.deepEqual(await page.locator("#inherited-wrapper").evaluate(element => ({property:element.style.transitionProperty,duration:element.style.transitionDuration,delay:element.style.transitionDelay})),{property:"font-size, color",duration:"1e-05s, 0.4s",delay:"0s, 0.1s"},"authored transition update is restored exactly");
    assert.equal(await page.locator(".inherited-wrapper").first().getAttribute("data-lexend-transition"),null);
    const restored = await page.evaluate(() => ({
      styles:["parent","relative","wrapper","data-icon","dynamic","heading","cloned"].map((id) => __metrics(id)),
      markers:document.querySelectorAll("[data-lexend-text],[data-lexend-protected]").length,
      shadowMarkers:document.querySelector("#shadow-host").shadowRoot.querySelectorAll("[data-lexend-text],[data-lexend-protected]").length,
      unexpectedInline:document.getElementById("parent").getAttribute("style")
    }));
    assert.ok(restored.styles.every((style) => !/Lexend/.test(style.family)));
    assert.equal(restored.markers,0);
    assert.equal(restored.shadowMarkers,0);
    assert.equal(restored.unexpectedInline,null);
    assert.equal(restored.styles[1].size,27);
    await page.waitForTimeout(550);
    assert.equal((await page.evaluate(() => __metrics("transition"))).size,22.4);
    const delayedRestored=await page.locator("#delayed-instant").evaluate(element=>{const css=getComputedStyle(element);return{size:parseFloat(css.fontSize),property:css.transitionProperty,duration:css.transitionDuration,delay:css.transitionDelay};});
    assert.deepEqual(delayedRestored,{size:16,property:"all",duration:"0s",delay:"0.5s"},"pause restores zero-duration delayed author transitions");
    const tooltipRestored=await page.locator("#delayed-tooltip").evaluate(element=>{const css=getComputedStyle(element,"::after");return{size:parseFloat(css.fontSize),property:css.transitionProperty,duration:css.transitionDuration,delay:css.transitionDelay};});
    assert.deepEqual(tooltipRestored,{size:13,property:"all",duration:"0s",delay:"0.5s"},"pause restores independent generated-content transitions");
    assert.equal(await page.locator("#transition").evaluate((element) => getComputedStyle(element).transitionProperty),"all");
    assert.equal((await page.evaluate(() => __metrics("fit-clone"))).size,20);
    assert.equal(await page.locator("#priority").getAttribute("style"),"font-family: Georgia !important; font-size: 19px !important; line-height: 1.2 !important; letter-spacing: 2px !important;");
  } finally { await browser.close(); }
});

test("native scrolling panels preserve focus, bounds, and scroll after typography changes", async () => {
  const browser=await chromium.launch({headless:true});
  try {
    const page=await browser.newPage({viewport:{width:600,height:420}});
    await page.route("http://panel.test/**",async route=>route.fulfill({body:await readFile(resolve(`.${new URL(route.request().url()).pathname}`)),contentType:"font/woff2"}));
    await page.setContent(`<!doctype html><style>body{margin:0;font:16px/20px Arial;min-height:5000px}.panel{position:fixed;left:20px;top:40px;width:300px;height:300px;max-height:300px;overflow:auto;background:white}p{margin:0}button{font:inherit}</style><main>Document content</main><div class=panel role=dialog aria-label="Instructions">${Array.from({length:12},(_,i)=>`<p>Panel instruction ${i+1}</p>`).join("")}<button id=action>Continue</button></div>`);
    await page.evaluate(()=>{
      globalThis.__settings={enabled:true,scope:"all",textScale:110,lineHeight:1.6,letterSpacing:.02};globalThis.__listeners=[];
      globalThis.chrome={runtime:{getURL:p=>`http://panel.test/${p}`,sendMessage:async()=>{},onMessage:{addListener:()=>{}}},storage:{sync:{get:async()=>__settings},onChanged:{addListener:f=>__listeners.push(f)}}};
      globalThis.__update=values=>{Object.assign(__settings,values);const changes=Object.fromEntries(Object.entries(values).map(([key,newValue])=>[key,{newValue}]));__listeners.forEach(fn=>fn(changes,"sync"));};
      globalThis.__focusedBounds=()=>{const p=document.querySelector('.panel'),a=document.querySelector('#action'),r=p.getBoundingClientRect(),q=a.getBoundingClientRect();return{repair:p.dataset.lexendLayoutRepair,paneTop:r.top,paneBottom:r.bottom,actionTop:q.top,actionBottom:q.bottom,scrollTop:p.scrollTop,scrollY,focused:document.activeElement===a};};
    });
    for(const name of ["settings","adaptive-layout","content"])await page.addScriptTag({path:resolve(`src/${name}.js`)});
    await page.waitForFunction(()=>getComputedStyle(document.querySelector("#action")).fontFamily.includes("Lexend"));
    await page.evaluate(()=>{window.scrollTo(0,1500);document.querySelector('#action').focus();});
    await page.waitForTimeout(150);
    const before=await page.evaluate(()=>__focusedBounds());
    assert.equal(before.focused,true);
    assert.ok(before.scrollTop>0,"native action focus reveals the bottom of the repaired panel");
    assert.ok(before.actionBottom<=before.paneBottom+1);
    await page.evaluate(()=>__update({textScale:140}));
    const after=await page.evaluate(()=>__focusedBounds());
    assert.equal(after.focused,true);
    assert.equal(after.scrollTop,before.scrollTop,"the native scroll position stays under author control");
    assert.equal(after.paneBottom,before.paneBottom,"the panel keeps its authored size");
    assert.equal(after.scrollY,before.scrollY,"focused-panel reveal preserves document scroll");
  } finally {await browser.close();}
});

test("newly painted automatic content gets a fresh layout baseline without refresh loops",async()=>{
 const browser=await chromium.launch({headless:true});
 try{
  const page=await browser.newPage({viewport:{width:390,height:800}});
  await page.route('http://lazy.test/**',async route=>{const path=new URL(route.request().url()).pathname;await route.fulfill({body:await readFile(resolve(`.${path}`)),contentType:'font/woff2'});});
  await page.setContent('<!doctype html><style>body{font:16px/24px Arial;margin:0}#lazy,#lazy-second{content-visibility:auto;contain-intrinsic-size:auto 60px;width:min(220px,100vw)}#box,#box-second{height:48px;overflow:hidden}p{margin:0}</style><div style="height:5000px"></div><section id="lazy"><div id="box"><p id="caption">MMMM MMMM MMMM MMMM MMMM MMMM</p></div></section><div style="height:5000px"></div><section id="lazy-second"><div id="box-second"><p>MMMM MMMM MMMM MMMM MMMM MMMM</p></div></section><div style="height:3000px"></div>');
  await page.evaluate(()=>{
   globalThis.__listeners=[];globalThis.__captureCount=0;globalThis.__reveals=0;
   document.addEventListener('contentvisibilityautostatechange',e=>{if(e.target.id==='lazy'&&!e.skipped)__reveals++;},true);
   globalThis.chrome={runtime:{getURL:p=>`http://lazy.test/${p}`,sendMessage:async()=>{},onMessage:{addListener:()=>{}}},storage:{sync:{get:async()=>({layoutMode:"fit",enabled:true,scope:'all',textScale:110,lineHeight:1.6,letterSpacing:.02})},onChanged:{addListener:f=>__listeners.push(f)}}};
  });
  for(const name of ['settings','adaptive-layout'])await page.addScriptTag({path:resolve(`src/${name}.js`)});
  await page.evaluate(()=>{const create=LexendLayout.create;globalThis.LexendLayout={create:options=>{const controller=create(options);return{...controller,capture:(...args)=>{__captureCount++;return controller.capture(...args);}};}};});
  await page.addScriptTag({path:resolve('src/content.js')});
  await page.evaluate(()=>document.fonts.ready);await page.waitForTimeout(250);
  assert.equal(await page.locator('#caption').evaluate(e=>e.checkVisibility({contentVisibilityAuto:true})),false,'browser genuinely skips the distant subtree');
  assert.equal(await page.locator('#box').getAttribute('data-lexend-layout-repair'),null,'skipped placeholder geometry receives no fixed-height repair');
  const before=await page.evaluate(()=>__captureCount);
  await page.evaluate(()=>scrollTo(0,4800));
  await page.waitForFunction(before=>__reveals>0&&__captureCount>before&&document.querySelector('#caption').checkVisibility({contentVisibilityAuto:true}),before);
  assert.ok((await page.evaluate(()=>__captureCount))>before,'native reveal schedules a fresh baseline without DOM mutation');
  const geometry=await page.locator('#caption').evaluate(e=>({text:e.getBoundingClientRect().height,container:e.parentElement.clientHeight,family:getComputedStyle(e).fontFamily}));
  assert.match(geometry.family,/Lexend/);assert.equal(geometry.container,48,'newly visible content retains its authored box');
  await page.waitForTimeout(200);const quiet=await page.evaluate(()=>__captureCount);await page.waitForTimeout(300);
  assert.equal(await page.evaluate(()=>__captureCount),quiet,'paint-state events and baseline restoration do not repeatedly refresh a settled subtree');
  await page.evaluate(()=>scrollTo(0,9800));
  await page.waitForFunction(()=>document.querySelector('#box-second').firstElementChild.checkVisibility({contentVisibilityAuto:true}));
  assert.equal(await page.locator('#caption').evaluate(e=>e.checkVisibility({contentVisibilityAuto:true})),false,'revealing second distant subtree skips the first');
  const secondBaseline=await page.evaluate(()=>__captureCount);
  await page.evaluate(()=>scrollTo(0,4800));
  await page.waitForFunction(before=>__captureCount>before&&document.querySelector('#caption').checkVisibility({contentVisibilityAuto:true}),secondBaseline);
  assert.ok((await page.evaluate(()=>__captureCount))>secondBaseline,'A→B→A recaptures a subtree whose earlier repairs were restored while skipped');
  const returned=await page.locator('#caption').evaluate(e=>({text:e.getBoundingClientRect().height,container:e.parentElement.clientHeight}));
  assert.equal(returned.container,48,'returning content keeps its authored box');
  await page.waitForTimeout(200);const returnedQuiet=await page.evaluate(()=>__captureCount);await page.waitForTimeout(300);
  assert.equal(await page.evaluate(()=>__captureCount),returnedQuiet,'return reveal remains quiet without author changes');
  await page.evaluate(()=>scrollTo(0,0));
  await page.waitForFunction(()=>!document.querySelector('#caption').checkVisibility({contentVisibilityAuto:true}));
  await page.setViewportSize({width:160,height:800});await page.waitForTimeout(200);
  const skippedEpoch=await page.evaluate(()=>__captureCount);
  await page.evaluate(()=>scrollTo(0,4800));
  await page.waitForFunction(before=>__captureCount>before&&document.querySelector('#caption').checkVisibility({contentVisibilityAuto:true}),skippedEpoch);
  assert.ok((await page.evaluate(()=>__captureCount))>skippedEpoch,'resize while skipped allows another reveal baseline');
  const resized=await page.locator('#caption').evaluate(e=>({text:e.getBoundingClientRect().height,container:e.parentElement.clientHeight}));
  assert.equal(resized.container,geometry.container,'Fit mode preserves the authored height after resize');

  await page.waitForTimeout(200);const quietAgain=await page.evaluate(()=>__captureCount);await page.waitForTimeout(300);
  assert.equal(await page.evaluate(()=>__captureCount),quietAgain,'second reveal remains quiet within its new epoch');
 }finally{await browser.close();}
});


test("slotted typography overrides inner important rules and loads exact Latin subsets", async () => {
  const browser = await chromium.launch({ headless: true });
  try {
    const page = await browser.newPage({ viewport: { width: 1000, height: 800 } });
    const loadedFonts = [];
    await page.route("http://slotted.test/**", async (route) => {
      const path = new URL(route.request().url()).pathname;
      loadedFonts.push(path);
      await route.fulfill({ body: await readFile(resolve(`.${path}`)), contentType: "font/woff2" });
    });
    await page.setContent('<!doctype html><style>body{font:16px/24px Arial;margin:0}#host{--author-size:20px}#spacer{height:2000px}</style><div id="host"><h2 id="title" slot="title">Ihre perfekte Begleitung</h2><p id="body" slot="body">Română tiếng Việt café</p><code id="code" slot="code">const answer = 42;</code><p id="fallback" slot="body">百度一下 한국어 العربية Кириллица</p></div><div id="spacer"></div>');
    await page.evaluate(() => {
      const shadow = document.querySelector("#host").attachShadow({ mode: "open" });
      shadow.innerHTML = '<style>@layer component {::slotted([slot="title"]){font-family:Arial!important;font-size:var(--author-size)!important;line-height:28px!important;letter-spacing:-.5px!important}::slotted([slot="body"]){font:14px/24px Arial!important}::slotted([slot="code"]){font:13px/19px monospace!important}}</style><slot name="title"></slot><slot name="body"></slot><slot name="code"></slot>';
      globalThis.__settings = {enabled:true,scope:"all",textScale:110,lineHeight:1.6,letterSpacing:.02};
      globalThis.__listeners=[];
      globalThis.chrome={runtime:{getURL:path=>`http://slotted.test/${path}`,sendMessage:async()=>{},onMessage:{addListener:()=>{}}},storage:{sync:{get:async()=>__settings},onChanged:{addListener:listener=>__listeners.push(listener)}}};
      globalThis.__update=values=>{Object.assign(__settings,values);const changes=Object.fromEntries(Object.entries(values).map(([key,newValue])=>[key,{newValue}]));__listeners.forEach(listener=>listener(changes,"sync"));};
      globalThis.__metrics=id=>{const css=getComputedStyle(document.getElementById(id));return{family:css.fontFamily,size:parseFloat(css.fontSize),line:parseFloat(css.lineHeight),spacing:css.letterSpacing};};
    });
    const before = await page.evaluate(() => ({title:__metrics("title"),body:__metrics("body"),code:__metrics("code"),fallback:document.querySelector("#fallback").textContent}));
    for (const name of ["settings","adaptive-layout","content"]) await page.addScriptTag({path:resolve(`src/${name}.js`)});
    await page.waitForFunction(() => /Lexend/.test(__metrics("title").family));
    await page.evaluate(() => document.fonts.ready);
    const assertScaled = async (id, size, line) => {
      const metrics=await page.evaluate(id=>__metrics(id),id);
      assert.match(metrics.family,/Lexend/);
      assert.ok(Math.abs(metrics.size-size)<.02,JSON.stringify(metrics));
      assert.ok(Math.abs(metrics.line-line)<.02,JSON.stringify(metrics));
    };
    await assertScaled("title",22,35.2);
    await assertScaled("body",15.4,24.64);
    assert.deepEqual(await page.evaluate(()=>__metrics("code")),before.code,"protected slotted code retains authored metrics");
    assert.equal(await page.evaluate(()=>document.fonts.check('400 15.4px "Lexend for the Web"','Română')),true,"Romanian checks loaded when unused overlapping subsets are absent");
    assert.equal(await page.evaluate(()=>document.fonts.check('400 15.4px "Lexend for the Web"','tiếng Việt')),true,"Vietnamese glyphs still load their bundled subset");
    assert.ok(loadedFonts.some(path=>path.includes("latin-ext")) && loadedFonts.some(path=>path.includes("vietnamese")),"every required subset was requested");
    assert.equal(await page.locator("#fallback").textContent(),before.fallback,"unsupported glyphs are preserved");
    assert.match((await page.evaluate(()=>__metrics("fallback"))).family,/Lexend.*Arial/,"original family remains available for fallback scripts");
    await assertScaled("fallback",15.4,24.64);
    for(let index=0;index<10;index++){
      await page.evaluate(index=>{document.querySelector("#body").textContent=`Română tiếng Việt café ${index}`;window.scrollTo(0,index%2?800:0);},index);
      await page.waitForTimeout(150);
      await assertScaled("title",22,35.2);
      await assertScaled("body",15.4,24.64);
    }
    await page.locator("#host").evaluate(host=>host.style.setProperty("--author-size","30px"));
    await page.waitForFunction(()=>Math.abs(__metrics("title").size-33)<.02);
    await assertScaled("title",33,52.8);
    await page.evaluate(()=>__update({enabled:false}));
    const restored=await page.evaluate(()=>({title:__metrics("title"),body:__metrics("body"),code:__metrics("code"),markers:document.querySelectorAll("[data-lexend-text],[data-lexend-protected]").length}));
    assert.deepEqual(restored.title,{...before.title,size:30},"pause restores current author shadow typography");
    assert.deepEqual(restored.body,before.body);
    assert.deepEqual(restored.code,before.code);
    assert.equal(restored.markers,0);
  } finally {await browser.close();}
});

test("incoming feed text outruns coalesced animation updates and exposes pending refresh state", async () => {
  const browser=await chromium.launch({headless:true});
  try {
    const page=await browser.newPage({viewport:{width:800,height:800}});
    await page.route("http://feed.test/**",async route=>{const path=new URL(route.request().url()).pathname;await route.fulfill({body:await readFile(resolve(`.${path}`)),contentType:"font/woff2"});});
    await page.setContent('<!doctype html><style>body{font:16px/24px Arial;margin:0}button{font:inherit}#motion{height:10px;width:10px}#feed{font:14px/20px Arial}#spacer{height:6000px}</style><button id="action"><span>Ordinary action</span></button><div id="motion"></div><div id="feed"><p>Initial feed</p></div><div id="spacer"></div>');
    await page.evaluate(()=>{
      globalThis.__runtime=[];
      globalThis.chrome={runtime:{getURL:path=>`http://feed.test/${path}`,sendMessage:async()=>{},onMessage:{addListener:listener=>__runtime.push(listener)}},storage:{sync:{get:async()=>({enabled:true,scope:"all",textScale:110,lineHeight:1.6,letterSpacing:.02})},onChanged:{addListener:()=>{}}}};
      globalThis.__state=()=>{let state;__runtime.forEach(listener=>listener({type:"LEXEND_GET_STATE"},null,value=>state=value));return state;};
    });
    for(const name of ["settings","adaptive-layout","content"])await page.addScriptTag({path:resolve(`src/${name}.js`)});
    await page.waitForFunction(()=>document.querySelector("#feed p").hasAttribute("data-lexend-text")&&__state().pending===false);
    await page.evaluate(()=>document.fonts.ready);
    await page.waitForFunction(()=>__state().pending===false);
    const revision=await page.evaluate(()=>__state().refreshRevision);
    await page.evaluate(()=>document.querySelector("#motion").style.transform="translateX(1px)");
    await page.waitForFunction(()=>__state().pending===true,{},{timeout:70});
    await page.evaluate(()=>{
      const node=document.createElement("p");node.id="incoming";node.textContent="Newly inserted headline";document.querySelector("#feed").replaceChildren(node);
    });
    await page.waitForFunction(()=>document.querySelector("#incoming").hasAttribute("data-lexend-text")&&__state().refreshRevision>0,{},{timeout:70});
    assert.ok((await page.evaluate(()=>__state().refreshRevision))>revision,"text insertion upgrades a pending style batch instead of waiting100ms");
    await page.evaluate(()=>{let tick=0;globalThis.__animation=setInterval(()=>document.querySelector("#motion").style.transform=`translateX(${tick++%4}px)`,20);});
    for(let index=0;index<12;index++){
      await page.evaluate(index=>{
        const p=document.createElement("p");p.id="incoming";p.textContent=`Fresh feed caption ${index}`;
        const select=document.createElement("select");select.id="incoming-select";select.innerHTML='<option>Libra</option>';
        document.querySelector("#feed").replaceChildren(p,select);
        window.scrollTo(0,index%2?3000:0);
      },index);
      await page.waitForFunction(()=>[...document.querySelectorAll("#incoming,#incoming-select")].every(node=>node.hasAttribute("data-lexend-text")),{},{timeout:70});
      const sizes=await page.evaluate(()=>[...document.querySelectorAll("#incoming,#incoming-select")].map(node=>({font:getComputedStyle(node).fontFamily,size:parseFloat(getComputedStyle(node).fontSize)})));
      assert.ok(sizes.every(style=>style.font.includes("Lexend")),"new text and replacement form control convert during continuing animation mutations");
      assert.ok(Math.abs(sizes[0].size-15.4)<.02,"feed inherits authored14px and scales exactly once");
      assert.ok(Math.abs((await page.locator("#action span").evaluate(node=>parseFloat(getComputedStyle(node).fontSize)))-17.6)<.02,"nested action inheritance stays once-scaled");
      await page.waitForTimeout(30);
    }
    await page.evaluate(()=>clearInterval(__animation));
    await page.waitForFunction(()=>__state().pending===false);
    const quiet=await page.evaluate(()=>__state().refreshRevision);
    await page.waitForTimeout(250);
    assert.equal(await page.evaluate(()=>__state().refreshRevision),quiet,"own conversion writes do not schedule another text-mutation loop");
    assert.equal(await page.evaluate(()=>__state().healthy),true);
  } finally {await browser.close();}
});
