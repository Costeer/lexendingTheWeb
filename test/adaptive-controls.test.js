import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import { chromium } from "playwright";

const sources = await Promise.all(["adaptive-controls", "adaptive-layout"].map((name) => readFile(new URL(`../src/${name}.js`, import.meta.url), "utf8")));
let browser;
test.before(async () => { browser = await chromium.launch({ headless: true }); });
test.after(async () => { await browser?.close(); });
const prepare = async (html, css = "body :is(p,a,button,select) {font-size:24px!important;line-height:1.6!important;letter-spacing:.02em!important}", width = 390, buttonFirst = false) => {
  const page = await browser.newPage({ viewport: { width, height: 700 } });
  await page.setContent(html);
  await page.evaluate(() => document.fonts.ready);
  for (const content of sources) await page.addScriptTag({ content });
  await page.evaluate(({css, buttonFirst}) => {
    window.originalStyles = [...document.querySelectorAll("[id]")].map((element) => [element.id, element.hasAttribute("style") ? element.style.cssText : null]);
    const type = document.createElement("style");
    type.id = "typography"; type.media = "not all"; type.textContent = css; document.head.append(type);
    const getTextElements = buttonFirst ? (root) => [...root.querySelectorAll("button,[role=button],button > span")] : undefined;
    window.layout = LexendLayout.create({ getTextElements, withStylesDisabled(callback) {
      const media = type.media; type.media = "not all";
      try { return callback(); } finally { type.media = media; }
    }});
    layout.capture(); type.media = "all"; layout.repair();
  }, {css, buttonFirst});
  return page;
};
const restored = async (page) => {
  const result = await page.evaluate(() => {
    document.querySelector("#typography").media = "not all";
    layout.restore();
    return originalStyles.map(([id, before]) => ({ id, before, after: document.getElementById(id).getAttribute("style"), repair: document.getElementById(id).getAttribute("data-lexend-layout-repair") }));
  });
  assert.ok(result.every((element) => element.before === element.after && element.repair === null), JSON.stringify(result));
};

test("a shrinking header action preserves its whole word and original background icon footprint", async () => {
  const page = await prepare(`<style>body{margin:0;font:16px Arial}header{display:flex;justify-content:space-between;align-items:center;padding:16px}.logo{width:50px}.actions{display:flex;align-items:center;gap:30px}.locale{padding:10px 20px;white-space:nowrap}.menu{width:44px;min-width:44px;padding:32px 0 0;border:0;font:16px Arial;text-transform:uppercase;background:linear-gradient(blue,blue) top left/44px 24px no-repeat}</style>
    <header id="header"><div class="logo">Logo</div><div id="actions" class="actions"><a id="locale" class="locale" href="/language">Español</a><button id="menu" class="menu">Menu</button></div></header><button id="ordinary">A plain action</button>`, "#locale,#menu{font-size:24px!important;line-height:1.6!important;letter-spacing:.02em!important}");
  const result = await page.evaluate(() => {
    const menu = document.querySelector("#menu"), range = document.createRange(); range.selectNodeContents(menu.firstChild);
    const boxes = [...range.getClientRects()];
    return { lines: new Set(boxes.map((box) => Math.round(box.top / 2))).size, width: menu.getBoundingClientRect().width, right: menu.getBoundingClientRect().right,
      textRight: Math.max(...boxes.map((box) => box.right)), font: getComputedStyle(menu).fontSize, background: getComputedStyle(menu).backgroundImage, repair: menu.getAttribute("data-lexend-layout-repair"), ordinary: document.querySelector("#ordinary").getAttribute("data-lexend-layout-repair") };
  });
  assert.equal(result.lines, 1); assert.ok(result.width >= 44 && result.right <= 390 && result.textRight <= result.right + 2);
  assert.equal(result.font, "24px"); assert.ok(result.background.includes("linear-gradient"));
  assert.ok(result.repair?.includes("action-word")); assert.ok(!result.ordinary?.includes("action-word"));
  await restored(page); await page.close();
});

test("native select and its dropdown hit area remain within the original column", async () => {
  const page = await prepare(`<style>body{margin:16px;font:16px sans-serif}.field{margin-left:160px;width:190px}select{font:16px sans-serif}</style>
    <div id="field" class="field"><select id="language"><option>Portuguese - Português</option></select></div>`, "select{font-size:32px!important;letter-spacing:.02em!important}");
  const box = await page.evaluate(() => ({ field: document.querySelector("#field").getBoundingClientRect().toJSON(), select: document.querySelector("select").getBoundingClientRect().toJSON() }));
  assert.ok(box.select.right <= box.field.right + 2 && box.select.right <= 390);
  assert.ok(box.select.width >= 48);
  await restored(page); await page.close();
});

test("touching split controls retain equal height while ordinary independent buttons stay independent", async () => {
  const page = await prepare(`<style>body{font:16px sans-serif;margin:16px}.group button{border:0;padding:10px;line-height:20px;font-size:16px;vertical-align:top}.separate button{margin-right:20px}</style>
    <div id="group" class="group"><button id="main"><span>Download</span></button><button id="arrow">▾</button></div>
    <div class="separate group"><button id="other">Read details</button><button id="small">+</button></div>`, "#main span,#other{font-size:26px!important;line-height:1.6!important;letter-spacing:.02em!important}");
  const result = await page.evaluate(() => Object.fromEntries(["main", "arrow", "other", "small"].map((id) => [id, document.getElementById(id).getBoundingClientRect().height])));
  assert.ok(Math.abs(result.main - result.arrow) < 2);
  assert.ok(result.other > result.small + 10);
  await restored(page); await page.close();
});

test("large local gutters yield space to enlarged prose but code and short labels keep their gutters", async () => {
  const page = await prepare(`<style>body{font:16px/1.2 sans-serif;margin:16px}.panel{width:340px;box-sizing:border-box;padding:12px 80px;background:#ddd}p{margin:0}pre{font:16px monospace}</style>
    <section id="panel" class="panel" style="border: 1px solid red"><p id="prose">We defend your privacy and free expression because technology should serve all people, not just the powerful. Our nonprofit is powered by members, and we need you in this fight.</p></section>
    <section id="short" class="panel"><p>Only a label</p></section><section id="code" class="panel"><pre>const preserve = true;</pre></section>`);
  const values = await page.evaluate(() => ({ width: document.querySelector("#prose").getBoundingClientRect().width, panel: getComputedStyle(document.querySelector("#panel")).paddingLeft, short: getComputedStyle(document.querySelector("#short")).paddingLeft, code: getComputedStyle(document.querySelector("#code")).paddingLeft }));
  assert.ok(values.width >= 260);
  assert.ok(parseFloat(values.panel) <= 24);
  assert.equal(values.short, "80px"); assert.equal(values.code, "80px");
  await restored(page); await page.close();
});

