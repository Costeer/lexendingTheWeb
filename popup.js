(() => {
  "use strict";

  const extension = globalThis.browser ?? globalThis.chrome;
  const settingsApi = globalThis.LexendSettings;
  const quotesApi = globalThis.LexendQuotes;
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
  const settingsButton = document.querySelector("#settings-button");
  const masterState = document.querySelector("#master-state");
  const scopeFieldset = document.querySelector("#scope-fieldset");
  const spacingFieldset = document.querySelector("#spacing-fieldset");
  const scopeInputs = [...document.querySelectorAll('input[name="scope"]')];
  const spacingInputs = [...document.querySelectorAll('input[name="spacing"]')];
  const spacingPreviewText = document.querySelector("#spacing-preview-text");
  const quoteAuthor = document.querySelector("#quote-author");
  const siteStrip = document.querySelector("#site-strip");
  const siteStatusText = document.querySelector("#site-status-text");
  const siteMessage = document.querySelector("#site-message");
  const toggleSiteButton = document.querySelector("#toggle-site");
  const restrictedNote = document.querySelector("#restricted-note");
  const feedback = document.querySelector("#popup-feedback");
  const retryLoad = document.querySelector("#retry-load");

  let settings = settingsApi.normalizeSettings({ theme: document.documentElement.dataset.theme });
  let site = null;
  let feedbackTimer;
  const quote = quotesApi.random();
  const preferences = globalThis.LexendPreferences.createClient(extension, {
    theme: settings.theme,
    onChange(value) { settings = value; render(); }
  });

  const renderQuote = () => {
    spacingPreviewText.textContent = `“${quote.text}”`;
    spacingPreviewText.lang = quote.lang;
    quoteAuthor.textContent = quote.author;
    quoteAuthor.href = quote.url;
  };

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

  const renderSettings = () => {
    globalThis.LexendTheme.apply(settings.theme);
    enabledInput.checked = settings.enabled;
    enabledInput.setAttribute(
      "aria-label",
      settings.enabled ? "Turn Lexend off" : "Turn Lexend on"
    );
    masterState.textContent = settings.enabled ? "On" : "Off";
    enabledInput.disabled = !preferences.loaded;
    toggleSiteButton.disabled = !preferences.loaded;
    scopeFieldset.disabled = !preferences.loaded || !settings.enabled;
    spacingFieldset.disabled = !preferences.loaded || !settings.enabled;
    scopeInputs.forEach((input) => {
      input.checked = input.value === settings.scope;
    });
    spacingInputs.forEach((input) => {
      input.checked = Number(input.value) === settings.letterSpacing;
    });
    spacingPreviewText.style.letterSpacing = `${settings.letterSpacing}em`;
  };

  const renderSite = () => {
    const supported = Boolean(site?.supported);
    siteStrip.hidden = !supported;
    restrictedNote.hidden = !site?.restricted;
    if (!supported) return;

    const effective = settingsApi.resolveSite(settings, site.hostname);
    if (!settings.enabled) {
      siteStatusText.textContent = "Off";
      siteMessage.textContent = "Lexend is paused everywhere.";
    } else {
      const status = effective.active ? "Active on " : "Paused on ";
      const hostname = document.createElement("strong");
      hostname.textContent = site.hostname;
      siteStatusText.replaceChildren(document.createTextNode(status), hostname);
      siteMessage.textContent = effective.active
        ? (effective.scope === "all" ? "Body text and headings use Lexend." : "Body text uses Lexend.")
        : "This site uses its original fonts.";
    }
    toggleSiteButton.textContent = effective.active ? "Pause here" : "Resume here";
    toggleSiteButton.setAttribute(
      "aria-label",
      `${effective.active ? "Pause" : "Resume"} Lexend on ${site.hostname}`
    );
  };

  const render = () => {
    renderSettings();
    renderSite();
  };

  const mutate = async (operation) => {
    if (!preferences.loaded) {
      render();
      return false;
    }

    try {
      await preferences.mutate(operation);
      return true;
    } catch (error) {
      console.error("Lexend for the Web could not save settings.", error);
      showFeedback(error.message || "Changes could not be saved.", true, 0);
      return false;
    }
  };
  const save = (changes) => mutate({ type: "patch", changes });

  const getSiteContext = async () => {
    if (!tabs?.query) {
      return { hostname: "example.com", supported: true, restricted: false };
    }

    const [tab] = await tabs.query({ active: true, currentWindow: true });
    if (tab?.id !== undefined && tabs.sendMessage) {
      try {
        const state = await tabs.sendMessage(tab.id, { type: "LEXEND_GET_STATE" }, { frameId: 0 });
        const hostname = state?.hostname?.trim().toLowerCase();
        if (state?.error === "SETTINGS_LOAD_FAILED") {
          return { hostname, supported: false, restricted: false, error: "This page couldn't load your settings. Reload the page to try again." };
        }
        if (state?.ready && hostname) {
          return { hostname, supported: true, restricted: false };
        }
      } catch {}
    }

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

  settingsButton.addEventListener("click", async () => {
    try {
      if (extension?.runtime?.openOptionsPage) {
        await extension.runtime.openOptionsPage();
      } else if (tabs?.create && extension?.runtime?.getURL) {
        await tabs.create({ url: extension.runtime.getURL("options.html") });
      } else {
        window.open("options.html", "_blank");
      }
      window.close();
    } catch (error) {
      console.error("Lexend for the Web could not open settings.", error);
      showFeedback("Settings could not be opened.", true, 0);
    }
  });

  enabledInput.addEventListener("change", () => {
    save({ enabled: enabledInput.checked });
  });

  scopeInputs.forEach((input) => {
    input.addEventListener("change", () => {
      if (input.checked) save({ scope: input.value });
    });
  });

  spacingInputs.forEach((input) => {
    input.addEventListener("click", () => {
      const letterSpacing = Number(input.value);
      if (settings.letterSpacing !== letterSpacing) {
        save({ letterSpacing });
      }
    });
  });

  toggleSiteButton.addEventListener("click", () => {
    if (!site?.supported) return;
    mutate({ type: "toggleSite", hostname: site.hostname });
  });

  const start = async () => {
    retryLoad.hidden = true;
    try {
      await preferences.load();
      try { site = await getSiteContext(); }
      catch { site = { hostname: "", supported: false, restricted: true }; }
      if (site.error) showFeedback(site.error, true, 0);
      else feedback.textContent = "";
      render();
    } catch (error) {
      console.error("Lexend for the Web could not load settings.", error);
      site = { hostname: "", supported: false, restricted: true };
      retryLoad.hidden = false;
      render();
      showFeedback("Settings could not be loaded.", true, 0);
    }
  };

  retryLoad.addEventListener("click", start);
  renderQuote();
  start();
})();
