(() => {
  "use strict";

  const extension = globalThis.browser ?? globalThis.chrome;
  const storage = extension?.storage?.sync;
  const tabs = extension?.tabs;
  const defaults = { enabled: true, scope: "body", disabledSites: [] };
  const protectedHosts = new Set([
    "chrome.google.com",
    "chromewebstore.google.com",
    "addons.cdn.mozilla.net",
    "addons.mozilla.org",
    "accounts.firefox.com",
    "api.accounts.firefox.com",
    "content.cdn.mozilla.net",
    "discovery.addons.mozilla.org",
    "install.mozilla.org",
    "oauth.accounts.firefox.com",
    "support.mozilla.org",
    "sync.services.mozilla.com"
  ]);

  const enabledInput = document.querySelector("#enabled");
  const fieldset = document.querySelector("#scope-fieldset");
  const status = document.querySelector("#status");
  const scopeInputs = [...document.querySelectorAll('input[name="scope"]')];
  const siteEnabledInput = document.querySelector("#site-enabled");
  const siteLabel = document.querySelector("#site-label");
  const siteMessage = document.querySelector("#site-message");
  const exportButton = document.querySelector("#export-settings");
  const importButton = document.querySelector("#import-settings");
  const importFile = document.querySelector("#import-file");

  let settings = defaults;
  let site = null;
  let statusTimer;

  const normalizeSettings = (value) => ({
    enabled: typeof value?.enabled === "boolean" ? value.enabled : defaults.enabled,
    scope: value?.scope === "all" ? "all" : defaults.scope,
    disabledSites: [...new Set(
      (Array.isArray(value?.disabledSites) ? value.disabledSites : [])
        .filter((hostname) => typeof hostname === "string")
        .map((hostname) => hostname.trim().toLowerCase())
        .filter((hostname) => (
          hostname.length > 0
          && hostname.length <= 253
          && !hostname.includes("/")
          && (/^[a-z0-9.-]+$/.test(hostname) || /^\[[0-9a-f:]+\]$/.test(hostname))
        ))
        .slice(0, 250)
    )].sort()
  });

  const getBaseStatus = () => {
    if (!settings.enabled) return "PAUSED";
    if (site && !site.supported) return "UNAVAILABLE";
    if (site && settings.disabledSites.includes(site.hostname)) return "SITE PAUSED";
    return "ACTIVE";
  };

  const showStatus = (message) => {
    status.textContent = message;
    clearTimeout(statusTimer);
    statusTimer = setTimeout(() => {
      status.textContent = getBaseStatus();
    }, 1400);
  };

  const renderSettings = () => {
    enabledInput.checked = settings.enabled;
    fieldset.disabled = !settings.enabled;
    scopeInputs.forEach((input) => {
      input.checked = input.value === settings.scope;
      input.closest(".choice").classList.toggle("is-selected", input.checked);
    });
    status.textContent = getBaseStatus();
  };

  const renderSite = () => {
    if (!site) return;

    siteLabel.textContent = site.label;
    siteEnabledInput.disabled = !site.supported;
    siteEnabledInput.checked = site.supported
      && !settings.disabledSites.includes(site.hostname);

    if (!site.supported) {
      siteMessage.textContent = "Browser-protected pages cannot be changed by extensions.";
    } else if (!site.reachable) {
      siteMessage.textContent = "Refresh the page or allow extension access in the browser.";
    } else if (siteEnabledInput.checked) {
      siteMessage.textContent = "Lexend is allowed on this website.";
    } else {
      siteMessage.textContent = "This website keeps its original typography.";
    }

    status.textContent = getBaseStatus();
  };

  const save = async (nextSettings) => {
    settings = normalizeSettings({ ...settings, ...nextSettings });
    renderSettings();
    renderSite();

    if (!storage) {
      showStatus("PREVIEW");
      return;
    }

    try {
      await storage.set(nextSettings);
      showStatus("SAVED");
    } catch (error) {
      console.error("Lexend the Web could not save settings.", error);
      status.textContent = "SAVE FAILED";
    }
  };

  const getSiteContext = async () => {
    if (!tabs?.query) {
      return {
        hostname: "example.com",
        label: "example.com",
        supported: true,
        reachable: true
      };
    }

    const [tab] = await tabs.query({ active: true, currentWindow: true });
    let url;

    try {
      url = new URL(tab?.url ?? "");
    } catch {
      return { hostname: "", label: "Browser page", supported: false, reachable: false };
    }

    const supported = ["http:", "https:"].includes(url.protocol)
      && !protectedHosts.has(url.hostname);
    let reachable = false;

    if (supported && tab?.id !== undefined) {
      try {
        const response = await tabs.sendMessage(tab.id, { type: "LEXEND_GET_STATE" });
        reachable = Boolean(response?.ready);
      } catch {
        reachable = false;
      }
    }

    return {
      hostname: url.hostname.toLowerCase(),
      label: supported ? url.hostname : "Browser page",
      supported,
      reachable
    };
  };

  const exportSettings = () => {
    const payload = {
      schemaVersion: 1,
      exportedAt: new Date().toISOString(),
      settings
    };
    const blob = new Blob([`${JSON.stringify(payload, null, 2)}\n`], {
      type: "application/json"
    });
    const url = URL.createObjectURL(blob);
    const link = document.createElement("a");
    link.href = url;
    link.download = "lexend-the-web-settings.json";
    link.click();
    URL.revokeObjectURL(url);
    showStatus("EXPORTED");
  };

  const importSettings = async (file) => {
    try {
      if (file.size > 256 * 1024) throw new Error("Settings file is too large");

      const payload = JSON.parse(await file.text());
      if (payload?.schemaVersion !== 1 || typeof payload?.settings !== "object") {
        throw new Error("Unsupported settings file");
      }

      const imported = normalizeSettings(payload.settings);
      settings = imported;

      if (storage) await storage.set(imported);

      renderSettings();
      renderSite();
      showStatus("IMPORTED");
    } catch (error) {
      console.error("Lexend the Web could not import settings.", error);
      status.textContent = "INVALID FILE";
    } finally {
      importFile.value = "";
    }
  };

  enabledInput.addEventListener("change", () => {
    save({ enabled: enabledInput.checked });
  });

  scopeInputs.forEach((input) => {
    input.addEventListener("change", () => {
      if (input.checked) save({ scope: input.value });
    });
  });

  siteEnabledInput.addEventListener("change", () => {
    if (!site?.supported) return;

    const disabledSites = new Set(settings.disabledSites);
    if (siteEnabledInput.checked) disabledSites.delete(site.hostname);
    else disabledSites.add(site.hostname);
    save({ disabledSites: [...disabledSites].sort() });
  });

  exportButton.addEventListener("click", exportSettings);
  importButton.addEventListener("click", () => importFile.click());
  importFile.addEventListener("change", () => {
    if (importFile.files?.[0]) importSettings(importFile.files[0]);
  });

  const start = async () => {
    try {
      const [storedSettings, siteContext] = await Promise.all([
        storage ? storage.get(defaults) : defaults,
        getSiteContext()
      ]);
      settings = normalizeSettings(storedSettings);
      site = siteContext;
      renderSettings();
      renderSite();
    } catch (error) {
      console.error("Lexend the Web could not load settings.", error);
      settings = defaults;
      site = {
        hostname: "",
        label: "Browser page",
        supported: false,
        reachable: false
      };
      renderSettings();
      renderSite();
      status.textContent = "LOAD FAILED";
    }
  };

  start();
})();
