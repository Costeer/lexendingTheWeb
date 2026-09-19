(() => {
  "use strict";

  const extension = globalThis.browser ?? globalThis.chrome;
  const settingsApi = globalThis.LexendSettings;
  const storage = extension?.storage?.sync;
  const status = document.querySelector("#status");
  const textScaleInput = document.querySelector("#text-scale");
  const lineHeightInput = document.querySelector("#line-height");
  const letterSpacingInput = document.querySelector("#letter-spacing");
  const addRuleForm = document.querySelector("#add-rule");
  const hostnameInput = document.querySelector("#new-hostname");
  const subdomainsInput = document.querySelector("#new-subdomains");
  const searchInput = document.querySelector("#rule-search");
  const ruleList = document.querySelector("#rule-list");
  const emptyRules = document.querySelector("#empty-rules");
  const clearPausedButton = document.querySelector("#clear-paused");
  const clearRulesButton = document.querySelector("#clear-rules");
  const exportButton = document.querySelector("#export-settings");
  const importButton = document.querySelector("#import-settings");
  const importFile = document.querySelector("#import-file");
  const shortcutOutput = document.querySelector("#shortcut");
  let settings = settingsApi.normalizeSettings();
  let statusTimer;

  const showStatus = (message, reset = true) => {
    status.textContent = message;
    clearTimeout(statusTimer);
    if (reset) {
      statusTimer = setTimeout(() => {
        status.textContent = "READY";
      }, 1600);
    }
  };

  const makeOption = (value, label, selected) => {
    const option = document.createElement("option");
    option.value = value;
    option.textContent = label;
    option.selected = selected;
    return option;
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
      const row = document.createElement("div");
      row.className = "rule-row";
      row.dataset.hostname = rule.hostname;
      row.dataset.subdomains = String(rule.includeSubdomains);

      const domain = document.createElement("div");
      domain.className = "rule-domain";
      const strong = document.createElement("strong");
      strong.textContent = rule.hostname;
      const small = document.createElement("small");
      small.textContent = rule.includeSubdomains
        ? "This hostname and its subdomains"
        : "This hostname only";
      domain.append(strong, small);

      const enabled = document.createElement("select");
      enabled.className = "rule-enabled";
      enabled.setAttribute("aria-label", `Enabled state for ${rule.hostname}`);
      enabled.append(
        makeOption("inherit", "Inherit enabled state", rule.enabled === null),
        makeOption("on", "Allowed", rule.enabled === true),
        makeOption("off", "Paused", rule.enabled === false)
      );

      const scope = document.createElement("select");
      scope.className = "rule-scope";
      scope.setAttribute("aria-label", `Typography scope for ${rule.hostname}`);
      scope.append(
        makeOption("inherit", "Inherit typography", rule.scope === null),
        makeOption("body", "Only body text", rule.scope === "body"),
        makeOption("all", "Body & headings", rule.scope === "all")
      );

      const remove = document.createElement("button");
      remove.type = "button";
      remove.className = "delete-rule";
      remove.setAttribute("aria-label", `Delete rule for ${rule.hostname}`);
      remove.title = "Delete rule";
      remove.textContent = "×";
      row.append(domain, enabled, scope, remove);
      ruleList.append(row);
    });

    emptyRules.hidden = rules.length > 0;
    emptyRules.textContent = settings.siteRules.length && !rules.length
      ? "No site rules match this search."
      : "No site rules saved.";
    clearPausedButton.disabled = !settings.siteRules.some((rule) => rule.enabled === false);
    clearRulesButton.disabled = settings.siteRules.length === 0;
  };

  const render = () => {
    textScaleInput.value = String(settings.textScale);
    lineHeightInput.value = String(settings.lineHeight);
    letterSpacingInput.value = String(settings.letterSpacing);
    renderRules();
  };

  const save = async (nextSettings, message = "SAVED") => {
    settings = settingsApi.normalizeSettings(nextSettings);
    render();
    if (!storage) {
      showStatus("PREVIEW");
      return;
    }
    try {
      await storage.set(settings);
      await storage.remove?.(["disabledSites", "spacing"]);
      showStatus(message);
    } catch (error) {
      console.error("Lexend the Web could not save settings.", error);
      showStatus("SAVE FAILED", false);
    }
  };

  textScaleInput.addEventListener("change", () => {
    save({ ...settings, textScale: Number(textScaleInput.value) });
  });
  lineHeightInput.addEventListener("change", () => {
    save({ ...settings, lineHeight: Number(lineHeightInput.value) });
  });
  letterSpacingInput.addEventListener("change", () => {
    save({ ...settings, letterSpacing: Number(letterSpacingInput.value) });
  });

  addRuleForm.addEventListener("submit", (event) => {
    event.preventDefault();
    const hostname = hostnameInput.value.trim().toLowerCase().replace(/\.$/, "");
    if (!settingsApi.validHostname(hostname)) {
      showStatus("INVALID HOSTNAME", false);
      hostnameInput.focus();
      return;
    }

    const includeSubdomains = subdomainsInput.checked;
    if (settingsApi.getDirectRule(settings, hostname, includeSubdomains)) {
      showStatus("RULE EXISTS", false);
      return;
    }

    const nextSettings = settingsApi.setSiteRule(settings, {
      hostname,
      includeSubdomains,
      enabled: false
    });
    if (!settingsApi.getDirectRule(nextSettings, hostname, includeSubdomains)) {
      showStatus("RULE LIMIT REACHED", false);
      return;
    }
    hostnameInput.value = "";
    subdomainsInput.checked = false;
    save(nextSettings, "RULE ADDED");
  });

  searchInput.addEventListener("input", renderRules);

  ruleList.addEventListener("change", (event) => {
    const row = event.target.closest(".rule-row");
    if (!row) return;
    const identity = {
      hostname: row.dataset.hostname,
      includeSubdomains: row.dataset.subdomains === "true"
    };

    if (event.target.classList.contains("rule-enabled")) {
      const values = { inherit: null, on: true, off: false };
      save(settingsApi.setSiteRule(settings, {
        ...identity,
        enabled: values[event.target.value]
      }));
    } else if (event.target.classList.contains("rule-scope")) {
      save(settingsApi.setSiteRule(settings, {
        ...identity,
        scope: event.target.value === "inherit" ? null : event.target.value
      }));
    }
  });

  ruleList.addEventListener("click", (event) => {
    const button = event.target.closest(".delete-rule");
    const row = button?.closest(".rule-row");
    if (!row) return;
    save(settingsApi.removeSiteRule(
      settings,
      row.dataset.hostname,
      row.dataset.subdomains === "true"
    ), "RULE REMOVED");
  });

  clearPausedButton.addEventListener("click", () => {
    const siteRules = settings.siteRules
      .map((rule) => rule.enabled === false ? { ...rule, enabled: null } : rule)
      .filter((rule) => rule.enabled !== null || rule.scope !== null);
    save({ ...settings, siteRules }, "PAUSED CLEARED");
  });

  clearRulesButton.addEventListener("click", () => {
    if (globalThis.confirm("Remove every saved site rule?")) {
      save({ ...settings, siteRules: [] }, "RULES CLEARED");
    }
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
    URL.revokeObjectURL(url);
    showStatus("EXPORTED");
  });

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
      await save(payload.settings, "IMPORTED");
    } catch (error) {
      console.error("Lexend the Web could not import settings.", error);
      showStatus("INVALID FILE", false);
    } finally {
      importFile.value = "";
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
      const commands = await extension?.commands?.getAll?.();
      const command = commands?.find((item) => item.name === "toggle-current-site");
      shortcutOutput.textContent = command?.shortcut || "Not assigned";
    } catch (error) {
      console.error("Lexend the Web could not load settings.", error);
      render();
      showStatus("LOAD FAILED", false);
    }
  };

  start();
})();
