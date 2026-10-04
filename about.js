(() => {
  "use strict";

  const extension = globalThis.browser ?? globalThis.chrome;
  const settingsApi = globalThis.LexendSettings;
  const applyTheme = (value) => {
    document.documentElement.dataset.theme = settingsApi.normalizeSettings(value).theme;
  };

  applyTheme();

  extension?.storage?.onChanged?.addListener((changes, areaName) => {
    if (areaName === "sync" && Object.hasOwn(changes, "theme")) {
      applyTheme({ theme: changes.theme.newValue });
    }
  });

  const start = async () => {
    try {
      applyTheme(await extension?.storage?.sync?.get(null));
    } catch (error) {
      console.error("Lexend for the Web could not load the interface theme.", error);
    }
  };
  start();
})();
