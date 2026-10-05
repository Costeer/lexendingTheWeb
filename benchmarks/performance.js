/* Browser-only fixture. Extension APIs are mocked; DOM, CSS and scheduling are real. */
const STYLE_ID = "lexend-the-web-styles";
const sources = Promise.all(["/src/settings.js", "/src/content.js", "/baseline/settings.js", "/baseline/content.js", "/src/shadow-detector.js"]
  .map(async (url) => (await fetch(url)).text()));
const sleep = (ms = 0) => new Promise((resolve) => setTimeout(resolve, ms));
const assert = (value, message) => { if (!value) throw new Error(message); };

async function createPage({ baseline = false, stored = {}, shared = true, rejectAdoption = false, markup = "", pendingSettings = false, detector = true } = {}) {
  const iframe = document.createElement("iframe");
  const ready = new Promise((resolve) => iframe.addEventListener("load", resolve, { once: true }));
  iframe.srcdoc = `<!doctype html><html><head><style>body { font-family: serif; } h1 { font-family: serif; } code, .icon { font-family: monospace; }</style></head><body>${markup}</body></html>`;
  document.querySelector("#frames").append(iframe);
  await ready;
  const win = iframe.contentWindow;
  const doc = win.document;
  const stats = { visits: 0, queries: 0, resolves: 0, fontUrls: 0, styleWrites: 0, sheetWrites: 0, cssCharacters: 0, notifications: 0, slices: 0, maxSliceVisits: 0, maxSliceMs: 0 };
  const observers = new Set();
  const scheduled = new Set();
  const nativeObserver = win.MutationObserver;
  win.MutationObserver = class extends nativeObserver {
    constructor(callback) {
      super(callback);
      observers.add(this);
    }
  };
  const nativeQuery = win.Element.prototype.querySelectorAll;
  win.Element.prototype.querySelectorAll = function (selector) {
    const result = nativeQuery.call(this, selector);
    stats.queries++;
    if (selector === "*") stats.visits += result.length;
    return result;
  };
  const nativeShadowQuery = win.ShadowRoot.prototype.querySelectorAll;
  win.ShadowRoot.prototype.querySelectorAll = function (selector) {
    const result = nativeShadowQuery.call(this, selector);
    stats.queries++;
    if (selector === "*") stats.visits += result.length;
    return result;
  };
  const nativeWalker = doc.createTreeWalker.bind(doc);
  doc.createTreeWalker = (...args) => {
    const walker = nativeWalker(...args);
    const nativeNext = walker.nextNode.bind(walker);
    walker.nextNode = () => {
      const node = nativeNext();
      if (node) stats.visits++;
      return node;
    };
    return walker;
  };
  const text = Object.getOwnPropertyDescriptor(win.Node.prototype, "textContent");
  Object.defineProperty(win.Node.prototype, "textContent", {
    ...text,
    set(value) {
      if (this.nodeName === "STYLE" && this.id === STYLE_ID) {
        stats.styleWrites++;
        stats.cssCharacters += value.length;
      }
      text.set.call(this, value);
    }
  });
  const nativeReplace = win.CSSStyleSheet.prototype.replaceSync;
  win.CSSStyleSheet.prototype.replaceSync = function (css) {
    stats.sheetWrites++;
    stats.cssCharacters += css.length;
    return nativeReplace.call(this, css);
  };
  if (!shared) win.CSSStyleSheet = undefined;
  if (rejectAdoption) {
    const adopted = Object.getOwnPropertyDescriptor(win.ShadowRoot.prototype, "adoptedStyleSheets");
    Object.defineProperty(win.ShadowRoot.prototype, "adoptedStyleSheets", {
      ...adopted, set() { throw new Error("Compartment cannot adopt this sheet"); }
    });
  }
  const nativeTimeout = win.setTimeout.bind(win);
  const nativeClear = win.clearTimeout.bind(win);
  function schedule(callback, delay) {
    let id;
    const run = () => {
      scheduled.delete(id);
      const before = stats.visits;
      const start = performance.now();
      callback();
      stats.slices++;
      stats.maxSliceVisits = Math.max(stats.maxSliceVisits, stats.visits - before);
      stats.maxSliceMs = Math.max(stats.maxSliceMs, performance.now() - start);
    };
    id = nativeTimeout(run, delay);
    scheduled.add(id);
    return id;
  }
  win.setTimeout = (callback, delay) => schedule(callback, delay);
  win.clearTimeout = (id) => { scheduled.delete(id); nativeClear(id); };
  let changeListener;
  let messageListener;
  let resolveStorage;
  win.chrome = {
    runtime: {
      getURL: (path) => { stats.fontUrls++; return `${location.origin}/${path}`; },
      sendMessage: async () => { stats.notifications++; },
      onMessage: { addListener: (listener) => { messageListener = listener; } }
    },
    storage: {
      sync: { get: () => pendingSettings ? new Promise((resolve) => { resolveStorage = resolve; }) : Promise.resolve(stored) },
      onChanged: { addListener: (listener) => { changeListener = listener; } }
    }
  };
  const source = await sources;
  win.eval(source[baseline ? 2 : 0]);
  const api = win.LexendSettings;
  win.LexendSettings = { ...api, resolveSite(...args) { stats.resolves++; return api.resolveSite(...args); } };
  const start = performance.now();
  win.eval(source[baseline ? 3 : 1]);
  if (!baseline && detector) win.eval(source[4]);
  const resetStats = () => { Object.keys(stats).forEach((key) => { stats[key] = 0; }); };
  const flush = async () => {
    const until = performance.now() + 15000;
    let settled = 0;
    do {
      await sleep(5);
      settled = scheduled.size ? 0 : settled + 1;
      if (performance.now() > until) throw new Error("Discovery did not settle within 15 seconds");
    } while (settled < 2);
    // Include synchronous style/layout work in the measured end point.
    doc.body.getBoundingClientRect();
  };
  if (!pendingSettings) await flush();
  const startupMs = performance.now() - start;
  return {
    win, doc, stats, scheduled, observers, startupMs, resetStats, flush,
    resolveStorage: (value) => resolveStorage(value),
    change: (changes, area = "sync") => changeListener(changes, area),
    state: () => { let state; messageListener({ type: "LEXEND_GET_STATE" }, {}, (value) => { state = value; }); return state; },
    close: () => { observers.forEach((observer) => observer.disconnect()); iframe.remove(); }
  };
}