test("a newly overflowing pill shows its complete action label with reversible wrapping", async () => {
  const page = await prepare(`<style>body{font:16px sans-serif;margin:16px}a{display:inline-block;box-sizing:border-box;width:150px;height:30px;white-space:nowrap;overflow:hidden;border:1px solid;padding:4px}</style><a id="pill" href="/updates">View all updates</a>`);
  const result = await page.evaluate(() => {
    const element = document.querySelector("a"), box = element.getBoundingClientRect(), range = document.createRange(); range.selectNodeContents(element.firstChild);
    return { height: box.height, texts: [...range.getClientRects()].map((r) => ({ right: r.right, bottom: r.bottom })), right: box.right, bottom: box.bottom };
  });
  assert.ok(result.height > 30);
  assert.ok(result.texts.every((r) => r.right <= result.right + 2 && r.bottom <= result.bottom + 2));
  await restored(page); await page.close();
});

test("newly staggered complete float rows become aligned while media backgrounds remain intact", async () => {
  const page = await prepare(`<style>body{font:16px/1.2 sans-serif;margin:16px}.tiles{display:flow-root;width:600px}.tile{float:left;width:50%;min-height:130px;box-sizing:border-box;padding:16px;background-image:linear-gradient(white,gray)}p{margin:0}</style>
    <div id="tiles" class="tiles"><section id="one" class="tile"><p>This long description needs several lines when typography grows. It describes a creative tool and explains how to produce detailed projects with accessible guidance for everyone.</p></section><section id="two" class="tile"><p>Original artwork creation.</p></section><section id="three" class="tile"><p>Graphic design elements.</p></section><section id="four" class="tile"><p>Programming algorithms.</p></section></div>`, undefined, 800);
  const result = await page.evaluate(() => ({ display: getComputedStyle(document.querySelector("#tiles")).display, boxes: [...document.querySelectorAll(".tile")].map((e) => e.getBoundingClientRect().toJSON()), backgrounds: [...document.querySelectorAll(".tile")].map((e) => getComputedStyle(e).backgroundImage) }));
  assert.ok(Math.abs(result.boxes[2].top - result.boxes[3].top) < 2);
  assert.ok(result.boxes[2].top >= Math.max(result.boxes[0].bottom, result.boxes[1].bottom) - 2);
  assert.ok(result.backgrounds.every((image) => image.includes("linear-gradient")));
  await restored(page); await page.close();
});

test("float row starts repair mixed body siblings without changing the header, footer or parent layout", async () => {
  const page = await prepare(`<style>body{font:16px/1.2 sans-serif;margin:0}header,footer{clear:both;padding:10px}.tile{float:left;width:50%;min-height:130px;box-sizing:border-box;padding:16px;background:linear-gradient(white,gray)}p{margin:0}</style>
    <header id="header">Navigation stays full width</header><section id="one" class="tile"><p>This longer description wraps onto more lines as text grows and explains how this creative tool helps everyone produce detailed accessible projects with clear guidance for new users.</p></section><section id="two" class="tile"><p>Original artwork.</p></section><section id="three" class="tile"><p>Graphic design.</p></section><section id="four" class="tile"><p>Programming.</p></section><footer id="footer">Footer remains full width</footer>`, undefined, 800);
  const result = await page.evaluate(() => ({ display: getComputedStyle(document.body).display, boxes: [...document.querySelectorAll(".tile")].map((e) => e.getBoundingClientRect().toJSON()), headerStyle: document.querySelector("header").getAttribute("style"), footerStyle: document.querySelector("footer").getAttribute("style") }));
  assert.equal(result.display, "block");
  assert.ok(Math.abs(result.boxes[2].top - result.boxes[3].top) < 2);
  assert.ok(result.boxes[2].left < result.boxes[3].left);
  assert.ok(result.boxes[2].top >= Math.max(result.boxes[0].bottom, result.boxes[1].bottom) - 2);
  assert.equal(result.headerStyle, null); assert.equal(result.footerStyle, null);
  await restored(page); await page.close();
});

test("a larger fixed bottom utility reserves a stable reachable footer footprint and restores it", async () => {
  const page = await prepare(`<style>body{font:16px sans-serif;margin:0;padding-bottom:4px}main{height:1200px}footer{padding:12px}a{display:inline-block;padding:8px;line-height:20px;font-size:16px}.utility{position:fixed;right:12px;bottom:12px;background:#ddd}.header{position:fixed;top:0;left:0;width:100%;background:#ddd}</style>
    <body id="body"><main>Article content</main><footer><p id="last">Last footer line remains reachable</p></footer><a id="utility" class="utility" href="#">Back to top</a><a id="header" class="header" href="#">Header navigation</a></body>`);
  const result = await page.evaluate(() => {
    const first = parseFloat(getComputedStyle(document.body).paddingBottom);
    layout.repair();
    const second = parseFloat(getComputedStyle(document.body).paddingBottom);
    scrollTo(0, document.documentElement.scrollHeight);
    return { first, second, footerBottom: document.querySelector("#last").getBoundingClientRect().bottom, utilityTop: document.querySelector("#utility").getBoundingClientRect().top,
      headerRepair: document.querySelector("#header").getAttribute("data-lexend-layout-repair") };
  });
  assert.ok(result.first > 40);
  assert.equal(result.first, result.second);
  assert.ok(result.footerBottom < result.utilityTop + 2);
  assert.ok(!result.headerRepair?.includes("floating-control-space"));
  await restored(page); await page.close();
});

test("prose with padding on its own text box receives the same measured gutter relief", async () => {
  const page = await prepare(`<style>body{font:16px sans-serif;margin:16px}p{width:340px;box-sizing:border-box;padding:0 90px}</style><p id="prose">Our nonprofit defends privacy and free expression because technology should serve all people. Members support our work and we need you in this fight.</p>`);
  const width = await page.evaluate(() => { const p = document.querySelector("p"), css = getComputedStyle(p); return p.clientWidth - parseFloat(css.paddingLeft) - parseFloat(css.paddingRight); });
  assert.ok(width >= 260);
  await restored(page); await page.close();
});

