(async () => {
  if (window.__lexendAudit) return { ready: true, alreadyInstalled: true };
  const fonts = __FONT_DATA__;
  const fontUrls = Object.fromEntries(fonts.map(({ file, data }) => [file, `data:font/woff2;base64,${data}`]));
  const loadedFonts = [];
  for (const font of fonts) {
    const bytes = Uint8Array.from(atob(font.data), (char) => char.charCodeAt(0));
    const face = new FontFace("Lexend for the Web", bytes, { weight: "400 900", style: "normal", unicodeRange: font.range });
    try { await face.load(); document.fonts.add(face); loadedFonts.push(face); } catch {}
  }
  const sleep = (ms) => new Promise((resolve) => window.setTimeout(resolve, ms));
  const protectedNodes = Array.from(document.querySelectorAll('h1,h2,pre,code,[data-icon],[class~="fa"],[class*="material-icons"]'))
    .filter((node) => node.getClientRects().length).slice(0, 60)
    .map((node) => ({ node, font: getComputedStyle(node).fontFamily, tag: node.tagName }));
  let active;
  let detectorInstalled = false;

  // Live sites can reject the probe's data: URLs through CSP. Production uses
  // extension URLs instead. Remove only our duplicate font-face declarations
  // after startup so the bundled FontFace buffers above supply actual glyphs.
  // Both variants receive exactly the same audit-only adjustment.
  const useBufferedFonts = () => {
    const pending = [document];
    while (pending.length) {
      const root = pending.pop();
      for (const sheet of new Set([...root.styleSheets, ...root.adoptedStyleSheets])) {
        try {
          for (let index = sheet.cssRules.length - 1; index >= 0; index--) {
            const rule = sheet.cssRules[index];
            if (rule.type === CSSRule.FONT_FACE_RULE && rule.style.fontFamily.includes("Lexend for the Web")) sheet.deleteRule(index);
          }
        } catch { /* Cross-origin website sheets are unrelated. */ }
      }
      for (const node of root.querySelectorAll("*")) if (node.shadowRoot) pending.push(node.shadowRoot);
    }
  };

  const inspect = () => {
    const roots = [];
    const pending = [document];
    let shadowText = 0;
    let shadowStyled = 0;
    while (pending.length) {
      const root = pending.pop();
      for (const node of root.querySelectorAll("*")) {
        if (node.shadowRoot) { roots.push(node.shadowRoot); pending.push(node.shadowRoot); }
        if (root !== document && /^(P|SPAN|BUTTON|LABEL|A|LI)$/.test(node.tagName)
          && node.textContent.trim() && node.getClientRects().length) {
          shadowText++;
          if (getComputedStyle(node).fontFamily.includes("Lexend for the Web")) shadowStyled++;
        }
      }
    }
    const bodySamples = Array.from(document.querySelectorAll("p,li,td,label,button"))
      .filter((node) => node.textContent.trim() && node.getClientRects().length).slice(0, 100);
    const changedProtected = protectedNodes.filter(({ node, font }) => node.isConnected && getComputedStyle(node).fontFamily !== font)
      .map(({ node, tag, font }) => ({ tag, text: node.textContent.slice(0, 60), before: font, after: getComputedStyle(node).fontFamily })).slice(0, 12);
    return {
      url: location.href, title: document.title,
      mode: active?.state()?.discoveryMode ?? (active ? "observer-baseline" : "off"),
      elements: document.querySelectorAll("*").length, openShadowRoots: roots.length,
      bodySamples: bodySamples.length,
      bodyStyled: bodySamples.filter((node) => getComputedStyle(node).fontFamily.includes("Lexend for the Web")).length,
      shadowText, shadowStyled, changedProtected,
      horizontalOverflow: Math.max(0, document.documentElement.scrollWidth - document.documentElement.clientWidth),
      loadedFontBuffers: loadedFonts.length,
      lexendFontReady: document.fonts.check('400 14px "Lexend for the Web"', "Readable text"),
      lexendBoldReady: document.fonts.check('700 14px "Lexend for the Web"', "Readable text")
    };
  };

  const launch = (version) => {
    const metrics = { callbacks: 0, records: 0, visits: 0, tasks: 0, discoveryMs: 0, maxTaskMs: 0 };
    const observers = new Set();
    const timers = new Set();
    const listeners = [];
    let change;
    let message;
    const time = (fn) => {
      const started = performance.now();
      try { return fn(); }
      finally { const elapsed = performance.now() - started; metrics.discoveryMs += elapsed; metrics.maxTaskMs = Math.max(metrics.maxTaskMs, elapsed); }
    };
    const nativeDocument = window.document;
    const proxied = (target) => new Proxy(target, {
      get(object, key) {
        if (key === "addEventListener") return (type, listener, options) => {
          object.addEventListener(type, listener, options);
          listeners.push([object, type, listener, options]);
        };
        if (key === "createTreeWalker") return (...args) => {
          const walker = object.createTreeWalker(...args);
          const next = walker.nextNode.bind(walker);
          walker.nextNode = () => { const node = next(); if (node) metrics.visits++; return node; };
          return walker;
        };
        const value = Reflect.get(object, key, object);
        return typeof value === "function" ? value.bind(object) : value;
      },
      set(object, key, value) { return Reflect.set(object, key, value, object); }
    });
    const document = proxied(nativeDocument);
    const windowProxy = proxied(window);
    const NativeObserver = window.MutationObserver;
    const MutationObserver = class extends NativeObserver {
      constructor(callback) {
        super((records, observer) => time(() => { metrics.callbacks++; metrics.records += records.length; callback(records, observer); }));
        observers.add(this);
      }
      observe(target, options) { return super.observe(target === document ? nativeDocument : target, options); }
    };
    const setTimeout = (callback, delay) => {
      let id;
      id = window.setTimeout(() => {
        timers.delete(id);
        time(() => { metrics.tasks++; callback(); });
      }, delay);
      timers.add(id);
      return id;
    };
    const clearTimeout = (id) => { timers.delete(id); window.clearTimeout(id); };
    const globalThis = {
      browser: {
        runtime: {
          getURL: (path) => fontUrls[path.split("/").at(-1)] ?? "",
          sendMessage: async () => {},
          onMessage: { addListener: (listener) => { message = listener; } }
        },
        storage: {
          sync: { get: async () => ({ enabled: true, scope: "body" }) },
          onChanged: { addListener: (listener) => { change = listener; } }
        }
      }
    };
    __SETTINGS_SOURCE__
    // This lexical window keeps lifecycle listeners removable without touching
    // the website's own APIs. The real document and DOM remain unchanged.
    ((window) => {
      if (version === "observer") { __BASELINE_SOURCE__ }
      else { __CONTENT_SOURCE__ }
    })(windowProxy);
    return {
      version, metrics, timers,
      state() { let state; message?.({ type: "LEXEND_GET_STATE" }, {}, (value) => { state = value; }); return state; },
      reset() { for (const key of Object.keys(metrics)) metrics[key] = 0; },
      stop() {
        change?.({ enabled: { newValue: false } }, "sync");
        observers.forEach((observer) => observer.disconnect());
        timers.forEach((id) => window.clearTimeout(id));
        listeners.forEach(([target, type, listener, options]) => target.removeEventListener(type, listener, options));
      }
    };
  };
  const installDetector = () => { __DETECTOR_SOURCE__ };
  const start = async (version = "auto") => {
    active?.stop();
    active = launch(version);
    if (version === "auto" && !detectorInstalled) { installDetector(); detectorInstalled = true; }
    const until = performance.now() + 8000;
    let stable = 0;
    do {
      await sleep(20);
      stable = active.timers.size ? 0 : stable + 1;
    } while (stable < 3 && performance.now() < until);
    useBufferedFonts();
    return inspect();
  };
  const measure = async (durationMs = 800) => {
    active.reset();
    const startY = scrollY;
    const step = Math.max(200, innerHeight * 0.65);
    const started = performance.now();
    for (let i = 0; i < 4; i++) {
      scrollTo(0, startY + step * (i + 1));
      await sleep(durationMs / 4);
    }
    const metrics = { ...active.metrics, discoveryMs: +active.metrics.discoveryMs.toFixed(3), maxTaskMs: +active.metrics.maxTaskMs.toFixed(3), elapsedMs: +(performance.now() - started).toFixed(1) };
    scrollTo(0, startY);
    return metrics;
  };
  window.__lexendAudit = {
    start, inspect,
    resetCounters() { active?.reset(); },
    counters() { return { version: active?.version, ...active?.metrics, page: inspect() }; },
    async compare({ samples = 2, durationMs = 800 } = {}) {
      const runs = [];
      for (let sample = 0; sample < samples; sample++) {
        for (const version of (sample % 2 ? ["auto", "observer"] : ["observer", "auto"])) {
          await start(version);
          const metrics = await measure(durationMs);
          runs.push({ sample, version, ...metrics, mode: active.state()?.discoveryMode ?? "observer-baseline" });
        }
      }
      await start("auto");
      return { page: inspect(), runs };
    },
    pause() { active?.stop(); active = null; return inspect(); }
  };
  return { ready: true, fontBuffers: loadedFonts.length, url: location.href };
})()