function addComponents(page, count, parent = page.doc.body) {
  const roots = [];
  for (let i = 0; i < count; i++) {
    const host = page.doc.createElement("lexend-fixture");
    const shadow = host.attachShadow({ mode: "open" });
    shadow.innerHTML = "<p>Component body <strong>bold</strong></p><h1>Component heading</h1><code>const code = 1</code>";
    roots.push(shadow);
    parent.append(host);
  }
  return roots;
}

window.runBenchmarks = async ({ rounds = 3 } = {}) => {
  const results = [];
  // Warm both font/resource caches, then alternate which implementation runs first.
  for (let sample = 0; sample <= rounds; sample++) {
    for (const baseline of (sample % 2 ? [false, true] : [true, false])) {
      const stored = { siteRules: Array.from({ length: 70 }, (_, i) => ({ hostname: `site-${i}.example.com`, enabled: false })) };
      const page = await createPage({ baseline, stored });
      try {
        page.resetStats();
        let start = performance.now();
        const roots = addComponents(page, 300);
        await page.flush();
        const record = (scenario, start) => {
          if (sample) results.push({ sample, version: baseline ? "baseline" : "working", scenario, elapsedMs: +(performance.now() - start).toFixed(2), ...page.stats });
        };
        record("insert 300 components", start);
        page.resetStats();
        start = performance.now();
        page.change({ letterSpacing: { newValue: 0.04 } });
        await page.flush();
        record("update 300 components", start);
        page.resetStats();
        start = performance.now();
        const activeContainer = page.doc.createElement("div");
        page.doc.body.append(activeContainer);
        for (let i = 0; i < 1000; i++) {
          const child = page.doc.createElement("div");
          child.textContent = "Dynamic page content";
          activeContainer.append(child);
        }
        await page.flush();
        record("1000 overlapping insertions while active", start);
        page.change({ enabled: { newValue: false } });
        await page.flush();
        page.resetStats();
        start = performance.now();
        const container = page.doc.createElement("div");
        page.doc.body.append(container);
        // Overlapping insertion records: old code scans every growing subtree again.
        let current = container;
        for (let i = 0; i < 1000; i++) {
          const child = page.doc.createElement("div");
          child.textContent = "Dynamic page content";
          current.append(child);
          current = child;
        }
        await page.flush();
        record("1000 nested insertions while paused", start);
        page.resetStats();
        const candidates = Array.from({ length: 250 }, (_, i) => ({ hostname: `candidate-${i}.example.com`, enabled: false }));
        start = performance.now();
        for (let i = 0; i < 500; i++) page.win.LexendSettings.normalizeSettings({ siteRules: candidates });
        record("normalize 250 rule candidates 500 times", start);
        assert(roots.length === 300, "fixture component count");
      } finally { page.close(); }
    }
  }
  document.querySelector("#results").textContent = JSON.stringify(results, null, 2);
  return results;
};

