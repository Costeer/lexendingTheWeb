(() => {
  "use strict";

  const extension = globalThis.browser ?? globalThis.chrome;
  const settingsApi = globalThis.LexendSettings;
  const storage = extension?.storage?.sync;
  const tabs = extension?.tabs;
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
  const enabledState = document.querySelector("#enabled-state");
  const scopeFieldset = document.querySelector("#scope-fieldset");
  const spacingFieldset = document.querySelector("#spacing-fieldset");
  const status = document.querySelector("#status");
  const scopeInputs = [...document.querySelectorAll('input[name="scope"]')];
  const spacingInputs = [...document.querySelectorAll('input[name="spacing"]')];
  const spacingPreview = document.querySelector("#spacing-preview");
  const siteContainer = document.querySelector("#site-container");
  const siteState = document.querySelector("#site-state");
  const siteLabel = document.querySelector("#site-label");
  const siteAction = document.querySelector("#site-action");
  const siteMatchInput = document.querySelector("#site-match");
  const siteScopeInput = document.querySelector("#site-scope");
  const optionsButton = document.querySelector("#open-options");
  const exportButton = document.querySelector("#export-settings");
  const importButton = document.querySelector("#import-settings");
  const importFile = document.querySelector("#import-file");
  const resetButton = document.querySelector("#reset-settings");

  let settings = settingsApi.normalizeSettings();
  let site = null;
  let includeSubdomains = false;
  let statusTimer;

  const getEffectiveSite = () => site?.supported
    ? settingsApi.resolveSite(settings, site.hostname)
    : null;

  const getBaseStatus = () => {
    if (!settings.enabled) return "Paused";
    if (site && !site.supported) return "Unavailable";
    if (getEffectiveSite() && !getEffectiveSite().siteEnabled) return "Site paused";
    return "Active";
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
    enabledState.textContent = settings.enabled ? "On" : "Off";
    scopeFieldset.disabled = !settings.enabled;
    spacingFieldset.disabled = !settings.enabled;

    scopeInputs.forEach((input) => {
      input.checked = input.value === settings.scope;
      input.closest(".choice").classList.toggle("is-selected", input.checked);
    });

    spacingInputs.forEach((input) => {
      input.checked = input.value === settings.spacing;
    });
    spacingPreview.dataset.spacing = settings.spacing;
    status.textContent = getBaseStatus();
  };

  const renderSite = () => {
    if (!site) return;

    siteContainer.hidden = !site.supported;
    if (!site.supported) {
      status.textContent = getBaseStatus();
      return;
    }

    const effective = getEffectiveSite();
    const directRule = settingsApi.getDirectRule(
      settings,
      site.hostname,
      includeSubdomains
    );
    const paused = !effective.siteEnabled;

    siteLabel.textContent = site.label;
    siteAction.disabled = false;
    siteAction.textContent = paused ? "Resume here" : "Pause here";
    siteAction.setAttribute(
      "aria-label",
      `${paused ? "Resume" : "Pause"} Lexend on ${site.label}`
    );
    siteMatchInput.disabled = false;
    siteMatchInput.value = includeSubdomains ? "subdomains" : "exact";
    siteScopeInput.disabled = false;
    siteScopeInput.value = directRule?.scope ?? "inherit";

    if (paused) siteState.textContent = "Paused on";
    else if (!settings.enabled) siteState.textContent = "Off on";
    else if (!site.reachable) siteState.textContent = "Ready on";
    else siteState.textContent = "Active on";

    status.textContent = getBaseStatus();
  };

  const save = async (nextSettings, confirmation = "Saved") => {
    settings = settingsApi.normalizeSettings(nextSettings);
    renderSettings();
    renderSite();

    if (!storage) {
      showStatus("Preview");
      return;
    }

    try {
      await storage.set(settings);
      await storage.remove?.("disabledSites");
      showStatus(confirmation);
    } catch (error) {
      console.error("Lexend the Web could not save settings.", error);
      status.textContent = "Save failed";
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
      label: url.hostname,
      supported,
      reachable
    };
  };

  const exportSettings = () => {
    const payload = {
      schemaVersion: 2,
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
    showStatus("Exported");
  };

  const importSettings = async (file) => {
    try {
      if (file.size > 256 * 1024) throw new Error("Settings file is too large");

      const payload = JSON.parse(await file.text());
      if (![1, 2].includes(payload?.schemaVersion)
        || typeof payload?.settings !== "object") {
        throw new Error("Unsupported settings file");
      }

      await save(payload.settings, "Imported");
    } catch (error) {
      console.error("Lexend the Web could not import settings.", error);
      status.textContent = "Invalid file";
    } finally {
      importFile.value = "";
    }
  };

  enabledInput.addEventListener("change", () => {
    save({ ...settings, enabled: enabledInput.checked });
  });

  scopeInputs.forEach((input) => {
    input.addEventListener("change", () => {
      if (input.checked) save({ ...settings, scope: input.value });
    });
  });

  spacingInputs.forEach((input) => {
    input.addEventListener("change", () => {
      if (input.checked) save({ ...settings, spacing: input.value });
    });
  });

  siteAction.addEventListener("click", () => {
    if (!site?.supported) return;

    const effective = getEffectiveSite();
    const desiredEnabled = !effective.siteEnabled;
    const withoutDirectRule = settingsApi.removeSiteRule(
      settings,
      site.hostname,
      includeSubdomains
    );
    const inherited = settingsApi.resolveSite(withoutDirectRule, site.hostname);
    save(settingsApi.setSiteRule(settings, {
      hostname: site.hostname,
      includeSubdomains,
      enabled: desiredEnabled === inherited.siteEnabled ? null : desiredEnabled
    }));
  });

  siteScopeInput.addEventListener("change", () => {
    if (!site?.supported) return;
    save(settingsApi.setSiteRule(settings, {
      hostname: site.hostname,
      includeSubdomains,
      scope: siteScopeInput.value === "inherit" ? null : siteScopeInput.value
    }));
  });

  siteMatchInput.addEventListener("change", () => {
    if (!site?.supported) return;
    includeSubdomains = siteMatchInput.value === "subdomains";
    renderSite();
  });

  optionsButton.addEventListener("click", async () => {
    await extension?.runtime?.openOptionsPage?.();
    globalThis.close?.();
  });
  exportButton.addEventListener("click", exportSettings);
  importButton.addEventListener("click", () => importFile.click());
  importFile.addEventListener("change", () => {
    if (importFile.files?.[0]) importSettings(importFile.files[0]);
  });
  resetButton.addEventListener("click", () => {
    save(settingsApi.defaults, "Reset to defaults");
  });

  extension?.storage?.onChanged?.addListener((changes, areaName) => {
    if (areaName !== "sync") return;
    const nextSettings = { ...settings };
    Object.entries(changes).forEach(([key, change]) => {
      if (change.newValue === undefined) delete nextSettings[key];
      else nextSettings[key] = change.newValue;
    });
    settings = settingsApi.normalizeSettings(nextSettings);
    renderSettings();
    renderSite();
  });

  const start = async () => {
    try {
      const [storedSettings, siteContext] = await Promise.all([
        storage ? storage.get(null) : settingsApi.defaults,
        getSiteContext()
      ]);
      settings = settingsApi.normalizeSettings(storedSettings);
      site = siteContext;
      includeSubdomains = Boolean(
        site.supported
        && !settingsApi.getDirectRule(settings, site.hostname, false)
        && settingsApi.getDirectRule(settings, site.hostname, true)
      );
      renderSettings();
      renderSite();
    } catch (error) {
      console.error("Lexend the Web could not load settings.", error);
      settings = settingsApi.normalizeSettings();
      site = {
        hostname: "",
        label: "Browser page",
        supported: false,
        reachable: false
      };
      renderSettings();
      renderSite();
      status.textContent = "Load failed";
    }
  };

  start();
})();
