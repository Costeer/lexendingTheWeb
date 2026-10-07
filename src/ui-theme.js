(() => {
  "use strict";

  const cacheKey = "lexend-ui-theme";
  const apply = (value) => {
    const theme = value === "dark" ? "dark" : "light";
    document.documentElement.dataset.theme = theme;
    try {
      // Extension pages share this synchronous cache; synced settings remain authoritative.
      globalThis.localStorage.setItem(cacheKey, theme);
    } catch {
      // An unavailable cache must not prevent the saved theme from being applied.
    }
    return theme;
  };

  let cachedTheme;
  try {
    cachedTheme = globalThis.localStorage.getItem(cacheKey);
  } catch {
    // Fresh installations and restricted storage fall back to the default theme.
  }

  globalThis.LexendTheme = Object.freeze({ apply });
  // This blocking head script runs before stylesheets and the first page paint.
  apply(cachedTheme);
})();
