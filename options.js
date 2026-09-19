(() => {
  "use strict";

  const extension = globalThis.browser ?? globalThis.chrome;
  const settingsApi = globalThis.LexendSettings;
  const storage = extension?.storage?.sync;
  const textScaleInputs = [...document.querySelectorAll('input[name="textScale"]')];
  const lineHeightInputs = [...document.querySelectorAll('input[name="lineHeight"]')];
  const letterSpacingInputs = [...document.querySelectorAll('input[name="letterSpacing"]')];
  const previewCopy = document.querySelector("#preview-copy");
  const resetReadabilityButton = document.querySelector("#reset-readability");
  const saveStatus = document.querySelector("#save-status");
  const saveStatusText = document.querySelector("#save-status-text");
  const retrySaveButton = document.querySelector("#retry-save");
  const addRuleForm = document.querySelector("#add-rule");
  const hostnameInput = document.querySelector("#new-hostname");
  const hostnameError = document.querySelector("#hostname-error");
  const subdomainsInput = document.querySelector("#new-subdomains");
  const subdomainPreview = document.querySelector("#subdomain-preview");
  const ruleToolbar = document.querySelector("#rule-toolbar");
  const searchInput = document.querySelector("#rule-search");
  const ruleList = document.querySelector("#rule-list");
  const searchEmpty = document.querySelector("#search-empty");
  const emptyRules = document.querySelector("#empty-rules");
  const clearRulesButton = document.querySelector("#clear-rules");
  const exportButton = document.querySelector("#export-settings");
  const importButton = document.querySelector("#import-settings");
  const importFile = document.querySelector("#import-file");
  const importError = document.querySelector("#import-error");
  const shortcutOutput = document.querySelector("#shortcut");
  const shortcutAction = document.querySelector("#shortcut-action");
  const shortcutInstructions = document.querySelector("#shortcut-instructions");
  const toast = document.querySelector("#toast");
  const toastMessage = document.querySelector("#toast-message");
  const toastAction = document.querySelector("#toast-action");

  let settings = settingsApi.normalizeSettings();
  let failedSettings = null;
  let writeQueue = Promise.resolve();
  let saveRevision = 0;
  let toastTimer;

  const setSaveState = (state, message) => {
    saveStatus.className = `save-status is-${state}`;
    saveStatusText.textContent = message;
    retrySaveButton.hidden = state !== "error";
  };

  const showToast = (message, actionLabel = "", action = null, timeout = 3000) => {
    clearTimeout(toastTimer);
    toastMessage.textContent = message;
    toastAction.textContent = actionLabel;
    toastAction.hidden = !actionLabel;
    toastAction.onclick = action;
    toast.hidden = false;
    toastTimer = setTimeout(() => {
      toast.hidden = true;
      toastAction.onclick = null;
    }, timeout);
  };

  const normalizeHostnameInput = (rawValue) => {
    const value = rawValue.trim().toLowerCase();
    if (!value) return "";
    try {
      const url = new URL(
        /^[a-z][a-z0-9+.-]*:\/\//i.test(value) ? value : `http://${value}`
      );
      if (url.username || url.password) return "";
      return url.hostname.toLowerCase().replace(/\.$/, "");
    } catch {
      return "";
    }
  };

  const setRadioValue = (inputs, value) => {
    inputs.forEach((input) => {
      input.checked = Number(input.value) === Number(value);
    });
  };

  const renderPreview = () => {
    previewCopy.style.fontSize = `${14 * settings.textScale / 100}px`;
    previewCopy.style.lineHeight = settings.lineHeight || 1.5;
    previewCopy.style.letterSpacing = `${settings.letterSpacing}em`;
  };

  const makeDeleteButton = (rule) => {
    const button = document.createElement("button");
    button.type = "button";
    button.className = "delete-rule";
    button.setAttribute("aria-label", `Delete rule for ${rule.hostname}`);
    button.title = `Delete rule for ${rule.hostname}`;
    button.innerHTML = '<svg aria-hidden="true" viewBox="0 0 24 24"><path d="M8 3h8l1 2h4v2H3V5h4l1-2Zm-2 6h12l-1 12H7L6 9Zm3 2v8h2v-8H9Zm4 0v8h2v-8h-2Z" /></svg>';
    return button;
  };

  const renderRules = () => {
    const query = searchInput.value.trim().toLowerCase();
    const rules = settings.siteRules
      .filter((rule) => rule.hostname.includes(query))
      .sort((a, b) => (
        a.hostname.localeCompare(b.hostname)
        || Number(a.includeSubdomains) - Number(b.includeSubdomains)
      ));
    ruleList.replaceChildren();

    rules.forEach((rule) => {
      const active = rule.enabled !== false;
      const row = document.createElement("div");
      row.className = "rule-row";
      row.dataset.hostname = rule.hostname;
      row.dataset.subdomains = String(rule.includeSubdomains);

      const domain = document.createElement("div");
      domain.className = "rule-domain";
      const hostname = document.createElement("strong");
      hostname.textContent = rule.hostname;
      domain.append(hostname);
      if (rule.includeSubdomains) {
        const tag = document.createElement("span");
        tag.className = "rule-tag";
        tag.textContent = "+ subdomains";
        domain.append(tag);
      }

      const status = document.createElement("span");
      status.className = "rule-status";
      status.textContent = active ? "Active" : "Paused";

      const switchLabel = document.createElement("label");
      switchLabel.className = "rule-switch";
      const switchInput = document.createElement("input");
      switchInput.type = "checkbox";
      switchInput.className = "rule-enabled";
      switchInput.checked = active;
      switchInput.setAttribute(
        "aria-label",
        `${active ? "Pause" : "Activate"} Lexend for ${rule.hostname}`
      );
      const track = document.createElement("span");
      track.className = "switch-track";
      track.setAttribute("aria-hidden", "true");
      const thumb = document.createElement("span");
      thumb.className = "switch-thumb";
      track.append(thumb);
      switchLabel.append(switchInput, track);

      row.append(domain, status, switchLabel, makeDeleteButton(rule));
      ruleList.append(row);
    });

    const hasRules = settings.siteRules.length > 0;
    emptyRules.hidden = hasRules;
    ruleToolbar.hidden = !hasRules;
    ruleToolbar.querySelector(".search-field").hidden = settings.siteRules.length <= 5;
    clearRulesButton.hidden = !hasRules;
    searchEmpty.hidden = !hasRules || !query || rules.length > 0;
  };

  const render = () => {
    setRadioValue(textScaleInputs, settings.textScale);
    setRadioValue(lineHeightInputs, settings.lineHeight);
    setRadioValue(letterSpacingInputs, settings.letterSpacing);
    renderPreview();
    renderRules();
  };

  const persist = (snapshot) => {
    const revision = ++saveRevision;
    failedSettings = null;
    setSaveState("saving", "Saving…");

    const write = async () => {
      if (!storage) {
        if (revision === saveRevision) {
          setSaveState("error", "Changes are preview-only");
          failedSettings = snapshot;
        }
        return false;
      }
      try {
        await storage.set(snapshot);
        await storage.remove?.(["disabledSites", "spacing"]);
        if (revision === saveRevision) {
          failedSettings = null;
          setSaveState("saved", "All changes saved");
        }
        return true;
      } catch (error) {
        console.error("Lexend the Web could not save settings.", error);
        if (revision === saveRevision) {
          failedSettings = snapshot;
          setSaveState("error", "Changes could not be saved");
        }
        return false;
      }
    };

    writeQueue = writeQueue.then(write, write);
    return writeQueue;
  };

  const save = (nextSettings) => {
    settings = settingsApi.normalizeSettings(nextSettings);
    render();
    return persist(settings);
  };

  const clearHostnameError = () => {
    hostnameError.textContent = "";
    hostnameInput.removeAttribute("aria-invalid");
  };

  const showHostnameError = (message) => {
    hostnameError.textContent = message;
    hostnameInput.setAttribute("aria-invalid", "true");
    hostnameInput.focus();
  };

  const updateSubdomainPreview = () => {
    const hostname = normalizeHostnameInput(hostnameInput.value);
    subdomainPreview.textContent = `*.${settingsApi.validHostname(hostname) ? hostname : "example.com"}`;
  };

  [...textScaleInputs, ...lineHeightInputs, ...letterSpacingInputs].forEach((input) => {
    input.addEventListener("change", () => {
      if (!input.checked) return;
      const key = input.name;
      save({ ...settings, [key]: Number(input.value) });
    });
  });

  resetReadabilityButton.addEventListener("click", () => {
    save({
      ...settings,
      textScale: settingsApi.defaults.textScale,
      lineHeight: settingsApi.defaults.lineHeight,
      letterSpacing: settingsApi.defaults.letterSpacing
    });
  });

  retrySaveButton.addEventListener("click", () => {
    persist(failedSettings ?? settings);
  });

  hostnameInput.addEventListener("input", () => {
    clearHostnameError();
    updateSubdomainPreview();
  });

  addRuleForm.addEventListener("submit", (event) => {
    event.preventDefault();
    clearHostnameError();
    const hostname = normalizeHostnameInput(hostnameInput.value);
    if (!settingsApi.validHostname(hostname)) {
      showHostnameError("Enter just the domain, like example.com");
      return;
    }

    const includeSubdomains = subdomainsInput.checked;
    if (settingsApi.getDirectRule(settings, hostname, includeSubdomains)) {
      showHostnameError("That site already has a rule");
      return;
    }

    const nextSettings = settingsApi.setSiteRule(settings, {
      hostname,
      includeSubdomains,
      enabled: false
    });
    if (!settingsApi.getDirectRule(nextSettings, hostname, includeSubdomains)) {
      showHostnameError("There isn't room for another site rule");
      return;
    }

    hostnameInput.value = "";
    subdomainsInput.checked = false;
    updateSubdomainPreview();
    save(nextSettings);
  });

  searchInput.addEventListener("input", renderRules);

  ruleList.addEventListener("change", (event) => {
    if (!event.target.classList.contains("rule-enabled")) return;
    const row = event.target.closest(".rule-row");
    if (!row) return;
    save(settingsApi.setSiteRule(settings, {
      hostname: row.dataset.hostname,
      includeSubdomains: row.dataset.subdomains === "true",
      enabled: event.target.checked
    }));
  });

  ruleList.addEventListener("click", (event) => {
    const button = event.target.closest(".delete-rule");
    const row = button?.closest(".rule-row");
    if (!row) return;
    save(settingsApi.removeSiteRule(
      settings,
      row.dataset.hostname,
      row.dataset.subdomains === "true"
    ));
  });

  clearRulesButton.addEventListener("click", async () => {
    const removedRules = settings.siteRules.map((rule) => ({ ...rule }));
    const saved = await save({ ...settings, siteRules: [] });
    if (!saved) return;
    showToast("Site rules cleared", "Undo", () => {
      toast.hidden = true;
      clearTimeout(toastTimer);
      save({ ...settings, siteRules: removedRules });
    }, 8000);
  });

  exportButton.addEventListener("click", () => {
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
    showToast("Settings exported");
  });

  importButton.addEventListener("click", () => importFile.click());
  importFile.addEventListener("change", async () => {
    const file = importFile.files?.[0];
    if (!file) return;
    importError.textContent = "";
    try {
      if (file.size > 256 * 1024) throw new Error("Settings file is too large");
      const payload = JSON.parse(await file.text());
      if (![1, 2].includes(payload?.schemaVersion) || typeof payload.settings !== "object") {
        throw new Error("Unsupported settings file");
      }
      if (await save(payload.settings)) showToast("Settings imported");
    } catch {
      importError.textContent = "Choose a valid Lexend settings file.";
    } finally {
      importFile.value = "";
    }
  });

  const renderShortcut = (shortcut) => {
    shortcutOutput.replaceChildren();
    if (!shortcut) {
      shortcutOutput.textContent = "Not assigned";
      shortcutAction.textContent = "Set shortcut";
      return;
    }

    shortcut.split("+").forEach((key, index) => {
      if (index) shortcutOutput.append(document.createTextNode("+"));
      const keycap = document.createElement("kbd");
      keycap.textContent = key;
      shortcutOutput.append(keycap);
    });
    shortcutAction.textContent = "Change";
  };

  shortcutAction.addEventListener("click", async () => {
    shortcutInstructions.hidden = true;
    try {
      if (typeof extension?.commands?.openShortcutSettings === "function") {
        await extension.commands.openShortcutSettings();
        return;
      }
      const extensionUrl = extension?.runtime?.getURL?.("") ?? "";
      if (extensionUrl.startsWith("chrome-extension://") && extension?.tabs?.create) {
        const shortcutsUrl = navigator.userAgent.includes("Edg/")
          ? "edge://extensions/shortcuts"
          : "chrome://extensions/shortcuts";
        await extension.tabs.create({ url: shortcutsUrl });
        return;
      }
      shortcutInstructions.hidden = false;
    } catch {
      shortcutInstructions.hidden = false;
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
      settings = settingsApi.normalizeSettings(
        storage ? await storage.get(null) : settingsApi.defaults
      );
      render();
      setSaveState("saved", "All changes saved");
    } catch (error) {
      console.error("Lexend the Web could not load settings.", error);
      render();
      setSaveState("error", "Settings could not be loaded");
    }

    try {
      const commands = await extension?.commands?.getAll?.();
      const command = commands?.find((item) => item.name === "toggle-current-site");
      renderShortcut(command?.shortcut ?? "");
    } catch {
      renderShortcut("");
      shortcutInstructions.hidden = false;
    }
  };

  start();
})();
