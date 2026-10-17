(() => {
  "use strict";

  const extension = globalThis.browser ?? globalThis.chrome;
  const settingsApi = globalThis.LexendSettings;
  const STYLE_ID = "lexend-the-web-styles";
  const FONT_STYLE_ID = "lexend-the-web-fonts";
  const SYMBOLS_FAMILY = "Lexend Nerd Symbols";
  const TRANSITION_STYLE_ID = "lexend-the-web-transitions";
  const ownStyleIds = [STYLE_ID, FONT_STYLE_ID, TRANSITION_STYLE_ID];
  const styledRoots = new Set();
  let settings = settingsApi.normalizeSettings();
  let settingsReadGeneration = 0;
  let restoringChanges = null;
  let initializing = true;
  let settingsLoaded = false;
  let settingsLoadError = null;
  let rawSettings = {};
  let startupChanges = {};
  const mergeStorageChanges = (raw, changes) => {
    const next = { ...raw };
    for (const [key, change] of Object.entries(changes)) {
      if (change.newValue === undefined) delete next[key];
      else next[key] = change.newValue;
    }
    return next;
  };

  // Names such as `with-icon` are often ordinary prose wrappers. Protect actual
  // semantics and computed symbol/code fonts rather than substring class names.
  const protection = globalThis.LexendProtection;
  let editingDocument = protection.editorDocument();
  let knownEditorBoundaries = new WeakSet();
  const protectedSelector = [
    "script", "style", "template", "noscript", "pre", "code", "kbd", "samp",
    "math", "svg", "[data-lexend-ignore]", "[role='img']",
    ".CodeMirror", ".cm-editor", ".monaco-editor", ".ace_editor", ".code-editor"
  ].join(",");
  const iconFont = /icomoon|glyph|pictogram|icon|symbol|awesome|dingbat|wingding|musescore|mscore|creative[\s-]*commons|fontello|entypo|octicon|ionicon|^cc$/i;
  const codeFont = /monospace|mono\b|menlo|monaco|consolas|courier|iosevka|fira[\s-]*code|source[\s-]*code/i;
  const TEXT_ATTRIBUTE = "data-lexend-text";
  const PROTECTED_ATTRIBUTE = "data-lexend-protected";
  const FONT_ATTRIBUTE = "data-lexend-font";
  const managedElements = new Map();
  const authorFontFamilies = new Map();
  const eligibleTextRoots = new Map();
  const transitionRules = new Map();
  const retainedStyleRules = new Map();
  let retainedStyleId = 0;
  const transitionAttributes = ["data-lexend-transition", "data-lexend-before-transition", "data-lexend-after-transition"];
  const settledFontFaces = new WeakSet();
  const settledBundledFaces = new Set();
  const bundledFaceKey = (face) => [face.family.replace(/["']/g, ""), face.style, face.weight, face.stretch, face.unicodeRange].join(";");
  let refreshTimer = null;
  let refreshUrgent = false;
  let refreshRevision = 0;
  let refreshing = false;
  let repairFrame = null;
  let pendingRepair = null;
  let repairSynchronously = false;
  let nextRefreshTime = 0;
  let refreshRequired = false;
  const pendingAriaChanges = new Map();
  const pendingStyleChanges = new Map();
  const pendingStateChanges = new Map();
  let pendingRegions = null;
  let queuedGlobalRefresh = false;
  let authorStylesheetSnapshot = null;
  let nativeStateSnapshot = null;
  let retainedTypography = new WeakSet();
  let retentionWrites = new WeakMap();
  let retentionTimer = null;
  let counterContext = null;
  let layout = null;
  const NO_ATTRIBUTE_MUTATION = () => null;
  let regionalMutationWitness = null;
  let viewportStyleWitness = null;
  const viewportStyleGuards = new Map();
  const pendingStyleWrites = new Set();
  const beginAttributeMutation = (element, name) => {
    if (name === "style") pendingStyleWrites.add(element);
    const regional = regionalMutationWitness?.begin(element, name);
    const viewport = viewportStyleWitness?.begin(element, name);
    if (!regional && !viewport) return NO_ATTRIBUTE_MUTATION;
    return () => { const mutation = regional?.(); return viewport?.() ?? mutation ?? null; };
  };
  const mutateAttribute = (element, name, callback) => {
    const finish = beginAttributeMutation(element, name);
    try { return callback(); } finally { finish(); }
  };
  const disconnectObserver = () => {
    adoptStyleMutations(observer.takeRecords());
    observer.disconnect();
  };
  const mutationStyle = document.createElement("span").style;
  let lastRefreshError = null;
  let warnedRefreshError = null;
  let revealedAutoContent = new WeakSet();
  const knownAutoContent = new Map();
  let initialFrameHeight = window === window.top ? null : innerHeight;
  let requestedFrameHeight = null;
  const resizedFrames = new Map();
  let lastFrameRequest = null;
  const FRAME_MESSAGE = "lexend-measured-frame-height";
  const FRAME_RECHECK = "LEXEND_RECHECK_FRAME_REQUIREMENT";
  const FRAME_RUNTIME_RECHECK = "LEXEND_RECHECK_FRAME_REQUIREMENTS";
  const FRAME_RUNTIME_REQUEST = "LEXEND_FRAME_REQUIREMENT";
  const FRAME_RUNTIME_APPLY = "LEXEND_APPLY_FRAME_REQUIREMENT";
  // Presence belongs to the author, even while another Lexend owner supplies
  // the only declarations. In particular a recapture can acquire new owners
  // while the temporary scroll-anchor declaration is still installed.
  const getStylePresence = (element) => {
    viewportStyleWitness?.flush();
    const owned = viewportStyleGuards.get(element)?.hadStyle
      ?? managedElements.get(element)?.hadStyle ?? layout?.getStylePresence(element);
    if (owned !== undefined) return owned;
    for (const [frame, state] of resizedFrames) {
      if (frame === element) return state.hadStyle;
      if (state.elements.has(element)) return state.elements.get(element).hadStyle;
    }
    return element.hasAttribute("style");
  };
  const writeFrameProperty = (state, element, name, value) => {
    if (protection.editorOwned(element)) return;
    let properties = state.elements.get(element);
    if (!properties) state.elements.set(element, properties = { hadStyle: getStylePresence(element), values: new Map() });
    let original = properties.values.get(name);
    if (!original) {
      original = { value: element.style.getPropertyValue(name), priority: element.style.getPropertyPriority(name) };
      properties.values.set(name, original);
    } else if (element.style.getPropertyValue(name) !== original.applied) {
      original.value = element.style.getPropertyValue(name);
      original.priority = element.style.getPropertyPriority(name);
    }
    original.applied = value;
    if (element.style.getPropertyValue(name) !== value || element.style.getPropertyPriority(name) !== "important") mutateAttribute(element, "style", () => element.style.setProperty(name, value, "important"));
  };
  const restoreFrame = (frame) => {
    const state = resizedFrames.get(frame);
    if (!state) return;
    for (const [name, original] of state.properties) {
      if (frame.style.getPropertyValue(name) !== original.applied
          || frame.style.getPropertyPriority(name) !== "important") continue;
      mutateAttribute(frame, "style", () => {
        if (original.value) frame.style.setProperty(name, original.value, original.priority);
        else frame.style.removeProperty(name);
      });
    }
    if (!state.hadStyle && !frame.getAttribute("style")) mutateAttribute(frame, "style", () => frame.removeAttribute("style"));
    for (const [element, properties] of state.elements) {
      for (const [name, original] of properties.values) {
        if (element.style.getPropertyValue(name) !== original.applied || element.style.getPropertyPriority(name) !== "important") continue;
        mutateAttribute(element, "style", () => {
          if (original.value) element.style.setProperty(name, original.value, original.priority);
          else element.style.removeProperty(name);
        });
      }
      if (!properties.hadStyle && !element.getAttribute("style")) mutateAttribute(element, "style", () => element.removeAttribute("style"));
    }
    resizedFrames.delete(frame);
  };
  const notifyFrameRequirement = () => {
    if (initialFrameHeight === null || (!isLayoutRepairActive() && lastFrameRequest === null)) return;
    // At document_start an embed can still have its default/placeholder size.
    // Follow native viewport changes until our measured request is actually
    // reflected in the child viewport, then retain the pre-repair baseline.
    if (innerHeight > 0 && (requestedFrameHeight === null
        || Math.abs(innerHeight - requestedFrameHeight) > 1)) initialFrameHeight = innerHeight;
    const requirement = isLayoutRepairActive() ? layout?.getFrameRequirement?.(initialFrameHeight) ?? null : null;
    const serialized = JSON.stringify(requirement);
    if (lastFrameRequest === serialized && (!requirement
        || Math.abs(innerHeight - requirement.requiredHeight) <= 1)) return;
    lastFrameRequest = serialized;
    requestedFrameHeight = requirement?.requiredHeight ?? null;
    // Chrome can redact MessageEvent.source between extension isolated worlds.
    // Route measured requirements through authenticated extension messaging.
    extension.runtime.sendMessage({ type: FRAME_RUNTIME_REQUEST, requirement }).catch(() => {});
  };
  const frameTouchesEditor = (frame, state = resizedFrames.get(frame)) => {
    if (protection.editorOwned(frame)) return true;
    // A measured frame can own clipping ancestors and independent fixed action
    // bars. Any of those entering an editor invalidates the whole repair group;
    // restore with the same author-override checks used for pause/removal.
    for (const element of state?.elements.keys() ?? []) if (protection.editorOwned(element)) return true;
    return false;
  };
  const applyFrameRequirement = (frame, requirement) => {
    if (!isLayoutRepairActive() || requirement === null || frameTouchesEditor(frame)) {
      disconnectObserver();
      try { restoreFrame(frame); } finally { if (!refreshing) observeRoots(); }
      return;
    }
    if (!requirement || typeof requirement !== "object" || Array.isArray(requirement)) return;
    const { viewportHeight, requiredHeight, baselineHeight } = requirement;
    if (![viewportHeight, requiredHeight, baselineHeight].every(Number.isFinite)
        || viewportHeight <= 0 || viewportHeight > 160 || baselineHeight <= 0 || baselineHeight > 160
        || baselineHeight > viewportHeight + 2
        || requiredHeight <= viewportHeight || requiredHeight > Math.min(320, innerHeight * 0.5)) return;
    const box = frame.getBoundingClientRect(), css = getComputedStyle(frame);
    if (box.width < 80 || box.height <= 0
        || css.display === "none" || css.visibility === "hidden" || Number(css.opacity) === 0) return;
    // A caption can report before its parent scrolls it into the viewport.
    // Keep its measured flow footprint ready, but do not open a closed portal
    // or a subtree whose author styles prevent any native frame surface.
    let paintedLeft = box.left, paintedRight = box.right, paintedTop = box.top, paintedBottom = box.bottom;
    for (let parent = frame.parentElement; parent; parent = parent.parentElement) {
      const style = getComputedStyle(parent);
      if (style.display === "none" || style.visibility === "hidden" || style.contentVisibility === "hidden"
          || Number(style.opacity) === 0) return;
      const parentBox = parent.getBoundingClientRect();
      if (/hidden|clip/.test(style.overflowX)) {
        paintedLeft = Math.max(paintedLeft, parentBox.left);
        paintedRight = Math.min(paintedRight, parentBox.right);
      }
      if (/hidden|clip/.test(style.overflowY)) {
        paintedTop = Math.max(paintedTop, parentBox.top);
        paintedBottom = Math.min(paintedBottom, parentBox.bottom);
      }
      if (paintedRight <= paintedLeft || paintedBottom <= paintedTop) return;
    }
    let state = resizedFrames.get(frame);
    if (!state && Math.abs(box.height - viewportHeight) > 4) return;
    disconnectObserver();
    try {
      if (!state) {
        state = { hadStyle: getStylePresence(frame), properties: new Map(), elements: new Map() };
        resizedFrames.set(frame, state);
      }
      const shortAncestors = [];
      for (let parent = frame.parentElement; parent && parent !== document.body && shortAncestors.length < 4; parent = parent.parentElement) {
        const style = getComputedStyle(parent), before = parent.getBoundingClientRect();
        // Our earlier request can grow an eligible wrapper past the native
        // cutoff. Keep following that owned wrapper when later fonts or
        // settings require more room; new ancestors still use the cutoff.
        if ((before.height > 160 && !state.elements.has(parent)) || before.width + 2 < box.width) break;
        shortAncestors.push({ element: parent, box: before, clips: /hidden|clip/.test(style.overflowY) });
      }
      const oldBottom = shortAncestors.at(-1)?.box.bottom ?? box.bottom;
      const borderBoxExtra = css.boxSizing === "border-box"
        ? [css.borderTopWidth, css.borderBottomWidth, css.paddingTop, css.paddingBottom].reduce((total, value) => total + (parseFloat(value) || 0), 0) : 0;
      for (const [name, value] of [["height", `${Math.ceil(requiredHeight + borderBoxExtra)}px`], ["max-height", "none"]]) {
        let original = state.properties.get(name);
        if (!original) {
          original = { value: frame.style.getPropertyValue(name), priority: frame.style.getPropertyPriority(name) };
          state.properties.set(name, original);
        } else if (frame.style.getPropertyValue(name) !== original.applied) {
          original.value = frame.style.getPropertyValue(name);
          original.priority = frame.style.getPropertyPriority(name);
        }
        original.applied = value;
        if (frame.style.getPropertyValue(name) !== value || frame.style.getPropertyPriority(name) !== "important") mutateAttribute(frame, "style", () => frame.style.setProperty(name, value, "important"));
      }
      for (const parent of shortAncestors) {
        const frameBox = frame.getBoundingClientRect(), parentBox = parent.element.getBoundingClientRect();
        if (!parent.clips || frameBox.bottom <= parentBox.bottom + 2) continue;
        const height = Math.ceil(parentBox.height + frameBox.bottom - parentBox.bottom);
        if (height > Math.min(320, innerHeight * 0.5)) continue;
        writeFrameProperty(state, parent.element, "height", `${height}px`);
        writeFrameProperty(state, parent.element, "max-height", "none");
      }
      const newBottom = shortAncestors.at(-1)?.element.getBoundingClientRect().bottom ?? frame.getBoundingClientRect().bottom;
      if (newBottom > oldBottom + 2) {
        for (const actionBar of document.querySelectorAll("header,nav,[role='navigation']")) {
          if (actionBar.contains(frame) || shortAncestors.some((entry) => entry.element.contains(actionBar))) continue;
          const style = getComputedStyle(actionBar), bar = actionBar.getBoundingClientRect();
          if (style.position !== "fixed" || bar.height <= 0 || bar.height > 160 || bar.top < oldBottom - 2 || bar.top >= newBottom
              || bar.right <= box.left || bar.left >= box.right || !Number.isFinite(parseFloat(style.top))) continue;
          writeFrameProperty(state, actionBar, "top", `${parseFloat(style.top) + newBottom - bar.top}px`);
        }
      }
    } finally { if (!refreshing) observeRoots(); }
  };
  const receiveFrameRequirement = (event) => {
    if (event.data?.type !== FRAME_MESSAGE || !event.source) return;
    const frame = [...document.querySelectorAll("iframe")].find((candidate) => candidate.contentWindow === event.source);
    if (frame) applyFrameRequirement(frame, event.data.requirement);
  };
  const isBackgroundSender = (sender) => {
    if (sender?.id !== extension.runtime.id) return false;
    try {
      const senderUrl = new URL(sender.url), extensionUrl = new URL(extension.runtime.getURL(""));
      return senderUrl.protocol === extensionUrl.protocol && senderUrl.host === extensionUrl.host;
    } catch { return false; }
  };
  const receiveRuntimeFrameRequirement = (message, sender) => {
    if (sender?.id !== extension.runtime.id || !Number.isInteger(message.sourceFrameId) || message.sourceFrameId <= 0) return;
    let sourceUrl, senderUrl;
    try {
      sourceUrl = new URL(message.frameUrl);
      senderUrl = new URL(sender.url);
      if (!["http:", "https:"].includes(sourceUrl.protocol) || senderUrl.protocol !== new URL(extension.runtime.getURL("")).protocol
          || senderUrl.host !== new URL(extension.runtime.getURL("")).host) return;
      sourceUrl.hash = "";
    } catch { return; }
    const matches = [...document.querySelectorAll("iframe")].filter((frame) => {
      try { const url = new URL(frame.src); url.hash = ""; return url.href === sourceUrl.href; } catch { return false; }
    });
    if (matches.length === 1) applyFrameRequirement(matches[0], message.requirement);
  };

  // Exact, disjoint cmap coverage of the bundled subsets. Overlapping faces
  // can leave an unused subset pending in document.fonts.check even though
  // every painted character is loaded from another subset. Unsupported scripts
  // stay with the original family instead of matching an empty declared range.
  const fontFaces = [
    {
      file: "lexend-vietnamese-wght-normal.woff2",
      range: "U+1EA0-1EF1"
    },
    {
      file: "lexend-latin-ext-wght-normal.woff2",
      range: "U+0100-0101,U+0103-0130,U+0132-0151,U+0154-017E,U+018F,U+0192,U+019D,U+01A0-01A1,U+01AF-01B0,U+01C4-01D4,U+01E6-01E7,U+01EA-01EB,U+01F1-01F2,U+01FA-021B,U+022A-022D,U+0230-0233,U+0237,U+0259,U+0272,U+02BE-02BF,U+02C7-02C8,U+02CC,U+02DD,U+1E08-1E09,U+1E0C-1E0F,U+1E14-1E17,U+1E1C-1E1D,U+1E20-1E21,U+1E24-1E25,U+1E2A-1E2B,U+1E2E-1E2F,U+1E36-1E37,U+1E3A-1E3B,U+1E42-1E49,U+1E4C-1E53,U+1E5A-1E5B,U+1E5E-1E69,U+1E6C-1E6F,U+1E78-1E7B,U+1E80-1E85,U+1E8E-1E8F,U+1E92-1E93,U+1E97,U+1E9E,U+1EF2-1EF9,U+2020,U+20A1,U+20A3-20A4,U+20A6-20A7,U+20A9,U+20AB,U+20AD,U+20B1-20B2,U+20B5,U+20B9-20BA,U+20BC-20BD,U+2113"
    },
    {
      file: "lexend-latin-wght-normal.woff2",
      range: "U+0020-007E,U+00A0-00FF,U+0102,U+0131,U+0152-0153,U+02BB-02BC,U+02C6,U+02DA,U+02DC,U+0300-0301,U+0303-0304,U+0308-0309,U+0323,U+2009,U+200B,U+2013-2014,U+2018-201A,U+201C-201E,U+2022,U+2026,U+2033,U+2039-203A,U+2044,U+20AC,U+2122,U+2212,U+2215"
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
  ).join("\n") + `
    @font-face {
      font-family: "${SYMBOLS_FAMILY}";
      src: url("${extension.runtime.getURL("assets/fonts/nerd-fonts-symbols.woff2")}") format("woff2");
      font-style: normal;
      font-weight: 100 900;
      font-display: swap;
      unicode-range: U+23FB-23FE,U+2630,U+2665,U+26A1,U+276C-2771,U+2B58,U+E000-F8FF,U+F0000-FFFFD,U+100000-10FFFD;
    }
  `;

  const createCss = (effective) => {
    if (!effective.active) return "";
    const converted = (prefix = "") => `
      font-family: var(--lexend-${prefix}family) !important;
      font-size: var(--lexend-${prefix}size) !important;
      line-height: var(--lexend-${prefix}line) !important;
      letter-spacing: var(--lexend-${prefix}spacing) !important;
    `;
    const preserved = (prefix = "") => `
      font-family: var(--lexend-${prefix}family) !important;
      font-size: var(--lexend-${prefix}size) !important;
      line-height: var(--lexend-${prefix}line) !important;
      letter-spacing: var(--lexend-${prefix}spacing) !important;
    `;
    return `
      [${FONT_ATTRIBUTE}] { font-family: var(--lexend-family) !important; }
      [data-lexend-before='font']::before { font-family: var(--lexend-before-family) !important; }
      [data-lexend-after='font']::after { font-family: var(--lexend-after-family) !important; }
      [${TEXT_ATTRIBUTE}] { ${converted()} }
      [${PROTECTED_ATTRIBUTE}] { ${preserved()} }
      [data-lexend-before='text']::before { ${converted("before-")} }
      [data-lexend-after='text']::after { ${converted("after-")} }
      [data-lexend-before='protected']::before { ${preserved("before-")} }
      [data-lexend-after='protected']::after { ${preserved("after-")} }
      [data-lexend-hide-fade-before]::before, [data-lexend-hide-fade-after]::after { display: none !important; }
      [data-lexend-fit-pseudo-before]::before { margin-left: var(--lexend-layout-before-margin-left) !important; }
      [data-lexend-fit-pseudo-after]::after { margin-left: var(--lexend-layout-after-margin-left) !important; }
      /* Slotted light-DOM text belongs to an inner shadow cascade. Important
         author ::slotted declarations outrank outer inline-important styles. */
      @layer lexend-slotted-typography {
        ::slotted([${FONT_ATTRIBUTE}]) { font-family: var(--lexend-family) !important; }
        ::slotted([data-lexend-before='font'])::before { font-family: var(--lexend-before-family) !important; }
        ::slotted([data-lexend-after='font'])::after { font-family: var(--lexend-after-family) !important; }
        ::slotted([${TEXT_ATTRIBUTE}]), ::slotted([${PROTECTED_ATTRIBUTE}]) { ${converted()} }
        ::slotted([data-lexend-before='text'])::before, ::slotted([data-lexend-before='protected'])::before { ${converted("before-")} }
        ::slotted([data-lexend-after='text'])::after, ::slotted([data-lexend-after='protected'])::after { ${converted("after-")} }
      }
    `;
  };

  let effectiveCache;
  const getEffectiveSettings = () => {
    const hostname = getEffectiveHostname();
    if (effectiveCache?.settings !== settings || effectiveCache.hostname !== hostname) {
      effectiveCache = { settings, hostname, value: settingsApi.resolveSite(settings, hostname) };
    }
    return effectiveCache.value;
  };
  const isActive = () => settingsLoaded && getEffectiveSettings().active;
  const isLayoutRepairActive = () => isActive() && getEffectiveSettings().layoutRepair === true;
  const composedParent = (element) => element.parentElement
    ?? (element.getRootNode() instanceof ShadowRoot ? element.getRootNode().host : null);
  const hasProtectedAncestor = (element) => protection.protected(element);
  const isHeading = (element) => {
    for (let current = element; current; current = composedParent(current)) {
      if (/^H[1-6]$/.test(current.tagName) || current.getAttribute("role") === "heading") return true;
    }
    return false;
  };
  const primaryFont = (family) => family.split(",")[0].replace(/["']/g, "").trim();
  const protectedFont = (family) => iconFont.test(primaryFont(family)) || codeFont.test(family);
  const privateGlyphs = /[\uE000-\uF8FF\u{F0000}-\u{FFFFD}\u{100000}-\u{10FFFD}]/gu;
  const containsPrivateGlyph = (text) => /[\uE000-\uF8FF\u{F0000}-\u{FFFFD}\u{100000}-\u{10FFFD}]/u.test(text);
  const onlyPrivateGlyphs = (text) => containsPrivateGlyph(text) && !text.replace(privateGlyphs, "").replace(/[\s"']/g, "");
  const paintedGeneratedContent = (content) => {
    let quote = null, escaped = false;
    for (let index = 0; index < content.length; index++) {
      const character = content[index];
      if (escaped) { escaped = false; continue; }
      if (character === "\\") { escaped = true; continue; }
      if (quote) { if (character === quote) quote = null; continue; }
      if (character === '"' || character === "'") { quote = character; continue; }
      // CSS content's slash-separated alternative is accessible text, not a
      // painted caption. It must not turn a private-use icon into mixed prose.
      if (character === "/") return content.slice(0, index);
    }
    return content;
  };
  const ownTextContent = (element) => {
    let text = "";
    for (const node of element.childNodes) if (node.nodeType === Node.TEXT_NODE) text += node.textContent;
    return text;
  };
  const hasEmptyPaintClip = (element, style, styleFor = getComputedStyle) => {
    for (let current = element; current; current = composedParent(current)) {
      const css = current === element ? style : styleFor(current);
      // Legacy visually-hidden links can have a sizable border box while their
      // absolute-positioned paint clip is empty. Preserve that hidden state's
      // metrics; a focus event remeasures once the page reveals the label.
      if (!/^(absolute|fixed)$/.test(css.position)) continue;
      const rect = css.clip.match(/^rect\(([^)]+)\)$/)?.[1].split(/[,\s]+/).filter(Boolean);
      if (rect?.length === 4 && rect.every((value) => /^-?[\d.]+px$/.test(value))) {
        const [top, right, bottom, left] = rect.map(parseFloat);
        if (right <= left || bottom <= top) return true;
      }
    }
    return false;
  };
  const isImageReplacementText = (element, style, styleFor = getComputedStyle) => {
    const alpha = style.color.match(/rgba\([^)]*,\s*([\d.]+)\s*\)/)?.[1];
    if (style.backgroundClip.includes("text")
        || style.webkitBackgroundClip?.includes("text")) return false;
    if (Number(alpha ?? 1) !== 0) {
      // A closed fixed drawer may leave only background icons in the viewport.
      // Its unpainted, horizontally displaced labels must not grow into that
      // visible rail. Reclassification after opening converts the prose.
      if (!style.backgroundImage.includes("url(")) return false;
      let fixed = false;
      for (let current = element; current; current = composedParent(current)) {
        if (styleFor(current).position === "fixed") { fixed = true; break; }
      }
      if (!fixed) return false;
      const boxes = [...element.childNodes].filter((node) => node.nodeType === Node.TEXT_NODE && node.textContent.trim())
        .flatMap((node) => { const range = document.createRange(); range.selectNodeContents(node); return [...range.getClientRects()]; });
      return boxes.length > 0 && boxes.every((box) => box.right <= 0 || box.left >= innerWidth);
    }
    // Accessible labels behind a sprite/image are deliberately unpainted. Their
    // typography must not enlarge the replacement artwork's fixed geometry.
    for (let current = element, depth = 0; current && depth < 3; depth++, current = composedParent(current)) {
      const css = current === element ? style : styleFor(current);
      if (css.backgroundClip.includes("text") || css.webkitBackgroundClip?.includes("text")) return false;
      if (css.backgroundImage !== "none" || current.querySelector("img,picture,svg")) return true;
    }
    return [element.previousElementSibling, element.nextElementSibling].some((sibling) => sibling?.matches("img,picture,svg"));
  };
  const directText = (element) => [...element.childNodes].some((node) => (
    node.nodeType === Node.TEXT_NODE && node.textContent.trim()
  ));
  const isTextControl = (element) => element.matches("textarea,select,option,button,input:not([type='hidden']):not([type='checkbox']):not([type='radio']):not([type='range']):not([type='color'])");
  const allElements = function* (root) {
    const scope = root === document.documentElement ? document.body : root;
    if (!scope || protection.editorOwned(scope instanceof ShadowRoot ? scope.host : scope)
        || (root instanceof ShadowRoot && hasProtectedAncestor(root.host))) return;
    // Freeze the typography at each semantic boundary. Its descendants then
    // inherit the original font naturally; thousands of editor tokens need no
    // overrides, pseudo measurements, or clone-recovery attributes of their own.
    const walker = document.createTreeWalker(scope, NodeFilter.SHOW_ELEMENT, {
      acceptNode: (element) => !element.style || ownStyleIds.includes(element.id)
        || element.matches(protection.editorSelector)
        || element.matches("script,style,template,noscript") || element.parentElement?.matches(protectedSelector)
        ? NodeFilter.FILTER_REJECT : NodeFilter.FILTER_ACCEPT
    });
    if (scope instanceof Element) yield scope;
    let element;
    while ((element = walker.nextNode())) yield element;
  };
  const collectTextElements = (root) => eligibleTextRoots.get(root) ?? new Set();

  // Keep only the properties we own. Page updates to unrelated inline styles
  // remain intact when settings change or the extension is switched off.
  const manage = (element) => {
    let state = managedElements.get(element);
    if (!state) {
      state = { attributes: new Map(), properties: new Map(), hadStyle: getStylePresence(element) };
      managedElements.set(element, state);
    }
    return state;
  };
  const setAttribute = (element, name, value) => {
    const state = manage(element);
    if (!state.attributes.has(name)) state.attributes.set(name, element.getAttribute(name));
    const finish = beginAttributeMutation(element, name);
    element.setAttribute(name, value);
    finish();
  };
  const setProperty = (element, name, value, priority = "") => {
    const state = manage(element);
    if (!state.properties.has(name)) state.properties.set(name, {
      value: element.style.getPropertyValue(name), priority: element.style.getPropertyPriority(name)
    });
    const finish = beginAttributeMutation(element, "style");
    element.style.setProperty(name, value, priority);
    const applied = finish();
    const property = state.properties.get(name);
    if (applied === null) {
      property.appliedValue = element.style.getPropertyValue(name);
      property.appliedPriority = element.style.getPropertyPriority(name);
    } else {
      mutationStyle.cssText = applied.value ?? "";
      property.appliedValue = mutationStyle.getPropertyValue(name);
      property.appliedPriority = mutationStyle.getPropertyPriority(name);
    }
  };
  // Compare author declarations, not the temporary typography overrides a
  // framework may remove when it reapplies its style prop. Restoring an
  // unchanged author style must not restart a full-page baseline/repair cycle.
  const authorStyle = document.createElement("span").style;
  const authorStyleSignature = (element, cssText) => {
    authorStyle.cssText = cssText ?? "";
    for (const [name, property] of managedElements.get(element)?.properties ?? []) {
      if (authorStyle.getPropertyValue(name) !== property.appliedValue
          || authorStyle.getPropertyPriority(name) !== property.appliedPriority) continue;
      if (property.value) authorStyle.setProperty(name, property.value, property.priority);
      else authorStyle.removeProperty(name);
    }
    // Declaration order is immaterial after CSSOM has resolved shorthands.
    return JSON.stringify([...authorStyle].sort().map(name =>
      [name, authorStyle.getPropertyValue(name), authorStyle.getPropertyPriority(name)]));
  };
  const retainTypographyInStylesheet = (element, state) => {
    // This notification may contain a newer author declaration than the
    // inline write it answered. Keep it for future edits, cloning and pause.
    for (const [name, property] of state.properties) {
      const value = element.style.getPropertyValue(name), priority = element.style.getPropertyPriority(name);
      if (value === property.appliedValue && priority === property.appliedPriority) continue;
      property.value = value;
      property.priority = priority;
    }
    setAttribute(element, "data-lexend-original-typography", JSON.stringify({
      hadStyle: state.hadStyle,
      properties: [...state.properties].map(([name, { value, priority }]) => [name, value, priority])
    }));
    if (state.retainedStyle) return;
    // A style-prop observer can immediately remove our inline declarations
    // again. Keep this element's values in our existing reversible stylesheet
    // instead of repeatedly fighting that observer or refreshing the page.
    const root = element.getRootNode();
    const sheet = (root instanceof ShadowRoot ? root : document.documentElement)
      .querySelector(`#${STYLE_ID}`)?.sheet;
    if (!sheet) return;
    const id = String(++retainedStyleId);
    const index = sheet.insertRule(`[data-lexend-retained='${id}'] {}`, sheet.cssRules.length);
    const style = sheet.cssRules[index].style;
    for (const [name, property] of state.properties) {
      style.setProperty(name, property.appliedValue, property.appliedPriority);
    }
    if (!retainedStyleRules.has(sheet)) retainedStyleRules.set(sheet, []);
    retainedStyleRules.get(sheet).push(index);
    state.retainedStyle = true;
    setAttribute(element, "data-lexend-retained", id);
  };
  const retainOverwrittenTypography = (element) => {
    const state = managedElements.get(element);
    if (!state || !element.isConnected || !isActive() || protection.editorOwned(element)) return;
    // The stylesheet handles repeated copies of the same author baseline.
    // A later, genuinely different declaration still gets immediate retention
    // while the scheduled pass measures its new typography.
    if (state.retainedStyle && ![...state.properties].some(([name, property]) => {
      const value = element.style.getPropertyValue(name), priority = element.style.getPropertyPriority(name);
      return (value !== property.appliedValue || priority !== property.appliedPriority)
        && (value !== property.value || priority !== property.priority);
    })) return;
    if (retainedTypography.has(element) || (retentionWrites.get(element) ?? 0) >= 32) {
      if ([...state.properties].some(([name, property]) =>
        element.style.getPropertyValue(name) !== property.appliedValue
        || element.style.getPropertyPriority(name) !== property.appliedPriority)) {
        retainTypographyInStylesheet(element, state);
      }
      return;
    }
    let overwritten = false;
    state.properties.forEach((property, name) => {
      const value = element.style.getPropertyValue(name), priority = element.style.getPropertyPriority(name);
      if (value === property.appliedValue && priority === property.appliedPriority) return;
      // Hover rerenders can replace an entire style attribute. Keep the new
      // author declaration as the next baseline, but restore our current
      // typography before the browser paints the intervening native font.
      property.value = value;
      property.priority = priority;
      mutateAttribute(element, "style", () => {
        if (property.appliedValue) element.style.setProperty(name, property.appliedValue, property.appliedPriority);
        else element.style.removeProperty(name);
      });
      overwritten = true;
    });
    if (overwritten) {
      // Let the notification caused by our writes and its author feedback
      // drain before releasing this element. A timer alone can run after other
      // queued author tasks and wrongly suppress their independent updates.
      retainedTypography.add(element);
      retentionWrites.set(element, (retentionWrites.get(element) ?? 0) + 1);
      queueMicrotask(() => queueMicrotask(() => retainedTypography.delete(element)));
      // A hard task-budget also bounds authors that defer observer feedback
      // through additional microtasks beyond the immediate notification turn.
      if (retentionTimer === null) retentionTimer = setTimeout(() => {
        retainedTypography = new WeakSet();
        retentionWrites = new WeakMap();
        retentionTimer = null;
      }, 0);
      setAttribute(element, "data-lexend-original-typography", JSON.stringify({
        hadStyle: state.hadStyle,
        properties: [...state.properties].map(([name, { value, priority }]) => [name, value, priority])
      }));
    }
  };
  const recoverClonedTypography = (roots) => {
    // cloneNode copies inline overrides but not WeakMap/Map ownership. Carry a
    // small author-state record so cloned cards start from the page's baseline.
    const clones = [];
    roots.forEach((root) => [
      ...(root.matches?.("[data-lexend-original-typography]") ? [root] : []),
      ...root.querySelectorAll("[data-lexend-original-typography]")
    ].forEach((element) => {
      if (managedElements.has(element) || protection.editorOwned(element)) return;
      try {
        const original = JSON.parse(element.getAttribute("data-lexend-original-typography"));
        for (const attribute of [TEXT_ATTRIBUTE, PROTECTED_ATTRIBUTE, FONT_ATTRIBUTE, "data-lexend-before", "data-lexend-after", "data-lexend-retained"]) element.removeAttribute(attribute);
        original.properties.filter(([name]) => name !== "transition-property").forEach(([name, value, priority]) => {
          mutateAttribute(element, "style", () => {
            if (value) element.style.setProperty(name, value, priority);
            else element.style.removeProperty(name);
          });
        });
        clones.push({ element, original });
      } catch { /* Do not trust unrelated malformed page attributes. */ }
    }));
    // Inherited font changes can animate in nontext wrappers between a cloned
    // control and its label. Restore the whole branch before releasing guards.
    for (const { element, original } of clones) {
      if (original.properties.some(([name]) => name === "transition-property")) getComputedStyle(element).fontSize;
      for (const pseudo of ["before", "after"]) {
        if (element.hasAttribute(`data-lexend-${pseudo}-transition`)) getComputedStyle(element, `::${pseudo}`).fontSize;
      }
    }
    for (const { element, original } of clones) {
      try {
        const transition = original.properties.find(([name]) => name === "transition-property");
        if (transition) {
          mutateAttribute(element, "style", () => {
            if (transition[1]) element.style.setProperty(transition[0], transition[1], transition[2]);
            else element.style.removeProperty(transition[0]);
          });
        }
        for (const attribute of [TEXT_ATTRIBUTE, PROTECTED_ATTRIBUTE, FONT_ATTRIBUTE, "data-lexend-before", "data-lexend-after", ...transitionAttributes, "data-lexend-original-typography"]) element.removeAttribute(attribute);
        if (!original.hadStyle && !element.getAttribute("style")) mutateAttribute(element, "style", () => element.removeAttribute("style"));
      } catch { /* Do not trust unrelated malformed page attributes. */ }
    }
  };
  const clearTypography = (scope = null) => {
    const ownsElement = (element) => scope === null || element.getRootNode() === scope;
    // Preserve font-transition guards while removing a contested element's
    // stylesheet fallback. Otherwise releasing that rule can animate toward
    // the native font and make the next capture measure an intermediate size.
    if (retainedStyleRules.size) for (const [element, state] of managedElements) {
      if (!ownsElement(element)) continue;
      if (!state.retainedStyle) continue;
      for (const [name, property] of state.properties) {
        if (!name.startsWith("transition-")) continue;
        const value = element.style.getPropertyValue(name), priority = element.style.getPropertyPriority(name);
        if (value !== property.appliedValue || priority !== property.appliedPriority) {
          property.value = value;
          property.priority = priority;
        }
        mutateAttribute(element, "style", () => element.style.setProperty(name, property.appliedValue, property.appliedPriority));
      }
    }
    for (const [sheet, indices] of retainedStyleRules) {
      if (scope !== null && sheet !== scope.querySelector(`#${STYLE_ID}`)?.sheet) continue;
      for (const index of indices.reverse()) sheet.deleteRule(index);
      retainedStyleRules.delete(sheet);
    }
    const restorations = [];
    managedElements.forEach((state, element) => {
      if (!ownsElement(element)) return;
      const restoreAttribute = (value, name) => {
        mutateAttribute(element, name, () => {
          if (value === null) element.removeAttribute(name);
          else element.setAttribute(name, value);
        });
      };
      state.attributes.forEach((value, name) => {
        if (!transitionAttributes.includes(name)) restoreAttribute(value, name);
      });
      const restoreProperty = (property, name) => {
        // A page may replace an owned inline declaration between refreshes.
        // Adopt that new author baseline instead of restoring stale content.
        if (element.style.getPropertyValue(name) !== property.appliedValue
            || element.style.getPropertyPriority(name) !== property.appliedPriority) {
          property.value = element.style.getPropertyValue(name);
          property.priority = element.style.getPropertyPriority(name);
        }
        const { value, priority } = property;
        mutateAttribute(element, "style", () => {
          if (value) element.style.setProperty(name, value, priority);
          else element.style.removeProperty(name);
        });
      };
      state.properties.forEach((property, name) => {
        if (name !== "transition-property") restoreProperty(property, name);
      });
      restorations.push({ state, element, restoreProperty, restoreAttribute });
    });
    // Restore every inherited font source before releasing any transition
    // guard, including guards on wrappers that never receive Lexend themselves.
    // A microsecond transition still retains its previous computed font during
    // this synchronous measurement and would otherwise scale a child twice.
    for (const { state, element } of restorations) {
      // Font transitions outrank even inline !important. Restore the authored
      // typography and flush it while font transitions are still suppressed;
      // otherwise a transient animated size becomes the next scaled baseline.
      const transition = state.properties.get("transition-property");
      if (transition) getComputedStyle(element).fontSize;
      // Generated content owns its own transitions; a host flush alone does
      // not settle the tooltip's delayed font values. Keep the guards until
      // authored pseudo typography has also been computed.
      for (const pseudo of ["before", "after"]) {
        if (state.attributes.has(`data-lexend-${pseudo}-transition`)) getComputedStyle(element, `::${pseudo}`).fontSize;
      }
    }
    // Resolve all guarded fonts in one read phase. Releasing a guard between
    // reads forces a new style calculation for every animated label.
    for (const { state, element, restoreProperty, restoreAttribute } of restorations) {
      const transition = state.properties.get("transition-property");
      if (transition) restoreProperty(transition, "transition-property");
      for (const name of transitionAttributes) {
        if (state.attributes.has(name)) restoreAttribute(state.attributes.get(name), name);
      }
      if (!state.hadStyle && !element.getAttribute("style")) mutateAttribute(element, "style", () => element.removeAttribute("style"));
    }
    for (const { element } of restorations) managedElements.delete(element);
    if (scope === null) {
      authorFontFamilies.clear();
      eligibleTextRoots.clear();
      transitionRules.clear();
    } else eligibleTextRoots.delete(scope);
  };
  const typographyTransitionProperties = new Set([
    "font", "font-family", "font-size", "line-height", "letter-spacing", "font-stretch", "font-variation-settings"
  ]);
  let otherTransitionProperties;
  const withoutTypographyTransitions = (style) => {
    const split = (value) => value.split(/,(?![^()]*\))/).map((part) => part.trim());
    const properties = split(style.transitionProperty);
    const durations = split(style.transitionDuration);
    const delays = split(style.transitionDelay);
    // Even a zero-duration transition keeps its old computed value until a
    // positive delay expires. That deferred converted size is not an authored
    // baseline and would be scaled again on every intervening refresh.
    if ((!durations.some((duration) => parseFloat(duration) > 0)
        && !delays.some((delay) => parseFloat(delay) > 0))
        || !properties.some((property) => property === "all" || typographyTransitionProperties.has(property))) return null;
    const timings = split(style.transitionTimingFunction);
    const entries = [];
    properties.forEach((property, index) => {
      let expanded;
      if (property === "all") {
        otherTransitionProperties ??= [...style].filter((name) => !typographyTransitionProperties.has(name));
        expanded = otherTransitionProperties;
      } else expanded = typographyTransitionProperties.has(property) ? [] : [property];
      expanded.forEach((name) => entries.push({ name,
        duration: durations[index % durations.length], delay: delays[index % delays.length], timing: timings[index % timings.length]
      }));
    });
    const list = (key) => entries.every((entry) => entry[key] === entries[0]?.[key])
      ? entries[0]?.[key] : entries.map((entry) => entry[key]).join(", ");
    return entries.length ? { property: entries.map((entry) => entry.name).join(", "),
      duration: list("duration"), delay: list("delay"), timing: list("timing") }
      : { property: "none", duration: "0s", delay: "0s", timing: "ease" };
  };
  const readTypography = (style, family = style.fontFamily) => ({
    family, size: style.fontSize,
    line: style.lineHeight, spacing: style.letterSpacing,
    transition: withoutTypographyTransitions(style)
  });
  const measureTypography = (roots, newOnly = false) => {
    const effective = getEffectiveSettings();
    const measurements = [];
    // Do not convert inherited typography above an editor either. A boundary
    // style would serialize into editor HTML; preserving its ancestors avoids
    // that write and leaves mixed ancestor-owned prose in the authored font.
    const editorAncestors = new WeakSet();
    for (const root of roots) {
      const editors = [...root.querySelectorAll(protection.editorSelector)];
      if (root.matches?.(protection.editorSelector)) editors.push(root);
      for (const editor of editors) {
        knownEditorBoundaries.add(editor);
        for (let parent = composedParent(editor); parent; parent = composedParent(parent)) editorAncestors.add(parent);
      }
    }
    const styles = new WeakMap();
    const styleFor = (element) => {
      if (!styles.has(element)) styles.set(element, getComputedStyle(element));
      return styles.get(element);
    };
    for (const root of roots) for (const element of allElements(root)) {
      if (editorAncestors.has(element) || newOnly && managedElements.has(element)) continue;
      const style = styleFor(element);
      const family = newOnly ? authorFontFamilies.get(style.fontFamily) ?? style.fontFamily : style.fontFamily;
      const semanticProtection = hasProtectedAncestor(element);
      const inScope = effective.scope === "all" || !isHeading(element);
      const text = ownTextContent(element);
      const mixedGlyphProse = containsPrivateGlyph(text) && !onlyPrivateGlyphs(text);
      const protectedText = semanticProtection || codeFont.test(family)
        || (!mixedGlyphProse && protectedFont(family)) || onlyPrivateGlyphs(text)
        || isImageReplacementText(element, style, styleFor) || hasEmptyPaintClip(element, style, styleFor) || !inScope;
      const target = !protectedText && inScope && (Boolean(text.trim()) || isTextControl(element));
      const pseudos = [];
      // Generated text can be the only label, or an icon whose family would
      // otherwise inherit Lexend from its newly converted parent.
      for (const pseudo of ["before", "after"]) {
        const pseudoStyle = getComputedStyle(element, `::${pseudo}`);
        if (["none", "normal", '""', "''"].includes(pseudoStyle.content)) continue;
        const paintedContent = paintedGeneratedContent(pseudoStyle.content);
        const mixedPseudo = containsPrivateGlyph(paintedContent) && !onlyPrivateGlyphs(paintedContent);
        const pseudoFamily = newOnly ? authorFontFamilies.get(pseudoStyle.fontFamily) ?? pseudoStyle.fontFamily : pseudoStyle.fontFamily;
        pseudos.push({ pseudo, noTracking: /\p{Script=Arabic}/u.test(paintedContent), protected: protectedText || codeFont.test(pseudoFamily)
          || (!mixedPseudo && protectedFont(pseudoFamily)) || onlyPrivateGlyphs(paintedContent),
          inScope, typography: { ...readTypography(pseudoStyle, pseudoFamily), symbols: !semanticProtection && !codeFont.test(pseudoFamily) && containsPrivateGlyph(paintedContent) } });
      }
      const typography = { ...readTypography(style, family), symbols: !semanticProtection && !codeFont.test(family) && containsPrivateGlyph(text) };
      if (protectedText || target || pseudos.length || typography.transition !== null) measurements.push({
        element, protected: protectedText, target, noTracking: /\p{Script=Arabic}/u.test(text), typography, pseudos
      });
      if (target) {
        if (!eligibleTextRoots.has(root)) eligibleTextRoots.set(root, new Set());
        eligibleTextRoots.get(root).add(element);
      }
    }
    return measurements;
  };
  const applyTypography = (measurements, fontOnly = false, roots = styledRoots) => {
    measurements.forEach(({ typography, pseudos }) => {
      for (const values of [typography, ...pseudos.map(({ typography }) => typography)]) {
        if (values.transition !== null && !transitionRules.has(values.transition.property)) {
          transitionRules.set(values.transition.property, transitionRules.size);
        }
      }
    });
    const transitionCss = [...transitionRules].map(([property, id]) => `
      [data-lexend-transition='${id}'] { --lexend-transition-property: ${property}; }
      ${["before", "after"].map((pseudo) => `[data-lexend-${pseudo}-transition='${id}']::${pseudo} {
        transition-property: ${property} !important;
        transition-duration: var(--lexend-${pseudo}-transition-duration) !important;
        transition-delay: var(--lexend-${pseudo}-transition-delay) !important;
        transition-timing-function: var(--lexend-${pseudo}-transition-timing) !important;
      }`).join("\n")}
    `).join("\n");
    // These declarations stay enabled during baseline measurement so temporary
    // typography removal cannot restart the page's original font transitions.
    roots.forEach((root) => {
      let style = root.querySelector(`#${TRANSITION_STYLE_ID}`);
      if (!style) { style = document.createElement("style"); style.id = TRANSITION_STYLE_ID; root.append(style); }
      if (style.textContent !== transitionCss) style.textContent = transitionCss;
    });
    const applyTransition = (element, values, prefix = "") => {
      if (values.transition !== null) {
        let transitionId = transitionRules.get(values.transition.property);
        if (transitionId === undefined) {
          transitionId = transitionRules.size;
          transitionRules.set(values.transition.property, transitionId);
        }
        // Author rules sometimes inspect style substrings such as border-width
        // and turn them into painted borders. Keep the expanded transition
        // list in our stylesheet, with only a variable reference inline.
        setAttribute(element, `data-lexend-${prefix}transition`, String(transitionId));
        if (prefix) {
          setProperty(element, `--lexend-${prefix}transition-duration`, values.transition.duration);
          setProperty(element, `--lexend-${prefix}transition-delay`, values.transition.delay);
          setProperty(element, `--lexend-${prefix}transition-timing`, values.transition.timing);
        } else {
          setProperty(element, "transition-property", "var(--lexend-transition-property)", "important");
          setProperty(element, "transition-duration", values.transition.duration, "important");
          setProperty(element, "transition-delay", values.transition.delay, "important");
          setProperty(element, "transition-timing-function", values.transition.timing, "important");
        }
      }
    };
    // Suppress inherited typography transitions before changing any parent
    // font. A wrapper with no own text can animate its child's inherited size.
    measurements.forEach(({ element, typography, pseudos }) => {
      applyTransition(element, typography);
      pseudos.forEach(({ pseudo, typography: values, protected: protectedPseudo, inScope }) => {
        if (protectedPseudo || inScope) applyTransition(element, values, `${pseudo}-`);
      });
    });
    const applyValues = (element, values, protectedText, prefix = "", noTracking = false) => {
      const scale = protectedText ? 1 : settings.textScale / 100;
      // Joining Arabic glyphs gain no readability from added tracking, and a
      // fixed label can lose its first character when tracking is applied.
      const scalePixels = (value) => value.endsWith("px") ? `${parseFloat(value) * scale}px` : value;
      const spacing = !protectedText && settings.letterSpacing > 0
        ? noTracking ? "0px" : `${settings.letterSpacing}em` : scalePixels(values.spacing);
      // Computed unitless/em line heights arrive in pixels. Keep the site's
      // reading rhythm when scaling its letters instead of squeezing enlarged
      // glyphs into the old line box. `normal` remains font-dependent.
      const line = !protectedText && settings.lineHeight > 0 ? String(settings.lineHeight) : scalePixels(values.line);
      // Site fonts must resolve their own private-use icons before Nerd Fonts:
      // unrelated icon sets can assign different artwork to the same codepoint.
      // Semantic opt-outs and code keep their original families unchanged.
      const fallback = `, "${SYMBOLS_FAMILY}"`;
      const family = protectedText ? values.family + (values.symbols ? fallback : "")
        : `"Lexend for the Web", ${values.family}${fallback}`;
      authorFontFamilies.set(family, values.family);
      setProperty(element, `--lexend-${prefix}family`, family);
      if (fontOnly) {
        if (!prefix) setProperty(element, "font-family", family, "important");
        return;
      }
      setProperty(element, `--lexend-${prefix}size`, `${parseFloat(values.size) * scale}px`);
      setProperty(element, `--lexend-${prefix}line`, line);
      setProperty(element, `--lexend-${prefix}spacing`, spacing);
      if (!prefix) {
        // Inline important declarations also defeat author inline-important
        // typography while retaining its exact value for disable/refresh.
        setProperty(element, "font-family", family, "important");
        setProperty(element, "font-size", `${parseFloat(values.size) * scale}px`, "important");
        setProperty(element, "line-height", line, "important");
        setProperty(element, "letter-spacing", spacing, "important");
      }
    };
    measurements.forEach(({ element, protected: protectedText, target, noTracking, typography, pseudos }) => {
      if (protectedText || target) {
        setAttribute(element, fontOnly ? FONT_ATTRIBUTE : protectedText ? PROTECTED_ATTRIBUTE : TEXT_ATTRIBUTE, "");
        applyValues(element, typography, protectedText, "", noTracking);
      }
      pseudos.forEach(({ pseudo, protected: protectedPseudo, noTracking: pseudoNoTracking, inScope, typography: values }) => {
        if (!protectedPseudo && !inScope) return;
        setAttribute(element, `data-lexend-${pseudo}`, fontOnly ? "font" : protectedPseudo ? "protected" : "text");
        applyValues(element, values, protectedPseudo, `${pseudo}-`, pseudoNoTracking);
      });
      const state = managedElements.get(element);
      if (state) setAttribute(element, "data-lexend-original-typography", JSON.stringify({
        hadStyle: state.hadStyle,
        properties: [...state.properties].map(([name, { value, priority }]) => [name, value, priority])
      }));
    });
  };
  const installFontStyle = (root) => {
    if (protection.editorOwned(root instanceof ShadowRoot ? root.host : root)) return;
    // Font declarations stay enabled while measuring author typography.
    // Disabling/re-enabling @font-face repeatedly emits loadingdone events
    // even with cached files, which would perpetually schedule new baselines.
    let fontStyle = root.querySelector(`#${FONT_STYLE_ID}`);
    if (!fontStyle) {
      fontStyle = document.createElement("style");
      fontStyle.id = FONT_STYLE_ID;
      fontStyle.textContent = getFontFaceCss();
      root.append(fontStyle);
    }
  };
  const applyToRoot = (root) => {
    if (protection.editorOwned(root instanceof ShadowRoot ? root.host : root)) return;
    installFontStyle(root);
    let style = root.querySelector(`#${STYLE_ID}`);
    if (!style) {
      style = document.createElement("style");
      style.id = STYLE_ID;
      // First-layer important rules must precede author layers in this shadow
      // tree; adopted stylesheets follow its ordinary style elements.
      if (root instanceof ShadowRoot) root.prepend(style);
      else root.append(style);
    }
    const css = createCss(getEffectiveSettings());
    if (style.textContent !== css) style.textContent = css;
    styledRoots.add(root);
  };
  // Classification can move an element across a protection boundary; author
  // typography and geometry may affect ancestors/siblings through selectors.
  // All retain the conservative capture fallback, but only this finite state
  // vocabulary is observed. Work is coalesced by first-old/final value below.
  const observedAttributeKinds = Object.freeze({
    role: "classification", "aria-multiline": "classification", contenteditable: "classification", "data-lexend-ignore": "classification", "data-icon": "classification",
    class: "typography", style: "typography", "data-state": "typography",
    hidden: "geometry", "aria-hidden": "geometry", open: "geometry", "aria-expanded": "geometry", "aria-selected": "geometry", "aria-pressed": "geometry"
  });
  const observedAttributes = Object.keys(observedAttributeKinds);
  const observeRoots = () => {
    // Blink can keep CSSOM-only styles physically absent until serialization.
    // Materialize each written attribute once before returning it to authors;
    // otherwise their later removeAttribute can recreate style="" natively.
    for (const element of pendingStyleWrites) element.getAttribute("style");
    pendingStyleWrites.clear();
    if (!isActive() || protection.editorDocument()) return;
    observer.observe(document, { childList: true, subtree: true, characterData: true, characterDataOldValue: true,
      attributes: true, attributeOldValue: true, attributeFilter: observedAttributes });
    styledRoots.forEach((root) => {
      if (root instanceof ShadowRoot) observer.observe(root, { childList: true, subtree: true,
        characterData: true, characterDataOldValue: true, attributes: true, attributeOldValue: true, attributeFilter: observedAttributes });
    });
  };
  const visitShadowRoots = (root) => {
    if (protection.editorOwned(root instanceof ShadowRoot ? root.host : root)) return;
    const walker = document.createTreeWalker(root, NodeFilter.SHOW_ELEMENT, {
      acceptNode: (element) => element.matches(protection.editorSelector) ? NodeFilter.FILTER_REJECT : NodeFilter.FILTER_ACCEPT
    });
    let element;
    while ((element = walker.nextNode())) if (element.shadowRoot) {
      applyToRoot(element.shadowRoot);
      visitShadowRoots(element.shadowRoot);
    }
  };
  const applyIncomingFonts = (branches, fontOnly = true) => {
    if (!isActive() || !document.documentElement || !branches.size) return;
    adoptStyleMutations(observer.takeRecords());
    observer.disconnect();
    try {
      applyToRoot(document.documentElement);
      const roots = new Set(branches);
      for (const branch of branches) {
        if (protection.editorOwned(branch)) continue;
        if (branch.shadowRoot) { applyToRoot(branch.shadowRoot); roots.add(branch.shadowRoot); }
        const previousRoots = new Set(styledRoots);
        visitShadowRoots(branch);
        if (branch.shadowRoot) visitShadowRoots(branch.shadowRoot);
        for (const root of styledRoots) if (!previousRoots.has(root)) roots.add(root);
        // A mutation can originate inside an already discovered shadow tree.
        const tree = branch.getRootNode();
        if (tree instanceof ShadowRoot) applyToRoot(tree);
      }
      recoverClonedTypography(roots);
      // Resolve inherited families through the exact stacks we applied. New
      // code and icons keep the author's family without temporarily stripping
      // typography from the rest of the page or rerunning geometry repairs.
      const measurements = measureTypography(roots, true);
      applyTypography(measurements, fontOnly);
    } catch (error) {
      lastRefreshError = error instanceof Error ? error.message : String(error);
      console.warn("Lexend for the Web could not apply incoming fonts.", error);
    } finally { observeRoots(); }
  };
  const cancelPendingRepair = () => {
    const pending = pendingRepair !== null;
    if (repairFrame !== null) cancelAnimationFrame(repairFrame);
    repairFrame = null;
    pendingRepair = null;
    return pending;
  };
  const createViewportStyleWitness = (guards) => {
    const records = [], expected = new WeakSet();
    const witness = new MutationObserver((batch) => records.push(...batch));
    for (const element of guards.keys()) witness.observe(element, { attributes: true, attributeOldValue: true, attributeFilter: ["style"] });
    const drain = () => records.push(...witness.takeRecords());
    const flush = () => {
      drain();
      adoptStyleMutations(records.splice(0), expected);
    };
    return {
      flush,
      begin(element, name) {
        if (name !== "style" || !guards.has(element)) return null;
        flush();
        const oldValue = element.getAttribute("style");
        return () => {
          drain();
          const first = records[0];
          if (first?.target === element && first.oldValue === oldValue) expected.add(first);
          const next = records.slice(1).find((record) => record.target === element);
          const applied = { value: next ? next.oldValue : element.getAttribute("style") };
          flush();
          return applied;
        };
      },
      stop() { try { flush(); } finally { witness.disconnect(); } }
    };
  };
  const withViewportPreserved = (callback) => {
    refreshing = true;
    disconnectObserver();
    let focusedElement = document.activeElement;
    while (focusedElement?.shadowRoot?.activeElement) focusedElement = focusedElement.shadowRoot.activeElement;
    const ownedTableChild = (element) => element?.matches?.("[data-lexend-layout-repair~='scroll-table']")
      ? [...element.children].find((child) => child.tagName === "TABLE") ?? null : null;
    const focusedTable = ownedTableChild(focusedElement);
    const scrollPosition = { x: scrollX, y: scrollY };
    const rootStyle = document.documentElement.style;
    const anchor = { value: rootStyle.getPropertyValue("overflow-anchor"), priority: rootStyle.getPropertyPriority("overflow-anchor"), hadStyle: getStylePresence(document.documentElement) };
    const body = document.body;
    const primaryBodyScroller = body && !protection.editorOwned(body) && /^(auto|scroll)$/.test(getComputedStyle(body).overflowY)
      && body.clientHeight >= innerHeight * 0.8 && body.clientHeight <= innerHeight + 64
      && body.scrollHeight > body.clientHeight + 2;
    const bodyScroll = primaryBodyScroller ? { x: body.scrollLeft, y: body.scrollTop,
      value: body.style.getPropertyValue("overflow-anchor"), priority: body.style.getPropertyPriority("overflow-anchor"),
      hadStyle: getStylePresence(body) } : null;
    const nestedScrollers = new Map();
    for (const root of new Set([document.documentElement, ...styledRoots])) {
      if (protection.editorDocument()) break;
      root.querySelectorAll("*").forEach((element) => {
        if (!element.style || element === body || element === document.documentElement) return;
        const x = element.scrollLeft, y = element.scrollTop;
        if ((!x && !y) || protection.editorOwned(element)) return;
        nestedScrollers.set(element, { x, y,
          value: element.style.getPropertyValue("overflow-anchor"), priority: element.style.getPropertyPriority("overflow-anchor"),
          hadStyle: getStylePresence(element), table: ownedTableChild(element) });
      });
    }
    // Read every scroll offset before changing styles; interleaving these
    // writes with geometry reads forces layout repeatedly on dashboard pages.
    if (!protection.editorOwned(document.documentElement)) viewportStyleGuards.set(document.documentElement, anchor);
    if (bodyScroll) viewportStyleGuards.set(body, bodyScroll);
    for (const [element, position] of nestedScrollers) viewportStyleGuards.set(element, position);
    viewportStyleWitness = createViewportStyleWitness(viewportStyleGuards);
    const restoreAnchor = (element, position) => {
      viewportStyleWitness.flush();
      if (element.style.getPropertyValue("overflow-anchor") === "none"
          && element.style.getPropertyPriority("overflow-anchor") === "important") {
        mutateAttribute(element, "style", () => {
          if (position.value) element.style.setProperty("overflow-anchor", position.value, position.priority);
          else element.style.removeProperty("overflow-anchor");
        });
      }
      if (!position.hadStyle && !element.getAttribute("style")) mutateAttribute(element, "style", () => element.removeAttribute("style"));
    };
    if (!protection.editorOwned(document.documentElement)) mutateAttribute(document.documentElement, "style", () => rootStyle.setProperty("overflow-anchor", "none", "important"));
    if (bodyScroll) mutateAttribute(body, "style", () => body.style.setProperty("overflow-anchor", "none", "important"));
    for (const element of nestedScrollers.keys()) mutateAttribute(element, "style", () => element.style.setProperty("overflow-anchor", "none", "important"));
    let refreshError = null;
    try {
      callback();
    } catch (error) {
      refreshError = error;
    } finally {
      // A temporary author-layout baseline must never move the user's viewport.
      // Flush final geometry, then restore position (naturally clamped if the
      // finished page is shorter) before re-enabling native scroll anchoring.
      try {
        document.documentElement.getBoundingClientRect();
        const focusTarget = focusedElement?.isConnected ? focusedElement : focusedTable?.parentElement;
        if (focusTarget && !protection.editorOwned(focusTarget) && focusTarget !== document.body && focusTarget !== document.documentElement
            && (!focusedTable || focusTarget.matches("[data-lexend-layout-repair~='scroll-table']"))) {
          focusTarget.focus({ preventScroll: true });
        }
        nestedScrollers.forEach((position, originalElement) => {
          const element = originalElement.isConnected ? originalElement : position.table?.parentElement;
          if (!element?.isConnected || (position.table && !element.matches("[data-lexend-layout-repair~='scroll-table']"))) return;
          element.scrollTo({ left: position.x, top: position.y, behavior: "instant" });
          // A replacement table wrapper never received the old guard write.
          if (element === originalElement) restoreAnchor(element, position);
        });
        window.scrollTo({ left: scrollPosition.x, top: scrollPosition.y, behavior: "instant" });
        if (bodyScroll && body.isConnected) {
          body.scrollTo({ left: bodyScroll.x, top: bodyScroll.y, behavior: "instant" });
          restoreAnchor(body, bodyScroll);
        }
        if (!protection.editorOwned(document.documentElement)) {
          restoreAnchor(document.documentElement, anchor);
        }
        // An already focused action does not emit focusin again when its pane
        // grows. Recheck its repaired vertical viewport after restoring saved
        // offsets; ordinary page/table scrollers remain under native control.
        if (!refreshError && isLayoutRepairActive() && focusTarget?.isConnected && !protection.editorOwned(focusTarget)) globalThis.LexendControls?.revealFocused?.(focusTarget);
      } catch (error) { refreshError ??= error; }
      finally {
        try { viewportStyleWitness.stop(); }
        catch (error) { refreshError ??= error; }
        finally { viewportStyleWitness = null; viewportStyleGuards.clear(); }
        refreshing = false;
        try { observeRoots(); }
        catch (error) { refreshError ??= error; }
      }
    }
    return refreshError;
  };
  const budgetRefresh = (duration, regional = false) => {
    // Count synchronous work in both phases, excluding time spent waiting for
    // a rendering frame or coalescing author changes.
    // A cheaper regional pass still consumes the same share of a busy stream.
    const finished = performance.now();
    nextRefreshTime = finished + (regional || duration > 50 ? duration * 4 : 0);
  };
  const clearPendingRegions = () => {
    pendingRegions = null;
    queuedGlobalRefresh = false;
  };
  // CSS containment does not isolate selectors. Only a closed layout surface
  // inside an open shadow tree can qualify, and any unobservable stylesheet
  // change must first return the page to the normal full capture.
  const snapshotAuthorStylesheets = () => {
    try {
      const records = [];
      const staticPseudos = new Set(["root", "scope", "empty", "first-child", "last-child", "only-child",
        "first-of-type", "last-of-type", "only-of-type", "nth-child", "nth-last-child", "nth-of-type", "nth-last-of-type",
        "is", "where", "not", "has", "host", "host-context"]);
      const staticElements = new Set(["before", "after", "slotted"]);
      const staticSelector = (selector) => {
        if (selector.includes("\\") || selector.includes("&")) return false;
        let known = true;
        const rest = selector.replace(/(::?)([-a-zA-Z_][-a-zA-Z_0-9]*)/g, (token, prefix, name) => {
          const allowed = prefix === "::" ? staticElements : staticPseudos;
          if (!allowed.has(name.toLowerCase())) known = false;
          return "";
        });
        return known && !rest.includes(":");
      };
      const staticDeclarations = (cssText) => {
        if (cssText.includes("\\")) return false;
        for (const match of cssText.matchAll(/\bvar\s*\(\s*([^,\s)]+)/gi)) {
          if (!/^--lexend-[a-zA-Z0-9_-]+$/.test(match[1])) return false;
        }
        return true;
      };
      const serializeRules = (rules) => [...rules].map((rule) => {
        const layer = ["CSSLayerBlockRule", "CSSLayerStatementRule"].includes(rule.constructor.name);
        if (![1, 4, 5, 12].includes(rule.type) && !layer) throw new Error("Unsupported stylesheet rules require a full capture.");
        if (rule.type === 1 && !staticSelector(rule.selectorText)) throw new Error("Stateful selectors require a full capture.");
        if (rule.style && !staticDeclarations(rule.style.cssText)) throw new Error("Author variables require a full capture.");
        const media = rule.type === 4 ? String(matchMedia(rule.conditionText).matches) : "";
        const supports = rule.type === 12 ? String(CSS.supports(rule.conditionText)) : "";
        return [rule.cssText, media, supports, rule.cssRules ? serializeRules(rule.cssRules) : ""];
      });
      for (const root of new Set([document, ...[...styledRoots].filter((root) => root instanceof ShadowRoot)])) {
        // Manual slot assignment can change another component's composed tree
        // without a DOM mutation. Keep pages containing slots on full capture.
        if (root instanceof ShadowRoot && root.querySelector("slot")) return null;
        for (const element of root.querySelectorAll("[style]")) {
          const cssText = element.getAttribute("style") ?? "";
          // Most declarations and saved author values contain no dynamic
          // variables. They need no canonical CSS parsing or JSON round trip.
          // Inspect originals too: our applied pixels may mask an author var().
          let staticInline = !/[\u0000-\u001f\u007f']/.test(cssText) && !cssText.includes("/*") && staticDeclarations(cssText);
          if (staticInline) for (const property of managedElements.get(element)?.properties.values() ?? []) {
            if (property.value && (/[\u0000-\u001f\u007f']/.test(property.value) || property.value.includes("/*") || !staticDeclarations(property.value))) { staticInline = false; break; }
          }
          if (staticInline) continue;
          const declarations = JSON.parse(authorStyleSignature(element, cssText));
          if (declarations.some(([, value]) => !staticDeclarations(value))) return null;
        }
        const sheets = root === document ? [...document.styleSheets]
          : [...root.querySelectorAll("style,link[rel~='stylesheet']")].map((element) => element.sheet);
        sheets.push(...(root.adoptedStyleSheets ?? []));
        for (const sheet of sheets) {
          // The page can mutate our sheets too; an element ID is not an
          // ownership guarantee and must never exempt CSSOM from this check.
          if (!sheet) return null;
          const media = sheet.media?.mediaText ?? "";
          records.push({ root, sheet, value: JSON.stringify([sheet.disabled, media,
            media ? matchMedia(media).matches : true, serializeRules(sheet.cssRules)]) });
        }
      }
      return records;
    } catch { return null; }
  };
  const snapshotNativeState = () => {
    try {
      const focus = [];
      for (let element = document.activeElement; element; element = element.shadowRoot?.activeElement) focus.push(element);
      const controls = [], topLayer = [];
      const validityFlags = ["badInput", "customError", "patternMismatch", "rangeOverflow", "rangeUnderflow", "stepMismatch",
        "tooLong", "tooShort", "typeMismatch", "valid", "valueMissing"];
      for (const root of new Set([document, ...[...styledRoots].filter((root) => root instanceof ShadowRoot)])) {
        for (const element of root.querySelectorAll(":popover-open,:modal,:fullscreen")) topLayer.push(element);
        for (const element of root.querySelectorAll("input,textarea,select,option,button,fieldset,output")) {
          controls.push({ element, form: element.form, value: JSON.stringify([
            element.value, element.defaultValue, element.checked, element.defaultChecked, element.indeterminate,
            element.selected, element.defaultSelected, element.selectedIndex, element.disabled, element.readOnly,
            element.required, element.multiple, element.type, element.willValidate, element.selectionStart,
            element.selectionEnd, element.selectionDirection,
            element.validity ? validityFlags.map((name) => element.validity[name]) : null
          ]) });
        }
      }
      if (!document.fonts?.[Symbol.iterator]) return null;
      const fontDescriptors = ["family", "style", "weight", "stretch", "unicodeRange", "variant", "featureSettings",
        "variationSettings", "display", "ascentOverride", "descentOverride", "lineGapOverride", "sizeAdjust", "status"];
      const fonts = [...document.fonts].map((face) => ({ face, value: JSON.stringify(fontDescriptors.map((name) => face[name])) }));
      return { url: location.href, focus, topLayer, controls, fonts, fontStatus: document.fonts.status };
    } catch { return null; }
  };
  const nativeStateUnchanged = () => {
    if (nativeStateSnapshot === null) return false;
    const current = snapshotNativeState(), previous = nativeStateSnapshot;
    return current !== null && current.url === previous.url && current.fontStatus === previous.fontStatus
      && current.focus.length === previous.focus.length && current.focus.every((element, index) => element === previous.focus[index])
      && current.topLayer.length === previous.topLayer.length && current.topLayer.every((element, index) => element === previous.topLayer[index])
      && current.controls.length === previous.controls.length && current.controls.every((record, index) =>
        record.element === previous.controls[index].element && record.form === previous.controls[index].form
          && record.value === previous.controls[index].value)
      && current.fonts.length === previous.fonts.length && current.fonts.every((record, index) =>
        record.face === previous.fonts[index].face && record.value === previous.fonts[index].value);
  };
  const authorStylesheetsUnchanged = () => {
    if (authorStylesheetSnapshot === null) return false;
    const current = snapshotAuthorStylesheets();
    return current !== null && current.length === authorStylesheetSnapshot.length
      && current.every((record, index) => record.root === authorStylesheetSnapshot[index].root
        && record.sheet === authorStylesheetSnapshot[index].sheet && record.value === authorStylesheetSnapshot[index].value);
  };
  const canRefreshRegion = (root) => {
    if (!(root instanceof ShadowRoot) || root.host.shadowRoot !== root || !styledRoots.has(root)
        || !root.host.isConnected || window !== window.top) return false;
    const host = root.host;
    if (host.childNodes.length || protection.editorOwned(host) || protection.protected(host)) return false;
    const css = getComputedStyle(host), containment = new Set(css.contain.split(/\s+/));
    if (!(containment.has("strict") || ["size", "layout", "style", "paint"].every((value) => containment.has(value)))
        || !["block", "flow-root"].includes(css.display) || !["static", "relative"].includes(css.position)
        || ![css.overflowX, css.overflowY].every((value) => ["auto", "scroll"].includes(value))
        || css.display === "none" || css.visibility !== "visible" || Number(css.opacity) === 0
        || !host.getClientRects().length || host.checkVisibility && !host.checkVisibility({ contentVisibilityAuto: true })) return false;
    for (let current = host; current; current = composedParent(current)) {
      if (managedElements.has(current) || current.matches("[dir='auto' i],bdi")) return false;
    }
    if (root.querySelector(`slot,iframe,frame,bdi,[dir='auto' i],${protection.editorSelector},${protection.semanticSelector}`)) return false;
    for (const element of root.querySelectorAll("*")) if (element.shadowRoot) return false;
    return layout?.canRefreshRegion?.(root) === true;
  };
  const regionalMutationRoots = (mutations) => {
    if (!isLayoutRepairActive() || !mutations.length || initializing || refreshing || restoringChanges !== null || pendingRepair !== null
        || repairFrame !== null || refreshRevision === 0 || lastRefreshError !== null || !settingsLoaded) return null;
    const roots = new Set();
    for (const mutation of mutations) {
      if (mutation.type !== "characterData" || !mutation.oldValue?.trim() || !mutation.target.data.trim()
          || !managedElements.has(mutation.target.parentElement)) return null;
      const root = mutation.target.getRootNode();
      if (!(root instanceof ShadowRoot) || !styledRoots.has(root)) return null;
      roots.add(root);
    }
    return roots;
  };
  const completeRefresh = (refreshError, completedConversion = true, duration = 0, regional = false) => {
    const completionStarted = performance.now();
    if (refreshError) {
      lastRefreshError = refreshError instanceof Error ? refreshError.message : String(refreshError);
      if (warnedRefreshError !== lastRefreshError) {
        console.warn("Lexend for the Web could not refresh the page.", refreshError);
        warnedRefreshError = lastRefreshError;
      }
    } else {
      lastRefreshError = null;
      warnedRefreshError = null;
      if (completedConversion) refreshRevision++;
      // A global repair restores earlier overrides, including those belonging
      // to a subtree that has since been skipped. Only painted subtrees have
      // a valid baseline from this refresh; returning to an omitted subtree
      // must trigger another capture even without an author mutation/resize.
      if (!regional && isLayoutRepairActive()) {
        authorStylesheetSnapshot = [...styledRoots].some((root) => root instanceof ShadowRoot && canRefreshRegion(root))
          ? snapshotAuthorStylesheets() : null;
        nativeStateSnapshot = authorStylesheetSnapshot === null ? null : snapshotNativeState();
        revealedAutoContent = new WeakSet();
        for (const [target, skipped] of knownAutoContent) {
          if (!target.isConnected) { knownAutoContent.delete(target); continue; }
          const child = target.firstElementChild;
          const painted = child?.checkVisibility
            ? child.checkVisibility({ contentVisibilityAuto: true }) : !skipped;
          if (painted) revealedAutoContent.add(target);
        }
      }
      notifyFrameRequirement();
    }
    // Large pages can spend hundreds of milliseconds in a full repair. Give
    // the site four times that duration to handle input and paint before the
    // next automatic pass. Incoming text receives its font independently.
    budgetRefresh(duration + performance.now() - completionStarted, regional);
    notifyState();
  };
  const refresh = (preserveHidden = false, priorDuration = 0) => {
    refreshTimer = null;
    refreshUrgent = false;
    refreshRequired = false;
    pendingAriaChanges.clear();
    pendingStyleChanges.clear();
    pendingStateChanges.clear();
    clearPendingRegions();
    authorStylesheetSnapshot = null;
    nativeStateSnapshot = null;
    if (refreshing || !document.documentElement) return;
    const started = performance.now();
    cancelPendingRepair();
    const focused = document.activeElement && !document.activeElement.matches("body,html");
    if (retentionTimer !== null) clearTimeout(retentionTimer);
    retentionTimer = null;
    retainedTypography = new WeakSet();
    retentionWrites = new WeakMap();
    let deferred = false;
    const error = withViewportPreserved(() => {
      for (const [frame, state] of resizedFrames) {
        // Disposal precedes geometry reads: document editing and a protected
        // member of this independent ownership group cannot retain old repairs.
        if (!isLayoutRepairActive() || frameTouchesEditor(frame, state)) { restoreFrame(frame); continue; }
        let hidden = !frame.isConnected || !frame.getClientRects().length;
        for (let current = frame; !hidden && current; current = current.parentElement) {
          const css = getComputedStyle(current);
          hidden = css.display === "none" || css.visibility === "hidden" || Number(css.opacity) === 0;
        }
        // An embed may be removed before its child can relay a null request.
        // Restore its surrounding footprint while preserving the site's own
        // close-state mutations, even when typography remains enabled.
        if (hidden) restoreFrame(frame);
      }
      layout?.restore({ preserveHidden: isLayoutRepairActive() && preserveHidden });
      if (!isLayoutRepairActive()) layout?.dispose();
      recoverClonedTypography(new Set([document.documentElement, ...styledRoots]));
      clearTypography();
      knownEditorBoundaries = new WeakSet();
      for (const root of styledRoots) {
        if (root.isConnected && !protection.editorOwned(root instanceof ShadowRoot ? root.host : root)) continue;
        for (const id of ownStyleIds) root.querySelector(`#${id}`)?.remove();
        styledRoots.delete(root);
      }
      if (!isActive() || protection.editorDocument()) {
        layout?.dispose();
        for (const root of styledRoots) for (const id of ownStyleIds) root.querySelector(`#${id}`)?.remove();
        styledRoots.clear(); knownAutoContent.clear();
        return;
      }
      applyToRoot(document.documentElement);
      visitShadowRoots(document.documentElement);
      if (isActive()) {
        const roots = [...styledRoots];
        // Layout and typography ownership have already been restored above.
        // Keep the now-inert stylesheet active: toggling its cascade layer
        // recreates author FontFaces in Chromium, whose loadingdone events
        // would schedule another capture indefinitely.
        const measurements = measureTypography(roots);
        if (isLayoutRepairActive()) layout?.capture(roots, { preserveHidden });
        applyTypography(measurements);
        // Automatic recaptures must restore existing repairs before painting,
        // so ordinary site animations cannot alternate between repaired and
        // unrepaired layouts. Startup and explicit preference changes keep
        // their early font paint. Hidden tabs cannot depend on frames either.
        const keepLayoutStable = preserveHidden && refreshRevision > 0;
        if (isLayoutRepairActive()) {
          if (keepLayoutStable || repairSynchronously || focused || document.visibilityState === "hidden" || window !== window.top) layout?.repair(settings);
          else deferred = true;
        }
      }
    });
    const duration = priorDuration + performance.now() - started;
    repairSynchronously = false;
    if (error || !deferred) { completeRefresh(error, true, duration); return; }
    refreshRevision++;
    budgetRefresh(duration);
    pendingRepair = () => {
      pendingRepair = null;
      repairFrame = null;
      const started = performance.now();
      const error = withViewportPreserved(() => { if (isLayoutRepairActive()) layout?.repair(settings); });
      completeRefresh(error, false, duration + performance.now() - started);
    };
    // Let converted text paint before the expensive geometry repair. A second
    // frame keeps that repair out of the first font paint's rendering task.
    // The saved native baseline belongs to this conversion only; new settings
    // or author mutations cancel it before another capture can replace it.
    repairFrame = requestAnimationFrame(() => {
      repairFrame = requestAnimationFrame(() => pendingRepair?.());
    });
  };
  const createRegionalMutationWitness = (roots) => {
    const records = [], expected = new WeakSet(), changes = new Map();
    const outsideAttributes = new Map(), outsideText = new Map();
    const scopes = new Set(roots);
    let processed = 0, unexpectedInternal = false, outsideStructure = false;
    const append = (batch) => { for (const record of batch) records.push(record); };
    const witness = new MutationObserver(append);
    const options = { subtree: true, childList: true, characterData: true,
      characterDataOldValue: true, attributes: true, attributeOldValue: true };
    witness.observe(document, options);
    for (const root of styledRoots) if (root instanceof ShadowRoot) witness.observe(root, options);
    const drain = () => append(witness.takeRecords());
    const attributeValue = (record) => record.attributeNamespace === null
      ? record.target.getAttribute(record.attributeName)
      : record.target.getAttributeNS(record.attributeNamespace, record.attributeName);
    const attributeKey = (record) => `${record.attributeNamespace ?? ""}\u0000${record.attributeName}`;
    const changeFor = (element) => {
      if (!changes.has(element)) changes.set(element, { properties: new Map(), attributes: new Map(), stylePresent: undefined });
      return changes.get(element);
    };
    const beforeStyle = document.createElement("span").style;
    const afterStyle = document.createElement("span").style;
    const process = () => {
      drain();
      const batch = records.slice(processed), after = new Map(), tails = new Map();
      for (let index = batch.length - 1; index >= 0; index--) {
        const record = batch[index];
        if (record.type !== "attributes" && record.type !== "characterData") continue;
        let values = tails.get(record.target);
        if (!values) tails.set(record.target, values = new Map());
        const key = record.type === "attributes" ? attributeKey(record) : "text";
        after.set(record, values.has(key) ? values.get(key)
          : record.type === "attributes" ? attributeValue(record) : record.target.data);
        values.set(key, record.oldValue);
      }
      for (const record of batch) {
        if (expected.has(record)) continue;
        const internal = scopes.has(record.target.getRootNode());
        if (internal) unexpectedInternal = true;
        else if (record.type === "childList") outsideStructure = true;
        if (record.type === "attributes") {
          const value = after.get(record);
          if (!internal) {
            let attributes = outsideAttributes.get(record.target);
            if (!attributes) outsideAttributes.set(record.target, attributes = new Map());
            const key = attributeKey(record);
            if (!attributes.has(key)) attributes.set(key, { record, before: record.oldValue, after: value });
            else attributes.get(key).after = value;
          }
          if (record.attributeNamespace !== null) continue;
          const change = changeFor(record.target);
          if (record.attributeName !== "style") change.attributes.set(record.attributeName, value);
          else {
            beforeStyle.cssText = record.oldValue ?? "";
            afterStyle.cssText = value ?? "";
            for (const name of new Set([...beforeStyle, ...afterStyle])) {
              const next = { value: afterStyle.getPropertyValue(name), priority: afterStyle.getPropertyPriority(name) };
              if (beforeStyle.getPropertyValue(name) !== next.value || beforeStyle.getPropertyPriority(name) !== next.priority) {
                change.properties.set(name, next);
              }
            }
            change.stylePresent = value !== null;
          }
        } else if (record.type === "characterData" && !internal) {
          if (!outsideText.has(record.target)) outsideText.set(record.target, { before: record.oldValue, after: after.get(record) });
          else outsideText.get(record.target).after = after.get(record);
        }
      }
      processed = records.length;
    };
    const inspect = () => {
      process();
      const changedAttributes = [...outsideAttributes.values()].some((attributes) => [...attributes.values()].some(({ before, after }) =>
        before !== after));
      return { changes, unexpected: unexpectedInternal || outsideStructure || changedAttributes
        || [...outsideText.values()].some(({ before, after }) => before !== after) };
    };
    return {
      begin(element, name) {
        drain();
        const index = records.length, oldValue = element.getAttribute(name);
        return () => {
          drain();
          const first = records[index];
          if (first?.type === "attributes" && first.target === element && first.attributeNamespace === null
              && first.attributeName === name && first.oldValue === oldValue) expected.add(first);
          const next = records.slice(index + 1).find((record) => record.type === "attributes" && record.target === element
            && record.attributeNamespace === null && record.attributeName === name);
          return { value: next ? next.oldValue : element.getAttribute(name) };
        };
      },
      inspect,
      stop() { try { drain(); } finally { witness.disconnect(); } }
    };
  };
  const adoptAuthoredChanges = (changes, typographyProperties = true) => {
    for (const [element, change] of changes) {
      const state = managedElements.get(element);
      if (!state) continue;
      if (change.stylePresent !== undefined) state.hadStyle = change.stylePresent;
      for (const [name, value] of change.properties) {
        const property = state.properties.get(name);
        if (property && (typographyProperties || value.value === property.appliedValue
            && value.priority === property.appliedPriority)) {
          property.value = value.value; property.priority = value.priority;
        }
      }
      for (const [name, value] of change.attributes) if (state.attributes.has(name)) state.attributes.set(name, value);
    }
    layout.adoptAuthorChanges(changes);
  };
  // Read every transition's actual after-value, including synchronous custom
  // element reactions that run before a CSSOM operation returns. Only the
  // mutation produced by our own operation is excluded by the guard witness.
  const adoptStyleMutations = (records, expected = null, typographyProperties = true) => {
    const styles = records.filter((record) => record.type === "attributes" && record.attributeName === "style"
      && record.attributeNamespace === null);
    if (!styles.length) return;
    const after = new Map(), tails = new Map(), changes = new Map();
    for (let index = styles.length - 1; index >= 0; index--) {
      const record = styles[index], element = record.target;
      after.set(record, tails.has(element) ? tails.get(element) : element.getAttribute("style"));
      tails.set(element, record.oldValue);
    }
    let beforeStyle, afterStyle;
    for (const record of styles) {
      if (expected?.has(record)) continue;
      const element = record.target, value = after.get(record);
      let change = changes.get(element);
      if (!change) changes.set(element, change = { properties: new Map(), attributes: new Map() });
      change.stylePresent = value !== null;
      beforeStyle ??= document.createElement("span").style;
      afterStyle ??= document.createElement("span").style;
      beforeStyle.cssText = record.oldValue ?? "";
      afterStyle.cssText = value ?? "";
      for (const name of new Set([...beforeStyle, ...afterStyle])) {
        const next = { value: afterStyle.getPropertyValue(name), priority: afterStyle.getPropertyPriority(name) };
        if (beforeStyle.getPropertyValue(name) !== next.value || beforeStyle.getPropertyPriority(name) !== next.priority) change.properties.set(name, next);
      }
    }
    if (!changes.size) return;
    adoptAuthoredChanges(changes, typographyProperties);
    for (const [element, change] of changes) {
      const guard = viewportStyleGuards.get(element);
      if (guard) {
        guard.hadStyle = change.stylePresent;
        const anchor = change.properties.get("overflow-anchor");
        if (anchor) { guard.value = anchor.value; guard.priority = anchor.priority; }
      }
      for (const [frame, state] of resizedFrames) {
        const properties = frame === element ? state.properties : state.elements.get(element)?.values;
        const owner = frame === element ? state : state.elements.get(element);
        if (!owner) continue;
        owner.hadStyle = change.stylePresent;
        for (const [name, value] of change.properties) {
          const property = properties.get(name);
          if (property) { property.value = value.value; property.priority = value.priority; }
        }
      }
    }
  };
  const preserveWitnessAuthorChanges = (witness) => {
    let { changes } = witness.inspect();
    adoptAuthoredChanges(changes);
    // Replay declaration deltas rather than whole historical cssText, retaining
    // unrelated current declarations and any newer callback writes. New keys
    // produced by replay callbacks already exist in the live DOM; ownership is
    // updated again below before the full restore can remove those values.
    const targets = [...changes].map(([element, change]) => ({ element,
      properties: [...change.properties.keys()], attributes: [...change.attributes.keys()] }));
    try {
      for (const { element, properties, attributes } of targets) {
        for (const name of properties) {
          ({ changes } = witness.inspect());
          const value = changes.get(element).properties.get(name);
          if (element.style.getPropertyValue(name) === value.value && element.style.getPropertyPriority(name) === value.priority) continue;
          mutateAttribute(element, "style", () => {
            if (value.value) element.style.setProperty(name, value.value, value.priority);
            else element.style.removeProperty(name);
          });
        }
        for (const name of attributes) {
          ({ changes } = witness.inspect());
          const value = changes.get(element).attributes.get(name);
          if (element.getAttribute(name) === value) continue;
          mutateAttribute(element, name, () => {
            if (value === null) element.removeAttribute(name);
            else element.setAttribute(name, value);
          });
        }
        ({ changes } = witness.inspect());
        const present = changes.get(element).stylePresent;
        if (present === true && !element.hasAttribute("style")) mutateAttribute(element, "style", () => element.setAttribute("style", ""));
        else if (present === false && !element.getAttribute("style") && element.hasAttribute("style")) {
          mutateAttribute(element, "style", () => element.removeAttribute("style"));
        }
      }
    } finally { adoptAuthoredChanges(witness.inspect().changes); }
  };
  const refreshChangedRegions = (roots) => {
    const started = performance.now();
    const eligible = () => isLayoutRepairActive() && document.getAnimations && document.getAnimations().length === 0
      && authorStylesheetsUnchanged() && nativeStateUnchanged() && roots.every(canRefreshRegion);
    if (!eligible()) { refresh(true, performance.now() - started); return; }
    refreshTimer = null;
    refreshUrgent = false;
    refreshRequired = false;
    pendingAriaChanges.clear();
    pendingStyleChanges.clear();
    pendingStateChanges.clear();
    clearPendingRegions();
    const witness = createRegionalMutationWitness(roots);
    regionalMutationWitness = witness;
    let error;
    try {
      error = withViewportPreserved(() => {
        // A queued deadline may follow another page task. Recheck every boundary
        // immediately before restoring any ownership, not merely at delivery.
        if (!eligible()) throw new Error("The changed region no longer has an isolated layout boundary.");
        for (const root of roots) {
          const host = root.host, before = host.getBoundingClientRect();
          layout.withRegion(root, () => {
            layout.restore({ preserveHidden: true });
            clearTypography(root);
            const measurements = measureTypography([root]);
            layout.capture([root], { preserveHidden: true });
            applyTypography(measurements, false, [root]);
            layout.repair(settings);
          });
          const after = host.getBoundingClientRect();
          if (["left", "top", "width", "height"].some((name) => Math.abs(after[name] - before[name]) > 0.01)) {
            throw new Error("A changed region altered its outer layout boundary.");
          }
        }
      });
      if (!error && (witness.inspect().unexpected || !eligible())) {
        error = new Error("Author callbacks changed the regional transaction.");
      }
      if (error) preserveWitnessAuthorChanges(witness);
    } catch (failure) { error = failure; }
    finally {
      try { witness.stop(); } catch (failure) { error ??= failure; }
      finally { regionalMutationWitness = null; }
    }
    // Scoped state is kept in the shared layout owner even when repair throws,
    // so the ordinary transaction can restore it and recapture the full page.
    if (error) { refresh(true, performance.now() - started); return; }
    completeRefresh(null, true, performance.now() - started, true);
  };
  const runQueuedRefresh = () => {
    // Responsive navigation can temporarily hide and reveal the same links
    // across separate observer deliveries while measuring them. Restoring
    // typography restarts that measurement, so refreshing an unchanged final
    // state would create a feedback loop even with a refresh cooldown. Theme
    // observers can likewise add/remove inline variables in separate tasks.
    const changed = !refreshRequired && ([...pendingAriaChanges].some(([element, value]) =>
      element.isConnected && element.getAttribute("aria-hidden") !== value)
      || [...pendingStyleChanges].some(([element, value]) => element.isConnected
        && authorStyleSignature(element, element.getAttribute("style")) !== value)
      || [...pendingStateChanges].some(([element, names]) => element.isConnected
        && [...names].some(([name, value]) => element.getAttribute(name) !== value)));
    if (refreshRequired || changed) {
      if (!changed && !queuedGlobalRefresh && pendingRegions?.size) refreshChangedRegions([...pendingRegions]);
      else refresh(true);
      return;
    }
    refreshTimer = null;
    refreshUrgent = false;
    pendingAriaChanges.clear();
    pendingStyleChanges.clear();
    pendingStateChanges.clear();
    clearPendingRegions();
    // A reverted temporary style/accessibility change leaves the saved native
    // baseline valid. Finish its suspended repair without another conversion.
    repairSynchronously = false;
    pendingRepair?.();
  };
  const queueRefresh = (urgent = false, ariaChanges = null, styleChanges = null, stateChanges = null, regions = null) => {
    urgent = urgent === true;
    if (refreshing || !settingsLoaded || !isActive()) return;
    if (pendingRepair !== null) {
      if (repairFrame !== null) cancelAnimationFrame(repairFrame);
      repairFrame = null;
      repairSynchronously = true;
      // Content/geometry changes invalidate the baseline outright. Temporary
      // author styles can settle back before the queued deadline instead.
      if (!ariaChanges && !styleChanges && !stateChanges) pendingRepair = null;
    }
    if (regions && !queuedGlobalRefresh && !ariaChanges && !styleChanges && !stateChanges) {
      pendingRegions ??= new Set();
      for (const root of regions) pendingRegions.add(root);
    } else {
      queuedGlobalRefresh = true;
      pendingRegions = null;
    }
    if (ariaChanges) {
      for (const mutation of ariaChanges) {
        if (!pendingAriaChanges.has(mutation.target)) pendingAriaChanges.set(mutation.target, mutation.oldValue);
      }
    }
    if (styleChanges) {
      for (const [element, value] of styleChanges) {
        if (!pendingStyleChanges.has(element)) pendingStyleChanges.set(element, value);
      }
    }
    if (stateChanges) for (const mutation of stateChanges) {
      let names = pendingStateChanges.get(mutation.target);
      if (!names) pendingStateChanges.set(mutation.target, names = new Map());
      if (!names.has(mutation.attributeName)) names.set(mutation.attributeName, mutation.oldValue);
    }
    if (!ariaChanges && !styleChanges && !stateChanges) refreshRequired = true;
    // Parser mutations still receive their fonts immediately, but cannot
    // start native capture before the startup preload has settled or timed out.
    if (initializing) return;
    if (refreshTimer !== null) {
      if (!urgent || refreshUrgent) return;
      clearTimeout(refreshTimer);
    }
    // Fonts have already been applied to incoming text. Keep layout repairs
    // on a fixed deadline so a continuous feed cannot starve or flood them.
    refreshUrgent = urgent;
    refreshTimer = setTimeout(runQueuedRefresh, Math.max(urgent ? 0 : 100, nextRefreshTime - performance.now()));
  };
  const invalidateAutoContent = (urgent = false, ariaChanges = null, styleChanges = null, stateChanges = null) => {
    revealedAutoContent = new WeakSet();
    queueRefresh(urgent === true, ariaChanges, styleChanges, stateChanges);
  };

  const pageState = () => ({
    ready: settingsLoaded && settingsLoadError === null,
    pending: initializing || restoringChanges !== null || refreshing || refreshTimer !== null || pendingRepair !== null,
    refreshRevision,
    healthy: settingsLoaded && settingsLoadError === null && lastRefreshError === null,
    error: settingsLoadError ?? lastRefreshError,
    active: isActive(),
    layoutRepair: isLayoutRepairActive(),
    hostname: getEffectiveHostname(),
    scope: getEffectiveSettings().scope
  });
  let lastNotifiedState;
  const notifyState = () => {
    if (window.top !== window) return;
    const state = pageState();
    const key = [state.ready, state.pending, state.healthy, state.error, state.active, state.layoutRepair].join(";");
    if (key === lastNotifiedState) return;
    lastNotifiedState = key;
    extension.runtime.sendMessage({ type: "LEXEND_STATE", ...state }).catch(() => {});
  };

  const applySettings = (nextSettings, deferLayout = false) => {
    settingsLoaded = true;
    const previous = getEffectiveSettings();
    const previousTypography = settings;
    settings = settingsApi.normalizeSettings(nextSettings);
    const effective = getEffectiveSettings();
    if (refreshRevision > 0 && lastRefreshError === null && previous.active === effective.active
        && previous.layoutRepair === effective.layoutRepair
        && (!effective.active || previous.scope === effective.scope
          && ["textScale", "lineHeight", "letterSpacing"].every((key) => previousTypography[key] === settings[key]))) {
      notifyState();
      return;
    }
    revealedAutoContent = new WeakSet();
    if (refreshTimer !== null) clearTimeout(refreshTimer);
    refreshTimer = null;
    if (deferLayout && effective.active) {
      applyIncomingFonts(new Set(document.documentElement ? [document.documentElement] : []), false);
      observeRoots();
      queueRefresh();
    } else refresh();
    if (isLayoutRepairActive() && (!previous.active || !previous.layoutRepair)) {
      // A child may have remained opted in while this parent was off. Its
      // earlier requirement was ignored, and no child preference or viewport
      // change is guaranteed when the parent turns back on.
      extension.runtime.sendMessage({ type: FRAME_RUNTIME_RECHECK }).catch(() => {});
    }
    notifyState();
  };
  const fittingCounterMutation = (mutation) => {
    let element, before, after;
    if (mutation.type === "characterData") {
      element = mutation.target.parentElement;
      before = mutation.oldValue;
      after = mutation.target.textContent;
    } else if (mutation.type === "childList" && mutation.addedNodes.length && mutation.removedNodes.length
        && [...mutation.addedNodes, ...mutation.removedNodes].every((node) => node.nodeType === Node.TEXT_NODE)) {
      element = mutation.target;
      before = [...mutation.removedNodes].map((node) => node.textContent).join("");
      after = [...mutation.addedNodes].map((node) => node.textContent).join("");
    } else return false;
    if (!element?.hasAttribute(TEXT_ATTRIBUTE) || !managedElements.has(element)
        || typeof before !== "string" || before.length > 500 || before.length !== after.length
        || !/[0-9]/.test(before) || before.replace(/[0-9]/g, "#") !== after.replace(/[0-9]/g, "#")) return false;
    const typography = getComputedStyle(element);
    if (typography.fontFeatureSettings !== "normal" || typography.fontVariationSettings !== "normal"
        || typography.fontVariantNumeric.includes("proportional-nums")) return false;
    counterContext ??= document.createElement("canvas").getContext("2d");
    if (!counterContext) return false;
    counterContext.font = typography.font || `${typography.fontStyle} ${typography.fontWeight} ${typography.fontSize} ${typography.fontFamily}`;
    counterContext.fontKerning = typography.fontKerning;
    if (Math.abs(counterContext.measureText(before).width - counterContext.measureText(after).width) > 0.01) return false;
    // Numeric animations keep the same typography. Skip a global author-font
    // restore only while the newly painted glyphs remain within every clip.
    const range = document.createRange();
    range.selectNodeContents(element);
    const boxes = [...range.getClientRects()];
    if (!boxes.length) return false;
    let checkedTextColumn = false;
    for (let current = element; current; current = composedParent(current)) {
      const css = getComputedStyle(current), box = current.getBoundingClientRect();
      if (css.display === "none" || css.visibility === "hidden" || Number(css.opacity) === 0
          || css.contentVisibility === "hidden" || css.clip !== "auto" || css.clipPath !== "none"
          || parseInt(css.webkitLineClamp, 10) > 0) return false;
      if (!checkedTextColumn && current.clientWidth > 0) {
        if (boxes.some((text) => text.left < box.left - 2 || text.right > box.right + 2)) return false;
        checkedTextColumn = true;
      }
      const clipsX = /^(hidden|clip|auto|scroll)$/.test(css.overflowX);
      const clipsY = /^(hidden|clip|auto|scroll)$/.test(css.overflowY);
      if (boxes.some((text) => clipsX && (text.left < box.left - 2 || text.right > box.right + 2)
          || clipsY && (text.top < box.top - 2 || text.bottom > box.bottom + 2))) return false;
    }
    return true;
  };
  const observer = new MutationObserver((mutations) => {
    if (!isActive()) return;
    // Frameworks frequently assign the same class/style again or change it
    // and restore it within one task. Compare the first old value with the
    // final value, rather than rebuilding the page for each notification.
    // Retention needs previous author values for declarations that differ from
    // our applied typography. Observable edits ending at the applied value can
    // already adopt that author baseline without reapplying any typography.
    adoptStyleMutations(mutations, null, false);
    const attributes = new Map();
    const authored = mutations.filter((mutation) => {
      if (!mutation.target.isConnected || ownStyleIds.includes(mutation.target.id)
          || ownStyleIds.includes(mutation.target.parentElement?.id)) return false;
      if (mutation.type === "attributes") {
        let names = attributes.get(mutation.target);
        if (!names) attributes.set(mutation.target, names = new Set());
        if (names.has(mutation.attributeName)) return false;
        names.add(mutation.attributeName);
        if (mutation.oldValue === mutation.target.getAttribute(mutation.attributeName)) return false;
      }
      return !fittingCounterMutation(mutation);
    });
    if (!authored.length) return;
    const incoming = new Set();
    const incomingText = (node) => {
      // Existing text already owns its font. A character edit adds no element
      // or shadow root to discover; walking its entire parent subtree on each
      // token bypasses the full-refresh budget without applying any new font.
      const parent = node.parentElement;
      if (parent && !managedElements.has(parent)) incoming.add(parent);
    };
    for (const mutation of authored) {
      if (mutation.type === "characterData") incomingText(mutation.target);
      if (mutation.type === "childList") for (const node of mutation.addedNodes) {
        if (node instanceof Element) incoming.add(node);
        else if (node.nodeType === Node.TEXT_NODE) incomingText(node);
      }
    }
    // Parser and framework batches can mention both a branch and its children.
    // Classify each new element once, before the next paint, without waiting
    // for the full-page repair cooldown.
    for (const element of incoming) {
      if (!element?.isConnected || ownStyleIds.includes(element.id) || protection.editorOwned(element)
          || element.matches("script,style,template,noscript")) { incoming.delete(element); continue; }
      for (let parent = composedParent(element); parent; parent = composedParent(parent)) {
        if (incoming.has(parent)) { incoming.delete(element); break; }
      }
    }
    const styleChanges = new Map();
    const needsRefresh = authored.filter((mutation) => {
      if (mutation.type !== "attributes" || mutation.attributeName !== "style") return true;
      const before = authorStyleSignature(mutation.target, mutation.oldValue);
      if (before === authorStyleSignature(mutation.target, mutation.target.getAttribute("style"))) return false;
      styleChanges.set(mutation.target, before);
      return true;
    });
    const enteringEditor = needsRefresh.some((mutation) => {
      if (mutation.type !== "attributes"
          || !(observedAttributeKinds[mutation.attributeName] === "classification" || mutation.attributeName === "class")
          || !protection.editorOwned(mutation.target)) return false;
      // Syntax highlighting and selection classes inside an already known
      // editor must retain the bounded scheduler; no content there needs to
      // release previous typography ownership. A WeakSet keeps this check
      // local to the target's ancestry rather than scanning editor tokens.
      for (let current = mutation.target; current; current = composedParent(current)) {
        if (knownEditorBoundaries.has(current) && current.matches(protection.editorSelector)) return false;
      }
      return true;
    });
    const changedStyles = new Set(authored.filter((mutation) => mutation.type === "attributes"
      && mutation.attributeName === "style").map((mutation) => mutation.target));
    if (changedStyles.size) {
      disconnectObserver();
      try { changedStyles.forEach(retainOverwrittenTypography); }
      finally { observeRoots(); }
    }
    applyIncomingFonts(incoming);
    if (!needsRefresh.length) return;
    // Entering an editor boundary must release previous ownership at observer
    // delivery, before the ordinary repair cooldown can leave serialized font
    // markers in the newly editable subtree. This also removes owned shadow
    // styles. Other classification/state changes retain the coalesced path.
    if (enteringEditor) {
      if (refreshTimer !== null) clearTimeout(refreshTimer);
      refresh();
      return;
    }
    const regionalRoots = regionalMutationRoots(needsRefresh);
    // Coalesce tokens on a fixed deadline even when each local repair is cheap.
    if (regionalRoots) { queueRefresh(false, null, null, null, regionalRoots); return; }
    const coalescible = needsRefresh.every((mutation) => mutation.type === "attributes");
    invalidateAutoContent(needsRefresh.some((mutation) => mutation.type === "childList" || mutation.type === "characterData"),
      coalescible ? needsRefresh.filter(mutation => mutation.attributeName === "aria-hidden") : null,
      coalescible ? styleChanges : null,
      coalescible ? needsRefresh.filter(mutation => !["style", "aria-hidden"].includes(mutation.attributeName)) : null);
  });
  const start = async () => {
    layout = globalThis.LexendLayout?.create({ getTextElements: collectTextElements, beginAttributeMutation, getStylePresence }) ?? null;
    window.addEventListener("pageshow", async (event) => {
      if (!event.persisted || initializing) return;
      // Cached documents may miss storage events while frozen. Read current
      // preferences before reusing their typography, without letting a stale
      // read replace a newer storage event or overlapping restoration.
      const generation = ++settingsReadGeneration;
      restoringChanges = {};
      notifyState();
      try {
        const saved = await extension.storage.sync.get(null);
        if (generation === settingsReadGeneration) {
          const reconciled = mergeStorageChanges(saved, restoringChanges);
          const confirmed = settingsApi.decodeSettings(reconciled);
          rawSettings = reconciled;
          startupChanges = {};
          settingsLoadError = null;
          applySettings(confirmed);
        }
      } catch (error) {
        console.warn("Lexend for the Web could not reload settings after navigation.", error);
      } finally {
        if (generation === settingsReadGeneration) restoringChanges = null;
      }
      notifyState();
    });
    document.addEventListener("lexend-design-mode", () => {
      const editing = protection.editorDocument();
      if (editing === editingDocument) return;
      editingDocument = editing;
      if (!settingsLoaded || !isActive()) return;
      if (refreshTimer !== null) clearTimeout(refreshTimer);
      // The native setter bridge dispatches synchronously, so existing owned
      // typography is restored before the page serializes its new editor.
      refresh();
    }, true);
    // The page-world bridge is only a discovery hint, never authority. Ignore
    // payloads and validate the actual open root; spoofed known/no-root hints
    // do not trigger traversal, typography reads, or a repair.
    document.addEventListener("lexend-open-shadow-root", (event) => {
      if (!isActive()) return;
      const host = event.composedPath()[0];
      if (!(host instanceof Element) || host.ownerDocument !== document || !host.isConnected
          || !host.shadowRoot || styledRoots.has(host.shadowRoot) || protection.editorOwned(host)) return;
      applyIncomingFonts(new Set([host]));
      queueRefresh();
    }, true);
    window.addEventListener("resize", invalidateAutoContent, { passive: true });
    window.addEventListener("message", receiveFrameRequirement);
    document.addEventListener("focusin", (event) => {
      if (!isActive() || protection.editorOwned(event.target)) return;
      queueRefresh();
      requestAnimationFrame(() => {
        if (isLayoutRepairActive()) globalThis.LexendControls?.revealFocused?.(event.target);
      });
    }, true);
    document.addEventListener("focusout", (event) => {
      if (isActive() && !protection.editorOwned(event.target)) queueRefresh();
    }, true);
    document.addEventListener("toggle", (event) => {
      if (!isActive() || !(event.target instanceof Element) || protection.editorOwned(event.target)) return;
      // details.open is observed and coalesced; popovers have no open attribute.
      if (event.target.matches("[popover]") && event.oldState !== event.newState) invalidateAutoContent();
    }, true);
    const remeasureRevealedLabels = (event) => {
      if (event.type === "transitionend"
          && !/^(transform|translate|left|right|top|bottom|inset.*|width|height)$/.test(event.propertyName)) return;
      const target = event.target;
      if (!isActive() || !(target instanceof Element) || protection.editorOwned(target)) return;
      // The mutation that starts a drawer/rail animation can be measured while
      // its labels are still outside the viewport. Reclassify once movement
      // finishes; ordinary font/color transitions do not schedule this work.
      const labels = target.matches(`[${PROTECTED_ATTRIBUTE}]`) ? [target] : [];
      labels.push(...target.querySelectorAll(`[${PROTECTED_ATTRIBUTE}]`));
      if (labels.some((element) => directText(element)
          && getComputedStyle(element).backgroundImage.includes("url("))) queueRefresh();
    };
    document.addEventListener("transitionend", remeasureRevealedLabels, true);
    document.addEventListener("animationend", remeasureRevealedLabels, true);
    document.addEventListener("contentvisibilityautostatechange", (event) => {
      if (!(event.target instanceof Element)) return;
      if (!isActive()) return;
      knownAutoContent.set(event.target, event.skipped);
      if (event.skipped !== false || revealedAutoContent.has(event.target)) return;
      // Offscreen automatic-containment subtrees have no usable geometry.
      // Capture their native layout once the browser paints them. Remember
      // the target until author content, settings or the viewport changes so
      // temporary baseline restoration cannot create a loop.
      revealedAutoContent.add(event.target);
      queueRefresh();
    }, true);
    document.addEventListener("load", (event) => {
      if (!ownStyleIds.includes(event.target?.id)) invalidateAutoContent();
    }, true);
    document.fonts?.addEventListener("loadingdone", (event) => {
      // Chromium can emit another loadingdone for a cached face when restored
      // typography stops using it and conversion requests it again. Its glyph
      // metrics did not change; refreshing that face repeatedly creates a loop.
      let newMetrics = false;
      let authorMetrics = false;
      for (const face of event.fontfaces) {
        const family = face.family.replace(/["']/g, "");
        if (family === "Lexend for the Web" || family === SYMBOLS_FAMILY) {
          // CSS cascade updates can recreate FontFace wrapper identities for
          // the same immutable bundled source. Its subset and weight identify
          // those cached metrics across stylesheet activation changes.
          const key = bundledFaceKey(face);
          if (settledBundledFaces.has(key)) continue;
          settledBundledFaces.add(key);
        } else {
          if (settledFontFaces.has(face)) continue;
          settledFontFaces.add(face);
          authorMetrics = true;
        }
        newMetrics = true;
      }
      // A pending repair will measure the converted layout with the newly
      // decoded bundled glyphs. Its native baseline is still valid. Author
      // fonts change that baseline too and require a fresh capture.
      if (newMetrics && (authorMetrics || !initializing && pendingRepair === null)) invalidateAutoContent(true);
    });
    let confirmed;
    try {
      const snapshot = await extension.storage.sync.get(null);
      const reconciled = mergeStorageChanges(snapshot, startupChanges);
      confirmed = settingsApi.decodeSettings(reconciled);
      rawSettings = reconciled;
      startupChanges = {};
      settingsLoadError = null;
    } catch (error) {
      // An incomplete event stream cannot stand in for a saved snapshot. Stay
      // passive until a successful reload establishes the user's preferences.
      settingsLoadError = "SETTINGS_LOAD_FAILED";
      console.warn("Lexend for the Web could not load settings; reload the page to retry.", error);
      notifyState();
      return;
    }
    // Apply fonts and startup sizing before any full-page layout work. The
    // first capture waits for the bounded preload and a scheduled task.
    applySettings(confirmed, true);
    if (document.documentElement && document.fonts?.load
        && settingsApi.resolveSite(confirmed, getEffectiveHostname()).active) {
      // Request both reading weights before the first native layout capture.
      // Incoming typography is already visible; bound the wait so failed or
      // slow fonts cannot hold the first repair indefinitely.
      installFontStyle(document.documentElement);
      const sample = "A" + (document.body?.textContent ?? "").slice(0, 4000);
      let timer;
      const loaded = Promise.all([400, 700].map((weight) =>
        document.fonts.load(`${weight} 16px "Lexend for the Web"`, sample)));
      try {
        const faces = await Promise.race([loaded, new Promise((resolve) => { timer = setTimeout(resolve, 50); })]);
        faces?.flat().forEach((face) => settledBundledFaces.add(bundledFaceKey(face)));
      } catch { /* Font errors retain the page's original fallback families. */ }
      finally { clearTimeout(timer); }
    }
  };

  extension.storage.onChanged.addListener((changes, areaName) => {
    if (areaName !== "sync") return;
    if (restoringChanges) Object.assign(restoringChanges, changes);

    if (!settingsLoaded) {
      Object.assign(startupChanges, changes);
      return;
    }
    rawSettings = mergeStorageChanges(rawSettings, changes);
    try {
      const confirmed = settingsApi.decodeSettings(rawSettings);
      settingsLoadError = null;
      applySettings(confirmed);
    } catch (error) {
      // Preserve confirmed preferences if a sync event is malformed/incomplete.
      settingsLoadError = "SETTINGS_LOAD_FAILED";
      console.warn("Lexend for the Web could not read updated settings.", error);
      notifyState();
    }
  });

  extension.runtime.onMessage.addListener((message, _sender, sendResponse) => {
    if (message?.type === FRAME_RECHECK) {
      if (window !== window.top && isLayoutRepairActive() && isBackgroundSender(_sender)) {
        lastFrameRequest = null;
        notifyFrameRequirement();
      }
      return undefined;
    }
    if (message?.type === FRAME_RUNTIME_APPLY) {
      receiveRuntimeFrameRequirement(message, _sender);
      sendResponse({ received: true });
      return undefined;
    }
    if (message?.type !== "LEXEND_GET_STATE") return undefined;
    sendResponse(pageState());
    return undefined;
  });

  start().finally(() => {
    initializing = false;
    if (refreshRequired || pendingAriaChanges.size || pendingStyleChanges.size || pendingStateChanges.size) queueRefresh(true);
    notifyState();
  });
})();
