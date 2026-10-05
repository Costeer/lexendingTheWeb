(() => {
  "use strict";

  const extension = globalThis.browser ?? globalThis.chrome;
  const settingsApi = globalThis.LexendSettings;
  const STYLE_ID = "lexend-the-web-styles";
  const FONT_FAMILY = '"Lexend for the Web", sans-serif';
  const styledRoots = new Map();
  const pendingNodes = new Set();
  const MAX_PENDING_NODES = 256;
  const SCAN_BUDGET_MS = 4;
  const SCAN_BATCH_SIZE = 250;
  const contentKeys = new Set([
    "enabled", "scope", "siteRules", "disabledSites", "textScale",
    "lineHeight", "letterSpacing", "spacing"
  ]);
  let settings = settingsApi.normalizeSettings();
  let effective = { active: false, scope: settings.scope };
  let documentCss = "";
  let shadowCss = "";
  let shadowSheet;
  let canShareSheet = typeof CSSStyleSheet === "function"
    && typeof CSSStyleSheet.prototype.replaceSync === "function";
  let scanStack = [];
  let scannedNodes = new WeakSet();
  let scheduledScan = null;
  let needsPrune = false;
  let observing = false;
  let loaded = false;
  let lastNotifiedState;
  let renderKey;
  const startupChanges = {};

  const iconAndContentExclusions = [
    "pre",
    "pre *",
    "code",
    "code *",
    "kbd",
    "kbd *",
    "samp",
    "samp *",
    "math",
    "math *",
    "svg",
    "svg *",
    "[data-lexend-ignore]",
    "[data-lexend-ignore] *",
    "[aria-hidden='true']",
    "[aria-hidden='true'] *",
    "[role='img']",
    "[role='img'] *",
    "[data-icon]",
    "[data-icon] *",
    "[class*='icon' i]",
    "[class*='symbol' i]",
    "[class~='fa']",
    "[class^='fa-']",
    "[class*=' fa-']",
    "[class*='material-icons' i]",
    "[class*='material-symbols' i]"
  ];

  const headers = ["h1", "h2", "h3", "h4", "h5", "h6"];
  const headerList = headers.join(", ");
  const bodyTextElements = [
    "p",
    "li",
    "dd",
    "dt",
    "blockquote",
    "figcaption",
    "caption",
    "td",
    "th",
    "label",
    "button",
    "input",
    "textarea",
    "select",
    "option",
    "summary",
    "address",
    "a",
    "span",
    "strong",
    "em",
    "b",
    "small",
    "time",
    "mark",
    "abbr",
    "q",
    `div:not(:has(${headerList}))`,
    `section:not(:has(${headerList}))`,
    `article:not(:has(${headerList}))`
  ];

  const fontFaces = [
    {
      file: "lexend-vietnamese-wght-normal.woff2",
      range: "U+0102-0103,U+0110-0111,U+0128-0129,U+0168-0169,U+01A0-01A1,U+01AF-01B0,U+0300-0301,U+0303-0304,U+0308-0309,U+0323,U+0329,U+1EA0-1EF9,U+20AB"
    },
    {
      file: "lexend-latin-ext-wght-normal.woff2",
      range: "U+0100-02BA,U+02BD-02C5,U+02C7-02CC,U+02CE-02D7,U+02DD-02FF,U+0304,U+0308,U+0329,U+1D00-1DBF,U+1E00-1E9F,U+1EF2-1EFF,U+2020,U+20A0-20AB,U+20AD-20C0,U+2113,U+2C60-2C7F,U+A720-A7FF"
    },
    {
      file: "lexend-latin-wght-normal.woff2",
      range: "U+0000-00FF,U+0131,U+0152-0153,U+02BB-02BC,U+02C6,U+02DA,U+02DC,U+0304,U+0308,U+0329,U+2000-206F,U+20AC,U+2122,U+2191,U+2193,U+2212,U+2215,U+FEFF,U+FFFD"
    }
  ];
  // Clamp light text to 400 without flattening medium and bold weights.
  const fontWeightRanges = ["400", "401 900"];

  const getEffectiveHostname = () => {
    for (const candidate of [location.href, location.origin, document.referrer]) {
      try {
        const hostname = new URL(candidate).hostname.toLowerCase();
        if (hostname) return hostname;
      } catch {}
    }
    return "";
  };

  const getFontFaceCss = () => fontFaces.flatMap(({ file, range }) =>
    fontWeightRanges.map((weight) => `
    @font-face {
      font-family: "Lexend for the Web";
      src: url("${extension.runtime.getURL(`assets/fonts/${file}`)}") format("woff2-variations");
      font-style: normal;
      font-weight: ${weight};
      font-display: swap;
      unicode-range: ${range};
    }
  `)
  ).join("\n");

  const createSelector = (scope, isShadowRoot) => {
    const exclusions = [...iconAndContentExclusions];

    if (scope === "body") {
      headers.forEach((header) => exclusions.push(header, `${header} *`));
    }

    let targets;
    if (scope === "all") {
      targets = isShadowRoot ? "*" : "body, body *";
    } else {
      const prefix = isShadowRoot ? "" : "body ";
      targets = bodyTextElements
        .flatMap((element) => [`${prefix}${element}`, `${prefix}${element} *`])
        .join(", ");
    }

    return `:where(${targets})${exclusions
      .map((item) => `:not(${item})`)
      .join("")}`;
  };

  // Font URLs and selectors do not depend on readability preferences or roots.
  let fontFaceCss;
  const selectors = new Map();
  const cachedSelector = (scope, isShadowRoot) => {
    const key = `${scope}:${isShadowRoot}`;
    if (!selectors.has(key)) selectors.set(key, createSelector(scope, isShadowRoot));
    return selectors.get(key);
  };

  const createCss = (effective, isShadowRoot) => {
    if (!effective.active) return "";

    const readability = [
      settings.lineHeight > 0
        ? `line-height: ${settings.lineHeight} !important;`
        : "",
      settings.letterSpacing > 0
        ? `letter-spacing: ${settings.letterSpacing}em !important;`
        : ""
    ].filter(Boolean).join("\n");
    const scale = !isShadowRoot && settings.textScale !== 100
      ? `:root { font-size: ${settings.textScale}% !important; }`
      : "";

    return `
      ${fontFaceCss ??= getFontFaceCss()}

      ${scale}

      ${cachedSelector(effective.scope, isShadowRoot)} {
        font-family: ${FONT_FAMILY} !important;
        ${readability}
      }
    `;
  };

  const applyToRoot = (root) => {
    const isShadowRoot = root instanceof ShadowRoot;
    let state = styledRoots.get(root);
    if (!state) {
      const rootObserver = isShadowRoot ? new MutationObserver(handleMutations) : null;
      state = { observer: rootObserver, style: null, shared: false };
      styledRoots.set(root, state);
      rootObserver?.observe(root, { childList: true, subtree: true });
    }

    if (isShadowRoot && canShareSheet && !state.style) {
      try {
        if (!root.adoptedStyleSheets.includes(shadowSheet)) {
          root.adoptedStyleSheets = [...root.adoptedStyleSheets, shadowSheet];
        }
        state.shared = true;
        return;
      } catch {
        // Some browser compartments cannot adopt sheets created by an extension.
        // Fall back for this root without replacing the site's own sheets.
      }
    }

    const css = isShadowRoot ? shadowCss : documentCss;
    if (!state.style?.parentNode) {
      state.style = document.createElement("style");
      state.style.id = STYLE_ID;
      state.style.textContent = css;
      root.append(state.style);
    } else if (state.style.textContent !== css) {
      state.style.textContent = css;
    }
  };

  const scheduleScan = () => {
    if (scheduledScan !== null || !effective.active) return;
    // Short tasks keep discovery responsive even when idle callbacks starve.
    scheduledScan = setTimeout(flushScans, 0);
  };

  const queueScan = (node) => {
    if (!(node instanceof Element) && !(node instanceof ShadowRoot)) return;
    if (!node.isConnected || node.id === STYLE_ID) return;
    if (pendingNodes.has(node.parentNode)) return;
    // Collapse bursts to a bounded queue. The document walk also enters shadows.
    if (pendingNodes.has(document.documentElement)) return;
    if (pendingNodes.size >= MAX_PENDING_NODES) {
      pendingNodes.clear();
      pendingNodes.add(document.documentElement);
    } else {
      pendingNodes.add(node);
    }
    scheduleScan();
  };

  const pruneRoots = () => {
    styledRoots.forEach((state, root) => {
      if (root.isConnected) return;
      state.observer?.disconnect();
      state.style?.remove();
      if (state.shared) {
        try {
          root.adoptedStyleSheets = root.adoptedStyleSheets.filter((sheet) => sheet !== shadowSheet);
        } catch {}
      }
      styledRoots.delete(root);
    });
  };

  const flushScans = () => {
    scheduledScan = null;
    if (!effective.active) return;
    if (needsPrune) {
      pruneRoots();
      needsPrune = false;
    }
    if (document.documentElement) applyToRoot(document.documentElement);

    const stopAt = performance.now() + SCAN_BUDGET_MS;
    let visited = 0;
    while (visited < SCAN_BATCH_SIZE && performance.now() < stopAt) {
      if (!scanStack.length) {
        const node = pendingNodes.values().next().value;
        if (!node) break;
        pendingNodes.delete(node);
        if (!node.isConnected) continue;
        // A queued ancestor will visit this subtree, including attached shadows.
        let ancestor = node.parentNode;
        while (ancestor && !pendingNodes.has(ancestor)) ancestor = ancestor.parentNode;
        if (ancestor) continue;
        scanStack.push({
          root: node,
          walker: document.createTreeWalker(node, NodeFilter.SHOW_ELEMENT),
          next: node instanceof Element ? node : null,
          started: false
        });
      }
      const scan = scanStack[scanStack.length - 1];
      if (!scan.root.isConnected) {
        scanStack.pop();
        continue;
      }
      const element = scan.started ? scan.walker.nextNode() : scan.next ?? scan.walker.nextNode();
      scan.started = true;
      if (!element) {
        scanStack.pop();
        continue;
      }
      visited++;
      if (scannedNodes.has(element)) continue;
      scannedNodes.add(element);
      const shadow = element.shadowRoot;
      if (shadow) {
        applyToRoot(shadow);
        scanStack.push({
          root: shadow,
          walker: document.createTreeWalker(shadow, NodeFilter.SHOW_ELEMENT),
          next: null,
          started: false
        });
      }
    }
    if (pendingNodes.size || scanStack.length || needsPrune) scheduleScan();
    else scannedNodes = new WeakSet();
  };

  const cancelScans = () => {
    if (scheduledScan !== null) {
      clearTimeout(scheduledScan);
    }
    scheduledScan = null;
    pendingNodes.clear();
    scanStack = [];
    scannedNodes = new WeakSet();
    needsPrune = false;
  };

  const notifyState = () => {
    if (window.top !== window || lastNotifiedState === effective.active) return;
    lastNotifiedState = effective.active;

    extension.runtime.sendMessage({
      type: "LEXEND_STATE",
      active: effective.active
    }).catch(() => {});
  };

  const applySettings = (nextSettings) => {
    settings = settingsApi.normalizeSettings(nextSettings);
    const wasActive = effective.active;
    effective = settingsApi.resolveSite(settings, getEffectiveHostname());
    const nextKey = effective.active ? JSON.stringify([
      effective.active, effective.scope, settings.textScale,
      settings.lineHeight, settings.letterSpacing
    ]) : "paused";
    if (nextKey === renderKey) return;
    renderKey = nextKey;

    if (!effective.active) {
      observer.disconnect();
      observing = false;
      cancelScans();
      // Clear first: even sheets retained by disconnected hosts must stop styling.
      try { shadowSheet?.replaceSync(""); } catch {}
      styledRoots.forEach((state, root) => {
        state.observer?.disconnect();
        state.style?.remove();
        if (state.shared) {
          try {
            root.adoptedStyleSheets = root.adoptedStyleSheets.filter((sheet) => sheet !== shadowSheet);
          } catch {}
        }
      });
      styledRoots.clear();
      documentCss = shadowCss = "";
    } else {
      documentCss = createCss(effective, false);
      shadowCss = createCss(effective, true);
      if (canShareSheet) {
        try {
          shadowSheet ??= new CSSStyleSheet();
          shadowSheet.replaceSync(shadowCss);
        } catch {
          canShareSheet = false;
        }
      }
      if (!observing) {
        observer.observe(document, { childList: true, subtree: true });
        observing = true;
      }
      pruneRoots();
      styledRoots.forEach((_state, root) => applyToRoot(root));
      if (document.documentElement) {
        applyToRoot(document.documentElement);
        // Readability changes update existing roots without rediscovering the DOM.
        if (!wasActive) queueScan(document.documentElement);
      }
    }

    notifyState();
  };

  const handleMutations = (mutations) => {
    if (!effective.active) return;
    if (document.documentElement && !styledRoots.has(document.documentElement)) {
      applyToRoot(document.documentElement);
    }

    mutations.forEach(({ target, addedNodes, removedNodes }) => {
      // Replacing our own CSS creates text-node records, not new shadow hosts.
      if (target.id === STYLE_ID) return;
      if (removedNodes.length) {
        needsPrune = true;
        scheduleScan();
      }
      addedNodes.forEach(queueScan);
    });
  };

  const observer = new MutationObserver(handleMutations);

  const start = async () => {
    let stored;
    try {
      stored = await extension.storage.sync.get(null);
    } catch (error) {
      console.warn("Lexend for the Web could not load settings; using defaults.", error);
      stored = settingsApi.defaults;
    }
    stored = { ...stored };
    Object.entries(startupChanges).forEach(([key, change]) => {
      if (change.newValue === undefined) delete stored[key];
      else stored[key] = change.newValue;
    });
    loaded = true;
    applySettings(stored);
  };

  extension.storage.onChanged.addListener((changes, areaName) => {
    if (areaName !== "sync") return;
    if (!loaded) {
      Object.assign(startupChanges, changes);
      return;
    }
    if (!Object.keys(changes).some((key) => contentKeys.has(key))) return;

    const nextSettings = { ...settings };
    Object.entries(changes).forEach(([key, change]) => {
      if (change.newValue === undefined) delete nextSettings[key];
      else nextSettings[key] = change.newValue;
    });
    applySettings(nextSettings);
  });

  extension.runtime.onMessage.addListener((message, _sender, sendResponse) => {
    if (message?.type !== "LEXEND_GET_STATE") return undefined;
    sendResponse({
      ready: loaded,
      active: effective.active,
      hostname: getEffectiveHostname(),
      scope: effective.scope
    });
    return undefined;
  });

  start();
})();
