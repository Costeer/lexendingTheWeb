import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import { chromium } from "playwright";

const source = await readFile(new URL("../src/adaptive-layout.js", import.meta.url), "utf8");
let browser;
test.before(async () => { browser = await chromium.launch({ headless: true }); });
test.after(async () => { await browser?.close(); });

const prepare = async (html, viewport = { width: 390, height: 600 }, typographyCss = "body :is(p,h1,h2,h3,span,a,button) {font-size: 24px!important;line-height:1.6!important;letter-spacing:.02em!important}") => {
  const page = await browser.newPage({ viewport });
  await page.setContent(html);
  await page.addScriptTag({ content: source });
  await page.evaluate((typographyCss) => {
    const typography = document.createElement("style");
    typography.id = "typography";
    typography.media = "not all";
    typography.textContent = typographyCss;
    document.head.append(typography);
    window.layout = LexendLayout.create({ withStylesDisabled(callback) {
      const media = typography.media;
      typography.media = "not all";
      try { return callback(); } finally { typography.media = media; }
    } });
    window.layout.capture();
    typography.media = "all";
    window.layout.repair();
  }, typographyCss);
  return page;
};

test("expanded quote with small SVG and a fade keeps its action above the author row", async () => {
  const page = await prepare(`<style>
    body{font:18px/1.2 sans-serif}.card{width:300px;display:flex;flex-direction:column}
    .row{display:flex;gap:16px}.copy{display:flex;flex-direction:column;flex:1}
    .excerpt{position:relative;max-height:100px;overflow:hidden;flex:1}p{margin:0}
    .fade{position:absolute;bottom:0;left:0;width:100%;height:30px;pointer-events:none;background:linear-gradient(to top,white,transparent)}
    button{margin-top:8px}.author{padding-top:16px;display:flex;gap:16px}.author img{width:40px;height:40px}
  </style><div class="card"><div class="row"><svg width="32" height="32"><path d="M0 0h20v20H0z"/></svg><div class="copy"><div class="excerpt"><p>This complete quotation explains why accessible captions help people follow courses without missing any words or the final sentence.</p><div class="fade"></div></div><button>Show More</button></div></div><div class="author"><img src="data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg'/%3E"><span>Sandy Example</span></div></div>`);
  const state = await page.evaluate(() => {
    const p=document.querySelector('p').getBoundingClientRect(), button=document.querySelector('button').getBoundingClientRect(), author=document.querySelector('.author').getBoundingClientRect();
    return {p:p.toJSON(),button:button.toJSON(),author:author.toJSON(),fade:getComputedStyle(document.querySelector('.fade')).display};
  });
  assert.ok(state.button.top >= state.p.bottom - 1);
  assert.ok(state.author.top >= state.button.bottom - 1);
  assert.equal(state.fade, "none");
  assert.equal(await page.evaluate(() => { layout.restore(); return document.querySelector('.fade').getAttribute('style'); }), null);
  await page.close();
});

test("fitting a heading preserves the space occupied by its authored side offset", async () => {
  const page = await prepare(`<style>body{margin:16px;font:18px/1.2 sans-serif}.article{width:320px}h3{font-size:18px;margin:0 0 0 110px;width:210px;overflow-wrap:anywhere}a{font:inherit}</style><div class="article"><h3><a>Understanding</a></h3></div>`, {width:390,height:600}, "h3 a{font-size:30px!important;line-height:1.6!important}");
  const result = await page.evaluate(() => {
    const h=document.querySelector('h3'),a=h.querySelector('a'),r=document.createRange();r.selectNodeContents(a);
    return {heading:h.getBoundingClientRect().toJSON(),parent:h.parentElement.getBoundingClientRect().toJSON(),text:[...r.getClientRects()].map(x=>x.toJSON()),width:document.documentElement.scrollWidth,margin:getComputedStyle(h).marginLeft};
  });
  assert.ok(result.heading.right <= result.parent.right + 1);
  assert.ok(result.text.every(r => r.right <= result.parent.right + 1));
  assert.equal(result.width,390);
  assert.equal(result.margin,'110px');
  const restored=await page.evaluate(()=>{layout.restore();return document.querySelector('h3').getAttribute('style')});
  assert.equal(restored,null);
  await page.close();
});

test("a linked card heading borrows unused outer padding before splitting a word", async () => {
  const page = await prepare(`<style>
    body{margin:0;font:16px Arial}.card{width:150px;background:white;padding:8px;box-sizing:border-box}
    .content{padding:8px}.header{width:116px}a{display:block;width:116px}
    h3{width:116px;margin:0;font:700 16px/1.4 Arial;overflow-wrap:anywhere;display:-webkit-box}
  </style><div class="card"><div class="content"><div class="header"><a href="#course"><h3>Fundamentals of Machine Learning</h3></a></div></div></div>`,
  { width: 390, height: 600 }, "h3{font-size:17.6px!important;line-height:1.6!important;letter-spacing:.02em!important}");
  const state = await page.evaluate(() => {
    const heading = document.querySelector("h3"), card = document.querySelector(".card");
    const range = document.createRange();
    range.setStart(heading.firstChild, 0); range.setEnd(heading.firstChild, "Fundamentals".length);
    return { fragments: [...range.getClientRects()].length,
      heading: heading.getBoundingClientRect().toJSON(), card: card.getBoundingClientRect().toJSON(),
      fontSize: parseFloat(getComputedStyle(heading).fontSize), repair: heading.getAttribute("data-lexend-layout-repair") };
  });
  assert.equal(state.fragments, 1);
  assert.ok(state.heading.right <= state.card.right - 1);
  assert.ok(state.fontSize >= 16);
  assert.match(state.repair, /fit-heading/);
  await page.close();
});

test("an enlarged generated tooltip stays within the viewport without revealing or shrinking it", async () => {
  const page = await prepare(`<style>
    body{margin:0}a{position:absolute;right:16px;top:100px;width:54px;height:36px;border:1px solid;box-sizing:border-box}
    a::after{content:"DigitalOcean";position:absolute;left:50%;translate:-50%;font:14px sans-serif;padding:6px 10px;box-sizing:border-box;white-space:nowrap;opacity:0}
    a:hover::after{opacity:1}[data-lexend-fit-pseudo-after]::after{margin-left:var(--lexend-layout-after-margin-left)!important}
    a.left{left:16px;right:auto}
  </style><a href="#">↗</a><a class="left" href="#">↗</a>`, {width:390,height:600}, 'a::after{font-size:24px!important;line-height:1.6!important;letter-spacing:.02em!important}');
  assert.equal(await page.evaluate(()=>document.documentElement.scrollWidth),390);
  assert.equal(await page.evaluate(()=>getComputedStyle(document.querySelector('a'),'::after').opacity),'0');
  await page.locator('a').first().hover();
  assert.equal(await page.evaluate(()=>getComputedStyle(document.querySelector('a'),'::after').opacity),'1');
  assert.equal(await page.evaluate(()=>document.documentElement.scrollWidth),390);
  assert.equal(await page.evaluate(()=>{layout.restore();return document.querySelector('a').hasAttribute('data-lexend-fit-pseudo-after')}),false);
  await page.close();
});

test("partly visible specimen captions escape a negative top crop reversibly", async () => {
  const page=await prepare(`<style>body{margin:16px;font:16px/1.2 sans-serif}.mask{width:300px;height:180px;overflow:hidden}.scene{margin-top:-36px;padding:26px 12px}span{display:block}</style><div class="mask"><div class="scene"><span>Power Meets Precision</span><p>A complete readable explanation in a constrained visual specimen.</p></div></div>`);
  const state=await page.evaluate(()=>{const mask=document.querySelector('.mask'),span=document.querySelector('span'),r=document.createRange();r.selectNodeContents(span);return{top:mask.getBoundingClientRect().top,text:r.getBoundingClientRect().toJSON(),margin:getComputedStyle(document.querySelector('.scene')).marginTop}});
  assert.ok(state.text.top>=state.top-1);
  assert.ok(parseFloat(state.margin)>-36);
  assert.equal(await page.evaluate(()=>{layout.restore();return document.querySelector('.scene').getAttribute('style')}),null);
  await page.close();
});

test("new intrinsic inline-block prose stays within its viewport including authored padding", async () => {
  const page=await prepare(`<style>body{margin:0;font:16px/1.2 sans-serif}.tagline{display:inline-block;padding:0 24px}</style><div class="tagline">Readable websites for everyone</div>`, {width:390,height:600}, '.tagline{font-size:24px!important;line-height:1.6!important;letter-spacing:.02em!important}');
  const state=await page.evaluate(()=>{const e=document.querySelector('.tagline');return{box:e.getBoundingClientRect().toJSON(),doc:document.documentElement.scrollWidth,font:getComputedStyle(e).fontSize,padding:getComputedStyle(e).paddingLeft}});
  assert.ok(state.box.right<=390);
  assert.equal(state.doc,390);
  assert.equal(state.font,'24px');
  assert.equal(state.padding,'24px');
  assert.equal(await page.evaluate(()=>{layout.restore();return document.querySelector('.tagline').getAttribute('style')}),null);
  await page.close();
});

