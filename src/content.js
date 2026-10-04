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

  // Names such as `with-icon` are often ordinary prose wrappers. Protect actual
  // semantics and computed symbol/code fonts rather than substring class names.
  const protectedSelector = [
    "script", "style", "template", "noscript", "pre", "code", "kbd", "samp",
    "math", "svg", "[data-lexend-ignore]", "[role='img']",
    ".CodeMirror", ".cm-editor", ".monaco-editor", ".ace_editor", ".code-editor"
  ].join(",");
  const iconFont = /icomoon|glyph|pictogram|icon|symbol|awesome|dingbat|wingding|musescore|mscore|creative[\s-]*commons|fontello|entypo|octicon|ionicon|^cc$/i;
  const codeFont = /monospace|mono\b|menlo|monaco|consolas|courier|iosevka|fira[\s-]*code|source[\s-]*code/i;
  const TEXT_ATTRIBUTE = "data-lexend-text";
  const PROTECTED_ATTRIBUTE = "data-lexend-protected";
  const managedElements = new Map();
  const eligibleTextElements = new Set();
  const transitionRules = new Map();
  const transitionAttributes = ["data-lexend-transition", "data-lexend-before-transition", "data-lexend-after-transition"];
  const settledFontFaces = new WeakSet();
  const settledBundledFaces = new Set();
  let refreshTimer = null;
  let refreshUrgent = false;
  let refreshRevision = 0;
  let refreshing = false;
  let retainedTypography = new WeakSet();
  let retentionTimer = null;
  let counterContext = null;
  let layout = null;
  let lastRefreshError = null;
  let warnedRefreshError = null;
  let revealedAutoContent = new WeakSet();
  const knownAutoContent = new Map();
  let initialFrameHeight = window === window.top ? null : innerHeight;
  let requestedFrameHeight = null;
  const resizedFrames = new Map();
  let lastFrameRequest = null;
  const FRAME_MESSAGE = "lexend-measured-frame-height";
  const FRAME_RUNTIME_REQUEST = "LEXEND_FRAME_REQUIREMENT";
  const FRAME_RUNTIME_APPLY = "LEXEND_APPLY_FRAME_REQUIREMENT";
  const writeFrameProperty = (state, element, name, value) => {
    let properties = state.elements.get(element);
    if (!properties) state.elements.set(element, properties = { hadStyle: element.hasAttribute("style"), values: new Map() });
    let original = properties.values.get(name);
    if (!original) {
      original = { value: element.style.getPropertyValue(name), priority: element.style.getPropertyPriority(name) };
      properties.values.set(name, original);
    } else if (element.style.getPropertyValue(name) !== original.applied) {
      original.value = element.style.getPropertyValue(name);
      original.priority = element.style.getPropertyPriority(name);
    }
    original.applied = value;
    if (element.style.getPropertyValue(name) !== value || element.style.getPropertyPriority(name) !== "important") element.style.setProperty(name, value, "important");
  };
  const restoreFrame = (frame) => {
    const state = resizedFrames.get(frame);
    if (!state) return;
    for (const [name, original] of state.properties) {
      if (frame.style.getPropertyValue(name) !== original.applied
          || frame.style.getPropertyPriority(name) !== "important") continue;
      if (original.value) frame.style.setProperty(name, original.value, original.priority);
      else frame.style.removeProperty(name);
    }
    if (!state.hadStyle && !frame.getAttribute("style")) frame.removeAttribute("style");
    for (const [element, properties] of state.elements) {
      for (const [name, original] of properties.values) {
        if (element.style.getPropertyValue(name) !== original.applied || element.style.getPropertyPriority(name) !== "important") continue;
        if (original.value) element.style.setProperty(name, original.value, original.priority);
        else element.style.removeProperty(name);
      }
      if (!properties.hadStyle && !element.getAttribute("style")) element.removeAttribute("style");
    }
    resizedFrames.delete(frame);
  };
  const notifyFrameRequirement = () => {
    if (initialFrameHeight === null) return;
    // At document_start an embed can still have its default/placeholder size.
    // Follow native viewport changes until our measured request is actually
    // reflected in the child viewport, then retain the pre-repair baseline.
    if (innerHeight > 0 && (requestedFrameHeight === null
        || Math.abs(innerHeight - requestedFrameHeight) > 1)) initialFrameHeight = innerHeight;
    const requirement = isActive() ? layout?.getFrameRequirement?.(initialFrameHeight) ?? null : null;
    const serialized = JSON.stringify(requirement);
    if (lastFrameRequest === serialized && (!requirement
        || Math.abs(innerHeight - requirement.requiredHeight) <= 1)) return;
    lastFrameRequest = serialized;
    requestedFrameHeight = requirement?.requiredHeight ?? null;
    // Chrome can redact MessageEvent.source between extension isolated worlds.
    // Route measured requirements through authenticated extension messaging.
    extension.runtime.sendMessage({ type: FRAME_RUNTIME_REQUEST, requirement }).catch(() => {});
  };
  const applyFrameRequirement = (frame, requirement) => {
    if (!isActive() || requirement === null) {
      observer.disconnect();
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
    observer.disconnect();
    try {
      if (!state) {
        state = { hadStyle: frame.hasAttribute("style"), properties: new Map(), elements: new Map() };
        resizedFrames.set(frame, state);
      }
      const shortAncestors = [];
      for (let parent = frame.parentElement; parent && parent !== document.body && shortAncestors.length < 4; parent = parent.parentElement) {
        const style = getComputedStyle(parent), before = parent.getBoundingClientRect();
        if (before.height > 160 || before.width + 2 < box.width) break;
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
        if (frame.style.getPropertyValue(name) !== value || frame.style.getPropertyPriority(name) !== "important") frame.style.setProperty(name, value, "important");
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
        ::slotted([${TEXT_ATTRIBUTE}]), ::slotted([${PROTECTED_ATTRIBUTE}]) { ${converted()} }
        ::slotted([data-lexend-before='text'])::before, ::slotted([data-lexend-before='protected'])::before { ${converted("before-")} }
        ::slotted([data-lexend-after='text'])::after, ::slotted([data-lexend-after='protected'])::after { ${converted("after-")} }
      }
    `;
  };

  const getEffectiveSettings = () => settingsApi.resolveSite(settings, getEffectiveHostname());
  const isActive = () => getEffectiveSettings().active;
  const composedParent = (element) => element.parentElement
    ?? (element.getRootNode() instanceof ShadowRoot ? element.getRootNode().host : null);
  const hasProtectedAncestor = (element) => {
    for (let current = element; current; current = composedParent(current)) {
      if (current.matches(protectedSelector)) return true;
    }
    return false;
  };
  const isHeading = (element) => {
    for (let current = element; current; current = composedParent(current)) {
      if (/^H[1-6]$/.test(current.tagName) || current.getAttribute("role") === "heading") return true;
    }
    return false;
  };
  const primaryFont = (family) => family.split(",")[0].replace(/["']/g, "").trim();
  const protectedFont = (style) => iconFont.test(primaryFont(style.fontFamily)) || codeFont.test(style.fontFamily);
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
  const ownTextContent = (element) => [...element.childNodes].filter((node) => node.nodeType === Node.TEXT_NODE).map((node) => node.textContent).join("");
  const hasEmptyPaintClip = (element, style) => {
    for (let current = element; current; current = composedParent(current)) {
      const css = current === element ? style : getComputedStyle(current);
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
  const isImageReplacementText = (element, style) => {
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
        if (getComputedStyle(current).position === "fixed") { fixed = true; break; }
      }
      if (!fixed) return false;
      const boxes = [...element.childNodes].filter((node) => node.nodeType === Node.TEXT_NODE && node.textContent.trim())
        .flatMap((node) => { const range = document.createRange(); range.selectNodeContents(node); return [...range.getClientRects()]; });
      return boxes.length > 0 && boxes.every((box) => box.right <= 0 || box.left >= innerWidth);
    }
    // Accessible labels behind a sprite/image are deliberately unpainted. Their
    // typography must not enlarge the replacement artwork's fixed geometry.
    for (let current = element, depth = 0; current && depth < 3; depth++, current = composedParent(current)) {
      const css = current === element ? style : getComputedStyle(current);
      if (css.backgroundClip.includes("text") || css.webkitBackgroundClip?.includes("text")) return false;
      if (css.backgroundImage !== "none" || current.querySelector("img,picture,svg")) return true;
    }
    return [element.previousElementSibling, element.nextElementSibling].some((sibling) => sibling?.matches("img,picture,svg"));
  };
  const directText = (element) => [...element.childNodes].some((node) => (
    node.nodeType === Node.TEXT_NODE && node.textContent.trim()
  ));
  const isTextControl = (element) => element.matches("textarea,select,option,button,input:not([type='hidden']):not([type='checkbox']):not([type='radio']):not([type='range']):not([type='color'])");
  const allElements = (root) => [
    ...(root instanceof Element ? [root] : []),
    ...root.querySelectorAll("*")
  ].filter((element) => element instanceof Element && element.style && !ownStyleIds.includes(element.id)
    && (root instanceof ShadowRoot || Boolean(element.closest("body"))));
  const collectTextElements = (root) => new Set([...eligibleTextElements].filter((element) => (
    element.isConnected && (element === root || element.getRootNode() === root || root.contains(element))
  )));

  // Keep only the properties we own. Page updates to unrelated inline styles
  // remain intact when settings change or the extension is switched off.
  const manage = (element) => {
    let state = managedElements.get(element);
    if (!state) {
      state = { attributes: new Map(), properties: new Map(), hadStyle: element.hasAttribute("style") };
      managedElements.set(element, state);
    }
    return state;
  };
  const setAttribute = (element, name, value) => {
    const state = manage(element);
    if (!state.attributes.has(name)) state.attributes.set(name, element.getAttribute(name));
    element.setAttribute(name, value);
  };
  const setProperty = (element, name, value, priority = "") => {
    const state = manage(element);
    if (!state.properties.has(name)) state.properties.set(name, {
      value: element.style.getPropertyValue(name), priority: element.style.getPropertyPriority(name)
    });
    element.style.setProperty(name, value, priority);
    const property = state.properties.get(name);
    property.appliedValue = element.style.getPropertyValue(name);
    property.appliedPriority = element.style.getPropertyPriority(name);
  };
  const retainOverwrittenTypography = (element) => {
    const state = managedElements.get(element);
    if (!state || !element.isConnected || retainedTypography.has(element) || !isActive()) return;
    let overwritten = false;
    state.properties.forEach((property, name) => {
      const value = element.style.getPropertyValue(name), priority = element.style.getPropertyPriority(name);
      if (value === property.appliedValue && priority === property.appliedPriority) return;
      // Hover rerenders can replace an entire style attribute. Keep the new
      // author declaration as the next baseline, but restore our current
      // typography before the browser paints the intervening native font.
      property.value = value;
      property.priority = priority;
      if (property.appliedValue) element.style.setProperty(name, property.appliedValue, property.appliedPriority);
      else element.style.removeProperty(name);
      overwritten = true;
    });
    if (overwritten) {
      // Limit immediate writes to one rescue per element in the current task;
      // an author MutationObserver must not start a microtask write loop.
      retainedTypography.add(element);
      if (retentionTimer === null) retentionTimer = setTimeout(() => {
        retainedTypography = new WeakSet();
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
    roots.forEach((root) => root.querySelectorAll("[data-lexend-original-typography]").forEach((element) => {
      if (managedElements.has(element)) return;
      try {
        const original = JSON.parse(element.getAttribute("data-lexend-original-typography"));
        for (const attribute of [TEXT_ATTRIBUTE, PROTECTED_ATTRIBUTE, "data-lexend-before", "data-lexend-after"]) element.removeAttribute(attribute);
        original.properties.filter(([name]) => name !== "transition-property").forEach(([name, value, priority]) => {
          if (value) element.style.setProperty(name, value, priority);
          else element.style.removeProperty(name);
        });
        clones.push({ element, original });
      } catch { /* Do not trust unrelated malformed page attributes. */ }
    }));
    // Inherited font changes can animate in nontext wrappers between a cloned
    // control and its label. Restore the whole branch before releasing guards.
    for (const { element, original } of clones) {
      try {
        const transition = original.properties.find(([name]) => name === "transition-property");
        if (transition) {
          getComputedStyle(element).fontSize;
          if (transition[1]) element.style.setProperty(transition[0], transition[1], transition[2]);
          else element.style.removeProperty(transition[0]);
        }
        for (const pseudo of ["before", "after"]) {
          if (element.hasAttribute(`data-lexend-${pseudo}-transition`)) getComputedStyle(element, `::${pseudo}`).fontSize;
        }
        for (const attribute of [TEXT_ATTRIBUTE, PROTECTED_ATTRIBUTE, "data-lexend-before", "data-lexend-after", ...transitionAttributes, "data-lexend-original-typography"]) element.removeAttribute(attribute);
        if (!original.hadStyle && !element.getAttribute("style")) element.removeAttribute("style");
      } catch { /* Do not trust unrelated malformed page attributes. */ }
    }
  };
  const clearTypography = () => {
    const restorations = [];
    managedElements.forEach((state, element) => {
      const restoreAttribute = (value, name) => {
        if (value === null) element.removeAttribute(name);
        else element.setAttribute(name, value);
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
        if (value) element.style.setProperty(name, value, priority);
        else element.style.removeProperty(name);
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
    for (const { state, element, restoreProperty, restoreAttribute } of restorations) {
      // Font transitions outrank even inline !important. Restore the authored
      // typography and flush it while font transitions are still suppressed;
      // otherwise a transient animated size becomes the next scaled baseline.
      const transition = state.properties.get("transition-property");
      if (transition) {
        getComputedStyle(element).fontSize;
        restoreProperty(transition, "transition-property");
      }
      // Generated content owns its own transitions; a host flush alone does
      // not settle the tooltip's delayed font values. Keep the guards until
      // authored pseudo typography has also been computed.
      for (const pseudo of ["before", "after"]) {
        if (state.attributes.has(`data-lexend-${pseudo}-transition`)) getComputedStyle(element, `::${pseudo}`).fontSize;
      }
      for (const name of transitionAttributes) {
        if (state.attributes.has(name)) restoreAttribute(state.attributes.get(name), name);
      }
      if (!state.hadStyle && !element.getAttribute("style")) element.removeAttribute("style");
    }
    managedElements.clear();
    eligibleTextElements.clear();
    transitionRules.clear();
  };
  const withExtensionStylesDisabled = (callback) => {
    const styles = [...styledRoots].map((root) => root.querySelector(`#${STYLE_ID}`)).filter(Boolean);
    const states = styles.map((style) => style.sheet?.disabled ?? false);
    styles.forEach((style) => { if (style.sheet) style.sheet.disabled = true; });
    const inline = [];
    managedElements.forEach((state, element) => state.properties.forEach((property, name) => {
      if (name.startsWith("--")) return;
      inline.push({ element, name, value: element.style.getPropertyValue(name), priority: element.style.getPropertyPriority(name) });
      if (property.value) element.style.setProperty(name, property.value, property.priority);
      else element.style.removeProperty(name);
    }));
    try { return callback(); }
    finally {
      inline.forEach(({ element, name, value, priority }) => {
        if (value) element.style.setProperty(name, value, priority);
        else element.style.removeProperty(name);
      });
      styles.forEach((style, index) => { if (style.sheet) style.sheet.disabled = states[index]; });
    }
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
  const readTypography = (style) => ({
    family: style.fontFamily, size: style.fontSize,
    line: style.lineHeight, spacing: style.letterSpacing,
    transition: withoutTypographyTransitions(style)
  });
  const measureTypography = (roots) => {
    const effective = getEffectiveSettings();
    const measurements = [];
    roots.forEach((root) => allElements(root).forEach((element) => {
      const style = getComputedStyle(element);
      const semanticProtection = hasProtectedAncestor(element);
      const inScope = effective.scope === "all" || !isHeading(element);
      const text = ownTextContent(element);
      const mixedGlyphProse = containsPrivateGlyph(text) && !onlyPrivateGlyphs(text);
      const protectedText = semanticProtection || codeFont.test(style.fontFamily)
        || (!mixedGlyphProse && protectedFont(style)) || onlyPrivateGlyphs(text)
        || isImageReplacementText(element, style) || hasEmptyPaintClip(element, style) || !inScope;
      const target = !protectedText && inScope && (directText(element) || isTextControl(element));
      const pseudos = [];
      // Generated text can be the only label, or an icon whose family would
      // otherwise inherit Lexend from its newly converted parent.
      for (const pseudo of ["before", "after"]) {
        const pseudoStyle = getComputedStyle(element, `::${pseudo}`);
        if (["none", "normal", '""', "''"].includes(pseudoStyle.content)) continue;
        const paintedContent = paintedGeneratedContent(pseudoStyle.content);
        const mixedPseudo = containsPrivateGlyph(paintedContent) && !onlyPrivateGlyphs(paintedContent);
        pseudos.push({ pseudo, noTracking: /\p{Script=Arabic}/u.test(paintedContent), protected: protectedText || codeFont.test(pseudoStyle.fontFamily)
          || (!mixedPseudo && protectedFont(pseudoStyle)) || onlyPrivateGlyphs(paintedContent),
          inScope, typography: { ...readTypography(pseudoStyle), symbols: !semanticProtection && !codeFont.test(pseudoStyle.fontFamily) && containsPrivateGlyph(paintedContent) } });
      }
      const typography = { ...readTypography(style), symbols: !semanticProtection && !codeFont.test(style.fontFamily) && containsPrivateGlyph(text) };
      if (protectedText || target || pseudos.length || typography.transition !== null) measurements.push({
        element, protected: protectedText, target, noTracking: /\p{Script=Arabic}/u.test(text), typography, pseudos
      });
      if (target) eligibleTextElements.add(element);
    }));
    return measurements;
  };
  const applyTypography = (measurements) => {
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
    styledRoots.forEach((root) => {
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
      const spacing = !protectedText && settings.letterSpacing > 0
        ? noTracking ? "0px" : `${settings.letterSpacing}em` : values.spacing;
      // Site fonts must resolve their own private-use icons before Nerd Fonts:
      // unrelated icon sets can assign different artwork to the same codepoint.
      // Semantic opt-outs and code keep their original families unchanged.
      const fallback = `, "${SYMBOLS_FAMILY}"`;
      const family = protectedText ? values.family + (values.symbols ? fallback : "")
        : `"Lexend for the Web", ${values.family}${fallback}`;
      setProperty(element, `--lexend-${prefix}family`, family);
      setProperty(element, `--lexend-${prefix}size`, `${parseFloat(values.size) * scale}px`);
      setProperty(element, `--lexend-${prefix}line`, !protectedText && settings.lineHeight > 0 ? String(settings.lineHeight) : values.line);
      setProperty(element, `--lexend-${prefix}spacing`, spacing);
      if (!prefix) {
        // Inline important declarations also defeat author inline-important
        // typography while retaining its exact value for disable/refresh.
        setProperty(element, "font-family", family, "important");
        setProperty(element, "font-size", `${parseFloat(values.size) * scale}px`, "important");
        setProperty(element, "line-height", !protectedText && settings.lineHeight > 0 ? String(settings.lineHeight) : values.line, "important");
        setProperty(element, "letter-spacing", spacing, "important");
      }
    };
    measurements.forEach(({ element, protected: protectedText, target, noTracking, typography, pseudos }) => {
      if (protectedText || target) {
        setAttribute(element, protectedText ? PROTECTED_ATTRIBUTE : TEXT_ATTRIBUTE, "");
        applyValues(element, typography, protectedText, "", noTracking);
      }
      pseudos.forEach(({ pseudo, protected: protectedPseudo, noTracking: pseudoNoTracking, inScope, typography: values }) => {
        if (!protectedPseudo && !inScope) return;
        setAttribute(element, `data-lexend-${pseudo}`, protectedPseudo ? "protected" : "text");
        applyValues(element, values, protectedPseudo, `${pseudo}-`, pseudoNoTracking);
      });
      const state = managedElements.get(element);
      if (state) setAttribute(element, "data-lexend-original-typography", JSON.stringify({
        hadStyle: state.hadStyle,
        properties: [...state.properties].map(([name, { value, priority }]) => [name, value, priority])
      }));
    });
  };
  const applyToRoot = (root) => {
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
  const observeRoots = () => {
    observer.observe(document, { childList: true, subtree: true, characterData: true, characterDataOldValue: true,
      attributes: true, attributeFilter: ["class", "style", "hidden", "aria-hidden", "role", "contenteditable", "data-lexend-ignore", "data-icon"] });
    styledRoots.forEach((root) => {
      if (root instanceof ShadowRoot) observer.observe(root, { childList: true, subtree: true,
        characterData: true, characterDataOldValue: true, attributes: true, attributeFilter: ["class", "style", "hidden", "aria-hidden", "role", "contenteditable", "data-lexend-ignore", "data-icon"] });
    });
  };
  const visitShadowRoots = (root) => {
    root.querySelectorAll?.("*").forEach((element) => {
      if (element.shadowRoot) {
        applyToRoot(element.shadowRoot);
        visitShadowRoots(element.shadowRoot);
      }
    });
  };
  const refresh = () => {
    refreshTimer = null;
    refreshUrgent = false;
    if (refreshing || !document.documentElement) return;
    refreshing = true;
    if (retentionTimer !== null) clearTimeout(retentionTimer);
    retentionTimer = null;
    retainedTypography = new WeakSet();
    observer.disconnect();
    let focusedElement = document.activeElement;
    while (focusedElement?.shadowRoot?.activeElement) focusedElement = focusedElement.shadowRoot.activeElement;
    const ownedTableChild = (element) => element?.matches?.("[data-lexend-layout-repair~='scroll-table']")
      ? [...element.children].find((child) => child.tagName === "TABLE") ?? null : null;
    const focusedTable = ownedTableChild(focusedElement);
    const scrollPosition = { x: scrollX, y: scrollY };
    const rootStyle = document.documentElement.style;
    const anchor = { value: rootStyle.getPropertyValue("overflow-anchor"), priority: rootStyle.getPropertyPriority("overflow-anchor"), hadStyle: document.documentElement.hasAttribute("style") };
    rootStyle.setProperty("overflow-anchor", "none", "important");
    const body = document.body;
    const primaryBodyScroller = body && /^(auto|scroll)$/.test(getComputedStyle(body).overflowY)
      && body.clientHeight >= innerHeight * 0.8 && body.clientHeight <= innerHeight + 64
      && body.scrollHeight > body.clientHeight + 2;
    const bodyScroll = primaryBodyScroller ? { x: body.scrollLeft, y: body.scrollTop,
      value: body.style.getPropertyValue("overflow-anchor"), priority: body.style.getPropertyPriority("overflow-anchor"),
      hadStyle: body.hasAttribute("style") } : null;
    if (bodyScroll) body.style.setProperty("overflow-anchor", "none", "important");
    const nestedScrollers = new Map();
    for (const root of new Set([document.documentElement, ...styledRoots])) {
      root.querySelectorAll("*").forEach((element) => {
        if (!element.style || element === body || element === document.documentElement
            || (!element.scrollLeft && !element.scrollTop)) return;
        nestedScrollers.set(element, { x: element.scrollLeft, y: element.scrollTop,
          value: element.style.getPropertyValue("overflow-anchor"), priority: element.style.getPropertyPriority("overflow-anchor"),
          hadStyle: element.hasAttribute("style"), table: ownedTableChild(element) });
        element.style.setProperty("overflow-anchor", "none", "important");
      });
    }
    let refreshError = null;
    try {
      for (const frame of resizedFrames.keys()) {
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
      layout?.restore();
      if (!isActive()) for (const frame of resizedFrames.keys()) restoreFrame(frame);
      recoverClonedTypography([document.documentElement, ...styledRoots]);
      clearTypography();
      [...styledRoots].forEach((root) => { if (!root.isConnected) styledRoots.delete(root); });
      applyToRoot(document.documentElement);
      visitShadowRoots(document.documentElement);
      if (isActive()) {
        const roots = [...styledRoots];
        let measurements;
        withExtensionStylesDisabled(() => {
          measurements = measureTypography(roots);
          layout?.capture(roots);
        });
        applyTypography(measurements);
        layout?.repair(settings);
      }
    } catch (error) {
      refreshError = error;
    } finally {
      // A temporary author-layout baseline must never move the user's viewport.
      // Flush final geometry, then restore position (naturally clamped if the
      // finished page is shorter) before re-enabling native scroll anchoring.
      try {
        document.documentElement.getBoundingClientRect();
        const focusTarget = focusedElement?.isConnected ? focusedElement : focusedTable?.parentElement;
        if (focusTarget && focusTarget !== document.body && focusTarget !== document.documentElement
            && (!focusedTable || focusTarget.matches("[data-lexend-layout-repair~='scroll-table']"))) {
          focusTarget.focus({ preventScroll: true });
        }
        nestedScrollers.forEach((position, originalElement) => {
          const element = originalElement.isConnected ? originalElement : position.table?.parentElement;
          if (!element?.isConnected || (position.table && !element.matches("[data-lexend-layout-repair~='scroll-table']"))) return;
          element.scrollTo({ left: position.x, top: position.y, behavior: "instant" });
          if (position.value) element.style.setProperty("overflow-anchor", position.value, position.priority);
          else element.style.removeProperty("overflow-anchor");
          if (!position.hadStyle && !element.getAttribute("style")) element.removeAttribute("style");
        });
        window.scrollTo({ left: scrollPosition.x, top: scrollPosition.y, behavior: "instant" });
        if (bodyScroll && body.isConnected) {
          body.scrollTo({ left: bodyScroll.x, top: bodyScroll.y, behavior: "instant" });
          if (bodyScroll.value) body.style.setProperty("overflow-anchor", bodyScroll.value, bodyScroll.priority);
          else body.style.removeProperty("overflow-anchor");
          if (!bodyScroll.hadStyle && !body.getAttribute("style")) body.removeAttribute("style");
        }
        if (anchor.value) rootStyle.setProperty("overflow-anchor", anchor.value, anchor.priority);
        else rootStyle.removeProperty("overflow-anchor");
        if (!anchor.hadStyle && !document.documentElement.getAttribute("style")) document.documentElement.removeAttribute("style");
        // An already focused action does not emit focusin again when its pane
        // grows. Recheck its repaired vertical viewport after restoring saved
        // offsets; ordinary page/table scrollers remain under native control.
        if (!refreshError && isActive() && focusTarget?.isConnected) globalThis.LexendControls?.revealFocused?.(focusTarget);
      } catch (error) { refreshError ??= error; }
      finally {
        refreshing = false;
        try { observeRoots(); }
        catch (error) { refreshError ??= error; }
      }
    }
    if (refreshError) {
      lastRefreshError = refreshError instanceof Error ? refreshError.message : String(refreshError);
      if (warnedRefreshError !== lastRefreshError) {
        console.warn("Lexend for the Web could not refresh the page.", refreshError);
        warnedRefreshError = lastRefreshError;
      }
    } else {
      lastRefreshError = null;
      warnedRefreshError = null;
      refreshRevision++;
      // A global repair restores earlier overrides, including those belonging
      // to a subtree that has since been skipped. Only painted subtrees have
      // a valid baseline from this refresh; returning to an omitted subtree
      // must trigger another capture even without an author mutation/resize.
      revealedAutoContent = new WeakSet();
      for (const [target, skipped] of knownAutoContent) {
        if (!target.isConnected) { knownAutoContent.delete(target); continue; }
        const child = target.firstElementChild;
        const painted = child?.checkVisibility
          ? child.checkVisibility({ contentVisibilityAuto: true }) : !skipped;
        if (painted) revealedAutoContent.add(target);
      }
      notifyFrameRequirement();
    }
  };
  const queueRefresh = (urgent = false) => {
    urgent = urgent === true;
    if (refreshing) return;
    if (refreshTimer !== null) {
      if (!urgent || refreshUrgent) return;
      clearTimeout(refreshTimer);
    }
    // Newly inserted/replaced prose must convert in the next task, without
    // waiting behind a continuously animated style-only mutation batch. Keep
    // style/geometry changes coalesced and measure descendants atomically.
    refreshUrgent = urgent;
    refreshTimer = setTimeout(refresh, urgent ? 0 : 100);
  };
  const invalidateAutoContent = (urgent = false) => {
    revealedAutoContent = new WeakSet();
    queueRefresh(urgent === true);
  };

  const notifyState = () => {
    if (window.top !== window) return;

    extension.runtime.sendMessage({
      type: "LEXEND_STATE",
      active: isActive()
    }).catch(() => {});
  };

  const applySettings = (nextSettings) => {
    revealedAutoContent = new WeakSet();
    settings = settingsApi.normalizeSettings(nextSettings);
    if (refreshTimer !== null) clearTimeout(refreshTimer);
    refreshTimer = null;
    refresh();
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
    const authored = mutations.filter((mutation) => !ownStyleIds.includes(mutation.target.id)
      && !ownStyleIds.includes(mutation.target.parentElement?.id) && !fittingCounterMutation(mutation));
    if (!authored.length) return;
    const changedStyles = new Set(authored.filter((mutation) => mutation.type === "attributes"
      && mutation.attributeName === "style").map((mutation) => mutation.target));
    if (changedStyles.size) {
      observer.disconnect();
      try { changedStyles.forEach(retainOverwrittenTypography); }
      finally { observeRoots(); }
    }
    invalidateAutoContent(authored.some((mutation) => mutation.type === "childList" || mutation.type === "characterData"));
  });
  const start = async () => {
    layout = globalThis.LexendLayout?.create({ withStylesDisabled: withExtensionStylesDisabled, getTextElements: collectTextElements }) ?? null;
    let initialSettings;
    try { initialSettings = await extension.storage.sync.get(null); }
    catch (error) {
      console.warn("Lexend for the Web could not load settings; using defaults.", error);
      initialSettings = settingsApi.defaults;
    }
    applySettings(initialSettings);
    window.addEventListener("resize", invalidateAutoContent, { passive: true });
    window.addEventListener("message", receiveFrameRequirement);
    document.addEventListener("focusin", (event) => {
      queueRefresh();
      requestAnimationFrame(() => {
        if (isActive()) globalThis.LexendControls?.revealFocused?.(event.target);
      });
    }, true);
    document.addEventListener("focusout", queueRefresh, true);
    const remeasureRevealedLabels = (event) => {
      if (event.type === "transitionend"
          && !/^(transform|translate|left|right|top|bottom|inset.*|width|height)$/.test(event.propertyName)) return;
      const target = event.target;
      if (!(target instanceof Element)) return;
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
      knownAutoContent.set(event.target, event.skipped);
      if (!isActive() || event.skipped !== false || revealedAutoContent.has(event.target)) return;
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
      for (const face of event.fontfaces) {
        const family = face.family.replace(/["']/g, "");
        if (family === "Lexend for the Web" || family === SYMBOLS_FAMILY) {
          // CSS cascade updates can recreate FontFace wrapper identities for
          // the same immutable bundled source. Its subset and weight identify
          // those cached metrics across stylesheet activation changes.
          const key = [family, face.style, face.weight, face.stretch, face.unicodeRange].join(";");
          if (settledBundledFaces.has(key)) continue;
          settledBundledFaces.add(key);
        } else {
          if (settledFontFaces.has(face)) continue;
          settledFontFaces.add(face);
        }
        newMetrics = true;
      }
      if (newMetrics) invalidateAutoContent();
    });
  };

  extension.storage.onChanged.addListener((changes, areaName) => {
    if (areaName !== "sync") return;

    const nextSettings = { ...settings };
    Object.entries(changes).forEach(([key, change]) => {
      if (change.newValue === undefined) delete nextSettings[key];
      else nextSettings[key] = change.newValue;
    });
    applySettings(nextSettings);
  });

  extension.runtime.onMessage.addListener((message, _sender, sendResponse) => {
    if (message?.type === FRAME_RUNTIME_APPLY) {
      receiveRuntimeFrameRequirement(message, _sender);
      sendResponse({ received: true });
      return undefined;
    }
    if (message?.type !== "LEXEND_GET_STATE") return undefined;
    sendResponse({
      ready: true,
      pending: refreshing || refreshTimer !== null,
      refreshRevision,
      healthy: lastRefreshError === null,
      error: lastRefreshError,
      active: isActive(),
      hostname: getEffectiveHostname(),
      scope: getEffectiveSettings().scope
    });
    return undefined;
  });

  start();
})();