window.runRegressionChecks = async () => {
  const checks = [];
  for (const mode of ["shared", "fallback", "rejected-adoption"]) {
    const page = await createPage({ shared: mode !== "fallback", rejectAdoption: mode === "rejected-adoption", markup: '<h1 id="heading">Heading</h1><p id="copy">Copy</p><code id="code">Code</code><div data-lexend-ignore><p id="ignored">Ignored</p></div><span class="icon" id="icon">Icon</span>' });
    try {
      const font = (id) => page.win.getComputedStyle(page.doc.getElementById(id)).fontFamily;
      assert(font("copy").includes("Lexend for the Web"), `${mode}: body styled`);
      assert(!font("heading").includes("Lexend for the Web"), `${mode}: heading excluded`);
      assert(!font("code").includes("Lexend for the Web"), `${mode}: code excluded`);
      assert(!font("ignored").includes("Lexend for the Web"), `${mode}: opt-out excluded`);
      assert(!font("icon").includes("Lexend for the Web"), `${mode}: icon excluded`);
      const editors = ["CodeMirror", "cm-editor"].map((className) => {
        const editor = page.doc.createElement("div");
        editor.className = className;
        editor.style.fontFamily = "monospace";
        editor.innerHTML = `<div class="${className === "CodeMirror" ? "CodeMirror-line" : "cm-line"}"><span>const source = 1;</span></div>`;
        page.doc.body.append(editor);
        assert(page.win.getComputedStyle(editor.querySelector("span")).fontFamily === "monospace", `${mode}: ${className} text excluded`);
        return editor;
      });
      const loadedFonts = await page.doc.fonts.load('16px "Lexend for the Web"');
      assert(loadedFonts.length > 0, `${mode}: bundled font actually loads`);
      const roots = addComponents(page, 600);
      let siteSheet;
      if (mode === "shared") {
        siteSheet = new page.win.CSSStyleSheet();
        siteSheet.replaceSync("p { color: rgb(1, 2, 3); }");
        roots[0].adoptedStyleSheets = [siteSheet];
      }
      await page.flush();
      const first = roots[0];
      const sheet = first.adoptedStyleSheets.at(-1);
      assert(page.win.getComputedStyle(first.querySelector("p")).fontFamily.includes("Lexend for the Web"), `${mode}: shadow styled`);
      if (mode === "shared") {
        assert(roots.every((root) => root.adoptedStyleSheets.at(-1) === sheet), `${mode}: one shared sheet`);
        assert(roots.every((root) => !root.getElementById(STYLE_ID)), `${mode}: no style copies`);
      } else {
        assert(roots.every((root) => root.getElementById(STYLE_ID)), `${mode}: style fallback`);
      }
      assert(page.stats.maxSliceVisits <= 250, `${mode}: scan slice is bounded`);
      page.resetStats();
      page.change({ theme: { newValue: "dark" } });
      page.change({ siteRules: { newValue: [{ hostname: "unrelated.example", enabled: false }] } });
      await page.flush();
      assert(page.stats.visits === 0 && page.stats.styleWrites === 0 && page.stats.sheetWrites === 0, `${mode}: unrelated settings cause no DOM work`);
      page.resetStats();
      page.change({ letterSpacing: { newValue: 0.08 }, scope: { newValue: "all" }, textScale: { newValue: 120 } });
      await page.flush();
      assert(page.stats.visits === 0, `${mode}: readability does not rescan`);
      assert(font("heading").includes("Lexend for the Web"), `${mode}: all scope includes headings`);
      assert(page.win.getComputedStyle(page.doc.documentElement).fontSize === "19.2px", `${mode}: scale applies to document`);
      assert(page.win.getComputedStyle(first.querySelector("p")).letterSpacing !== "normal", `${mode}: shadow updated`);
      first.append(...editors);
      await page.flush();
      for (const editor of editors) assert(page.win.getComputedStyle(editor.querySelector("span")).fontFamily === "monospace", `${mode}: shadow ${editor.className} text excluded in all scope`);
      // Nested roots must be found without recursive JS calls.
      const nested = addComponents(page, 1, first)[0];
      await page.flush();
      assert(page.win.getComputedStyle(nested.querySelector("p")).fontFamily.includes("Lexend for the Web"), `${mode}: nested shadow discovery`);
      const detached = roots.at(-1);
      detached.host.remove();
      await page.flush();
      assert(!detached.getElementById(STYLE_ID) && !detached.adoptedStyleSheets.includes(sheet), `${mode}: detached root cleaned`);
      page.change({ enabled: { newValue: false } });
      await page.flush();
      assert(!font("copy").includes("Lexend for the Web"), `${mode}: original font restored`);
      assert(!page.doc.getElementById(STYLE_ID), `${mode}: document style removed`);
      assert(!first.getElementById(STYLE_ID) && !first.adoptedStyleSheets.includes(sheet), `${mode}: shadow style removed`);
      if (siteSheet) assert(first.adoptedStyleSheets.includes(siteSheet), `${mode}: site stylesheet survives pause`);
      page.resetStats();
      page.doc.body.append(detached.host);
      const late = addComponents(page, 1)[0];
      await page.flush();
      assert(page.stats.visits === 0 && page.scheduled.size === 0, `${mode}: paused page idle`);
      page.change({ enabled: { newValue: true } });
      await page.flush();
      assert(page.win.getComputedStyle(late.querySelector("p")).fontFamily.includes("Lexend for the Web"), `${mode}: resume discovers new hosts`);
      assert(page.win.getComputedStyle(detached.querySelector("p")).fontFamily.includes("Lexend for the Web"), `${mode}: reattached root restored`);
      checks.push(`${mode}: passed`);
    } finally { page.close(); }
  }
  const startup = await createPage({ pendingSettings: true });
  try {
    assert(!startup.state().ready, "startup: no premature ready response");
    startup.change({ enabled: { newValue: false } });
    startup.resolveStorage({ enabled: true, letterSpacing: 0.04 });
    await startup.flush();
    assert(startup.state().ready && !startup.state().active, "startup: changes beat stale storage read");
    assert(!startup.doc.getElementById(STYLE_ID), "startup: paused settings do not inject a style");
    checks.push("storage startup race: passed");
  } finally { startup.close(); }
  const pausedSite = await createPage({ stored: { siteRules: [{ hostname: "localhost", enabled: false }] } });
  try {
    assert(!pausedSite.state().active, "site pause resolves for the frame hostname");
    pausedSite.resetStats();
    addComponents(pausedSite, 10);
    await pausedSite.flush();
    assert(pausedSite.stats.visits === 0, "site pause stops discovery");
    checks.push("per-site pause: passed");
  } finally { pausedSite.close(); }
  document.querySelector("#results").textContent = checks.join("\n");
  return checks;
};

