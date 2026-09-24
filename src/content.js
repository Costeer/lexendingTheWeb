(() => {
  "use strict";

  const extension = globalThis.browser ?? globalThis.chrome;
  const settingsApi = globalThis.LexendSettings;
  const STYLE_ID = "lexend-the-web-styles";
  const FONT_FAMILY = '"Lexend for the Web", sans-serif';
  const styledRoots = new Set();
  let settings = settingsApi.normalizeSettings();

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
      ${getFontFaceCss()}

      ${scale}

      ${createSelector(effective.scope, isShadowRoot)} {
        font-family: ${FONT_FAMILY} !important;
        ${readability}
      }
    `;
  };

  const getEffectiveSettings = () => settingsApi.resolveSite(
    settings,
    getEffectiveHostname()
  );

  const isActive = () => getEffectiveSettings().active;

  const applyToRoot = (root) => {
    let style = root.getElementById?.(STYLE_ID)
      ?? root.querySelector?.(`#${STYLE_ID}`);

    if (!style) {
      style = document.createElement("style");
      style.id = STYLE_ID;
      root.append(style);
    }

    style.textContent = createCss(getEffectiveSettings(), root instanceof ShadowRoot);
    styledRoots.add(root);
  };

  const visitShadowRoots = (node) => {
    if (!(node instanceof Element) && node !== document.documentElement) return;

    if (node.shadowRoot) {
      applyToRoot(node.shadowRoot);
      node.shadowRoot.querySelectorAll("*").forEach((element) => {
        if (element.shadowRoot) visitShadowRoots(element);
      });
    }

    node.querySelectorAll?.("*").forEach((element) => {
      if (element.shadowRoot) visitShadowRoots(element);
    });
  };

  const notifyState = () => {
    if (window.top !== window) return;

    extension.runtime.sendMessage({
      type: "LEXEND_STATE",
      active: isActive()
    }).catch(() => {});
  };

  const applySettings = (nextSettings) => {
    settings = settingsApi.normalizeSettings(nextSettings);

    styledRoots.forEach(applyToRoot);

    if (document.documentElement) {
      applyToRoot(document.documentElement);
      visitShadowRoots(document.documentElement);
    }

    notifyState();
  };

  const observer = new MutationObserver((mutations) => {
    if (document.documentElement && !styledRoots.has(document.documentElement)) {
      applyToRoot(document.documentElement);
    }

    mutations.forEach(({ addedNodes }) => {
      addedNodes.forEach(visitShadowRoots);
    });
  });

  const start = async () => {
    try {
      applySettings(await extension.storage.sync.get(null));
    } catch (error) {
      console.warn("Lexend for the Web could not load settings; using defaults.", error);
      applySettings(settingsApi.defaults);
    }

    observer.observe(document, { childList: true, subtree: true });
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
    if (message?.type !== "LEXEND_GET_STATE") return undefined;
    sendResponse({
      ready: true,
      active: isActive(),
      hostname: getEffectiveHostname(),
      scope: getEffectiveSettings().scope
    });
    return undefined;
  });

  start();
})();