test("a newly cropped one-line label fits above its original size and restores", async () => {
  const page = await prepare(`<style>
    body{margin:0;font:14px/24px Arial}.row{width:179px;display:flex;direction:rtl;padding:24px;gap:16px}
    .avatar{flex:none;width:48px;height:48px}.label{width:65px;flex:none;overflow:hidden;white-space:nowrap;direction:rtl}
    span{display:block;font:14px/24px Arial}
  </style><div class="row"><div class="avatar"></div><div class="label"><span>سارة أحمد</span></div></div>`,
  {width:390,height:600}, "span{font-size:15.4px!important;line-height:1.6!important;letter-spacing:0!important}");
  const result = await page.evaluate(() => {
    const span=document.querySelector("span"), clip=span.parentElement.getBoundingClientRect();
    const range=document.createRange();range.selectNodeContents(span);
    return {text:range.getBoundingClientRect().toJSON(),clip:clip.toJSON(),size:parseFloat(getComputedStyle(span).fontSize),repair:span.getAttribute("data-lexend-layout-repair")};
  });
  assert.ok(result.text.left>=result.clip.left-1 && result.text.right<=result.clip.right+1,JSON.stringify(result));
  assert.ok(result.size>=14 && result.size<=15.4);
  assert.match(result.repair,/fit-tight-label/,JSON.stringify(result));
  assert.equal(await page.evaluate(()=>{layout.restore();return document.querySelector("span").getAttribute("style")}),null);
  await page.close();
});

test("a short action keeps its full word when added tracking triggers author break-all", async () => {
  const page = await prepare(`<style>body{font:13px/1.5 Arial}.card{width:90px}a{display:block;color:#1460bd;text-decoration:none}span{display:block;word-break:break-all}</style>
    <div class="card"><a href="#"><span>Free knowledge base</span></a></div>`,
  {width:390,height:600}, "span{font-size:14.3px!important;line-height:1.6!important;letter-spacing:.02em!important}");
  const state = await page.evaluate(() => {
    const label=document.querySelector("span"),node=label.firstChild,match=node.textContent.indexOf("knowledge");
    const range=document.createRange();range.setStart(node,match);range.setEnd(node,match+9);
    return {fragments:[...range.getClientRects()].map(r=>r.toJSON()),wordBreak:getComputedStyle(label).wordBreak,repair:label.getAttribute("data-lexend-layout-repair"),font:parseFloat(getComputedStyle(label).fontSize)};
  });
  assert.equal(state.fragments.length,1);
  assert.equal(state.wordBreak,"normal");
  assert.match(state.repair,/whole-action-word/);
  assert.equal(state.font,14.3);
  assert.equal(await page.evaluate(()=>{layout.restore();return document.querySelector("span").getAttribute("style")}),null);
  await page.close();
});

test("a single-word action may fit without falling below its author size", async () => {
  const page = await prepare(`<style>body{font:18px Arial}a{display:block;width:94px;overflow-wrap:anywhere}</style><a href="#">biTStream</a>`,
    {width:390,height:600}, "a{font-size:19.8px!important;line-height:1.6!important;letter-spacing:.02em!important}");
  const state=await page.evaluate(()=>{const a=document.querySelector("a"),r=document.createRange();r.selectNodeContents(a);return{fragments:[...r.getClientRects()].map(x=>x.toJSON()),size:parseFloat(getComputedStyle(a).fontSize),repair:a.getAttribute("data-lexend-layout-repair")}});
  assert.equal(state.fragments.length,1);
  assert.ok(state.size>=18 && state.size<=19.8);
  assert.match(state.repair,/whole-action-word/);
  assert.equal(await page.evaluate(()=>{layout.restore();return document.querySelector("a").getAttribute("style")}),null);
  await page.close();
});

test("an action may borrow free gutter space for a complete long word", async () => {
  const page = await prepare(`<style>body{margin:8px;font:13px Arial}.row{display:flex;gap:34px}.item{width:82px;flex:none}span{display:block;overflow-wrap:anywhere}</style>
    <div class="row"><a href="#" class="item"><span>recursos de aprendizagem</span></a><a href="#" class="item"><span>Other subject</span></a></div>`,
  {width:390,height:600}, "span{font-size:14.3px!important;line-height:1.6!important;letter-spacing:.02em!important}");
  const state=await page.evaluate(()=>{const span=document.querySelector("span"),node=span.firstChild,r=document.createRange(),word="aprendizagem",start=node.textContent.indexOf(word);r.setStart(node,start);r.setEnd(node,start+word.length);return{fragments:[...r.getClientRects()].map(x=>x.toJSON()),repair:span.getAttribute("data-lexend-layout-repair"),size:parseFloat(getComputedStyle(span).fontSize)}});
  assert.equal(state.fragments.length,1);
  assert.match(state.repair,/whole-action-word/);
  assert.equal(state.size,14.3);
  assert.equal(await page.evaluate(()=>{layout.restore();return document.querySelector("span").getAttribute("style")}),null);
  await page.close();
});

test("measured growth expands prose and reflows overlapping absolute labels reversibly", async () => {
  const page = await prepare(`<style>
    body{font:16px/1.1 sans-serif;margin:16px} p,h3{margin:0}
    .card{width:260px;height:65px;overflow:hidden;border:1px solid}
    .card h3{height:19px;font-size:16px}.card p{height:39px;overflow:hidden;display:-webkit-box;-webkit-line-clamp:2;-webkit-box-orient:vertical}
    .badge{position:relative;width:130px;height:54px;margin-top:20px;background:#ddd}
    .badge span{position:absolute;left:0;width:130px;height:18px}
    .badge span:nth-child(1){top:0}.badge span:nth-child(2){top:18px}.badge span:nth-child(3){top:36px}
    pre{height:20px;overflow:auto}
  </style><div class="card" style="border-color: red"><h3>A clear heading</h3><p>All of this explanation should be readable when larger typography wraps into additional lines.</p></div>
  <div class="badge"><span>September</span><span>25</span><span>2026</span></div><pre>protected monospace</pre>`);
  const result = await page.evaluate(() => {
    const card = document.querySelector(".card"), p = card.querySelector("p");
    const labels = [...document.querySelectorAll(".badge span")].map((e) => e.getBoundingClientRect().toJSON());
    return { height: card.clientHeight, scroll: card.scrollHeight, clamp: getComputedStyle(p).webkitLineClamp,
      labels, protectedStyle: document.querySelector("pre").getAttribute("style") };
  });
  assert.ok(result.height >= result.scroll - 2);
  assert.equal(result.clamp, "none");
  for (let index = 1; index < result.labels.length; index++) assert.ok(result.labels[index].top >= result.labels[index - 1].bottom - 1);
  assert.equal(result.protectedStyle, null);
  const restored = await page.evaluate(() => {
    window.layout.restore();
    return [...document.querySelectorAll(".card,.card h3,.card p,.badge,.badge span")].map((e) => [e.getAttribute("style"), e.getAttribute("data-lexend-layout-repair")]);
  });
  assert.equal(restored[0][0], "border-color: red;");
  assert.ok(restored.every((state, i) => (i === 0 || state[0] === null) && state[1] === null));
  await page.close();
});

test("larger image-overlay text gains contrast and headings fit without going below baseline", async () => {
  const page = await prepare(`<style>
    body{font:16px/1.1 sans-serif;margin:16px}h1{font-size:20px;width:180px;overflow-wrap:anywhere}
    .photo{position:relative;background-image:url("data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' width='260' height='100'%3E%3Crect width='260' height='100' fill='white'/%3E%3C/svg%3E");height:100px;width:260px}
    .photo h3{position:absolute;bottom:5px;margin:0;color:white;font-size:16px;width:240px}
  </style><h1>ACCESSIBILITY</h1><div class="photo"><h3>A longer readable photograph headline</h3></div>`);
  const result = await page.evaluate(() => ({
    headingSize: parseFloat(getComputedStyle(document.querySelector("h1")).fontSize),
    marker: document.querySelector("h1").getAttribute("data-lexend-layout-repair"),
    backdrop: getComputedStyle(document.querySelector("h3")).backgroundColor
  }));
  assert.ok(result.headingSize >= 20 && result.headingSize <= 24);
  assert.match(result.marker, /fit-heading/);
  assert.equal(result.backdrop, "rgba(15, 23, 42, 0.94)");
  await page.close();
});

test("fixed panels remain bounded and controls are scrollable after growth and resize", async () => {
  const page = await prepare(`<style>
    body{font:16px/1.1 sans-serif;margin:0}p{margin:0}
    .panel{position:fixed;bottom:0;width:100%;background:#ddd;padding:12px;box-sizing:border-box}
    button{font-size:16px;margin-top:8px}
  </style><main>A useful article behind the panel.</main><div class="panel"><p>Preferences explain how this website uses stored information. Please review these available choices and select whichever option meets your needs. Further details explain optional measurement and advertising choices before making a decision.</p><button>Reject optional storage</button></div>`);
  const first = await page.evaluate(() => {
    const panel = document.querySelector(".panel");
    return { height: panel.getBoundingClientRect().height, overflow: getComputedStyle(panel).overflowY, scroll: panel.scrollHeight };
  });
  assert.ok(first.height <= 300);
  assert.equal(first.overflow, "auto");
  assert.ok(first.scroll > first.height);
  await page.setViewportSize({ width: 600, height: 400 });
  await page.evaluate(() => window.layout.refresh());
  assert.ok(await page.evaluate(() => document.querySelector(".panel").getBoundingClientRect().height <= 200));
  // Author changes written after repair survive restoration, as they should.
  assert.equal(await page.evaluate(() => {
    const panel = document.querySelector(".panel");
    panel.style.setProperty("max-height", "177px");
    window.layout.restore();
    return panel.style.maxHeight;
  }), "177px");
  await page.close();
});

