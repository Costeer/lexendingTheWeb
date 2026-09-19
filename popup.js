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
  const fieldset = document.querySelector("#scope-fieldset");
  const status = document.querySelector("#status");
  const scopeInputs = [...document.querySelectorAll('input[name="scope"]')];
  const siteEnabledInput = document.querySelector("#site-enabled");
  const siteLabel = document.querySelector("#site-label");
  const siteMessage = document.querySelector("#site-message");
  const siteMatchInput = document.querySelector("#site-match");
  const siteScopeInput = document.querySelector("#site-scope");
  const optionsButton = document.querySelector("#open-options");

  let settings = settingsApi.normalizeSettings();
  let site = null;
  let statusTimer;
  let includeSubdomains = false;

  const getBaseStatus = () => {
    if (!settings.enabled) return "PAUSED";
    if (site && !site.supported) return "UNAVAILABLE";
    if (site && !settingsApi.resolveSite(settings, site.hostname).active) {
      return "SITE PAUSED";
    }
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

    const effective = settingsApi.resolveSite(settings, site.hostname);
    const directRule = settingsApi.getDirectRule(
      settings,
      site.hostname,
      includeSubdomains
    );
    siteLabel.textContent = site.label;
    siteEnabledInput.disabled = !site.supported;
    siteMatchInput.disabled = !site.supported;
    siteScopeInput.disabled = !site.supported;
    siteEnabledInput.checked = site.supported && effective.siteEnabled;
    siteMatchInput.value = includeSubdomains ? "subdomains" : "exact";
    siteScopeInput.value = directRule?.scope ?? "inherit";

    if (!site.supported) {
      siteMessage.textContent = "Browser-protected pages cannot be changed by extensions.";
    } else if (!settings.enabled) {
      siteMessage.textContent = "Lexend is globally paused. This site rule is still editable.";
    } else if (!site.reachable) {
      siteMessage.textContent = "Refresh the page or allow extension access in the browser.";
    } else if (effective.active) {
      const label = effective.scope === "all" ? "body text and headings" : "body text";
      siteMessage.textContent = `Lexend is active for ${label} on this website.`;
    } else {
      siteMessage.textContent = "This website keeps its original typography.";
    }

    status.textContent = getBaseStatus();
  };

  const save = async (nextSettings) => {
    settings = settingsApi.normalizeSettings(nextSettings);
    renderSettings();
    renderSite();

    if (!storage) {
      showStatus("PREVIEW");
      return;
    }

    try {
      await storage.set(settings);
      await storage.remove?.(["disabledSites", "spacing"]);
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

  enabledInput.addEventListener("change", () => {
    save({ ...settings, enabled: enabledInput.checked });
  });

  scopeInputs.forEach((input) => {
    input.addEventListener("change", () => {
      if (input.checked) save({ ...settings, scope: input.value });
    });
  });

  siteEnabledInput.addEventListener("change", () => {
    if (!site?.supported) return;
    const withoutDirectRule = settingsApi.removeSiteRule(
      settings,
      site.hostname,
      includeSubdomains
    );
    const inherited = settingsApi.resolveSite(withoutDirectRule, site.hostname);
    const enabled = siteEnabledInput.checked === inherited.siteEnabled
      ? null
      : siteEnabledInput.checked;
    save(settingsApi.setSiteRule(settings, {
      hostname: site.hostname,
      includeSubdomains,
      enabled
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
    const nextIncludeSubdomains = siteMatchInput.value === "subdomains";
    const currentRule = settingsApi.getDirectRule(
      settings,
      site.hostname,
      includeSubdomains
    );
    let nextSettings = settings;

    if (currentRule) {
      nextSettings = settingsApi.removeSiteRule(
        nextSettings,
        site.hostname,
        includeSubdomains
      );
      nextSettings = settingsApi.setSiteRule(nextSettings, {
        ...currentRule,
        includeSubdomains: nextIncludeSubdomains
      });
    }

    includeSubdomains = nextIncludeSubdomains;
    save(nextSettings);
  });

  optionsButton.addEventListener("click", async () => {
    await extension?.runtime?.openOptionsPage?.();
    globalThis.close?.();
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
      status.textContent = "LOAD FAILED";
    }
  };

  start();
})();
