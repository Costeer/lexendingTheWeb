(() => {
  "use strict";

  const themeKey = "lexend-ui-theme";
  const designKey = "lexend-ui-design";
  // Keep in sync with LexendSettings.designs; this script runs before it loads.
  const designs = Object.freeze(["signal", "paper", "wide"]);

  const remember = (key, value) => {
    try {
      // Extension pages share this synchronous cache; synced settings remain authoritative.
      globalThis.localStorage.setItem(key, value);
    } catch {
      // An unavailable cache must not prevent the saved appearance from being applied.
    }
  };

  const recall = (key) => {
    try {
      return globalThis.localStorage.getItem(key);
    } catch {
      // Fresh installations and restricted storage fall back to the defaults.
      return null;
    }
  };

  const apply = (value) => {
    const theme = value === "dark" ? "dark" : "light";
    document.documentElement.dataset.theme = theme;
    remember(themeKey, theme);
    return theme;
  };

  const applyDesign = (value) => {
    const design = designs.includes(value) ? value : designs[0];
    document.documentElement.dataset.design = design;
    remember(designKey, design);
    return design;
  };

  globalThis.LexendTheme = Object.freeze({ apply, applyDesign, designs });
  // This blocking head script runs before stylesheets and the first page paint.
  apply(recall(themeKey));
  applyDesign(recall(designKey));
})();