test("a sprite arrow stays adjacent to a growing language action label", async () => {
  const page = await prepare(`<style>body{font:16px sans-serif;margin:16px}button{width:340px;padding:10px;font:16px sans-serif}i{display:inline-block;width:16px;height:16px;background:linear-gradient(red,red);vertical-align:middle}span{display:inline-block}</style><button id="language"><i id="icon"></i><span id="label">Read this resource in your language</span><i id="arrow"></i></button>`, "#label{font-size:24px!important;line-height:1.6!important;letter-spacing:.02em!important}");
  const result = await page.evaluate(() => {
    const button = document.querySelector("button").getBoundingClientRect();
    return [...document.querySelectorAll("i")].map((glyph) => { const box = glyph.getBoundingClientRect(); return { center: (box.top + box.bottom) / 2, buttonCenter: (button.top + button.bottom) / 2, right: box.right, limit: button.right }; });
  });
  assert.ok(result.every((glyph) => Math.abs(glyph.center - glyph.buttonCenter) < 3 && glyph.right <= glyph.limit));
  await restored(page); await page.close();
});

test("explicit radio labels stay alongside their inputs after a new row break", async () => {
  const page = await prepare(`<style>body{font:16px sans-serif;margin:16px}.options{width:240px}label{font:16px sans-serif}</style><div id="options" class="options"><input id="system" type="radio" name="theme"><label id="system-label" for="system">System</label> <input id="light" type="radio" name="theme"><label id="light-label" for="light">Light</label> <input id="dark" type="radio" name="theme"><label id="dark-label" for="dark">Dark</label></div>`, "label{font-size:24px!important;line-height:1.6!important;letter-spacing:.02em!important}");
  const differences = await page.evaluate(() => [...document.querySelectorAll("input")].map((input) => {
    const box = input.getBoundingClientRect(), label = document.querySelector(`label[for=${input.id}]`).getBoundingClientRect();
    return Math.abs((box.top + box.bottom - label.top - label.bottom) / 2);
  }));
  assert.ok(differences.every((distance) => distance < 3));
  await restored(page); await page.close();
});

test("a newly clipped native placeholder expands inside its local inline form", async () => {
  const page = await prepare(`<style>body{font:16px sans-serif;margin:10px}form{width:140px}input{width:101px;box-sizing:border-box;font:10px Arial;padding:2px;border:1px solid}button{font:12px Arial;padding:2px}</style><form id="form"><input id="location" placeholder="Enter location ..."><button id="go">Go</button></form>`, "input{font-size:14px!important;letter-spacing:.02em!important}");
  const result = await page.evaluate(() => ({ input: document.querySelector("input").getBoundingClientRect().toJSON(), parent: document.querySelector("form").getBoundingClientRect().toJSON(), button: document.querySelector("button").getBoundingClientRect().toJSON() }));
  assert.ok(result.input.width > 101);
  assert.ok(result.input.right <= result.parent.right + 2);
  assert.ok(result.button.right <= result.parent.right + 2);
  await restored(page); await page.close();
});

test("new navigation text overlap gets a reachable scroller while its sibling icon action stays in place", async () => {
  const page = await prepare(`<style>body{margin:0;font:16px Arial}nav{display:grid;width:390px}ul{grid-area:1/1;display:flex;list-style:none;margin:0;padding:0 8px;height:40px;align-items:center}li{flex-shrink:0}a{display:block;padding:4px}label{grid-area:1/1;justify-self:end;align-self:center;position:relative;z-index:1;width:40px;height:40px;background:yellow;border-radius:50%}svg{width:40px;height:40px}</style><nav id="nav"><ul id="row"><li><a href="/news">News</a></li><li><a href="/opinion">Opinion</a></li><li><a href="/sport">Sport</a></li><li><a href="/culture">Culture</a></li><li><a id="last" href="/lifestyle">Lifestyle</a></li></ul><label id="menu" role="button" tabindex="0" aria-label="Menu"><svg><path d="M10 10h20M10 20h20M10 30h20" stroke="black"/></svg></label></nav>`, "a{font-size:20px!important;letter-spacing:.02em!important}");
  const result = await page.evaluate(() => {
    const row = document.querySelector("#row"), menu = document.querySelector("#menu").getBoundingClientRect();
    row.scrollTo({left:10000,behavior:"instant"});
    const range = document.createRange(); range.selectNodeContents(document.querySelector("#last").firstChild);
    return { scroll: row.scrollLeft, textRight: range.getBoundingClientRect().right, menuLeft: menu.left, menuRight: menu.right, tab: row.tabIndex };
  });
  assert.ok(result.scroll > 0, JSON.stringify(result));
  assert.ok(result.textRight < result.menuLeft);
  assert.equal(result.menuRight, 390);
  assert.equal(result.tab, 0);
  await restored(page);
  assert.equal(await page.evaluate(() => document.querySelector("#row").hasAttribute("tabindex")), false);
  await page.close();
});

test("unchanged author default prompts grow while edited native values are not measured as prompts", async () => {
  const page = await prepare(`<style>body{margin:10px;font:16px sans-serif}form{width:160px}input{width:101px;box-sizing:border-box;font:10px Arial;padding:2px;border:1px solid}</style><form id="form"><input id="legacy" value="Enter location ..."><input id="edited" value="Short"></form><script>document.querySelector('#edited').value='An edited input value';</script>`, "input{font-size:14px!important;letter-spacing:.02em!important}");
  const result = await page.evaluate(() => ({ width: document.querySelector("#legacy").getBoundingClientRect().width, edited: document.querySelector("#edited").getAttribute("data-lexend-layout-repair") }));
  assert.ok(result.width > 101);
  assert.ok(!result.edited?.includes("native-field"));
  await restored(page); await page.close();
});

test("new label clipping inside a bounded navigation track becomes reachable without changing its transform", async () => {
  const page = await prepare(`<style>body{font:16px sans-serif;margin:16px}.viewport{width:180px;height:48px;overflow:hidden}ul{display:flex;width:max-content;margin:0;padding:0;transform:translateX(-10px);list-style:none}button{font:16px sans-serif;padding:6px}</style><nav id="nav"><div id="viewport" class="viewport"><ul id="track"><li><button>Learn</button></li><li><button>Chess</button></li><li><button id="math">Math</button></li></ul></div></nav>`);
  const result = await page.evaluate(() => {
    const pane = document.querySelector("#viewport"); pane.scrollTo({left:10000,behavior:"instant"});
    const range = document.createRange(); range.selectNodeContents(document.querySelector("#math").firstChild);
    return { left:pane.scrollLeft,textRight:range.getBoundingClientRect().right,right:pane.getBoundingClientRect().right, transform:getComputedStyle(document.querySelector("#track")).transform,tab:pane.tabIndex };
  });
  assert.ok(result.left > 0);
  assert.ok(result.textRight <= result.right + 2);
  assert.equal(result.transform, "matrix(1, 0, 0, 1, -10, 0)");
  assert.equal(result.tab, 0);
  await restored(page); await page.close();
});

