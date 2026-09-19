(() => {
  "use strict";

  const extension = globalThis.browser ?? globalThis.chrome;
  const STYLE_ID = "lexend-the-web-styles";
  const FONT_FAMILY = '"Lexend the Web", sans-serif';
  const defaults = { enabled: true, scope: "body" };
  const styledRoots = new Set();
  let settings = defaults;

  const excludedElements = [
    "pre",
    "code",
    "kbd",
    "samp",
    "math",
    "svg",
    "svg *",
    "[data-lexend-ignore]",
    "[data-lexend-ignore] *",
    "[aria-hidden='true']",
    "[aria-hidden='true'] *",
    "[class*='icon' i]",
    "[class*='icon' i] *",
    "[class*='symbol' i]",
    "[class*='symbol' i] *"
  ];

  const headers = ["h1", "h2", "h3", "h4", "h5", "h6"];

  const getFontUrl = () => extension.runtime.getURL(
    "assets/fonts/lexend-latin-wght-normal.woff2"
  );

  const createCss = ({ enabled, scope }, isShadowRoot) => {
    if (!enabled) return "";

    const exclusions = [...excludedElements];
    if (scope === "body") {
      headers.forEach((header) => exclusions.push(header, `${header} *`));
    }

    const selector = `:where(${isShadowRoot ? "*" : "body, body *"})${exclusions
      .map((item) => `:not(${item})`)
      .join("")}`;

    return `
      @font-face {
        font-family: "Lexend the Web";
        src: url("${getFontUrl()}") format("woff2-variations");
        font-style: normal;
        font-weight: 100 900;
        font-display: swap;
      }

      ${selector} {
        font-family: ${FONT_FAMILY} !important;
      }
    `;
  };

  const applyToRoot = (root) => {
    let style = root.getElementById?.(STYLE_ID)
      ?? root.querySelector?.(`#${STYLE_ID}`);

    if (!style) {
      style = document.createElement("style");
      style.id = STYLE_ID;
      root.append(style);
    }

    style.textContent = createCss(settings, root instanceof ShadowRoot);
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

  const applySettings = (nextSettings) => {
    settings = {
      enabled: typeof nextSettings.enabled === "boolean"
        ? nextSettings.enabled
        : defaults.enabled,
      scope: nextSettings.scope === "all" ? "all" : defaults.scope
    };

    styledRoots.forEach(applyToRoot);

    if (document.documentElement) {
      applyToRoot(document.documentElement);
      visitShadowRoots(document.documentElement);
    }
  };

  const observer = new MutationObserver((mutations) => {
    mutations.forEach(({ addedNodes }) => {
      addedNodes.forEach(visitShadowRoots);
    });
  });

  const start = async () => {
    try {
      applySettings(await extension.storage.sync.get(defaults));
    } catch (error) {
      console.warn("Lexend the Web could not load settings; using defaults.", error);
      applySettings(defaults);
    }

    observer.observe(document, { childList: true, subtree: true });
  };

  extension.storage.onChanged.addListener((changes, areaName) => {
    if (areaName !== "sync") return;

    applySettings({
      enabled: changes.enabled?.newValue ?? settings.enabled,
      scope: changes.scope?.newValue ?? settings.scope
    });
  });

  start();
})();