test("closed menus, replacement sprites and screen-reader labels remain hidden", async () => {
  const page = await prepare(`<style>
    body{font:16px/1.1 sans-serif;margin:0}
    header{position:fixed;top:0;height:56px;width:100%;background:#eee}
    header a{display:inline-block;line-height:56px}
    .closed{height:0;overflow:hidden}.closed p{margin:0;font-size:16px}
    .offscreen{position:fixed;top:100vh;width:100%;background:#ddd}
    .sr{position:absolute;width:1px;height:1px;clip:rect(0,0,0,0);overflow:hidden}
    .sprite{display:inline-block;width:20px;height:20px;text-indent:-9999px;overflow:hidden}
  </style><header><a>Home</a><span class="sr">A very long navigation explanation that is intended for a screen reader only.</span><span class="sprite">Search website</span><div class="closed"><p>Closed navigation items remain unavailable until opened.</p></div></header><div class="offscreen"><p>A panel deliberately closed below the viewport.</p></div>`);
  const state = await page.evaluate(() => ({
    height: document.querySelector("header").getBoundingClientRect().height,
    closed: document.querySelector(".closed").getBoundingClientRect().height,
    markers: [...document.querySelectorAll(".closed,.closed p,.sr,.sprite,.offscreen,.offscreen p")].map((e) => e.getAttribute("data-lexend-layout-repair"))
  }));
  assert.equal(state.height, 56);
  assert.equal(state.closed, 0);
  assert.ok(state.markers.every((value) => value === null));
  await page.close();
});

test("uppercase display headings and BR text runs fit with an explicit bounded size exception", async () => {
  const page = await prepare(`<style>
    body{margin:16px;font:16px sans-serif}h1{font:60px sans-serif;width:280px;margin:0;text-transform:uppercase;overflow-wrap:anywhere}
  </style><h1><span>accessibility</span><br>Framework</h1>`, { width: 390, height: 600 },
  "body :is(h1,span) {font:66px sans-serif;line-height:1.6;letter-spacing:.02em}");
  const state = await page.evaluate(() => [...document.querySelectorAll("h1,h1 span")].map((element) => {
    const range = document.createRange();
    const own = [...element.childNodes].find((node) => node.nodeType === Node.TEXT_NODE && node.textContent.trim());
    range.selectNodeContents(own);
    return { available: document.querySelector("h1").clientWidth, size: parseFloat(getComputedStyle(element).fontSize), marker: element.getAttribute("data-lexend-layout-repair"),
      rects: [...range.getClientRects()].map((r) => ({ width: r.width, left: r.left, right: r.right })) };
  }));
  assert.ok(state.every((item) => item.size >= 24 && item.size < 60));
  assert.ok(state.every((item) => /fit-heading-below-baseline/.test(item.marker)));
  assert.ok(state.every((item) => item.rects.length === 1 && item.rects[0].width <= item.available));
  await page.close();
});

test("tall navigation controls retain baseline centering after line-height changes", async () => {
  const page = await prepare(`<style>
    body{font:16px sans-serif}nav a{display:inline-block;height:64px;line-height:64px;font-size:16px}
  </style><nav><a href="/">Playground</a></nav>`);
  const centered = await page.evaluate(() => {
    const link = document.querySelector("a"), range = document.createRange();
    range.selectNodeContents(link.firstChild);
    const text = range.getBoundingClientRect(), box = link.getBoundingClientRect();
    return Math.abs((text.top + text.bottom - box.top - box.bottom) / 2);
  });
  assert.ok(centered < 3);
  await page.close();
});

test("new table overflow becomes reachable without shrinking cells and wrappers restore", async () => {
  const page = await prepare(`<style>body{font:16px sans-serif;margin:16px}td{white-space:nowrap}</style>
  <table><caption>Download choices</caption><tr><td><span>Download archives</span></td><td><span>Operating platform</span></td><td><span>Uncompressed size</span></td></tr></table>`);
  const state = await page.evaluate(() => {
    const table = document.querySelector("table"), viewport = table.parentElement;
    viewport.scrollLeft = viewport.scrollWidth;
    return { overflow: getComputedStyle(viewport).overflowX, right: viewport.getBoundingClientRect().right,
      scroll: viewport.scrollLeft, size: parseFloat(getComputedStyle(table.querySelector("span")).fontSize),
      parentRole: viewport.getAttribute("role") };
  });
  assert.equal(state.overflow, "auto");
  assert.ok(state.right <= 390);
  assert.ok(state.scroll > 0);
  assert.equal(state.size, 24);
  assert.equal(state.parentRole, "region");
  assert.equal(await page.evaluate(() => { window.layout.restore(); return document.querySelector("table").parentElement.tagName; }), "BODY");
  await page.close();
});

test("headings reserve letter-spacing room at the fractional word-fit boundary", async () => {
  const font = (await readFile(new URL("../assets/fonts/lexend-latin-wght-normal.woff2", import.meta.url))).toString("base64");
  const page = await prepare(`<style>
    @font-face{font-family:TestLexend;src:url(data:font/woff2;base64,${font});font-weight:100 900}
    body{margin:0}section{width:390px;box-sizing:border-box;padding:0 32px}
    h1{margin:0;font:900 48px/60px Arial;overflow-wrap:anywhere}
  </style><section><h1>The <span>Progressive</span><br>JavaScript Framework</h1></section>`,
  { width: 390, height: 600 }, "h1,h1 span{font-family:TestLexend;font-size:52.8px;font-weight:900;line-height:1.6;letter-spacing:.02em}");
  await page.evaluate(async () => { await document.fonts.ready; window.layout.refresh(); });
  const state = await page.evaluate(() => {
    const heading = document.querySelector("h1");
    const node = heading.lastChild, range = document.createRange();
    const start = node.textContent.indexOf("Framework");
    range.setStart(node, start); range.setEnd(node, start + "Framework".length);
    return { marker: heading.getAttribute("data-lexend-layout-repair"), size: parseFloat(getComputedStyle(heading).fontSize),
      wordRects: [...range.getClientRects()].map((r) => ({ width: r.width })) };
  });
  assert.match(state.marker, /fit-heading/);
  assert.ok(state.size < 52.8 && state.size >= 48);
  assert.equal(state.wordRects.length, 1);
  assert.ok(state.wordRects[0].width < 324);
  await page.close();
});

test("expanding captions retain percentage-height image backdrops", async () => {
  const page = await prepare(`<style>
    body{font:16px/1.1 sans-serif;margin:16px}
    .photo-card{position:relative;width:260px;height:110px;background:#000;overflow:hidden}
    .image{position:absolute;inset:0;height:100%;width:100%;background-image:linear-gradient(#28a,#742)}
    .caption{position:absolute;bottom:0;left:10px;right:10px;color:white}
    .caption p{margin:0;font-size:16px}
  </style><div class="photo-card"><div class="image"></div><div class="caption"><p>This photograph has a longer readable explanation that must expand without making its background image disappear.</p></div></div>`);
  const state = await page.evaluate(() => {
    const card = document.querySelector(".photo-card"), image = document.querySelector(".image"), caption = document.querySelector(".caption");
    const text = document.createRange(); text.selectNodeContents(caption.querySelector("p").firstChild);
    return { card: card.getBoundingClientRect().toJSON(), image: image.getBoundingClientRect().toJSON(),
      caption: caption.getBoundingClientRect().toJSON(), text: text.getBoundingClientRect().toJSON(), position: getComputedStyle(image).position,
      height: getComputedStyle(card).height, background: getComputedStyle(image).backgroundImage };
  });
  assert.ok(state.card.height > 110);
  assert.ok(state.image.height > 110);
  assert.ok(state.text.top >= state.card.top - 2);
  assert.ok(Math.abs(state.image.height - state.card.height) < 2);
  assert.equal(state.position, "absolute");
  assert.match(state.background, /linear-gradient/);
  assert.notEqual(state.height, "auto");
  await page.close();
});

test("large nonsemantic display words fit and nested pill labels wrap inside their control", async () => {
  const page = await prepare(`<style>
    body{margin:16px;font:16px sans-serif}.display{font-size:40px;width:160px;overflow-wrap:anywhere}
    button{display:flex;align-items:center;gap:8px;width:210px;height:42px;padding:8px 12px;overflow:hidden;white-space:nowrap}
    button svg{flex-shrink:0;width:18px;height:18px}
  </style><p class="display">Ecosystem</p><button><svg></svg><span>Search or ask anything</span></button>`,
  {width:390,height:600}, "body :is(p,span,button){font-size:44px!important;line-height:1.6!important;letter-spacing:.02em!important} button,button span{font-size:19px!important}");
  const result = await page.evaluate(() => {
    const word = document.querySelector("p"), button = document.querySelector("button"), span = button.querySelector("span"), range = document.createRange();
    range.selectNodeContents(span.firstChild);
    return {wordMarker:word.getAttribute("data-lexend-layout-repair"),wordWidth:word.scrollWidth,wordClient:word.clientWidth,
      text:range.getBoundingClientRect().toJSON(),button:button.getBoundingClientRect().toJSON()};
  });
  assert.match(result.wordMarker, /fit-heading/);
  assert.ok(result.wordWidth <= result.wordClient + 2);
  assert.ok(result.text.right <= result.button.right - 10);
  assert.ok(result.text.bottom <= result.button.bottom);
  await page.close();
});

test("expanded prose removes only empty gradient fade masks and restores them", async () => {
  const page = await prepare(`<style>
    body{font:16px/1.1 sans-serif;margin:16px}p{position:relative;width:240px;max-height:36px;overflow:hidden;display:-webkit-box;-webkit-line-clamp:2;-webkit-box-orient:vertical}
    p::after{content:"";position:absolute;top:18px;left:0;width:100%;height:30px;background:white;mask-image:linear-gradient(90deg,transparent,black)}
    p::before{content:"x";position:absolute;height:30px;width:10px;background:linear-gradient(transparent,white)}
    [data-lexend-hide-fade-before]::before,[data-lexend-hide-fade-after]::after{display:none!important}
  </style><p>The whole explanation must remain readable after removing its previous height constraint, without a white gradient mask covering the additional lines.</p>`);
  const result = await page.evaluate(() => {
    const p = document.querySelector("p");
    const after = getComputedStyle(p,"::after").display, before = getComputedStyle(p,"::before").display;
    const marker = p.getAttribute("data-lexend-layout-repair");
    window.layout.restore();
    return {after,before,marker,restored:getComputedStyle(p,"::after").display};
  });
  assert.equal(result.after,"none");
  assert.notEqual(result.before,"none");
  assert.match(result.marker,/remove-text-fade/);
  assert.notEqual(result.restored,"none");
  await page.close();
});