test("focused navigation tabs become visible while authored selection and focus survive", async () => {
  const page = await prepare(`<style>body{margin:16px;font:16px Arial}.tabs{display:flex;width:220px;overflow:auto;white-space:nowrap}button{flex-shrink:0;font:16px Arial;padding:8px}</style><div id="tabs" class="tabs" role="tablist"><button id="first" role="tab">Read a file</button><button id="second" role="tab">Write tests</button><button id="last" role="tab">Work with threads</button></div><div id="ordinary" style="width: 100px; overflow: auto; white-space: nowrap;"><button id="unrelated">Unrelated long action</button></div>`);
  const result = await page.evaluate(() => {
    const tabs = document.querySelector("#tabs"), last = document.querySelector("#last"), unrelated = document.querySelector("#unrelated");
    last.focus({preventScroll:true}); last.setAttribute("aria-selected", "true"); tabs.scrollLeft = 0;
    LexendControls.revealFocused(last);
    const box = last.getBoundingClientRect(), pane = tabs.getBoundingClientRect();
    unrelated.focus({preventScroll:true}); const ordinary = document.querySelector("#ordinary"); ordinary.scrollLeft = 0; LexendControls.revealFocused(unrelated);
    return { left:tabs.scrollLeft,right:box.right,paneRight:pane.right,selected:last.getAttribute("aria-selected"),ordinaryLeft:ordinary.scrollLeft,active:document.activeElement.id };
  });
  assert.ok(result.left > 0);
  assert.ok(result.right <= result.paneRight + 2);
  assert.equal(result.selected, "true");
  assert.equal(result.active, "unrelated");
  assert.equal(result.ordinaryLeft, 0);
  await restored(page); await page.close();
});

test("large two-sided prose margins receive measured gutter relief while code margins survive", async () => {
  const page = await prepare(`<style>body{margin:10px;font:16px sans-serif}section{width:360px}p,pre{margin:0 80px;padding:12px 0}pre{font:16px monospace}</style><section id="column"><p id="prose">Our nonprofit defends privacy and free expression because technology should serve all people. Members support our work and we need you in this fight.</p><pre id="code">preserve(code);</pre></section>`);
  const result = await page.evaluate(() => ({ width:document.querySelector("#prose").getBoundingClientRect().width, codeMargin:getComputedStyle(document.querySelector("#code")).marginLeft }));
  assert.ok(result.width >= 260);
  assert.equal(result.codeMargin, "80px");
  await restored(page); await page.close();
});

test("sprite controls retain association when the typography collector lists the button before its label", async () => {
  const page = await prepare(`<style>body{font:14px Arial;margin:16px}button{width:340px;padding:10px;font:14px Arial}i{display:inline-block;width:16px;height:16px;background:linear-gradient(red,red);vertical-align:middle}span{display:inline-block}</style><button id="language"><i id="icon"></i><span id="label">Read this resource in your language</span><i id="arrow"></i></button>`, "#label{font-size:24px!important;line-height:1.6!important;letter-spacing:.02em!important}", 390, true);
  const result = await page.evaluate(() => { const button = document.querySelector("button").getBoundingClientRect(), arrow = document.querySelector("#arrow").getBoundingClientRect(); return {middle:(button.top+button.bottom)/2,arrowMiddle:(arrow.top+arrow.bottom)/2,repair:document.querySelector("button").getAttribute("data-lexend-layout-repair")}; });
  assert.ok(Math.abs(result.middle-result.arrowMiddle)<3);
  assert.ok(result.repair?.includes("icon-label"));
  await restored(page); await page.close();
});

test("a single-word brand stays whole beside its icon after flex repair", async () => {
  const page = await prepare(`<style>body{font:14px Arial}header{display:flex;width:360px}a{display:inline-block;width:150px;padding:4px;box-sizing:border-box}i{display:inline-block;width:20px;height:20px;background:linear-gradient(blue,blue);vertical-align:middle}span{display:inline-block;overflow-wrap:anywhere}</style>
    <header><a id="brand" href="#"><i id="icon"></i><span id="label">TypeScript</span></a><nav id="next"><a href="#">Download</a></nav></header>`,
  "#label{font-size:26.4px!important;line-height:1.6!important;letter-spacing:.02em!important}");
  const state=await page.evaluate(()=>{const label=document.querySelector("#label"),node=label.firstChild,range=document.createRange();range.selectNodeContents(node);return{fragments:[...range.getClientRects()].map(x=>x.toJSON()),repair:document.querySelector("#brand").getAttribute("data-lexend-layout-repair"),whiteSpace:getComputedStyle(label).whiteSpace,gap:document.querySelector("#next").getBoundingClientRect().left-label.getBoundingClientRect().right}});
  assert.equal(state.fragments.length,1);
  assert.match(state.repair,/icon-label/);
  assert.equal(state.whiteSpace,"nowrap",JSON.stringify(state));
  assert.ok(state.gap>=7,JSON.stringify(state));
  await restored(page);await page.close();
});

test("media rail captions gain width only when a previously whole word breaks after conversion", async () => {
  const page = await prepare(`<style>body{margin:16px;font:14px Arial}.rail{display:flex;width:340px;overflow-x:auto;gap:22px}a{flex:0 0 106px;min-width:0;padding:10px;box-sizing:border-box}img{width:100%;height:80px;object-fit:cover}span{display:block;font:14px Arial;overflow-wrap:anywhere}</style><div id="rail" class="rail"><a id="card" href="#"><img id="photo" src="data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' width='100' height='80'%3E%3Crect width='100' height='80' fill='blue'/%3E%3C/svg%3E"><span id="caption">Many heroes by Ray Humphreys</span></a><a id="other" href="#"><span id="plain">Many heroes by Ray Humphreys</span></a></div>`, "span{font-size:18px!important;line-height:1.6!important;letter-spacing:.02em!important}");
  const result = await page.evaluate(() => {
    const text = document.querySelector("#caption").firstChild, index = text.textContent.indexOf("Humphreys"), range = document.createRange(); range.setStart(text,index);range.setEnd(text,index+9);
    return {lines:new Set([...range.getClientRects()].map(box=>Math.round(box.top/2))).size,card:document.querySelector("#card").getBoundingClientRect().width,ordinary:document.querySelector("#other").getAttribute("data-lexend-layout-repair"),photo:document.querySelector("#photo").getBoundingClientRect().height};
  });
  assert.equal(result.lines,1);
  assert.ok(result.card>106);
  assert.ok(!result.ordinary?.includes("media-caption"));
  assert.equal(result.photo,80);
  await restored(page); await page.close();
});

