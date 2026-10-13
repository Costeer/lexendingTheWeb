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
  const spacingCustom = document.querySelector("#spacing-custom");
  const spacingCustomChoice = document.querySelector("#spacing-custom-choice");
  const spacingCustomLabel = document.querySelector("#spacing-custom-label");
  const adjustCustomSpacing = document.querySelector("#adjust-custom-spacing");
  const spacingPreviewText = document.querySelector("#spacing-preview-text");
  const quoteAuthor = document.querySelector("#quote-author");
  const siteStrip = document.querySelector("#site-strip");
  const siteStatusText = document.querySelector("#site-status-text");
  const siteMessage = document.querySelector("#site-message");
  const siteSources = document.querySelector("#site-sources");
  const useInheritedSite = document.querySelector("#use-inherited-site");
  const toggleSiteButton = document.querySelector("#toggle-site");
  const restrictedNote = document.querySelector("#restricted-note");
  const feedback = document.querySelector("#popup-feedback");
  const retryLoad = document.querySelector("#retry-load");
  const retrySave = document.querySelector("#retry-save");
  const retryPage = document.querySelector("#retry-page");

  let settings = settingsApi.normalizeSettings({ theme: document.documentElement.dataset.theme });
  let site = null;
  let feedbackTimer;
  const quote = quotesApi.random();
  const preferences = globalThis.LexendPreferences.createClient(extension, {
    theme: settings.theme,
    onChange(value, _loaded, readError) {
      settings = value;
      render();
      if (readError) {
        retryLoad.hidden = false;
        showFeedback(`Settings could not be read. ${readError.message}`, true, 0);
      }
    }
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
      settings.enabled ? "Turn Lexend off everywhere" : "Turn Lexend on everywhere"
    );
    masterState.textContent = settings.enabled ? "On" : "Off";
    enabledInput.disabled = !preferences.loaded;
    toggleSiteButton.disabled = !preferences.loaded || site?.status !== "ready";
    useInheritedSite.disabled = !preferences.loaded || site?.status !== "ready";
    scopeFieldset.disabled = !preferences.loaded || !settings.enabled;
    spacingFieldset.disabled = !preferences.loaded || !settings.enabled;
    scopeInputs.forEach((input) => {
      input.checked = input.value === settings.scope;
    });
    spacingInputs.forEach((input) => {
      input.checked = !input.dataset.custom && Number(input.value) === settings.letterSpacing;
    });
    const isCustom = !spacingInputs.some((input) => !input.dataset.custom && input.checked);
    spacingCustom.checked = isCustom;
    spacingCustom.value = String(settings.letterSpacing);
    spacingCustomChoice.hidden = !isCustom;
    spacingCustomLabel.textContent = `Custom · ${settings.letterSpacing}em`;
    adjustCustomSpacing.hidden = !isCustom;
    spacingPreviewText.style.letterSpacing = `${settings.letterSpacing}em`;
  };

  const ruleSource = (rule) => rule
    ? `${rule.hostname} (${rule.includeSubdomains ? "including subdomains" : "exact host"})`
    : "global setting";

  const renderSite = () => {
    const supported = Boolean(site?.supported);
    siteStrip.hidden = !supported;
    restrictedNote.hidden = !site?.restricted;
    retryPage.hidden = !supported || site.status === "ready";
    siteSources.hidden = !supported || site.status !== "ready";
    useInheritedSite.hidden = true;
    if (!supported) return;

    if (site.status !== "ready") {
      siteStatusText.textContent = site.status === "pending" ? "Page is updating" : "Page unavailable";
      siteMessage.textContent = site.message;
      toggleSiteButton.hidden = true;
      return;
    }
    toggleSiteButton.hidden = false;

    const effective = settingsApi.resolveSite(settings, site.hostname);
    siteSources.textContent = `Site preference: ${effective.siteEnabled ? "Enabled" : "Paused"} from ${effective.enabledRule ? ruleSource(effective.enabledRule) : "default site preference (no activation rule)"}. Scope: ${effective.scope === "all" ? "Body and headings" : "Body text"} from ${ruleSource(effective.scopeRule)}.${settings.enabled ? "" : " The global Off switch takes priority."}`;
    useInheritedSite.hidden = !settingsApi.getDirectRule(settings, site.hostname);
    useInheritedSite.setAttribute("aria-label", `Remove exact overrides for ${site.hostname} and use inherited settings`);
    const confirmed = site.state.active === effective.active && (!effective.active || site.state.scope === effective.scope);
    if (!settings.enabled && confirmed) {
      siteStatusText.textContent = "Off";
      siteMessage.textContent = "Lexend is paused everywhere.";
    } else {
      const status = !confirmed ? "Updating on " : effective.active ? "Active on " : "Paused on ";
      const hostname = document.createElement("strong");
      hostname.textContent = site.hostname;
      siteStatusText.replaceChildren(document.createTextNode(status), hostname);
      retryPage.hidden = confirmed;
      siteMessage.textContent = !confirmed ? "Waiting for this page to apply your settings."
        : effective.active ? (effective.scope === "all" ? "Body text and headings use Lexend." : "Body text uses Lexend.")
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

  const renderSaveRecovery = ({ failures }) => {
    if (preferences.readError) {
      retryLoad.hidden = false;
      showFeedback(`Settings could not be read. ${preferences.readError.message}`, true, 0);
      return;
    }
    retrySave.hidden = !failures.length;
    if (failures.length) showFeedback(failures[0].error.message || "Changes could not be saved.", true, 0);
    else showFeedback("", false, 0);
  };
  const recovery = globalThis.LexendSaveRecovery.createTracker({
    mutate: (operation) => preferences.mutate(operation),
    getSettings: () => settings,
    getConfirmedSettings: () => preferences.confirmedSettings,
    onChange: renderSaveRecovery
  });
  const mutate = async (operation) => {
    if (!preferences.loaded) {
      render();
      return false;
    }
    try {
      await recovery.mutate(operation);
      await refreshSite();
      return true;
    } catch (error) {
      console.error("Lexend for the Web could not save settings.", error);
      return false;
    }
  };
  const save = (changes) => mutate({ type: "patch", changes });

  const getSiteContext = async () => {
    if (!tabs?.query) return { supported: true, restricted: false, status: "error",
      message: "This page is unavailable. Open a website and reopen Lexend to try again." };
    const [tab] = await tabs.query({ active: true, currentWindow: true });
    if (!tab) return { supported: true, restricted: false, status: "error",
      message: "No page is available. Open a website and check again." };
    let url;
    try { url = new URL(tab?.url ?? ""); } catch {}
    const hostname = url?.hostname.toLowerCase() ?? "";
    const restricted = url && (!["http:", "https:"].includes(url.protocol) || protectedHosts.has(hostname));
    if (restricted) return { hostname, supported: false, restricted: true };
    let state;
    if (tab?.id !== undefined && tabs.sendMessage) {
      try { state = await tabs.sendMessage(tab.id, { type: "LEXEND_GET_STATE" }, { frameId: 0 }); }
      catch { /* Missing host access and not-yet-injected tabs share this boundary. */ }
    }
    const context = { hostname: state?.hostname?.trim().toLowerCase() || hostname,
      supported: true, restricted: false, state };
    if (state?.error === "SETTINGS_LOAD_FAILED") return { ...context, status: "error",
      message: "This page couldn't load your settings. Reload the page to try again." };
    if (state?.ready && state?.healthy && !state?.pending && typeof state.active === "boolean") {
      return { ...context, status: "ready" };
    }
    if (state && (state.pending || !state.ready) && !state.error) return { ...context, status: "pending",
      message: "Waiting for this page to finish loading your settings. Check again in a moment." };
    return { ...context, status: "error", message: state
      ? "Lexend couldn't finish updating this page. Reload the page to try again."
      : "Reload this page, then check again. If needed, allow Lexend access to this site in your browser's extension settings." };
  };

  let siteRevision = 0;
  const refreshSite = async () => {
    const revision = ++siteRevision;
    let next;
    try { next = await getSiteContext(); }
    catch { next = { supported: true, restricted: false, status: "error",
      message: "This page is unavailable. Open a website and check again." }; }
    if (revision !== siteRevision) return;
    site = next;
    render();
  };
  retryPage.addEventListener("click", refreshSite);
  retrySave.addEventListener("click", async () => { await recovery.retry(); await refreshSite(); });

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
    const selectSpacing = () => {
      if (input.dataset.custom) return;
      const letterSpacing = Number(input.value);
      if (settings.letterSpacing !== letterSpacing) save({ letterSpacing });
    };
    input.addEventListener("click", selectSpacing);
    input.addEventListener("change", selectSpacing);
  });

  adjustCustomSpacing.addEventListener("click", async () => {
    try {
      const path = "options.html?section=readability-panel&advanced=1";
      if (tabs?.create && extension?.runtime?.getURL) {
        await tabs.create({ url: extension.runtime.getURL(path) });
      } else {
        window.open(path, "_blank");
      }
      window.close();
    } catch {
      showFeedback("Settings could not be opened.", true, 0);
    }
  });

  useInheritedSite.addEventListener("click", async () => {
    if (!site?.supported || site.status !== "ready") return;
    if (await mutate({ type: "removeRule", hostname: site.hostname, includeSubdomains: false })) {
      toggleSiteButton.focus();
    }
  });

  toggleSiteButton.addEventListener("click", () => {
    if (!site?.supported || site.status !== "ready") return;
    mutate({ type: "toggleSite", hostname: site.hostname });
  });

  const start = async () => {
    retryLoad.hidden = true;
    try {
      await preferences.load();
      await refreshSite();
      renderSaveRecovery(recovery.state);
      render();
    } catch (error) {
      console.error("Lexend for the Web could not load settings.", error);
      site = { hostname: "", supported: false, restricted: false };
      retryLoad.hidden = false;
      render();
      showFeedback("Settings could not be loaded.", true, 0);
    }
  };

  retryLoad.addEventListener("click", start);
  renderQuote();
  start();
})();