test("absolute consent panels in embedded viewports keep displaced controls reachable", async () => {
  const page = await browser.newPage({ viewport: { width:390,height:600 } });
  await page.setContent('<iframe style="width:390px;height:600px;border:0"></iframe>');
  const frame=page.frames()[1];
  await frame.setContent(`<style>body{margin:0;font:16px/1.1 sans-serif}.panel{position:absolute;bottom:0;width:100%;height:360px;overflow:hidden;background:white}p{margin:12px}button{margin:12px;height:36px;font-size:16px}</style><div class="panel"><p>This explanation describes personal information, optional storage, and the choices available to visitors. Larger typography adds enough lines to displace controls that originally fit inside this embedded viewport. Additional explanation makes sure this is a real scrolling case and a useful accessibility check.</p><button>Reject optional storage</button></div>`);
  await frame.addScriptTag({ content:source });
  await frame.evaluate(()=>{let style=document.createElement('style');style.textContent='p,button{font-size:30px!important;line-height:1.6!important}';style.media='not all';document.head.append(style);window.layout=LexendLayout.create({withStylesDisabled(callback){let old=style.media;style.media='not all';try{return callback()}finally{style.media=old}}});layout.capture();style.media='all';layout.repair()});
  const bounded=await frame.evaluate(()=>{let p=document.querySelector('.panel');return{height:p.getBoundingClientRect().height,overflow:getComputedStyle(p).overflowY,scroll:p.scrollHeight,marker:p.getAttribute('data-lexend-layout-repair')}});
  assert.ok(bounded.height<=568);assert.equal(bounded.overflow,'auto');assert.ok(bounded.scroll>bounded.height);assert.match(bounded.marker,/bounded-panel/);
  await frame.locator('button').focus();
  const reachable=await frame.evaluate(()=>{let b=document.querySelector('button').getBoundingClientRect(),p=document.querySelector('.panel').getBoundingClientRect();return b.top>=p.top&&b.bottom<=p.bottom+1&&b.bottom<=innerHeight});
  assert.ok(reachable);
  assert.equal(await frame.evaluate(()=>{layout.restore();return document.querySelector('.panel').getAttribute('style')}),null);
  await page.close();
});

test("native placeholders remain readable in flex forms and selects stay inside the viewport",async()=>{
 const page=await prepare(`<style>body{font:16px sans-serif;margin:16px}.form{display:flex;width:330px}input{box-sizing:border-box;width:180px;min-width:0;padding:12px 30px;font-size:16px}button{width:150px}select{font-size:16px;width:360px;padding:8px}</style><div class="form"><input placeholder="Your email"><button>Subscribe</button></div><select><option>Available downloads</option></select>`,{width:390,height:600},'input,button,select{font-size:30px!important;line-height:1.6!important}select{width:420px!important}');
 const result=await page.evaluate(()=>{let input=document.querySelector('input'),select=document.querySelector('select'),form=input.parentElement;return{width:input.getBoundingClientRect().width,wrap:getComputedStyle(form).flexWrap,right:select.getBoundingClientRect().right,marker:input.getAttribute('data-lexend-layout-repair')}});
 assert.ok(result.width>180);assert.equal(result.wrap,'wrap');assert.ok(result.right<=390);assert.match(result.marker,/wrap/);
 assert.equal(await page.evaluate(()=>{layout.restore();return document.querySelector('input').getAttribute('style')}),null);
 await page.close();
});

test("nested scrollable disclosures do not inflate their surrounding cards",async()=>{
 const page=await prepare(`<style>body{font:16px/1.1 sans-serif;margin:16px}.card{height:240px;width:300px;border:1px solid}.scroll{height:180px;overflow-y:auto}p{margin:0}button{height:40px}</style><div class="card"><div class="scroll"><p>A long explanatory disclosure with enough repeated detail to exceed its scrollable viewport. A long explanatory disclosure with enough repeated detail to exceed its scrollable viewport. A long explanatory disclosure with enough repeated detail to exceed its scrollable viewport. A long explanatory disclosure with enough repeated detail to exceed its scrollable viewport.</p></div><button>Reject optional storage</button></div>`);
 const result=await page.evaluate(()=>{let c=document.querySelector('.card'),s=document.querySelector('.scroll');return{card:c.clientHeight,scroll:s.scrollHeight,viewport:s.clientHeight}});
 assert.ok(result.scroll>result.viewport);assert.equal(result.card,240);
 await page.close();
});

test("inline brand headings retain their image row and positioned search clearance",async()=>{
 const page=await prepare(`<style>body{font:16px sans-serif;margin:0}.portal{width:390px;position:relative}.brand{height:70px;text-align:center}.brand img{display:inline-block;width:57px;height:54px}.brand h1{display:inline-block;position:relative;top:12px;width:146px;font-size:32px;line-height:25px;margin:12px 0}.brand span{font-size:32px}.brand strong{display:block;font-size:14px;line-height:25px}.search{position:absolute;top:96px;width:390px;height:44px;background:white}.links{margin-top:80px}</style><div class="portal"><div class="brand"><img src="data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' width='57' height='54'%3E%3Crect width='57' height='54' fill='blue'/%3E%3C/svg%3E"><h1><span>Wiktionary</span><strong>Free dictionary</strong></h1></div><nav class="links">Language links</nav><div class="search"><input placeholder="Search"><button>Search</button></div></div>`,{width:390,height:600},'.brand span{font-size:35.2px!important;line-height:1.6!important;letter-spacing:.02em!important}.brand strong{font-size:15.4px!important;line-height:1.6!important}');
 const result=await page.evaluate(()=>{let title=document.querySelector('h1').getBoundingClientRect(),img=document.querySelector('img').getBoundingClientRect(),search=document.querySelector('.search').getBoundingClientRect();return{title: title.toJSON(),img:img.toJSON(),search:search.toJSON()}});
 assert.ok(result.title.top<result.img.bottom);assert.ok(result.search.top>=result.title.bottom-1);
 await page.close();
});

test("masked visual specimens gain reversible keyboard scrolling while menus keep their masks",async()=>{
 const page=await prepare(`<style>body{font:16px sans-serif;margin:16px}.specimen,.menu{width:250px;height:100px;overflow:hidden}.scene{width:500px;display:flex;justify-content:space-between}.scene span:first-child{margin-left:150px}span{font-size:16px}.menu{height:0}.scene img{width:100px;height:80px}</style><div class="specimen"><div class="scene"><span>Lakefront cottages</span><span>6.4x</span></div></div><nav class="menu"><span>Closed menu</span></nav>`);
 const result=await page.evaluate(()=>{let s=document.querySelector('.specimen'),n=document.querySelector('nav');let css=getComputedStyle(s);s.scrollLeft=1000;return{overflow:css.overflowX,tab:s.tabIndex,scroll:s.scrollLeft,closed:n.clientHeight}});
 assert.equal(result.overflow,'auto');assert.equal(result.tab,0);assert.ok(result.scroll>0);assert.equal(result.closed,0);
 assert.equal(await page.evaluate(()=>{layout.restore();return document.querySelector('.specimen').getAttribute('tabindex')}),null);
 await page.close();
});

test("wide absolute decorative art retains its size and gains the headline's extra vertical space",async()=>{
 const page=await prepare(`<style>body{font:16px/1.1 sans-serif;margin:0}.hero{position:relative;width:390px;height:300px}.hero img{position:absolute;top:40px;width:390px;height:220px}.content{position:absolute;top:20px;width:220px}h1{font-size:24px;margin:0}a{display:block;margin-top:20px}</style><div class="hero"><div class="content"><h1>Web development for everyone</h1><a href="#">Get started</a></div><picture style="display:contents"><img src="data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' width='390' height='220'%3E%3Crect width='390' height='220' fill='red'/%3E%3C/svg%3E"></picture></div>`,{width:390,height:600},'h1{font-size:36px!important;line-height:1.6!important}a{font-size:24px!important;line-height:1.6!important}');
 const result=await page.evaluate(()=>{let art=document.querySelector('img'),h=document.querySelector('.hero');return{art:art.getBoundingClientRect().toJSON(),height:h.clientHeight,marker:art.getAttribute('data-lexend-layout-repair')}});
 assert.equal(result.art.width,390);assert.equal(result.art.height,220);assert.ok(result.art.top>40);assert.ok(result.height>300);assert.match(result.marker,/art-spacing/);
 await page.close();
});

test("boxless semantic headings do not abort subsequent large-word repairs",async()=>{
 const page=await prepare(`<style>body{font:16px sans-serif;margin:16px}h1{display:contents}h1 span{font-size:20px}p{font-size:42px;width:200px;margin:0;overflow-wrap:anywhere}</style><h1><span>Accessible interface</span></h1><p>Independent</p>`,{width:390,height:600},'h1 span{font-size:24px!important;line-height:1.6!important}p{font-size:48px!important;line-height:1.6!important}');
 const result=await page.evaluate(()=>({marker:document.querySelector('p').getAttribute('data-lexend-layout-repair'),size:parseFloat(getComputedStyle(document.querySelector('p')).fontSize)}));
 assert.match(result.marker,/fit-heading/);assert.ok(result.size>=24&&result.size<=48);
 await page.close();
});