test("a plain floating utility keeps its whole word and right anchor without replacing its native action", async () => {
  const page = await prepare(`<style>body{margin:0;font:14px Arial}.utility{position:fixed;right:12px;bottom:24px;width:66px;padding:8px;box-sizing:border-box;background:#ddd;cursor:pointer}.label{width:50px;overflow-wrap:anywhere;font:11px Arial}</style><div id="utility" class="utility" tabindex="0"><div id="label" class="label">Feedback</div></div><pre id="code">Feedback</pre><script>window.clicks=0;document.querySelector('#utility').onclick=()=>clicks++;</script>`, "#label{font-size:20px!important;line-height:1.6!important;letter-spacing:.02em!important}");
  const result = await page.evaluate(() => {
    const utility = document.querySelector("#utility"), label = document.querySelector("#label"), range = document.createRange(); range.selectNodeContents(label.firstChild);
    utility.focus(); utility.click();
    return { lines:new Set([...range.getClientRects()].map(box=>Math.round(box.top/2))).size,box:utility.getBoundingClientRect().toJSON(),textRight:range.getBoundingClientRect().right,position:getComputedStyle(utility).position,right:getComputedStyle(utility).right,focus:document.activeElement.id,clicks,code:document.querySelector("#code").getAttribute("style") };
  });
  assert.equal(result.lines,1,JSON.stringify(result));
  assert.ok(result.textRight <= result.box.right + 2 && result.box.right <= 390);
  assert.equal(result.position,"fixed"); assert.equal(result.right,"12px");
  assert.equal(result.focus,"utility"); assert.equal(result.clicks,1); assert.equal(result.code,null);
  await restored(page); await page.close();
});

test("a newly overflowing final header action wraps its local row while preserving focus and native click", async () => {
  const page = await prepare(`<style>body{margin:0;font:14px Arial}nav{display:flex;width:390px;background:#ddd}.logo{width:180px;flex-shrink:0}.actions{display:flex;gap:8px;min-width:0}button{font:14px Arial;white-space:nowrap;padding:6px;flex-shrink:0}</style><nav id="nav"><span id="logo" class="logo">Artwork</span><div id="actions" class="actions"><button id="login">Log In</button><button id="signup">Sign Up</button></div></nav><script>window.clicks=0;document.querySelector('#signup').onclick=()=>clicks++;</script>`, "button{font-size:30px!important;line-height:1.6!important;letter-spacing:.02em!important}");
  const result = await page.evaluate(() => {
    const signup=document.querySelector("#signup"), login=document.querySelector("#login"); signup.focus();signup.click();
    return {signup:signup.getBoundingClientRect().toJSON(),login:login.getBoundingClientRect().toJSON(),focus:document.activeElement.id,clicks,logoWidth:document.querySelector("#logo").getBoundingClientRect().width};
  });
  assert.ok(result.signup.right <= 390 + 2,JSON.stringify(result));
  assert.ok(result.signup.top >= result.login.bottom - 2,JSON.stringify(result));
  assert.equal(result.logoWidth,180); assert.equal(result.focus,"signup");assert.equal(result.clicks,1);
  await restored(page); await page.close();
});

test("an enlarged footer action wraps its authored nowrap descendant inside the viewport", async () => {
  const page = await prepare(`<style>body{font:14px Arial;margin:0}.footer{display:flex;width:400px;box-sizing:border-box;padding:0 20px;justify-content:center}.row{display:flex;width:100%;justify-content:center}a{display:block;white-space:nowrap;padding:15px}img{width:12.25px;height:14px;margin-right:6px;background:green}span{white-space:nowrap;font:14px Arial;vertical-align:top}</style><div id="footer" class="footer"><div class="row"><a id="climate" href="#"><img id="leaf" alt="" src="data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' width='16' height='16'%3E%3Crect width='16' height='16' fill='green'/%3E%3C/svg%3E"><span id="label">Drei Jahrzehnte Klimaschutz: Jede Entscheidung zählt</span></a></div></div>`, "#label{font-size:18px!important;line-height:1.6!important;letter-spacing:.02em!important}");
  const result = await page.evaluate(() => { const range=document.createRange();range.selectNodeContents(document.querySelector("#label").firstChild);return{rects:[...range.getClientRects()].map(box=>box.toJSON()),overflow:document.documentElement.scrollWidth,icon:document.querySelector("#leaf").getBoundingClientRect().width}; });
  assert.ok(result.rects.every(box=>box.left>=-2&&box.right<=392),JSON.stringify(result));
  assert.ok(result.rects.length>1); assert.ok(result.overflow<=400);assert.equal(result.icon,12.25);
  await restored(page);
  const baseline = await page.evaluate(() => {const action=document.querySelector("#climate").getBoundingClientRect(),label=document.querySelector("#label").getBoundingClientRect();return {actionRight:action.right,labelRight:label.right};});
  assert.ok(baseline.actionRight>392 && baseline.labelRight<=390,JSON.stringify(baseline));
  await page.close();
});

test("compact embedded branding can gain measured word width without widening its iframe or changing artwork", async () => {
  const page = await browser.newPage({viewport:{width:390,height:700}});
  await page.setContent(`<iframe id="widget" style="width:304px;height:78px;border:0"></iframe>`);
  const frame=page.frames()[1];
  await frame.setContent(`<style>body{margin:0;font:10px Arial}.brand{position:absolute;left:233px;top:48px;width:58px;font-size:10px;overflow-wrap:anywhere}.art{position:absolute;left:248px;top:8px;width:32px;height:32px;background:blue}</style><div id="art" class="art"></div><div id="brand" class="brand">reCAPTCHA</div>`);
  for (const content of sources) await frame.addScriptTag({content});
  await frame.evaluate(()=>{window.originalStyles=[...document.querySelectorAll("[id]")].map(e=>[e.id,e.getAttribute("style")]);const type=document.createElement("style");type.id="typography";type.media="not all";type.textContent="#brand{font-size:11px!important;line-height:1.6!important;letter-spacing:.02em!important}";document.head.append(type);window.layout=LexendLayout.create({withStylesDisabled(callback){const media=type.media;type.media="not all";try{return callback();}finally{type.media=media;}}});layout.capture();type.media="all";layout.repair();});
  const result=await frame.evaluate(()=>{const range=document.createRange();range.selectNodeContents(document.querySelector("#brand").firstChild);return{rects:[...range.getClientRects()].map(box=>box.toJSON()),art:document.querySelector("#art").getBoundingClientRect().toJSON()};});
  assert.equal(result.rects.length,1,JSON.stringify(result));assert.ok(result.rects[0].right<=304);assert.equal(result.art.width,32);assert.equal(result.art.left,248);
  assert.equal(await page.locator("#widget").evaluate(element=>element.getBoundingClientRect().width),304);
  await restored(frame);await page.close();
});

