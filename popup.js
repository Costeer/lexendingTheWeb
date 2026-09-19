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
  const spacingValues = [0, 0.04, 0.08];

  const enabledInput = document.querySelector("#enabled");
  const masterState = document.querySelector("#master-state");
  const scopeFieldset = document.querySelector("#scope-fieldset");
  const spacingFieldset = document.querySelector("#spacing-fieldset");
  const scopeInputs = [...document.querySelectorAll('input[name="scope"]')];
  const spacingInputs = [...document.querySelectorAll('input[name="spacing"]')];
  const spacingPreview = document.querySelector("#spacing-preview");
  const siteStrip = document.querySelector("#site-strip");
  const siteStatusText = document.querySelector("#site-status-text");
  const toggleSiteButton = document.querySelector("#toggle-site");
  const restrictedNote = document.querySelector("#restricted-note");
  const exportButton = document.querySelector("#export-settings");
  const importButton = document.querySelector("#import-settings");
  const importFile = document.querySelector("#import-file");
  const resetButton = document.querySelector("#reset-settings");
  const resetLabel = resetButton.querySelector("span");
  const optionsButton = document.querySelector("#open-options");
  const feedback = document.querySelector("#popup-feedback");

  let settings = settingsApi.normalizeSettings();
  let site = null;
  let feedbackTimer;
  let resetTimer;
  let resetArmed = false;

  const showFeedback = (message, isError = false, timeout = 2200) => {
    feedback.textContent = message;
    feedback.classList.toggle("is-error", isError);
    clearTimeout(feedbackTimer);
    if (timeout) {
      feedbackTimer = setTimeout(() => {
        feedback.textContent = "";
        feedback.classList.remove("is-error");
      }, timeout);
    }
  };

  const nearestSpacing = (value) => spacingValues.reduce((nearest, candidate) => (
    Math.abs(candidate - value) < Math.abs(nearest - value) ? candidate : nearest
  ));

  const renderSettings = () => {
    enabledInput.checked = settings.enabled;
    enabledInput.setAttribute(
      "aria-label",
      settings.enabled ? "Turn Lexend off" : "Turn Lexend on"
    );
    masterState.textContent = settings.enabled ? "On" : "Off";
    scopeFieldset.disabled = !settings.enabled;
    spacingFieldset.disabled = !settings.enabled;
    scopeInputs.forEach((input) => {
      input.checked = input.value === settings.scope;
    });
    const selectedSpacing = nearestSpacing(settings.letterSpacing);
    spacingInputs.forEach((input) => {
      input.checked = Number(input.value) === selectedSpacing;
    });
    spacingPreview.style.letterSpacing = `${settings.letterSpacing}em`;
  };

  const renderSite = () => {
    const supported = Boolean(site?.supported);
    siteStrip.hidden = !supported;
    restrictedNote.hidden = !site?.restricted;
    if (!supported) return;

    const effective = settingsApi.resolveSite(settings, site.hostname);
    if (!settings.enabled) {
      siteStatusText.textContent = "Off";
    } else {
      const status = effective.active ? "Active on " : "Paused on ";
      const hostname = document.createElement("strong");
      hostname.textContent = site.hostname;
      siteStatusText.replaceChildren(document.createTextNode(status), hostname);
    }
    toggleSiteButton.textContent = effective.siteEnabled ? "Pause here" : "Resume here";
    toggleSiteButton.setAttribute(
      "aria-label",
      `${effective.siteEnabled ? "Pause" : "Resume"} Lexend on ${site.hostname}`
    );
  };

  const render = () => {
    renderSettings();
    renderSite();
  };

  const save = async (nextSettings, successMessage = "") => {
    settings = settingsApi.normalizeSettings(nextSettings);
    render();
    if (!storage) {
      showFeedback("Changes are preview-only here.");
      return false;
    }

    try {
      await storage.set(settings);
      await storage.remove?.(["disabledSites", "spacing"]);
      if (successMessage) showFeedback(successMessage);
      return true;
    } catch (error) {
      console.error("Lexend the Web could not save settings.", error);
      showFeedback("Changes could not be saved.", true, 0);
      return false;
    }
  };

  const getSiteContext = async () => {
    if (!tabs?.query) {
      return { hostname: "example.com", supported: true, restricted: false };
    }

    const [tab] = await tabs.query({ active: true, currentWindow: true });
    let url;
    try {
      url = new URL(tab?.url ?? "");
    } catch {
      return { hostname: "", supported: false, restricted: true };
    }

    const supported = ["http:", "https:"].includes(url.protocol)
      && Boolean(url.hostname)
      && !protectedHosts.has(url.hostname.toLowerCase());
    return {
      hostname: url.hostname.toLowerCase(),
      supported,
      restricted: !supported
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
    setTimeout(() => URL.revokeObjectURL(url), 0);
    showFeedback("Settings exported");
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
      if (input.checked) save({ ...settings, letterSpacing: Number(input.value) });
    });
  });

  toggleSiteButton.addEventListener("click", () => {
    if (!site?.supported) return;
    const effective = settingsApi.resolveSite(settings, site.hostname);
    const withoutExactRule = settingsApi.removeSiteRule(settings, site.hostname, false);
    const inherited = settingsApi.resolveSite(withoutExactRule, site.hostname);
    const desiredEnabled = !effective.siteEnabled;
    save(settingsApi.setSiteRule(settings, {
      hostname: site.hostname,
      includeSubdomains: false,
      enabled: desiredEnabled === inherited.siteEnabled ? null : desiredEnabled
    }));
  });

  exportButton.addEventListener("click", exportSettings);

  importButton.addEventListener("click", () => importFile.click());
  importFile.addEventListener("change", async () => {
    const file = importFile.files?.[0];
    if (!file) return;
    try {
      if (file.size > 256 * 1024) throw new Error("Settings file is too large");
      const payload = JSON.parse(await file.text());
      if (![1, 2].includes(payload?.schemaVersion) || typeof payload.settings !== "object") {
        throw new Error("Unsupported settings file");
      }
      await save(payload.settings, "Settings imported");
    } catch (error) {
      console.error("Lexend the Web could not import settings.", error);
      showFeedback("Choose a valid Lexend settings file.", true, 0);
    } finally {
      importFile.value = "";
    }
  });

  resetButton.addEventListener("click", async () => {
    if (!resetArmed) {
      resetArmed = true;
      resetLabel.textContent = "Confirm reset";
      showFeedback("Click Confirm reset to restore every setting.", false, 4000);
      clearTimeout(resetTimer);
      resetTimer = setTimeout(() => {
        resetArmed = false;
        resetLabel.textContent = "Reset";
      }, 4000);
      return;
    }

    clearTimeout(resetTimer);
    resetArmed = false;
    resetLabel.textContent = "Reset";
    await save(settingsApi.defaults, "Settings reset");
  });

  optionsButton.addEventListener("click", async () => {
    try {
      await extension?.runtime?.openOptionsPage?.();
      globalThis.close?.();
    } catch (error) {
      console.error("Lexend the Web could not open settings.", error);
      showFeedback("Settings could not be opened.", true, 0);
    }
  });

  extension?.storage?.onChanged?.addListener((changes, areaName) => {
    if (areaName !== "sync") return;
    const nextSettings = { ...settings };
    Object.entries(changes).forEach(([key, change]) => {
      if (change.newValue === undefined) delete nextSettings[key];
      else nextSettings[key] = change.newValue;
    });
    settings = settingsApi.normalizeSettings(nextSettings);
    render();
  });

  const start = async () => {
    try {
      const [storedSettings, siteContext] = await Promise.all([
        storage ? storage.get(null) : settingsApi.defaults,
        getSiteContext()
      ]);
      settings = settingsApi.normalizeSettings(storedSettings);
      site = siteContext;
      render();
    } catch (error) {
      console.error("Lexend the Web could not load settings.", error);
      settings = settingsApi.normalizeSettings();
      site = { hostname: "", supported: false, restricted: true };
      render();
      showFeedback("Settings could not be loaded.", true, 0);
    }
  };

  start();
})();