test("bottom-aligned image captions retain their padding and nested photographs gain contrast",async()=>{
 const page=await prepare(`<style>body{font:16px/1.1 sans-serif;margin:16px}.card{position:relative;display:flex;flex-direction:column;justify-content:end;width:300px;height:180px;overflow:hidden}.media{position:absolute;top:0;left:0;width:100%;aspect-ratio:5/3}.media img{position:absolute;width:100%;height:100%}.caption{position:relative;padding:20px;color:white}h3,p{margin:0}h3{font-size:20px}p{font-size:16px}</style><a class="card"><div class="media"><div><img src="data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' width='300' height='180'%3E%3Crect width='300' height='180' fill='pink'/%3E%3C/svg%3E"></div></div><section class="caption"><h3><span>New research makes scientific discoveries easier to understand</span></h3><p>Research authors and their university</p></section></a>`,{width:390,height:600},'h3 span{font-size:28px!important;line-height:1.6!important}p{font-size:20px!important;line-height:1.6!important}');
 const result=await page.evaluate(()=>{let card=document.querySelector('.card').getBoundingClientRect(),caption=document.querySelector('.caption').getBoundingClientRect(),span=document.querySelector('h3 span');return{card:card.toJSON(),caption:caption.toJSON(),backdrop:getComputedStyle(span).backgroundColor,marker:span.getAttribute('data-lexend-layout-repair'),image:document.querySelector('img').getBoundingClientRect().height}});
 assert.ok(result.caption.top>=result.card.top-1);assert.ok(result.caption.bottom<=result.card.bottom+1);assert.ok(result.card.height>180);assert.ok(result.image>=result.card.height-1);assert.match(result.marker,/overlay-contrast/);assert.match(result.backdrop,/15, 23, 42/);
 assert.equal(await page.evaluate(()=>{layout.restore();return document.querySelector('.card').getAttribute('style')}),null);
 await page.close();
});

test("separate terminal actions stay initially visible inside a bounded fixed panel",async()=>{
 const page=await prepare(`<style>body{margin:0;font:16px/1.1 sans-serif}.panel{position:fixed;bottom:0;width:100%;padding:18px;box-sizing:border-box}.surface{background:#5c6f7c}p{margin:0 0 12px}.actions{display:flex;gap:8px}button{font-size:16px;padding:10px}</style><div class="panel"><div class="surface"><p>We use optional storage for preferences and measurement. Read the privacy information before choosing an action.</p><div class="actions"><button>Reject optional storage</button><button>Accept optional storage</button></div></div></div>`,{width:390,height:600},'p,button{font-size:24px!important;line-height:1.6!important}');
 const result=await page.evaluate(()=>{let panel=document.querySelector('.panel'),actions=document.querySelector('.actions');return{height:panel.clientHeight,scroll:panel.scrollHeight,actions:actions.getBoundingClientRect().toJSON(),sticky:getComputedStyle(actions).position,background:getComputedStyle(actions).backgroundColor,marker:actions.getAttribute('data-lexend-layout-repair')}});
 assert.ok(result.scroll>result.height);assert.ok(result.actions.bottom<=600+1);assert.ok(result.actions.top>=600-result.height-1);assert.equal(result.sticky,'sticky');assert.match(result.marker,/panel-actions/);
 assert.equal(result.background,'rgb(92, 111, 124)');
 const copyReachable=await page.evaluate(()=>{const panel=document.querySelector('.panel');panel.scrollTop=panel.scrollHeight;const copy=document.querySelector('p').getBoundingClientRect(),actions=document.querySelector('.actions').getBoundingClientRect();return copy.bottom<=actions.top+1});assert.ok(copyReachable);
 await page.locator('button').first().focus();
 const restored=await page.evaluate(()=>{layout.restore();return document.querySelector('.actions').getAttribute('style')});assert.equal(restored,null);
 await page.close();
});


test("existing overflowing table surfaces are keyboard reachable and restore author attributes",async()=>{
 const page=await prepare(`<style>body{margin:16px;font:16px sans-serif}table{display:block;overflow-x:auto;width:250px}td{min-width:200px}</style><table><tr><td>First column</td><td>Second column</td></tr></table>`);
 assert.deepEqual(await page.evaluate(()=>{let t=document.querySelector('table');return[t.tabIndex,t.getAttribute('role'),t.getAttribute('aria-label')]}),[0,'region','Scrollable table']);
 assert.equal(await page.evaluate(()=>{layout.restore();return document.querySelector('table').getAttribute('tabindex')}),null);
 await page.close();
});

test("small embedded announcements report measured height without resize oscillation",async()=>{
 const page=await browser.newPage({viewport:{width:390,height:600}});await page.setContent('<iframe style="width:360px;height:30px;border:0" srcdoc=""></iframe>');const frame=page.frames()[1];await frame.setContent('<style>body{margin:0;font:14px/1 sans-serif}p{margin:0}</style><p>Bonus learning resources for every developer</p>');await frame.addScriptTag({content:source});await frame.evaluate(()=>{window.layout=LexendLayout.create();layout.capture();document.querySelector('p').style.cssText='font-size:24px;line-height:1.6';layout.repair()});
 const request=await frame.evaluate(()=>layout.getFrameRequirement(30));assert.ok(request.requiredHeight>30&&request.requiredHeight<=120);await page.locator('iframe').evaluate((f,h)=>f.style.height=h+'px',request.requiredHeight);
 const afterResize=await frame.evaluate(()=>layout.getFrameRequirement(30));assert.equal(afterResize.viewportHeight,30);assert.equal(afterResize.requiredHeight,request.requiredHeight);
 await page.close();
});


test("relaxing a flex text row does not erase an intrinsic photographic column",async()=>{
 const page=await prepare(`<style>body{margin:16px;font:16px sans-serif}.row{display:flex;flex-wrap:wrap;width:300px}.media,.copy{flex:1 1 0;min-width:300px}.media{position:relative;height:180px}.media img{width:100%;height:100%}.media span{position:absolute;top:0;left:0}.copy{height:100px}</style><div class="row"><div class="media"><img src="data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' width='300' height='180'%3E%3Crect width='300' height='180' fill='red'/%3E%3C/svg%3E"><span>Photography</span></div><div class="copy"><p>A readable explanation</p></div></div>`,{width:390,height:600},'.media{min-width:0!important}p,span{font-size:24px!important;line-height:1.6!important}');
 const result=await page.evaluate(()=>({width:document.querySelector('img').getBoundingClientRect().width,marker:document.querySelector('.media').getAttribute('data-lexend-layout-repair'),html:document.querySelector('.row').outerHTML}));assert.ok(result.width>=295,JSON.stringify(result));assert.match(result.marker,/media-footprint/);await page.close();
});

test("decorative quote borders grow around enlarged positioned prose",async()=>{
 const page=await prepare(`<style>body{margin:16px;font:16px/1.1 sans-serif}.viewport{position:relative;height:120px;width:300px}.zero{width:0;height:0}.quote{position:absolute;top:20px;left:20px;width:240px}.border{position:absolute;top:0;left:0;width:298px;height:118px;border:1px solid;border-radius:10px}p{margin:0}</style><div class="viewport"><div class="zero"><div class="quote"><p>A quotation shares a valuable explanation for people reading this interface.</p></div><div class="border"></div></div></div>`);
 const result=await page.evaluate(()=>({text:document.querySelector('p').getBoundingClientRect().bottom,border:document.querySelector('.border').getBoundingClientRect().bottom,marker:document.querySelector('.border').getAttribute('data-lexend-layout-repair')}));assert.ok(result.border>=result.text);assert.match(result.marker,/border-backdrop/);assert.equal(await page.evaluate(()=>{layout.restore();return document.querySelector('.border').getAttribute('style')}),null);await page.close();
});

test("a fixed promotion in a zero-height portal cannot create blank flow space", async () => {
  const page = await prepare(`<style>body{margin:0;font:16px Arial}.portal{height:0}.promotion{position:fixed;bottom:12px;right:12px;width:240px;height:110px;background:white}.promotion p{margin:12px}.search{height:50px;background:#ccc}main{height:1800px}p{margin:0}</style><div class="portal"><aside class="promotion"><p>A complete explanation of an optional browser update.</p><button>Download browser</button></aside></div><header class="search"><input placeholder="Search the web"></header><main><p>Actual page content</p></main>`);
  const state = () => page.evaluate(() => ({ portal:document.querySelector('.portal').getBoundingClientRect().height, search:document.querySelector('.search').getBoundingClientRect().top, total:document.documentElement.scrollHeight }));
  const first = await state();
  assert.equal(first.portal, 0); assert.equal(first.search, 0);
  await page.evaluate(() => { scrollTo(0, 900); for (let i=0; i<8; i++) layout.repair(); scrollTo(0,0); });
  const repeated = await state();
  assert.equal(repeated.portal, 0); assert.equal(repeated.search, 0); assert.equal(repeated.total, first.total);
  await page.close();
});

test("a fixed consent panel growing above the viewport keeps its horizontal transform and reachable actions", async () => {
  const page=await prepare(`<style>body{margin:0;font:16px Arial}.panel{position:fixed;top:50%;left:50%;transform:translate(-50%,-50%);width:340px;max-height:260px;background:#eee;overflow:hidden;padding:12px;box-sizing:border-box}p{margin:0}button{margin:12px 0}</style><section class="panel" role="dialog"><p>A disclosure with enough explanatory text to require scrolling after typography grows. This explains the available privacy choices and remains readable without removing the site's centering transform. The full explanation must be available within the panel.</p><button>Reject optional storage</button></section>`,{width:390,height:300},'p,button{font-size:30px!important;line-height:1.6!important}');
  const state=await page.evaluate(()=>{const panel=document.querySelector('.panel');panel.scrollTop=panel.scrollHeight;const p=panel.getBoundingClientRect(),b=panel.querySelector('button').getBoundingClientRect();return {left:p.left,right:p.right,top:p.top,bottom:p.bottom,transform:getComputedStyle(panel).transform,buttonTop:b.top,buttonBottom:b.bottom,overflow:getComputedStyle(panel).overflowY};});
  assert.ok(state.left>=0&&state.right<=390,JSON.stringify(state));assert.ok(state.top>=-2&&state.bottom<=302,JSON.stringify(state));assert.notEqual(state.transform,'none');assert.equal(state.overflow,'auto');assert.ok(state.buttonTop>=state.top&&state.buttonBottom<=state.bottom+2,JSON.stringify(state));
  await page.evaluate(()=>layout.restore());assert.equal(await page.evaluate(()=>document.querySelector('.panel').getAttribute('style')),null);await page.close();
});