for (const [id, run] of [["bench", window.runBenchmarks], ["checks", window.runRegressionChecks], ["automatic", () => window.runAutomaticChecks()]]) {
  document.getElementById(id).addEventListener("click", async () => {
    document.querySelector("#results").textContent = "Running…";
    try { await run(); } catch (error) { document.querySelector("#results").textContent = error.stack; }
  });
}

window.runAutomaticChecks = async () => {
  const checks = [];
  const page = await createPage({ markup: '<p id="copy">Ordinary content</p><div id="existing"></div><div id="second"></div>' });
  try {
    assert(page.state().discoveryMode === "css", "ordinary page reaches CSS-only mode");
    page.resetStats();
    for (let i = 0; i < 1000; i++) {
      const p = page.doc.createElement("p");
      p.textContent = "New ordinary content";
      page.doc.body.append(p);
    }
    await page.flush();
    assert(page.stats.visits === 0 && page.stats.slices === 0, "ordinary insertions do not wake discovery");
    assert(page.win.getComputedStyle(page.doc.body.lastElementChild).fontFamily.includes("Lexend for the Web"), "CSS styles new content without JavaScript");
    const root = page.doc.getElementById("existing").attachShadow({ mode: "open" });
    root.innerHTML = "<p>Late component</p>";
    await page.flush();
    assert(page.state().discoveryMode === "shadow", "late root wakes discovery");
    assert(page.win.getComputedStyle(root.querySelector("p")).fontFamily.includes("Lexend for the Web"), "late connected host styled");
    page.resetStats();
    const second = page.doc.getElementById("second").attachShadow({ mode: "open" });
    second.innerHTML = "<p>Second late component</p>";
    await page.flush();
    assert(page.win.getComputedStyle(second.querySelector("p")).fontFamily.includes("Lexend for the Web"), "subsequent connected-host root styled");
    assert(page.stats.visits < 20, "subsequent root uses targeted discovery");
    checks.push("CSS-only mutations and targeted late-root wake-up: passed");
  } finally { page.close(); }

  const racing = await createPage({ pendingSettings: true, markup: '<div id="racing-host"></div>' + '<p>Startup content</p>'.repeat(1000) });
  try {
    const host = racing.doc.getElementById("racing-host");
    const createWalker = racing.doc.createTreeWalker.bind(racing.doc);
    let root;
    let queued = false;
    racing.doc.createTreeWalker = (...args) => {
      const walker = createWalker(...args);
      const next = walker.nextNode.bind(walker);
      walker.nextNode = () => {
        const node = next();
        if (node === host && !queued) {
          queued = true;
          racing.win.setTimeout(() => {
            root = host.attachShadow({ mode: "open" });
            root.innerHTML = "<p>Created between discovery slices</p>";
          }, 0);
        }
        return node;
      };
      return walker;
    };
    racing.resolveStorage({});
    await racing.flush();
    assert(root && racing.win.getComputedStyle(root.querySelector("p")).fontFamily.includes("Lexend for the Web"), "roots created on visited hosts between slices are styled");
    checks.push("shadow attachment during unfinished startup discovery: passed");
  } finally { racing.close(); }

  const declarative = await createPage({ markup: '<div id="declarative"><template shadowrootmode="open"><p>Server-rendered component</p></template></div>' });
  try {
    const root = declarative.doc.getElementById("declarative").shadowRoot;
    assert(root && declarative.state().discoveryMode === "shadow", "pre-existing declarative root detected");
    assert(declarative.win.getComputedStyle(root.querySelector("p")).fontFamily.includes("Lexend for the Web"), "declarative root styled");
    checks.push("initial declarative shadow DOM: passed");
  } finally { declarative.close(); }

  const dynamic = await createPage({ markup: '<div id="host"></div>' });
  try {
    const host = dynamic.doc.getElementById("host");
    if (host.setHTMLUnsafe) {
      host.setHTMLUnsafe('<div><template shadowrootmode="open"><p>Dynamic declarative component</p></template></div>');
      await dynamic.flush();
      const root = host.firstElementChild.shadowRoot;
      assert(root && dynamic.state().discoveryMode === "shadow", "dynamic declarative root detected");
      assert(dynamic.win.getComputedStyle(root.querySelector("p")).fontFamily.includes("Lexend for the Web"), "dynamic declarative font applied");
      for (let i = 0; i < 2; i++) {
        const existing = dynamic.doc.createElement("div");
        dynamic.doc.body.append(existing);
        await dynamic.flush();
        // Fragment parsing recognizes a template's newly parsed parent as a
        // declarative host; a template directly under the receiver stays inert.
        existing.setHTMLUnsafe('<div><template shadowrootmode="open"><p>Another parsed component</p></template></div>');
        await dynamic.flush();
        const parsedRoot = existing.firstElementChild.shadowRoot;
        assert(parsedRoot && dynamic.win.getComputedStyle(parsedRoot.querySelector("p")).fontFamily.includes("Lexend for the Web"), "repeated native parsing discovers new component roots");
      }
      checks.push("dynamic declarative shadow DOM: passed");
    }
  } finally { dynamic.close(); }

  const clone = await createPage({ markup: '<div><p>Clone this subtree</p></div>' });
  try {
    const copy = clone.doc.body.firstElementChild.cloneNode(true);
    clone.doc.body.append(copy);
    await clone.flush();
    assert(clone.state().discoveryMode === "fallback", "cloning retains conservative discovery");
    assert(copy.textContent === "Clone this subtree", "native cloning behavior preserved");
    checks.push("native clone behavior and conservative fallback: passed");
  } finally { clone.close(); }

  const fallback = await createPage({ detector: false });
  try {
    assert(fallback.state().discoveryMode === "fallback", "missing bridge retains observer");
    const root = addComponents(fallback, 1)[0];
    await fallback.flush();
    assert(fallback.win.getComputedStyle(root.querySelector("p")).fontFamily.includes("Lexend for the Web"), "fallback discovers inserted components");
    checks.push("missing detector fallback: passed");
  } finally { fallback.close(); }

  const resumed = await createPage();
  try {
    resumed.change({ enabled: { newValue: false } });
    // Borrow an unwrapped native method from the harness's own realm.
    resumed.win.Element.prototype.attachShadow = Element.prototype.attachShadow;
    resumed.change({ enabled: { newValue: true } });
    await resumed.flush();
    assert(resumed.state().discoveryMode === "fallback", "resume detects a replaced native hook");
    const root = addComponents(resumed, 1)[0];
    await resumed.flush();
    assert(resumed.win.getComputedStyle(root.querySelector("p")).fontFamily.includes("Lexend for the Web"), "fallback styles roots inserted after resume");
    checks.push("hook replacement while paused and resume fallback: passed");
  } finally { resumed.close(); }

  // Load both scripts while the parser is running, matching manifest ordering.
  const source = await sources;
  const iframe = document.createElement("iframe");
  const loaded = new Promise((resolve) => iframe.addEventListener("load", resolve, { once: true }));
  const bootstrap = `window.fixtureState = null; window.chrome = {
    runtime: { getURL: path => ${JSON.stringify(location.origin)} + '/' + path, sendMessage: async () => {}, onMessage: { addListener(listener) { window.fixtureState = () => { let value; listener({type:'LEXEND_GET_STATE'}, {}, result => value = result); return value; }; } } },
    storage: { sync: { get: async () => ({}) }, onChanged: { addListener() {} } }
  };`;
  iframe.srcdoc = '<!doctype html><html><head><script>' + bootstrap + source[0] + source[1] + '</script><script>' + source[4] + '</script></head><body><p>Parsing page</p><div id="host"><template shadowrootmode="open"><p>Parsing shadow</p></template></div></body></html>';
  document.querySelector("#frames").append(iframe);
  try {
    await loaded;
    const until = performance.now() + 3000;
    while (iframe.contentWindow.fixtureState()?.discoveryMode !== "shadow" && performance.now() < until) await sleep(10);
    assert(iframe.contentWindow.fixtureState()?.discoveryMode === "shadow", "document-start scripts discover parser-created roots");
    const root = iframe.contentDocument.getElementById("host").shadowRoot;
    assert(iframe.contentWindow.getComputedStyle(root.querySelector("p")).fontFamily.includes("Lexend for the Web"), "document-start declarative root styled");
    checks.push("document-start manifest order and parser-created roots: passed");
  } finally { iframe.remove(); }
  document.querySelector("#results").textContent = checks.join("\n");
  return checks;
};