test("focused actions in repaired dialog viewports scroll into reach without changing unrelated native scrollers", async () => {
  const page=await prepare(`<style>body{margin:0;font:14px Arial}.pane{height:100px;width:300px;overflow-y:auto}.space{height:240px}button,input{font:14px Arial}</style><div id="pane" class="pane" data-lexend-layout-repair="reachable-scroll"><div class="space"></div><input id="field" placeholder="Search"><button id="last">Reject cookies</button></div><div id="ordinary" class="pane"><div class="space"></div><button id="other">Another action</button></div>`, "");
  const result=await page.evaluate(()=>{const pane=document.querySelector("#pane"),field=document.querySelector("#field"),last=document.querySelector("#last"),ordinary=document.querySelector("#ordinary"),other=document.querySelector("#other");field.focus({preventScroll:true});LexendControls.revealFocused(field);last.focus({preventScroll:true});LexendControls.revealFocused(last);const box=last.getBoundingClientRect(),viewport=pane.getBoundingClientRect();other.focus({preventScroll:true});LexendControls.revealFocused(other);return{scroll:pane.scrollTop,bottom:box.bottom,viewportBottom:viewport.bottom,ordinary:ordinary.scrollTop,focus:document.activeElement.id};});
  assert.ok(result.scroll>0);assert.ok(result.bottom<=result.viewportBottom+2);assert.equal(result.ordinary,0);assert.equal(result.focus,"other");
  // This category is authored by the fixture, so restoration retains it.
  await page.close();
});

test("a partly visible header choice regains whole-label reach while an authored scrolling rail stays intact", async () => {
  const page=await prepare(`<style>body{margin:0;font:14px Arial}header{display:flex;width:390px}.logo{width:240px;flex-shrink:0}.actions{display:flex;gap:8px;flex-shrink:0}a{display:block;white-space:nowrap;font:14px Arial;padding:6px}.rail{display:flex;width:170px;overflow-x:auto;white-space:nowrap}.rail .track{display:flex;width:max-content}.rail a{flex-shrink:0}</style><header id="header"><div id="logo" class="logo">Artwork</div><div id="actions" class="actions"><a id="about" href="#">About</a><a id="business" href="#">Businesses</a></div></header><nav id="rail" class="rail"><div id="track" class="track"><a href="#">A first long option</a><a id="last" href="#">A second long option</a></div></nav>`,"a{font-size:18px!important;line-height:1.6!important;letter-spacing:.02em!important}");
  const result=await page.evaluate(()=>({business:document.querySelector("#business").getBoundingClientRect().toJSON(),about:document.querySelector("#about").getBoundingClientRect().toJSON(),railWrap:getComputedStyle(document.querySelector("#rail")).flexWrap,railOverflow:getComputedStyle(document.querySelector("#rail")).overflowX,trackRepair:document.querySelector("#track").getAttribute("data-lexend-layout-repair"),logo:document.querySelector("#logo").getBoundingClientRect().width}));
  assert.ok(result.business.right<=392,JSON.stringify(result));assert.ok(result.business.top>=result.about.bottom-2);assert.equal(result.railWrap,"nowrap");assert.equal(result.railOverflow,"auto");assert.ok(!result.trackRepair?.includes("action-row-wrap"));assert.equal(result.logo,240);
  await restored(page);await page.close();
});

test("an inline action with a growing block label reserves real flow height inside a fixed plain footer", async () => {
  const page=await prepare(`<style>body{margin:0;font:13px/15px Arial}.footer{position:fixed;bottom:0;left:0;width:390px;background:blue;color:white}.inner{padding:12px 48px 24px}.columns{display:flex;justify-content:space-between}.links{display:flex;flex-wrap:wrap;row-gap:12px;column-gap:28px;width:215px}.links>div{flex:0 1 auto}.info{display:inline;position:relative}.info-inner{display:flex;flex-wrap:wrap;align-items:center;gap:4px}.label{white-space:nowrap}svg{width:16px;height:16px}</style><div id="footer" class="footer"><div id="inner" class="inner"><div id="columns" class="columns"><div id="links" class="links"><div>VK © 2006–2026</div><div>Terms</div><div>Learn more about VK ID</div><div id="information"><span id="action" class="info" role="button" tabindex="0"><div id="info-inner" class="info-inner"><svg id="icon"><path d="M0 0h16v16z"/></svg>Information about&nbsp;content</div></span></div></div><div>English</div></div></div></div><script>window.clicks=0;document.querySelector('#action').onclick=()=>clicks++;</script>`,"#info-inner{font-size:18px!important;line-height:1.6!important;letter-spacing:.02em!important;white-space:normal!important}");
  const result=await page.evaluate(()=>{const label=document.querySelector("#info-inner"),range=document.createRange();range.selectNodeContents(label.lastChild);const action=document.querySelector("#action");action.focus();action.click();return{rects:[...range.getClientRects()].map(box=>box.toJSON()),footer:document.querySelector("#footer").getBoundingClientRect().toJSON(),parent:document.querySelector("#information").getBoundingClientRect().toJSON(),action:action.getBoundingClientRect().toJSON(),position:getComputedStyle(document.querySelector("#footer")).position,bottom:getComputedStyle(document.querySelector("#footer")).bottom,focus:document.activeElement.id,clicks};});
  assert.ok(result.action.height>32,JSON.stringify(result));
  assert.ok(result.rects.every(box=>box.bottom<=700+2),JSON.stringify(result));
  assert.ok(result.parent.bottom>=Math.max(...result.rects.map(box=>box.bottom))-2,JSON.stringify(result));
  assert.equal(result.position,"fixed");assert.equal(result.bottom,"0px");assert.equal(result.focus,"action");assert.equal(result.clicks,1);
  await restored(page);await page.close();
});