test("repeated art-spacing repairs use the authored offsets rather than accumulating growth", async () => {
  const page=await prepare(`<style>body{margin:0;font:16px Arial}.hero{position:relative;width:360px;height:300px}.hero img{position:absolute;top:100px;left:0;width:360px;height:140px}.copy{position:absolute;top:0;left:0;width:260px}h1{font-size:24px;margin:0}p{margin:0}</style><section class="hero"><img src="data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' width='360' height='140'%3E%3Crect width='360' height='140' fill='blue'/%3E%3C/svg%3E"><div class="copy"><h1>A readable heading across two lines</h1><p>More useful detail</p></div></section>`,{width:390,height:600},'h1{font-size:30px!important;line-height:1.6!important}p{font-size:18px!important;line-height:1.6!important}');
  const before=await page.evaluate(()=>({top:document.querySelector('img').style.top,height:document.querySelector('.hero').style.height}));
  assert.ok(before.top,JSON.stringify(before));
  await page.evaluate(()=>{for(let i=0;i<5;i++)layout.repair()});
  assert.deepEqual(await page.evaluate(()=>({top:document.querySelector('img').style.top,height:document.querySelector('.hero').style.height})),before);
  await page.close();
});

test("a translated label ticker keeps only its active frame visible after typography growth", async () => {
  const page=await prepare(`<style>body{font:16px Arial;margin:16px}.mask{height:52px;width:180px;overflow:hidden}.track{display:flex;flex-direction:column;transform:translateY(-90px);width:max-content}.track>span{font-size:30px;line-height:30px}.track>.active{font-size:60px;line-height:52px}.details{margin:8px 0}</style><div class="mask"><span class="track"><span>Now</span><span>20</span><span>25</span><span class="active"><span>31°C</span></span></span></div><p class="details">Current conditions remain below the display.</p>`,{width:390,height:600},'.track>span{font-size:33px!important;line-height:1.6!important}.track>.active,.active>span{font-size:66px!important;line-height:1.6!important}');
  const state=()=>page.evaluate(()=>{const mask=document.querySelector('.mask'),track=document.querySelector('.track'),active=document.querySelector('.active'),m=mask.getBoundingClientRect(),a=active.getBoundingClientRect();return {mask:m.toJSON(),active:a.toJSON(),previous:[...track.children].slice(0,-1).map(e=>e.getBoundingClientRect().bottom),transform:getComputedStyle(track).transform,overflow:getComputedStyle(mask).overflowY,details:document.querySelector('.details').getBoundingClientRect().top};});
  const first=await state();
  assert.equal(first.overflow,'hidden');assert.ok(Math.abs(first.active.top-first.mask.top)<1,JSON.stringify(first));assert.ok(first.active.bottom<=first.mask.bottom+1,JSON.stringify(first));assert.ok(first.previous.every(bottom=>bottom<=first.mask.top+1),JSON.stringify(first));assert.ok(first.mask.height<110,JSON.stringify(first));assert.ok(first.details>=first.mask.bottom);
  await page.evaluate(()=>{for(let i=0;i<6;i++)layout.repair()});assert.deepEqual(await state(),first);
  await page.evaluate(()=>layout.restore());assert.equal(await page.evaluate(()=>document.querySelector('.mask').getAttribute('style')),null);assert.equal(await page.evaluate(()=>document.querySelector('.track').getAttribute('style')),null);
  await page.close();
});

test("translated multi-line specimens remain distinct from a single-frame label ticker", async () => {
  const page=await prepare(`<style>body{font:16px Arial;margin:16px}.mask{width:300px;height:150px;overflow:hidden}.scene{transform:translateY(-18px);padding:20px}.scene p{margin:0 0 12px}</style><div class="mask"><div class="scene"><p>A partly visible explanation in an authored visual composition.</p><p>A second complete paragraph is meaningful content rather than a hidden animation frame.</p></div></div>`);
  assert.equal(await page.evaluate(()=>document.querySelector('.mask').getAttribute('data-lexend-layout-repair')?.includes('active-ticker-frame')??false),false);
  assert.equal(await page.evaluate(()=>getComputedStyle(document.querySelector('.scene')).transform),'matrix(1, 0, 0, 1, 0, -18)');await page.close();
});

test("far-offscreen focus links cannot inflate a sticky header and remain usable when revealed", async () => {
  const page=await prepare(`<style>body{font:16px Arial;margin:0}.shell{display:grid;grid-template-rows:64px 1fr}header{position:sticky;top:0;height:64px;display:flex;align-items:center;background:white}.skip{position:absolute;left:-10000px;top:0;width:8px;height:8px;white-space:nowrap}.skip:focus{left:8px;width:auto;height:auto}button{margin-left:170px}main{height:1000px}</style><div class="shell"><header><a class="skip" href="#main">Skip to the main content</a><a class="skip" href="#main">Skip to the sidebar</a><button>Search</button></header><main id="main"><p>The page content begins directly below its header.</p></main></div>`);
  assert.equal(await page.evaluate(()=>document.querySelector('header').getBoundingClientRect().height),64);
  assert.deepEqual(await page.evaluate(()=>[...document.querySelectorAll('.skip')].map(e=>e.getAttribute('style'))),[null,null]);
  await page.locator('.skip').first().focus();await page.evaluate(()=>{layout.capture();layout.repair()});
  assert.ok(await page.evaluate(()=>document.querySelector('.skip').getBoundingClientRect().left>=0));assert.equal(await page.evaluate(()=>document.activeElement===document.querySelector('.skip')),true);await page.close();
});

test("an out-of-flow popup expands its explanation without pushing its anchor navigation", async () => {
  const page=await prepare(`<style>body{font:16px Arial;margin:0}header{position:relative;height:60px;width:360px;background:#ddd}button{height:40px}.popup{position:absolute;top:50px;left:0;width:230px;height:90px;overflow:hidden;background:white}.popup p{margin:8px}nav{height:40px}main{height:500px}</style><header><button>Delivery location</button><aside class="popup"><p>A complete explanation about choosing a delivery location for these purchases.</p></aside></header><nav>Browse categories</nav><main></main>`);
  const state=await page.evaluate(()=>{const h=document.querySelector('header'),n=document.querySelector('nav'),p=document.querySelector('.popup'),r=document.createRange();r.selectNodeContents(p.querySelector('p'));return {header:h.getBoundingClientRect().height,nav:n.getBoundingClientRect().top,popup:p.getBoundingClientRect().toJSON(),text:r.getBoundingClientRect().toJSON()}});
  assert.equal(state.header,60,JSON.stringify(state));assert.equal(state.nav,60);assert.ok(state.popup.bottom>=state.text.bottom-2,JSON.stringify(state));await page.close();
});

test("identity-transformed consent wrappers grow within a bounded panel and keep both choices visible", async () => {
  const page=await prepare(`<style>body{font:16px Arial;margin:0}.outer{position:fixed;top:0;width:100%;height:96px;overflow:hidden;background:white}.inner{position:absolute;inset:0;overflow:hidden;transform:translateY(0)}.body{padding:8px}.body p{margin:0}.actions{margin-top:8px}button{height:32px;overflow:hidden}</style><aside class="outer"><div class="inner"><div class="body"><p>A privacy explanation with optional settings and choices.</p><div class="actions"><button>Accept</button><button>Reject</button></div></div></div></aside>`,{width:390,height:600},'p,button{font-size:24px!important;line-height:1.6!important}');
  const state=await page.evaluate(()=>{const panel=document.querySelector('.outer'),p=panel.getBoundingClientRect();return {panel:p.toJSON(),buttons:[...panel.querySelectorAll('button')].map(e=>e.getBoundingClientRect().toJSON()),transform:getComputedStyle(document.querySelector('.inner')).transform,overflow:getComputedStyle(panel).overflowY}});
  assert.ok(state.panel.height<=300);assert.ok(state.buttons.every(b=>b.top>=state.panel.top&&b.bottom<=state.panel.bottom+2),JSON.stringify(state));assert.equal(state.transform,'matrix(1, 0, 0, 1, 0, 0)');await page.evaluate(()=>layout.restore());assert.equal(await page.evaluate(()=>document.querySelector('.outer').getAttribute('style')),null);await page.close();
});

test("measured caption growth retains authored content-box padding without counting it twice", async () => {
  const page=await prepare(`<style>body{font:16px Arial;margin:0}.header{position:relative;width:360px;height:156px;padding:52px 0 8px}.art{position:absolute;inset:0;width:360px;height:215px}.nav{position:relative;margin:68px auto 0;width:340px}.nav span{display:block;font-size:16px;line-height:20px}</style><header class="header"><img class="art" src="data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' width='360' height='215'%3E%3Crect width='360' height='215' fill='white'/%3E%3C/svg%3E"><nav class="nav"><span>Readable service links</span></nav></header>`,{width:390,height:600},'.nav span{font-size:24px!important;line-height:1.6!important}');
  const state=()=>page.evaluate(()=>{const h=document.querySelector('.header'),css=getComputedStyle(h);return {height:h.getBoundingClientRect().height,paddingTop:css.paddingTop,paddingBottom:css.paddingBottom,min:css.minHeight,nav:document.querySelector('.nav').getBoundingClientRect().top}});
  const first=await state();assert.ok(first.height>=234&&first.height<=237,JSON.stringify(first));assert.equal(first.paddingTop,'52px');assert.equal(first.paddingBottom,'8px');assert.equal(first.nav,120);
  await page.evaluate(()=>{for(let i=0;i<5;i++)layout.repair()});assert.deepEqual(await state(),first);await page.close();
});

test("severe text contrast is repaired only on established solid surfaces and restores", async () => {
  const page=await prepare(`<style>body{background:white;font:16px Arial}.plain{background:white;color:#fff}.dark{background:#111;color:#222}.disabled{background:white;color:#eee}.gradient{background:linear-gradient(white,#eee);color:#eee}.photo{background-image:url("data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg'/%3E");color:#eee}.fade{opacity:.4}.fade span{background:white;color:#eee}.alpha{background:rgba(255,255,255,.5);color:#eee}</style><p class="plain">A visible model selector</p><p class="dark">Readable dark surface text</p><button class="disabled" disabled>Unavailable option</button><p class="gradient">Gradient artwork</p><p class="photo">Photographic caption</p><div class="fade"><span>Transitioning caption</span></div><p class="alpha">Composited caption</p>`);
  const state=await page.evaluate(()=>Object.fromEntries(['plain','dark','disabled','gradient','photo','alpha'].map(c=>{let e=document.querySelector('.'+c);return[c,{color:getComputedStyle(e).color,repair:e.getAttribute('data-lexend-layout-repair')??''}]})));
  assert.equal(state.plain.color,'rgb(0, 0, 0)');assert.equal(state.dark.color,'rgb(255, 255, 255)');for(const c of ['disabled','gradient','photo','alpha'])assert.ok(!state[c].repair.includes('solid-text-contrast'),JSON.stringify(state));assert.equal(await page.evaluate(()=>document.querySelector('.fade span').getAttribute('data-lexend-layout-repair')?.includes('solid-text-contrast')??false),false);
  await page.evaluate(()=>layout.restore());assert.equal(await page.evaluate(()=>getComputedStyle(document.querySelector('.plain')).color),'rgb(255, 255, 255)');assert.equal(await page.evaluate(()=>document.querySelector('.plain').getAttribute('style')),null);await page.close();
});

test("solid pseudo artwork is excluded from inferred text contrast repair", async () => {
  const page=await prepare(`<style>body{background:white;font:16px Arial}.label{position:relative;isolation:isolate;color:white}.label::before{content:"";position:absolute;inset:0;background:#146abb;z-index:-1}.parent{position:relative;isolation:isolate}.parent::after{content:"";position:absolute;inset:0;background:#146abb;z-index:-1}.parent span{color:white;background:white}</style><p class="label">White lettering on blue pseudo artwork</p><div class="parent"><span>Layered label with an opaque child</span></div>`);
  const colors=await page.evaluate(()=>[document.querySelector('.label'),document.querySelector('.parent span')].map(e=>({color:getComputedStyle(e).color,repair:e.getAttribute('data-lexend-layout-repair')??''})));
  for(const state of colors){assert.equal(state.color,'rgb(255, 255, 255)');assert.ok(!state.repair.includes('solid-text-contrast'),JSON.stringify(colors));}
  await page.close();
});

test("nested alert choices settle through rapid refreshes without replaying owned height transitions", async () => {
  const page=await prepare(`<style>body{font:16px/24px Arial;margin:0}.alert{position:fixed;top:0;width:100%;height:192px;overflow:hidden;transition:all .334s cubic-bezier(0,0,.2,1),opacity .7s ease-in .1s}.wrapper{position:absolute;top:0;width:100%;height:192px;display:flex;justify-content:center;overflow:hidden;transform:translateY(0);background:#5c6f7c}.copy{position:relative;padding:16px;width:780px}.copy h2{font-size:16px;margin:0 0 8px;color:white}.copy p{margin:0 0 8px;color:white}.actions{padding-top:16px}.actions button{font:16px/20px Arial;min-height:32px;padding:6px 12px;background:white;color:#5c6f7c;border:0;overflow:hidden}</style><aside class="alert" role="alert"><div class="wrapper"><section class="copy"><h2>Privacy choices</h2><p>Essential and optional cookies provide, secure, analyze and improve services and show relevant advertisements.</p><p>Select either choice to manage cookies. Choices can be updated at any time in your privacy settings.</p><div class="actions"><button>Accept</button><button>Reject</button></div></section></div></aside>`,{width:900,height:600},'.copy h2,.copy p,.actions button{font-size:24px!important;line-height:1.6!important;letter-spacing:.02em!important}');
  const states=await page.evaluate(async()=>{const result=[];for(let i=0;i<8;i++){if(i){layout.capture();layout.repair();}const p=document.querySelector('.alert'),css=getComputedStyle(p),b=p.getBoundingClientRect();result.push({height:b.height,buttons:[...p.querySelectorAll('button')].map(e=>({top:e.getBoundingClientRect().top,bottom:e.getBoundingClientRect().bottom})),background:getComputedStyle(document.querySelector('.actions')).backgroundColor,properties:css.transitionProperty,durations:css.transitionDuration,delays:css.transitionDelay,timing:css.transitionTimingFunction});await new Promise(r=>setTimeout(r,20));}return result;});
  for(const state of states){assert.ok(state.buttons.every(b=>b.top>=0&&b.bottom<=state.height+2),JSON.stringify(states));assert.ok(['rgb(92, 111, 124)','rgba(0, 0, 0, 0)'].includes(state.background));assert.match(state.properties,/all, opacity, height/);assert.match(state.durations,/0\.334s, 0\.7s, 0s/);assert.match(state.delays,/0s, 0\.1s, 0s/);assert.match(state.timing,/cubic-bezier\(0, 0, 0\.2, 1\), ease-in, linear/);}
  assert.ok(Math.max(...states.map(s=>s.height))-Math.min(...states.map(s=>s.height))<=1,JSON.stringify(states));
  await page.evaluate(()=>layout.restore());const restored=await page.evaluate(()=>{const p=document.querySelector('.alert');return {style:p.getAttribute('style'),properties:getComputedStyle(p).transitionProperty,durations:getComputedStyle(p).transitionDuration,actions:document.querySelector('.actions').getAttribute('style')};});assert.equal(restored.style,null);assert.equal(restored.actions,null);assert.equal(restored.properties,'all, opacity');assert.equal(restored.durations,'0.334s, 0.7s');await page.close();
});

test("full-cover empty overlays cannot reflow the columns owning a native viewport scroller", async () => {
  const page=await prepare(`<style>body{margin:0;overflow:hidden;font:16px/20px Arial}.shell{position:relative;display:flex;flex-direction:row;width:390px;height:600px;overflow:hidden}.rail{width:50px;flex-shrink:0}.main{width:340px;height:600px;overflow:hidden}.scroll{height:100%;overflow-y:auto}.copy{min-height:590px}.cover{position:absolute;inset:0;pointer-events:none}p{margin:0}a{display:block;width:100px}.last{margin-top:570px}</style><div class="shell"><aside class="rail"><p>Rail</p></aside><main class="main"><div class="scroll" tabindex="0"><section class="copy"><p>Browse readable categories</p><a class="last" href="#native">Music and DJs</a></section></div></main><div class="cover"><canvas width="390" height="600"></canvas></div></div>`,{width:390,height:600},'p,a{font-size:26.4px!important;line-height:1.6!important;letter-spacing:.02em!important}');
  const first=await page.evaluate(()=>{const e=document.querySelector('.scroll'),m=document.querySelector('main');return {main:m.getBoundingClientRect().toJSON(),client:e.clientHeight,scroll:e.scrollHeight,wrap:getComputedStyle(document.querySelector('.shell')).flexWrap,cover:getComputedStyle(document.querySelector('.cover')).position};});assert.equal(first.main.left,50);assert.equal(first.main.top,0);assert.equal(first.client,600);assert.ok(first.scroll>600);assert.equal(first.wrap,'nowrap');assert.equal(first.cover,'absolute');
  await page.locator('.scroll').focus();await page.keyboard.press('End');await page.waitForFunction(()=>{const e=document.querySelector('.scroll');return e.scrollTop>=e.scrollHeight-e.clientHeight-1},null,{timeout:2000});const end=await page.evaluate(()=>{const e=document.querySelector('.scroll'),a=document.querySelector('.last').getBoundingClientRect();return {scrollTop:e.scrollTop,top:a.top,bottom:a.bottom};});assert.ok(end.scrollTop>0);assert.ok(end.top>=0&&end.bottom<=600+2,JSON.stringify(end));
  await page.evaluate(()=>{for(let i=0;i<5;i++){layout.capture();layout.repair();}});assert.equal(await page.evaluate(()=>document.querySelector('.scroll').clientHeight),600);await page.close();
});

test("viewport-fixed text survives deep scroll recapture while transformed and hidden clips remain hidden", async () => {
  const page=await prepare(`<style>body{margin:0;font:16px Arial}.clip{height:100px;overflow:hidden}.fixed{position:fixed;top:20px;left:20px;max-height:18px;overflow:hidden}.fixed p{margin:0}.transformed{transform:translateY(0);height:100px;overflow:hidden}.transformed .fixed{top:180px}.hidden{visibility:hidden}.space{height:2400px}</style><div class="clip"><aside class="fixed"><p>Visible fixed choice</p></aside></div><div class="transformed"><aside class="fixed"><p>Clipped inside transformed block</p></aside></div><div class="hidden"><aside class="fixed"><p>Hidden authored label</p></aside></div><div class="space"></div>`,{width:390,height:600},'.fixed p{font-size:26.4px!important;line-height:1.6!important}');
  const state=await page.evaluate(()=>{globalThis.LexendControls={repair({baseline,snapshot}){window.collected=['.clip p','.transformed p','.hidden p'].map(selector=>{const e=document.querySelector(selector);return {baseline:baseline.has(e),visible:Boolean(snapshot(e))}})}};scrollTo(0,1700);layout.capture();layout.repair();return window.collected;});
  assert.deepEqual(state,[{baseline:true,visible:true},{baseline:false,visible:false},{baseline:false,visible:false}]);await page.close();
});