test("a compact multipart selector uses measured spare width instead of stacking its model label", async () => {
  const page=await prepare(`<style>body{margin:0;font:14px Arial}.toolbar{display:flex;align-items:center;gap:12px;width:390px}.menu{width:44px;flex-shrink:0}.model{display:flex;width:170px;padding:0 12px;box-sizing:border-box;flex-shrink:0}.parts{display:flex;align-items:center;height:24px}.brand{width:54px;flex-shrink:0}.label{display:block;width:72px;white-space:nowrap;text-overflow:ellipsis;overflow:hidden;font:18px/20px Arial;transform:scale(.888888);transform-origin:left center}.arrow{width:20px;height:20px;flex-shrink:0}.next{margin-left:auto;width:64px;flex-shrink:0}</style><div id="toolbar" class="toolbar"><div id="menu" class="menu">Menu</div><button id="model" class="model"><div id="parts" class="parts"><span id="brand" class="brand">Gemini</span><span id="label" class="label">3.5 Flash-Lite</span><svg id="arrow" class="arrow"><path d="M1 5l9 9 9-9"/></svg></div></button><button id="next" class="next">Sign in</button></div>`,"#label{font-size:19.8px!important;line-height:1.6!important;letter-spacing:.02em!important}");
  const result=await page.evaluate(()=>{const label=document.querySelector("#label"),range=document.createRange();range.selectNodeContents(label.firstChild);const model=document.querySelector("#model");model.focus();return{lines:new Set([...range.getClientRects()].map(box=>Math.round(box.top/2))).size,model:model.getBoundingClientRect().toJSON(),next:document.querySelector("#next").getBoundingClientRect().toJSON(),font:getComputedStyle(label).fontSize,transform:getComputedStyle(label).transform,focus:document.activeElement.id,repair:label.getAttribute("data-lexend-layout-repair")};});
  assert.equal(result.lines,1,JSON.stringify(result));assert.ok(result.model.right<=result.next.left-7,JSON.stringify(result));assert.equal(result.font,"19.8px");assert.match(result.transform,/0.888888/);assert.equal(result.focus,"model");
  assert.ok(result.repair?.includes("compact-selector"),JSON.stringify(result));
  await restored(page);await page.close();
});

test("a nested selector preserves whole words on two lines when real font growth cannot fit one line before its neighboring action", async () => {
  const font = (await readFile(new URL("../assets/fonts/lexend-latin-wght-normal.woff2", import.meta.url))).toString("base64");
  const page=await prepare(`<style>@font-face{font-family:TestLexend;src:url(data:font/woff2;base64,${font});font-weight:100 900}body{margin:0;font:14px Arial}.preload{position:absolute;visibility:hidden;font:20px TestLexend}.toolbar{display:flex;align-items:center;width:390px;padding:8px;box-sizing:border-box}.menu{width:48px;flex-shrink:0}.selector{width:170px}.model{display:flex;align-items:center;width:170px;min-width:0;padding:0 12px;border:0;box-sizing:border-box}.wrapper{display:block;min-width:0}.content{display:flex;min-width:0}.parts{display:flex;align-items:center;overflow:auto hidden;gap:4px}.brand{font:18px/24px Arial;flex-shrink:0}.label{display:block;width:72px;min-width:0;white-space:nowrap;text-overflow:ellipsis;overflow:hidden;font:18px/20px Arial;transform:scale(.888888)}.arrow{width:20px;height:20px;flex-shrink:0}.next{margin-left:auto;width:90px;flex-shrink:0}.touch{position:absolute;inset:0;pointer-events:none}</style><span class="preload">Font preload</span><div id="toolbar" class="toolbar"><div class="menu">Menu</div><div id="selector" class="selector"><button id="model" class="model"><span class="wrapper"><span class="content"><span class="wrapper"><div id="parts" class="parts"><span id="brand" class="brand">Gemini</span><span id="label" class="label">3.5 Flash-Lite</span><svg id="arrow" class="arrow"><path d="M1 5l9 9 9-9"/></svg></div></span></span></span></button></div><button id="next" class="next">Sign in</button></div>`,"#label,#brand{font-family:TestLexend!important;font-size:19.8px!important;line-height:1.6!important;letter-spacing:.02em!important}");
  const result=await page.evaluate(()=>{const label=document.querySelector('#label'),model=document.querySelector('#model'),range=document.createRange();range.selectNodeContents(label.firstChild);const token=document.createRange();token.setStart(label.firstChild,4);token.setEnd(label.firstChild,9);model.focus();return {lines:new Set([...range.getClientRects()].map(box=>Math.round(box.top/2))).size,tokenLines:new Set([...token.getClientRects()].map(box=>Math.round(box.top/2))).size,model:model.getBoundingClientRect().toJSON(),next:document.querySelector('#next').getBoundingClientRect().toJSON(),rects:[...range.getClientRects()].map(box=>box.toJSON()),font:getComputedStyle(label).fontSize,transform:getComputedStyle(label).transform,focus:document.activeElement.id,repair:label.getAttribute('data-lexend-layout-repair')};});
  assert.equal(result.lines,2,JSON.stringify(result));assert.equal(result.tokenLines,1,JSON.stringify(result));assert.ok(result.model.right<=result.next.left-7,JSON.stringify(result));assert.ok(result.rects.every(box=>box.right<=result.model.right+2));assert.equal(result.font,'19.8px');assert.match(result.transform,/0.888888/);assert.equal(result.focus,'model');assert.ok(result.repair?.includes('compact-selector'));
  await restored(page);await page.close();
});

test("a padded terminal dialog group wraps growing choices even through a zero-height fixed portal", async () => {
  const page=await prepare(`<style>body{margin:0;font:14px Arial}.portal{position:fixed;top:0;left:0;width:390px;height:0}.pane{margin:0 20px;width:350px;height:700px;overflow:auto}.space{height:450px}.actions{display:flex;justify-content:center;gap:12px}button{font:14px Arial;white-space:nowrap;padding:12px 64px;flex-shrink:0}.content{padding-bottom:24px}</style><div id="portal" class="portal" role="dialog"><div id="pane" class="pane"><div class="content"><div class="space"></div><div id="actions" class="actions"><button id="reject">Alle ablehnen</button><button id="accept">Alle akzeptieren</button></div></div></div></div><script>window.clicks=0;document.querySelector('#reject').onclick=()=>clicks++;</script>`,"button{font-size:24px!important;line-height:1.6!important;letter-spacing:.02em!important}");
  const result=await page.evaluate(()=>{const buttons=[...document.querySelectorAll('button')];const rects=buttons.flatMap(button=>{const range=document.createRange();range.selectNodeContents(button.firstChild);return [...range.getClientRects()].map(box=>box.toJSON());});buttons[0].focus();buttons[0].click();return {rects,actions:document.querySelector('#actions').getBoundingClientRect().toJSON(),wrap:getComputedStyle(document.querySelector('#actions')).flexWrap,portal:getComputedStyle(document.querySelector('#portal')).height,clicks,focus:document.activeElement.id,buttons:buttons.map(e=>e.getBoundingClientRect().toJSON())};});
  assert.equal(result.wrap,'wrap',JSON.stringify(result));assert.ok(result.rects.every(box=>box.left>=18&&box.right<=372),JSON.stringify(result));assert.ok(result.buttons[1].top>=result.buttons[0].bottom-2);assert.equal(result.portal,'0px');assert.equal(result.clicks,1);assert.equal(result.focus,'reject');
  await restored(page);await page.close();
});


test("a nested flex action keeps whole words beside its icon when a dialog header squeezes its outer wrappers", async () => {
  const font = (await readFile(new URL("../assets/fonts/lexend-latin-wght-normal.woff2", import.meta.url))).toString("base64");
  const page=await prepare(`<style>@font-face{font-family:TestLexend;src:url(data:font/woff2;base64,${font});font-weight:100 900}.preload{position:absolute;visibility:hidden;font:20px TestLexend}body{margin:0;font:14px Arial}.portal{position:fixed;inset:0}.dialog{width:390px;height:700px;padding:24px;box-sizing:border-box}.topbar{display:flex;justify-content:space-between;width:342px}.logo{width:142px;flex-shrink:0}.actions{display:flex;align-items:center}.locale{width:92px;flex-shrink:0}renderer{display:inline-block;min-width:0}shape{display:flex;min-width:0}a{position:relative;display:flex;align-items:center;box-sizing:border-box;height:40px;padding:0 15px;min-width:0;flex:1 1 0;white-space:nowrap;border:1px solid}.glyph{width:24px;height:24px;flex-shrink:0;margin-right:6px}.glyph svg{width:24px;height:24px}.label-box{min-width:0}.label{white-space:nowrap;font:14px Arial}.touch{position:absolute;inset:0;pointer-events:none}</style><span class="preload">Font preload</span><div id="portal" class="portal" role="dialog"><div id="dialog" class="dialog"><div id="topbar" class="topbar"><div id="logo" class="logo">Artwork</div><div id="actions" class="actions"><button id="locale" class="locale">English</button><div id="outer"><renderer id="renderer"><shape id="shape"><a id="signin" href="#"><div class="glyph" aria-hidden="true"><span><svg id="icon"><path d="M0 0h24v24z"/></svg></span></div><div id="label-box" class="label-box"><span id="label" class="label">Sign in</span></div><div id="touch" class="touch"></div></a></shape></renderer></div></div></div></div></div><script>window.clicks=0;document.querySelector('#signin').onclick=e=>{e.preventDefault();clicks++}</script>`,"#actions{width:170px!important;flex-shrink:0}#outer,#renderer,#shape{width:72px!important;min-width:0!important}#locale,#label{font-family:TestLexend!important;font-size:15.4px!important;line-height:1.6!important;letter-spacing:.02em!important;overflow-wrap:anywhere!important;white-space:normal!important}");
  const result=await page.evaluate(()=>{const label=document.querySelector('#label'),node=label.firstChild,range=document.createRange();range.setStart(node,0);range.setEnd(node,4);const action=document.querySelector('#signin');action.focus();action.click();return {wordLines:new Set([...range.getClientRects()].map(box=>Math.round(box.top/2))).size,rects:[...range.getClientRects()].map(box=>box.toJSON()),action:action.getBoundingClientRect().toJSON(),icon:document.querySelector('#icon').getBoundingClientRect().toJSON(),font:getComputedStyle(label).fontSize,style:label.style.cssText,labelcss:getComputedStyle(label).overflowWrap,box:label.getBoundingClientRect().toJSON(),parent:label.parentElement.style.cssText,focus:document.activeElement.id,repair:action.getAttribute('data-lexend-layout-repair'),clicks};});
  assert.equal(result.wordLines,1,JSON.stringify(result));assert.match(result.repair,/action-word/,JSON.stringify(result));assert.ok(result.rects.every(box=>box.left>=result.action.left-2&&box.right<=Math.min(result.action.right,390)+2),JSON.stringify(result));assert.ok(result.action.height<100,JSON.stringify(result));assert.ok(result.action.right<=392);assert.equal(result.icon.width,24);assert.equal(result.font,'15.4px');assert.equal(result.focus,'signin');assert.equal(result.clicks,1);
  await restored(page);await page.close();
});


test("an already focused action remains visible after growth in the native scroller inside a repaired panel", async () => {
  const page=await prepare(`<style>body{margin:0;font:14px Arial}.scope{height:240px;width:310px;overflow:hidden}.pane{height:150px;width:280px;overflow:auto}p{margin:0;font:14px/20px Arial}button{font:14px Arial}.space{height:1000px}</style><div class="space"></div><div id="scope" class="scope" data-lexend-layout-repair="bounded-panel"><div id="pane" class="pane"><p id="copy">A long explanation inside a native scrolling content pane. Keep this text readable while preserving its author scroll owner and its final keyboard action. A second paragraph makes its terminal choice move when the requested font changes.</p><button id="last">Reject all</button></div></div><div id="ordinary" class="pane"><p>Unrelated native scroller</p><div class="space"></div><button id="other">Other action</button></div>`,"#copy,#last{font-size:15.4px!important;line-height:1.6!important;letter-spacing:.02em!important}");
  const result=await page.evaluate(()=>{window.scrollTo(0,850);const target=document.querySelector('#last'),pane=document.querySelector('#pane');target.focus();const scrollYBefore=scrollY;document.querySelector('#typography').textContent='#copy,#last{font-size:24px!important;line-height:1.6!important;letter-spacing:.02em!important}';layout.repair();const before=target.getBoundingClientRect().toJSON(),viewport=pane.getBoundingClientRect().toJSON();LexendControls.revealFocused(target);const after=target.getBoundingClientRect().toJSON();return {before,after,viewport,scrollTop:pane.scrollTop,focused:document.activeElement.id,scrollYBefore,scrollYAfter:scrollY,ordinary:document.querySelector('#ordinary').scrollTop,paneRepair:pane.getAttribute('data-lexend-layout-repair')};});
  assert.ok(result.before.bottom>result.viewport.bottom+2,JSON.stringify(result));assert.ok(result.after.bottom<=result.viewport.bottom+2&&result.after.top>=result.viewport.top-2,JSON.stringify(result));assert.ok(result.scrollTop>0);assert.equal(result.focused,'last');assert.equal(result.scrollYBefore,result.scrollYAfter);assert.equal(result.ordinary,0);assert.ok(!result.paneRepair?.includes('bounded-panel'));
  await page.close();
});