test("zero-height fixed portals retain painted dialog controls while a closed clipping portal stays hidden", async () => {
  const page=await prepare(`<style>body{margin:0;font:16px Arial}.portal{position:fixed;top:0;left:0;width:0;height:0;overflow:visible}.dialog{position:absolute;top:30px;left:10px;width:300px;padding:10px;background:white}.closed{overflow:hidden}</style><div class="portal"><div class="dialog" role="dialog"><p>Readable consent choices</p><button>Reject optional cookies</button></div></div><div class="portal closed"><div class="dialog"><p>Hidden closed panel</p></div></div>`);
  const captured=await page.evaluate(()=>{globalThis.LexendControls={repair({baseline,snapshot}){window.collected=[document.querySelector('.portal button'),document.querySelector('.closed p')].map(e=>({baseline:baseline.has(e),visible:Boolean(snapshot(e))}))}};layout.capture();layout.repair();return collected;});assert.deepEqual(captured,[{baseline:true,visible:true},{baseline:false,visible:false}]);await page.close();
});

test("a collision between caption rows cannot move unrelated positioned brand artwork into flow", async () => {
  const page=await prepare(`<style>body{font:16px Arial;margin:0}.header{position:relative;width:390px;height:160px;padding-top:52px;box-sizing:border-box}.brand{position:absolute;top:30px;left:10px;width:90px;height:60px}.copy{margin-left:140px;width:220px;position:relative;height:30px}.next{position:relative;margin-left:140px;width:220px;height:30px}p{margin:0;line-height:20px}</style><header class="header"><img class="brand" src="data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' width='90' height='60'%3E%3Crect width='90' height='60' fill='blue'/%3E%3C/svg%3E"><div class="copy"><p>Readable information beside the brand</p></div><div class="next"><p>Service navigation labels</p></div></header>`,{width:390,height:600},'p{font-size:24px!important;line-height:1.6!important}');
  const art=await page.evaluate(()=>{const e=document.querySelector('.brand');return {position:getComputedStyle(e).position,rect:e.getBoundingClientRect().toJSON(),repair:e.getAttribute('data-lexend-layout-repair')};});assert.equal(art.position,'absolute');assert.equal(art.rect.top,30);assert.equal(art.rect.width,90);assert.equal(art.rect.height,60);assert.equal(art.repair,null);await page.close();
});

test("a growing fixed banner keeps its measured empty flow reservation and choices unobscured", async () => {
  const page = await prepare(`<style>body{margin:0;font:16px/1.25 sans-serif}.banner{position:fixed;top:0;left:0;width:100%;height:128px;overflow:hidden;z-index:9;transition:all .334s;background:#526878}.inner{position:absolute;height:128px;inset:0;overflow:hidden;display:flex;padding:16px;box-sizing:border-box;transform:translateY(0)}.copy{flex:1}p{margin:0 0 8px}.actions{margin-top:8px}button{font:inherit;padding:6px}.reservation{position:relative;height:128px;transition:all .334s;visibility:hidden}.nav{position:relative;z-index:10;background:white;height:70px}</style><div class="banner"><div class="inner"><div class="copy"><p>Privacy information explains how essential cookies are used and how you can update the choices in your settings at any time.</p><div class="actions"><button>Accept</button><button>Reject</button></div></div></div></div><div class="reservation"></div><nav class="nav">Navigation</nav>`, {width:760,height:600}, 'p,button{font-size:24px!important;line-height:1.6!important;letter-spacing:.02em!important}');
  const measure = () => page.evaluate(() => {const b=document.querySelector('.banner').getBoundingClientRect(),r=document.querySelector('.reservation').getBoundingClientRect(),n=document.querySelector('.nav').getBoundingClientRect(),a=document.querySelector('button'),q=a.getBoundingClientRect();return {banner:b.height,reservation:r.height,nav:n.top,action:q.toJSON(),hit:document.elementFromPoint(q.x+q.width/2,q.y+q.height/2)===a};});
  const first=await measure();assert.ok(first.banner>128);assert.equal(first.reservation,first.banner);assert.equal(await page.evaluate(()=>getComputedStyle(document.querySelector('.reservation')).visibility),'hidden');assert.ok(first.nav>=first.banner);assert.equal(first.hit,true);
  for(let i=0;i<8;i++){await page.evaluate(()=>{layout.capture();layout.repair()});await page.waitForTimeout(20);const now=await measure();assert.equal(now.banner,first.banner);assert.equal(now.reservation,first.reservation);assert.equal(now.hit,true)}
  await page.evaluate(()=>layout.restore());assert.equal(await page.evaluate(()=>document.querySelector('.reservation').getAttribute('style')),null);assert.equal(await page.evaluate(()=>document.querySelector('.reservation').getBoundingClientRect().height),128);await page.close();
});

test("already layered full-width artwork remains behind growing search labels", async () => {
  const page = await prepare(`<style>body{margin:0;font:16px/1.2 sans-serif}.header{position:relative;width:760px;height:347px;padding-top:52px;box-sizing:border-box}.art{position:absolute;top:0;left:0;width:760px;height:215px;overflow:hidden}.art picture{position:absolute;transform:scale(.5);transform-origin:top left}.art img{width:574px;height:284px}.search{position:relative;margin-left:220px;width:500px;height:60px}.nav{position:relative;margin-top:12px;height:60px}span{display:block}button{font:inherit}</style><div class="header"><div class="art"><picture><img src="data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg'/%3E"></picture></div><div class="search"><span>A search explanation expands naturally when its letters become larger and more readable.</span><button>Search</button></div><div class="nav"><span>Services</span></div></div>`, {width:800,height:600}, 'span,button{font-size:24px!important;line-height:1.6!important;letter-spacing:.02em!important}');
  const state=await page.evaluate(()=>({art:getComputedStyle(document.querySelector('.art')).position,top:document.querySelector('.art').getBoundingClientRect().top,transform:getComputedStyle(document.querySelector('picture')).transform,nav:document.querySelector('.nav').getBoundingClientRect().top}));assert.equal(state.art,'absolute');assert.equal(state.top,0);assert.equal(state.transform,'matrix(0.5, 0, 0, 0.5, 0, 0)');assert.ok(state.nav<300);await page.close();
});

test("a native viewport shell retains the scroll range of its sidebar after prose growth", async () => {
 const labels=Array.from({length:12},(_,i)=>`<p>Channel ${i} caption about the current broadcast</p>`).join('');
 const page=await prepare(`<style>body{margin:0;overflow:hidden;font:16px/1.2 sans-serif}.shell{height:600px;display:flex;flex-direction:column}.notice{flex:none}p{margin:8px}.columns{display:flex;flex:1;min-height:0;overflow:hidden}.side{width:180px;height:100%;overflow:auto;flex:none}.main{flex:1;min-width:0;height:100%;overflow:auto}.feed{height:1300px}</style><div class="shell"><div class="notice"><p>A privacy notice explains the available choices and becomes taller with more readable typography.</p></div><div class="columns"><nav class="side" tabindex="0">${labels}</nav><main class="main"><div class="feed"><p>Main content</p></div></main></div></div>`,{width:760,height:600});
 const first=await page.evaluate(()=>({shell:document.querySelector('.shell').getBoundingClientRect().height,side:document.querySelector('.side').clientHeight,scroll:document.querySelector('.side').scrollHeight,style:document.querySelector('.shell').getAttribute('style')}));assert.equal(first.shell,600);assert.ok(first.scroll>first.side);assert.equal(first.style,null);
 await page.locator('.side').focus();await page.keyboard.press('End');await page.waitForFunction(()=>{let e=document.querySelector('.side');return e.scrollTop>=e.scrollHeight-e.clientHeight-1},null,{timeout:2000});assert.ok(await page.evaluate(()=>document.querySelector('.side p:last-child').getBoundingClientRect().bottom<=600));
 for(let i=0;i<4;i++){await page.evaluate(()=>{layout.capture();layout.repair()});assert.equal(await page.evaluate(()=>document.querySelector('.shell').getBoundingClientRect().height),600)}
 await page.evaluate(()=>layout.restore());assert.equal(await page.evaluate(()=>document.querySelector('.shell').getAttribute('style')),null);await page.close();
});

test("an originally whole Hangul token keeps its boundary only when every token fits the column", async () => {
 const page=await prepare(`<style>body{margin:0;font:17px/1.2 sans-serif}.copy{width:202px}p{margin:0;word-break:normal}.long{width:70px}</style><div class="copy"><p>브라우저를 업데이트하세요</p></div><div class="long"><p>업데이트하세요</p></div>`,{width:390,height:600},'p{font-size:18.7px!important;line-height:1.6!important;letter-spacing:.02em!important}');
 const state=await page.evaluate(()=>{let p=document.querySelector('.copy p'),n=p.firstChild,r=document.createRange();let start=n.textContent.indexOf('업데이트하세요');r.setStart(n,start);r.setEnd(n,n.length);return {word:getComputedStyle(p).wordBreak,font:getComputedStyle(p).fontSize,lines:new Set([...r.getClientRects()].map(b=>Math.round(b.top*2))).size,overflow:p.scrollWidth-p.clientWidth,longWord:getComputedStyle(document.querySelector('.long p')).wordBreak}});
 assert.equal(state.word,'keep-all');assert.equal(state.font,'18.7px');assert.equal(state.lines,1);assert.ok(state.overflow<=1);assert.equal(state.longWord,'normal');
 for(let i=0;i<4;i++){await page.evaluate(()=>{layout.capture();layout.repair()});assert.equal(await page.evaluate(()=>getComputedStyle(document.querySelector('.copy p')).wordBreak),'keep-all')}
 await page.evaluate(()=>layout.restore());assert.equal(await page.evaluate(()=>document.querySelector('.copy p').getAttribute('style')),null);await page.close();
});
