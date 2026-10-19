(() => {
  "use strict";

  const extension = globalThis.browser ?? globalThis.chrome;
  const settingsApi = globalThis.LexendSettings;
  const quotesApi = globalThis.LexendQuotes;
  const preferenceStorage = extension?.storage?.local;
  const ADVANCED_PREFERENCE_KEY = "advancedReadability";
  const PREVIEW_DEFAULT_LINE_HEIGHT = 1.65;
  const layoutRepairInput = document.querySelector("#layout-repair");
  const darkThemeInput = document.querySelector("#dark-theme");
  const appearanceState = document.querySelector("#appearance-state");
  const designInputs = [...document.querySelectorAll('input[name="design"]')];
  const advancedModeInput = document.querySelector("#advanced-mode");
  const readabilityControlStage = document.querySelector("#readability-control-stage");
  const basicReadability = document.querySelector("#basic-readability");
  const advancedReadability = document.querySelector("#advanced-readability");
  const basicTextScaleInputs = [...document.querySelectorAll('input[name="basicTextScale"]')];
  const basicLineHeightInputs = [...document.querySelectorAll('input[name="basicLineHeight"]')];
  const basicLetterSpacingInputs = [...document.querySelectorAll('input[name="basicLetterSpacing"]')];
  const textScaleSlider = document.querySelector("#text-scale");
  const lineHeightSlider = document.querySelector("#line-height");
  const letterSpacingSlider = document.querySelector("#letter-spacing");
  const adjustCustomValues = document.querySelector("#adjust-custom-values");
  const customControls = [
    ["text-scale", basicTextScaleInputs, "textScale", (value) => `${value}%`],
    ["line-height", basicLineHeightInputs, "lineHeight", (value) => String(value)],
    ["letter-spacing", basicLetterSpacingInputs, "letterSpacing", (value) => `${value}em`]
  ];
  const textScaleOutput = document.querySelector("#text-scale-output");
  const lineHeightOutput = document.querySelector("#line-height-output");
  const letterSpacingOutput = document.querySelector("#letter-spacing-output");
  const previewCopy = document.querySelector("#preview-copy");
  const previewAuthor = document.querySelector("#preview-author");
  const previewAttribution = document.querySelector("#preview-attribution");
  const previewReading = document.querySelector("#preview-reading");
  const previewOriginal = document.querySelector("#preview-original");
  const previewOriginalCopy = document.querySelector("#preview-original-copy");
  const previewGlyphs = document.querySelector("#preview-glyphs");
  const previewText = document.querySelector("#preview-text");
  const previewModeInputs = [...document.querySelectorAll('input[name="previewMode"]')];
  const previewSpecimens = [...document.querySelectorAll(".preview-specimen")];
  let previewMode = "reading";
  const resetReadabilityButton = document.querySelector("#reset-readability");
  const saveStatus = document.querySelector("#save-status");
  const saveStatusText = document.querySelector("#save-status-text");
  const retrySaveButton = document.querySelector("#retry-save");
  const addRuleForm = document.querySelector("#add-rule");
  const addRuleButton = document.querySelector("#add-rule-button");
  const hostnameInput = document.querySelector("#new-hostname");
  const hostnameError = document.querySelector("#hostname-error");
  const subdomainsInput = document.querySelector("#new-subdomains");
  const subdomainPreview = document.querySelector("#subdomain-preview");
  const ruleToolbar = document.querySelector("#rule-toolbar");
  const searchInput = document.querySelector("#rule-search");
  const ruleList = document.querySelector("#rule-list");
  const toggleRuleListButton = document.querySelector("#toggle-rule-list");
  const toggleRuleListLabel = document.querySelector("#toggle-rule-list-label");
  const MOBILE_RULE_LIMIT = 2;
  let rulesExpanded = false;
  const searchEmpty = document.querySelector("#search-empty");
  const emptyRules = document.querySelector("#empty-rules");
  const exportButton = document.querySelector("#export-settings");
  const importButton = document.querySelector("#import-settings");
  const importFile = document.querySelector("#import-file");
  const importError = document.querySelector("#import-error");
  const importPreview = document.querySelector("#import-preview");
  const importPreviewTitle = document.querySelector("#import-preview-title");
  const importPreviewDescription = document.querySelector("#import-preview-description");
  const importPreviewList = document.querySelector("#import-preview-list");
  const applyImportButton = document.querySelector("#apply-import");
  const cancelImportButton = document.querySelector("#cancel-import");
  const importUndo = document.querySelector("#import-undo");
  const importUndoMessage = document.querySelector("#import-undo-message");
  const undoImportButton = document.querySelector("#undo-import");
  let importDraft = null;
  let undoRecord = null;
  let importBusy = false;
  let importSaveStatus = null;
  let importSelection = 0;
  const shortcutOutput = document.querySelector("#shortcut");
  const shortcutAction = document.querySelector("#shortcut-action");
  const shortcutInstructions = document.querySelector("#shortcut-instructions");
  const toast = document.querySelector("#toast");
  const toastMessage = document.querySelector("#toast-message");
  const desktopSettingsLayout = matchMedia(
    "(min-width: 900px) and (hover: hover) and (pointer: fine)"
  );
  const settingsPanels = [...document.querySelectorAll(".settings-panel")];
  const settingsNavigation = [...document.querySelectorAll("[data-settings-panel]")];
  const requestedSettingsPanel = new URLSearchParams(location.search).get("section");
  let selectedSettingsPanel = settingsPanels.some((panel) => panel.id === requestedSettingsPanel)
    ? requestedSettingsPanel
    : "readability-panel";

  const renderSettingsNavigation = () => {
    settingsPanels.forEach((panel) => {
      panel.hidden = desktopSettingsLayout.matches && panel.id !== selectedSettingsPanel;
    });
    settingsNavigation.forEach((button) => {
      if (button.dataset.settingsPanel === selectedSettingsPanel) {
        button.setAttribute("aria-current", "page");
      } else {
        button.removeAttribute("aria-current");
      }
    });
  };

  settingsNavigation.forEach((button) => {
    button.addEventListener("click", () => {
      cancelRuleDeletion();
      selectedSettingsPanel = button.dataset.settingsPanel;
      renderSettingsNavigation();
      const heading = document.querySelector(`#${selectedSettingsPanel} h2`);
      heading.setAttribute("tabindex", "-1");
      heading.focus({ preventScroll: true });
    });
  });

  desktopSettingsLayout.addEventListener("change", () => {
    renderSettingsNavigation();
    renderPreview();
    renderRules();
  });
  renderSettingsNavigation();

  const { theme, design } = document.documentElement.dataset;
  let settings = settingsApi.normalizeSettings({ theme, design });
  let confirmedSettings = settings;
  let loadFailed = false;
  let advancedPreferenceLoaded = false;
  let toastTimer;
  let readabilityAnimationToken = 0;
  let renderedRulesKey;
  let pendingRuleDeletion = null;
  const ruleRowData = new WeakMap();
  const quote = quotesApi.random();
  const mutationControls = [layoutRepairInput, darkThemeInput, ...designInputs, advancedModeInput, textScaleSlider,
    lineHeightSlider, letterSpacingSlider, resetReadabilityButton, hostnameInput,
    subdomainsInput, exportButton, importButton, importFile,
    ...basicTextScaleInputs, ...basicLineHeightInputs, ...basicLetterSpacingInputs];
  const preferences = globalThis.LexendPreferences.createClient(extension, {
    theme: settings.theme,
    design: settings.design,
    onChange(value, loaded, readError) {
      settings = value;
      if (loaded) {
        const confirmed = preferences.confirmedSettings;
        if (importBusy && importDraft && !settingsApi.settingsEqual(confirmedSettings, confirmed)
            && settingsApi.settingsEqual(confirmed, importDraft.preview.after)) {
          importDraft.observedApplied = true;
        }
        confirmedSettings = confirmed;
      }
      render();
      if (readError) {
        loadFailed = true;
        setSaveState("error", `Settings could not be read. ${readError.message}`);
      }
    }
  });

  const setSaveState = (state, message) => {
    saveStatus.className = `save-status is-${state}`;
    saveStatusText.textContent = message;
    retrySaveButton.hidden = state !== "error";
  };

  const showToast = (message) => {
    clearTimeout(toastTimer);
    toastMessage.textContent = message;
    toast.hidden = false;
    toastTimer = setTimeout(() => {
      toast.hidden = true;
    }, 3000);
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
      input.checked = !input.dataset.custom && Number(input.value) === value;
    });
  };

  const lineHeightFromSlider = (value) => {
    const step = Number(value);
    return step === 0 ? 0 : Number((0.99 + step / 100).toFixed(2));
  };

  const lineHeightToSlider = (value) => (
    value === 0 ? 0 : Math.min(141, Math.max(1, Math.round((value - 0.99) * 100)))
  );

  const formatNumber = (value, precision) => Number(value)
    .toFixed(precision)
    .replace(/\.?0+$/, "");

  const renderQuote = () => {
    const custom = previewText.value.trim();
    const text = custom || `“${quote.text}”`;
    for (const copy of [previewCopy, previewOriginalCopy]) {
      copy.textContent = text;
      // An empty language tag lets a custom multilingual sample stand on its
      // own instead of inheriting the randomly chosen quote's language.
      copy.lang = custom ? "" : quote.lang;
    }
    previewAttribution.hidden = Boolean(custom) || previewMode === "glyphs";
    previewAuthor.textContent = quote.author;
    previewAuthor.href = quote.url;
  };

  const renderPreview = (readability = settings) => {
    const baseSize = desktopSettingsLayout.matches ? 18 : 16;
    for (const copy of [previewCopy, ...previewSpecimens]) {
      copy.style.fontSize = `${baseSize * readability.textScale / 100}px`;
      copy.style.lineHeight = readability.lineHeight || PREVIEW_DEFAULT_LINE_HEIGHT;
      copy.style.letterSpacing = /\p{Script=Arabic}/u.test(copy.textContent) ? "0em" : `${readability.letterSpacing}em`;
    }
    previewOriginalCopy.style.fontSize = `${baseSize}px`;
  };

  const renderPreviewMode = () => {
    previewReading.hidden = previewMode === "glyphs";
    previewGlyphs.hidden = previewMode !== "glyphs";
    previewOriginal.hidden = previewMode !== "compare";
    previewReading.classList.toggle("is-comparing", previewMode === "compare");
    renderQuote();
  };

  previewModeInputs.forEach((input) => input.addEventListener("change", () => {
    if (!input.checked) return;
    previewMode = input.value;
    renderPreviewMode();
  }));
  previewText.addEventListener("input", () => {
    if (previewMode === "glyphs") {
      previewMode = "reading";
      previewModeInputs.forEach((input) => { input.checked = input.value === previewMode; });
    }
    renderPreviewMode();
    renderPreview();
  });

  const renderReadabilityMode = (animate = false) => {
    const showAdvanced = advancedModeInput.checked;
    adjustCustomValues.hidden = showAdvanced || !customControls.some(([id]) => document.querySelector(`#custom-${id}`).checked);
    const incoming = showAdvanced ? advancedReadability : basicReadability;
    const outgoing = showAdvanced ? basicReadability : advancedReadability;
    const token = ++readabilityAnimationToken;

    basicReadability.getAnimations?.().forEach((animation) => animation.cancel());
    advancedReadability.getAnimations?.().forEach((animation) => animation.cancel());
    incoming.hidden = false;
    incoming.inert = false;
    incoming.removeAttribute("aria-hidden");
    outgoing.inert = true;
    outgoing.setAttribute("aria-hidden", "true");

    const reduceMotion = globalThis.matchMedia?.("(prefers-reduced-motion: reduce)")?.matches;
    if (!animate || reduceMotion || typeof incoming.animate !== "function") {
      outgoing.hidden = true;
      readabilityControlStage.classList.remove("is-animating");
      return;
    }

    outgoing.hidden = false;
    readabilityControlStage.classList.add("is-animating");
    const direction = showAdvanced ? 1 : -1;
    const timing = {
      duration: 190,
      easing: "cubic-bezier(.22, 1, .36, 1)",
      fill: "both"
    };
    const outgoingAnimation = outgoing.animate([
      { opacity: 1, transform: "translateX(0)" },
      { opacity: 0, transform: `translateX(${-35 * direction}%)` }
    ], timing);
    const incomingAnimation = incoming.animate([
      { opacity: 0, transform: `translateX(${35 * direction}%)` },
      { opacity: 1, transform: "translateX(0)" }
    ], timing);

    Promise.allSettled([
      outgoingAnimation.finished,
      incomingAnimation.finished
    ]).then(() => {
      if (token !== readabilityAnimationToken) return;
      outgoing.hidden = true;
      readabilityControlStage.classList.remove("is-animating");
      outgoingAnimation.cancel();
      incomingAnimation.cancel();
    });
  };

  const renderSliderValues = (readability) => {
    textScaleOutput.textContent = readability.textScale === 100
      ? "Default"
      : `${readability.textScale}%`;
    lineHeightOutput.textContent = readability.lineHeight === 0
      ? "Default"
      : formatNumber(readability.lineHeight, 2);
    letterSpacingOutput.textContent = readability.letterSpacing === 0
      ? "Default"
      : `${formatNumber(readability.letterSpacing, 3)}em`;

    textScaleSlider.setAttribute("aria-valuetext", textScaleOutput.textContent);
    lineHeightSlider.setAttribute("aria-valuetext", lineHeightOutput.textContent);
    letterSpacingSlider.setAttribute("aria-valuetext", letterSpacingOutput.textContent);
  };

  const renderReadability = () => {
    layoutRepairInput.checked = settings.layoutRepair;
    setRadioValue(basicTextScaleInputs, settings.textScale);
    setRadioValue(basicLineHeightInputs, settings.lineHeight);
    setRadioValue(basicLetterSpacingInputs, settings.letterSpacing);

    let hasCustom = false;
    for (const [id, inputs, key, format] of customControls) {
      const custom = document.querySelector(`#custom-${id}`);
      const isCustom = !inputs.some((input) => !input.dataset.custom && input.checked);
      custom.checked = isCustom;
      custom.value = String(settings[key]);
      document.querySelector(`#custom-${id}-choice`).hidden = !isCustom;
      document.querySelector(`#custom-${id}-label`).textContent = `Custom · ${format(settings[key])}`;
      hasCustom ||= isCustom;
    }
    adjustCustomValues.hidden = !hasCustom || advancedModeInput.checked;
    textScaleSlider.value = String(settings.textScale);
    lineHeightSlider.value = String(lineHeightToSlider(settings.lineHeight));
    letterSpacingSlider.value = String(settings.letterSpacing);

    renderSliderValues(settings);
    renderPreview();
  };

  const renderInterfaceStyle = () => {
    globalThis.LexendTheme.apply(settings.theme);
    globalThis.LexendTheme.applyDesign(settings.design);
    darkThemeInput.checked = settings.theme === "dark";
    appearanceState.textContent = darkThemeInput.checked ? "On" : "Off";
    designInputs.forEach((input) => { input.checked = input.value === settings.design; });
  };

  const deletionPrompts = [
    "Delete this site rule?",
    "Remove this site rule?",
    "Really delete this rule?",
    "Ready to remove this rule?",
    "Confirm deleting this rule?",
    "Remove this site rule permanently?",
    "Delete this site-specific rule?",
    "This rule will be deleted. Continue?",
    "Remove the rule for {site}?",
    "Deleting this rule can't be undone. Proceed?",
    "Drop this rule?"
  ];

  const deletionPrompt = (hostname) => {
    // FNV-1a: stable across reloads, ordering, and exact/subdomain variants.
    let hash = 2166136261;
    for (let index = 0; index < hostname.length; index += 1) {
      hash = Math.imul(hash ^ hostname.charCodeAt(index), 16777619) >>> 0;
    }
    return deletionPrompts[hash % deletionPrompts.length].replace("{site}", hostname);
  };

  const setRuleButtonAction = (button, rule, action) => {
    const target = `${rule.hostname}${rule.includeSubdomains ? " and its subdomains" : ""}`;
    const labels = {
      delete: `Delete rule for ${target}`,
      cancel: `Cancel deleting rule for ${target}`,
      confirm: `Confirm deleting rule for ${target}`
    };
    button.dataset.action = action;
    button.setAttribute("aria-label", labels[action]);
    button.title = labels[action];
    if (action === "delete") {
      button.innerHTML = '<svg aria-hidden="true" viewBox="0 0 24 24"><path d="M8 3h8l1 2h4v2H3V5h4l1-2Zm-2 6h12l-1 12H7L6 9Zm3 2v8h2v-8H9Zm4 0v8h2v-8h-2Z" /></svg>';
    } else if (action === "cancel") {
      button.innerHTML = '<svg aria-hidden="true" viewBox="0 0 24 24"><path d="m6 6 12 12M18 6 6 18" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" /></svg>';
    } else {
      button.innerHTML = '<svg aria-hidden="true" viewBox="0 0 24 24"><path d="m5 12 4 4L19 6" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" /></svg>';
    }
  };

  const makeDeleteButton = (rule, action = "delete") => {
    const button = document.createElement("button");
    button.type = "button";
    button.className = "delete-rule";
    button.disabled = !preferences.loaded;
    setRuleButtonAction(button, rule, action);
    return button;
  };

  const cancelRuleDeletion = (restoreFocus = false) => {
    if (!pendingRuleDeletion) return;
    const { row, domain, status, button, rule, originalContent, confirmButton } = pendingRuleDeletion;
    pendingRuleDeletion = null;
    domain.replaceChildren(...originalContent);
    status.hidden = false;
    confirmButton.remove();
    row.classList.remove("is-confirming-delete");
    setRuleButtonAction(button, rule, "delete");
    if (restoreFocus) button.focus();
  };

  const requestRuleDeletion = (row) => {
    cancelRuleDeletion();
    const { domain, status, button, rule } = ruleRowData.get(row);
    const originalContent = [...domain.children];
    const prompt = document.createElement("span");
    prompt.className = "rule-delete-prompt";
    prompt.setAttribute("role", "status");
    prompt.textContent = deletionPrompt(rule.hostname);
    const context = document.createElement("span");
    context.className = "visually-hidden";
    context.textContent = ` Rule for ${rule.hostname}${rule.includeSubdomains ? " and its subdomains" : ""}.`;
    prompt.append(context);
    domain.replaceChildren(prompt);
    status.hidden = true;
    row.classList.add("is-confirming-delete");
    setRuleButtonAction(button, rule, "cancel");
    const confirmButton = makeDeleteButton(rule, "confirm");
    row.append(confirmButton);
    pendingRuleDeletion = { row, domain, status, button, rule, originalContent, confirmButton };
  };

  const ruleSource = (rule) => rule
    ? `${rule.hostname} (${rule.includeSubdomains ? "including subdomains" : "exact host"})`
    : "global setting";

  const sourceExplanation = (hostname) => {
    const effective = settingsApi.resolveSite(settings, hostname);
    const activation = effective.siteEnabled ? "Enabled" : "Paused";
    const gate = settings.enabled ? "" : " Global switch is Off, so Lexend is paused.";
    return `At ${hostname}: site preference ${activation} from ${effective.enabledRule ? ruleSource(effective.enabledRule) : "default site preference (no activation rule)"}; scope ${effective.scope === "all" ? "Body and headings" : "Body text"} from ${ruleSource(effective.scopeRule)}; layout repair ${effective.layoutRepair ? "on" : "off"} from ${settings.layoutRepair ? "all-sites setting" : effective.layoutRepairRule ? ruleSource(effective.layoutRepairRule) : "default (off)"}.${gate}`;
  };

  const makeRuleEditor = (rule) => {
    const editor = document.createElement("details");
    editor.className = "rule-editor";
    const summary = document.createElement("summary");
    summary.textContent = "Edit rule";
    summary.setAttribute("aria-label", `Edit rule for ${ruleSource(rule)}`);
    const form = document.createElement("form");
    const controls = {};
    const specs = [
      ["enabled", "Activation", [["inherit", "Use global / inherited rule"], ["true", "Active"], ["false", "Paused"]]],
      ["scope", "Scope", [["inherit", "Use global / inherited rule"], ["body", "Body text"], ["all", "Body and headings"]]],
      ["layoutRepair", "Layout repair", [["inherit", "Use inherited rule (default off)"], ["true", "On"], ["false", "Off"]]],
      ["includeSubdomains", "Match", [["false", "Exact host only"], ["true", "Host and subdomains"]]]
    ];
    for (const [name, title, choices] of specs) {
      const label = document.createElement("label");
      const text = document.createElement("span");
      text.textContent = title;
      const select = document.createElement("select");
      select.name = name;
      select.disabled = !preferences.loaded;
      for (const [value, caption] of choices) {
        const option = document.createElement("option");
        option.value = value;
        option.textContent = caption;
        select.append(option);
      }
      select.value = rule[name] == null ? "inherit" : String(rule[name]);
      controls[name] = select;
      label.append(text, select);
      form.append(label);
    }
    const explanation = document.createElement("p");
    explanation.className = "rule-sources";
    explanation.textContent = `${sourceExplanation(rule.hostname)} Inherited values can come from a broader rule. Inherit activation, scope, and layout repair to remove this rule. Layout repair adjusts containers to fit enlarged text; the all-sites setting takes priority.${rule.includeSubdomains ? " More specific rules can change the result on subdomains." : ""}`;
    const error = document.createElement("p");
    error.className = "field-error";
    error.setAttribute("role", "alert");
    const actions = document.createElement("div");
    actions.className = "button-row";
    const saveButton = document.createElement("button");
    saveButton.type = "submit";
    saveButton.className = "secondary-button rule-editor-save";
    saveButton.textContent = "Save rule";
    const cancelButton = document.createElement("button");
    cancelButton.type = "button";
    cancelButton.className = "inline-link rule-editor-cancel";
    cancelButton.textContent = "Cancel";
    cancelButton.addEventListener("click", () => {
      for (const [key, select] of Object.entries(controls)) select.value = rule[key] == null ? "inherit" : String(rule[key]);
      editor.open = false;
      error.textContent = "";
      summary.focus();
    });
    form.addEventListener("submit", async (event) => {
      event.preventDefault();
      if (!preferences.loaded || saveButton.disabled) return;
      const draft = {
        enabled: controls.enabled.value === "inherit" ? null : controls.enabled.value === "true",
        layoutRepair: controls.layoutRepair.value === "inherit" ? null : controls.layoutRepair.value === "true",
        scope: controls.scope.value === "inherit" ? null : controls.scope.value,
        includeSubdomains: controls.includeSubdomains.value === "true"
      };
      const changes = Object.fromEntries(Object.entries(draft).filter(([key, value]) => value !== (rule[key] ?? null)));
      if (!Object.keys(changes).length) { editor.open = false; summary.focus(); return; }
      saveButton.disabled = true;
      const ok = await persist({ type: "updateRule", hostname: rule.hostname,
        includeSubdomains: rule.includeSubdomains, changes });
      saveButton.disabled = false;
      if (!ok) {
        // Optimistic rendering may have replaced this editor; keep the failed
        // operation visible and actionable through the shared save status.
        error.textContent = saveStatusText.textContent;
        retrySaveButton.focus();
        return;
      }
      const row = [...ruleList.children].find((item) => item.dataset.hostname === rule.hostname
        && item.dataset.subdomains === String(draft.includeSubdomains));
      (ruleRowData.get(row)?.editorSummary ?? hostnameInput).focus();
    });
    actions.append(saveButton, cancelButton);
    form.append(explanation, error, actions);
    editor.append(summary, form);
    return { editor, summary };
  };

  const renderRules = () => {
    const query = searchInput.value.trim().toLowerCase();
    const key = JSON.stringify([
      settings.siteRules, settings.enabled, settings.scope, settings.layoutRepair, query, desktopSettingsLayout.matches, rulesExpanded
    ]);
    if (key === renderedRulesKey) return;
    cancelRuleDeletion();
    renderedRulesKey = key;
    const rules = settings.siteRules
      .filter((rule) => rule.hostname.includes(query))
      .sort((a, b) => (
        a.hostname.localeCompare(b.hostname)
        || Number(a.includeSubdomains) - Number(b.includeSubdomains)
      ));
    ruleList.replaceChildren();

    const limitRules = !desktopSettingsLayout.matches && !rulesExpanded;
    const visibleRules = limitRules ? rules.slice(0, MOBILE_RULE_LIMIT) : rules;
    visibleRules.forEach((rule) => {
      const row = document.createElement("div");
      row.className = "rule-row";
      row.dataset.hostname = rule.hostname;
      row.dataset.subdomains = String(rule.includeSubdomains);

      const domain = document.createElement("div");
      domain.className = "rule-domain";
      const hostname = document.createElement("a");
      hostname.className = "rule-hostname";
      hostname.href = `https://${rule.hostname}/`;
      hostname.target = "_blank";
      hostname.rel = "noopener noreferrer";
      hostname.title = `Open ${rule.hostname}`;
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
      status.textContent = `${rule.enabled === null ? "Inherit activation" : (rule.enabled ? "Active" : "Paused")} · ${rule.scope === null ? "Inherit scope" : (rule.scope === "all" ? "Body and headings" : "Body text")} · ${rule.layoutRepair == null ? "Inherit layout repair" : rule.layoutRepair ? "Layout repair on" : "Layout repair off"}`;
      const { editor, summary } = makeRuleEditor(rule);
      domain.append(editor);

      const button = makeDeleteButton(rule);
      ruleRowData.set(row, { domain, status, button, rule, editorSummary: summary });
      row.append(domain, status, button);
      ruleList.append(row);
    });

    const hasRules = settings.siteRules.length > 0;
    emptyRules.hidden = hasRules;
    ruleToolbar.hidden = !hasRules || (settings.siteRules.length <= 5 && !query);
    searchEmpty.hidden = !hasRules || !query || rules.length > 0;
    toggleRuleListButton.hidden = desktopSettingsLayout.matches || rules.length <= MOBILE_RULE_LIMIT;
    toggleRuleListButton.setAttribute("aria-expanded", String(rulesExpanded));
    toggleRuleListLabel.textContent = rulesExpanded
      ? "Show fewer rules"
      : `Show all ${rules.length} rules`;
  };

  const render = () => {
    renderInterfaceStyle();
    renderReadability();
    renderRules();
    mutationControls.forEach((control) => { control.disabled = !preferences.loaded; });
    advancedModeInput.disabled = !preferences.loaded || !advancedPreferenceLoaded;
    importButton.disabled ||= importBusy;
    importFile.disabled ||= importBusy;
    applyImportButton.disabled = !preferences.loaded || importBusy;
    cancelImportButton.disabled = importBusy;
    undoImportButton.disabled = !preferences.loaded || importBusy;
    retrySaveButton.disabled = importBusy;
    updateAddRuleState();
  };

  const renderSaveRecovery = ({ pending, failures }) => {
    if (preferences.readError) {
      loadFailed = true;
      setSaveState("error", `Settings could not be read. ${preferences.readError.message}`);
      return;
    }
    // Preview Apply owns its status and retry. Generic callbacks may arrive
    // synchronously during supersession or after an obsolete request settles.
    if (importSaveStatus && importSaveStatus.state !== "saved") {
      setSaveState(importSaveStatus.state, importSaveStatus.message);
    } else if (failures.length) {
      const labels = { theme: "appearance", design: "design", textScale: "text size", lineHeight: "line height",
        letterSpacing: "letter spacing", layoutRepair: "all-sites layout repair", enabled: "on/off setting", scope: "scope", siteRules: "site rules" };
      const fields = [...new Set(failures.flatMap((failure) => failure.keys)
        .map((key) => labels[key] ?? "site rule"))].join(", ");
      setSaveState("error", `Not saved: ${fields}. ${failures[0].error.message || "Try again."}`);
    } else if (pending) setSaveState("saving", "Saving…");
    else setSaveState("saved", importSaveStatus?.message || "All changes saved");
    retrySaveButton.hidden = !failures.length && !loadFailed;
    retrySaveButton.disabled = importBusy;
  };
  const recovery = globalThis.LexendSaveRecovery.createTracker({
    mutate: (operation) => preferences.mutate(operation),
    getSettings: () => settings,
    getConfirmedSettings: () => preferences.confirmedSettings,
    onChange: renderSaveRecovery
  });

  const renderSaveStatus = () => renderSaveRecovery(recovery.state);
  const persist = async (operation) => {
    if (!preferences.loaded) {
      render();
      return false;
    }
    if (importSaveStatus?.state === "saved") importSaveStatus = null;
    try {
      await recovery.mutate(operation);
      return true;
    } catch (error) {
      console.error("Lexend for the Web could not save settings.", error);
      return false;
    }
  };

  const save = (changes) => persist({ type: "patch", changes });

  let hostnameDraftVersion = 0;
  let failedAddFeedback = null;
  const clearHostnameError = () => {
    hostnameDraftVersion++;
    failedAddFeedback = null;
    hostnameError.textContent = "";
    hostnameInput.removeAttribute("aria-invalid");
  };

  const showHostnameError = (message) => {
    hostnameError.textContent = message;
    hostnameInput.setAttribute("aria-invalid", "true");
    hostnameInput.focus();
  };

  const failureForAddedRule = (rule) => recovery.state.failures.find((failure) => (
    failure.keys.includes(`rule:${rule.hostname}:${Boolean(rule.includeSubdomains)}`)
  ));

  const clearRecoveredAddError = (feedback) => {
    if (!feedback || failedAddFeedback !== feedback
        || hostnameDraftVersion !== feedback.version
        || hostnameInput.value !== feedback.value
        || subdomainsInput.checked !== feedback.rule.includeSubdomains
        || failureForAddedRule(feedback.rule)) return;
    const confirmed = settingsApi.getDirectRule(preferences.confirmedSettings,
      feedback.rule.hostname, feedback.rule.includeSubdomains);
    const desired = settingsApi.normalizeSettings({ siteRules: [feedback.rule] }).siteRules[0];
    // Another save or a retired retry is insufficient: the complete add intent
    // must be confirmed, including its independent activation/scope overrides.
    if (confirmed && JSON.stringify(confirmed) === JSON.stringify(desired)) clearHostnameError();
  };

  const updateSubdomainPreview = () => {
    const hostname = normalizeHostnameInput(hostnameInput.value);
    subdomainPreview.textContent = `*.${settingsApi.validHostname(hostname) ? hostname : "example.com"}`;
  };

  const updateAddRuleState = () => {
    const hostname = normalizeHostnameInput(hostnameInput.value);
    addRuleButton.disabled = !preferences.loaded || !settingsApi.validHostname(hostname);
  };

  adjustCustomValues.addEventListener("click", () => {
    advancedModeInput.checked = true;
    advancedModeInput.dispatchEvent(new Event("change"));
    textScaleSlider.focus();
  });

  advancedModeInput.addEventListener("change", async () => {
    if (!preferences.loaded || !advancedPreferenceLoaded) return;
    renderReadabilityMode(true);
    if (!preferenceStorage) return;
    try {
      await preferenceStorage.set({
        [ADVANCED_PREFERENCE_KEY]: advancedModeInput.checked
      });
    } catch {
      showToast("The advanced view preference could not be saved");
    }
  });

  darkThemeInput.addEventListener("change", () => {
    save({
      theme: darkThemeInput.checked ? "dark" : "light"
    });
  });

  designInputs.forEach((input) => input.addEventListener("change", () => {
    if (input.checked && settings.design !== input.value) save({ design: input.value });
  }));

  const basicControlGroups = [
    { inputs: basicTextScaleInputs, key: "textScale" },
    { inputs: basicLineHeightInputs, key: "lineHeight" },
    { inputs: basicLetterSpacingInputs, key: "letterSpacing" }
  ];

  basicControlGroups.forEach(({ inputs, key }) => {
    inputs.forEach((input) => {
      const selectValue = () => {
        if (input.dataset.custom) return;
        const value = Number(input.value);
        if (settings[key] !== value) save({ [key]: value });
      };
      input.addEventListener("click", selectValue);
      input.addEventListener("change", selectValue);
    });
  });

  const sliderControls = [
    {
      input: textScaleSlider,
      key: "textScale",
      getValue: (value) => Number(value)
    },
    {
      input: lineHeightSlider,
      key: "lineHeight",
      getValue: lineHeightFromSlider
    },
    {
      input: letterSpacingSlider,
      key: "letterSpacing",
      getValue: (value) => Number(value)
    }
  ];

  const getSliderReadability = () => ({
    textScale: Number(textScaleSlider.value),
    lineHeight: lineHeightFromSlider(lineHeightSlider.value),
    letterSpacing: Number(letterSpacingSlider.value)
  });

  sliderControls.forEach(({ input, key, getValue }) => {
    input.addEventListener("input", () => {
      const draft = getSliderReadability();
      renderSliderValues(draft);
      renderPreview(draft);
    });
    input.addEventListener("change", () => {
      save({ [key]: getValue(input.value) });
    });
  });

  resetReadabilityButton.addEventListener("click", () => {
    save({
      textScale: settingsApi.defaults.textScale,
      lineHeight: settingsApi.defaults.lineHeight,
      letterSpacing: settingsApi.defaults.letterSpacing
    });
  });

  retrySaveButton.addEventListener("click", async () => {
    if (importBusy) return;
    if (loadFailed) loadSettings();
    else {
      const feedback = failedAddFeedback;
      await recovery.retry();
      clearRecoveredAddError(feedback);
    }
  });

  hostnameInput.addEventListener("input", () => {
    clearHostnameError();
    updateSubdomainPreview();
    updateAddRuleState();
  });

  subdomainsInput.addEventListener("change", () => {
    if (failedAddFeedback) clearHostnameError();
    else hostnameDraftVersion++;
  });

  addRuleForm.addEventListener("submit", async (event) => {
    event.preventDefault();
    if (!preferences.loaded) return;
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

    const rule = {
      hostname,
      includeSubdomains,
      enabled: false
    };
    const draft = { version: hostnameDraftVersion, value: hostnameInput.value, rule };
    const saved = await persist({ type: "addRule", rule });
    // A late reply owns neither a newer form draft nor a newer validation error.
    if (hostnameDraftVersion !== draft.version || hostnameInput.value !== draft.value
        || subdomainsInput.checked !== includeSubdomains) return;
    if (!saved) {
      const failure = failureForAddedRule(rule);
      if (!failure) return;
      failedAddFeedback = draft;
      showHostnameError(`Not saved: site rule. ${failure.error.message || "Try again."}`);
      return;
    }

    hostnameInput.value = "";
    subdomainsInput.checked = false;
    updateSubdomainPreview();
    updateAddRuleState();
  });

  layoutRepairInput.addEventListener("change", () => persist({ type: "patch", changes: { layoutRepair: layoutRepairInput.checked } }));

  searchInput.addEventListener("input", renderRules);

  toggleRuleListButton.addEventListener("click", () => {
    rulesExpanded = !rulesExpanded;
    renderRules();
  });

  ruleList.addEventListener("click", async (event) => {
    if (!preferences.loaded) return;
    const button = event.target.closest(".delete-rule");
    const row = button?.closest(".rule-row");
    if (!row || !ruleRowData.has(row)) return;
    if (button.dataset.action === "delete") {
      requestRuleDeletion(row);
      return;
    }
    if (pendingRuleDeletion?.row !== row) return;
    if (button.dataset.action === "cancel") {
      cancelRuleDeletion(true);
      return;
    }
    if (button.dataset.action !== "confirm") return;
    const index = [...ruleList.children].indexOf(row);
    cancelRuleDeletion();
    if (!await persist({ type: "removeRule", hostname: row.dataset.hostname,
      includeSubdomains: row.dataset.subdomains === "true" })) {
      renderRules();
      ruleRowData.get(row)?.button.focus();
      return;
    }
    const nextRow = ruleList.children[Math.min(index, ruleList.children.length - 1)];
    (ruleRowData.get(nextRow)?.button ?? hostnameInput).focus();
  });

  ruleList.addEventListener("keydown", (event) => {
    if (event.key === "Escape" && pendingRuleDeletion?.row === event.target.closest(".rule-row")) {
      event.preventDefault();
      cancelRuleDeletion(true);
    }
  });

  exportButton.addEventListener("click", () => {
    if (!preferences.loaded) return;
    const payload = {
      schemaVersion: 3,
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

  const importValue = (key, value) => {
    if (key === "layoutRepair") return value ? "On for all sites" : "Per-site opt-in";
    if (key === "enabled") return value ? "On" : "Off";
    if (key === "scope") return value === "all" ? "Body and headings" : "Body text";
    if (key === "textScale") return `${value}%`;
    if (key === "letterSpacing") return `${value}em`;
    if (key === "lineHeight" && value === 0) return "Default";
    if (key === "design") return designNames[value];
    return String(value);
  };
  const designNames = { signal: "Signal", paper: "Paper", wide: "Wide" };
  const importKeys = { enabled: "Global switch", scope: "Global scope", theme: "Theme", design: "Design",
    layoutRepair: "Layout repair", textScale: "Text size", lineHeight: "Line height", letterSpacing: "Letter spacing" };
  const ruleDescription = (rule) => `${ruleSource(rule)}: activation ${rule.enabled === null ? "inherit" : rule.enabled ? "active" : "paused"}, scope ${rule.scope === null ? "inherit" : importValue("scope", rule.scope)}, layout repair ${rule.layoutRepair == null ? "inherit" : rule.layoutRepair ? "on" : "off"}`;

  const showImportPreview = (preview, kind = "import") => {
    importDraft = { preview, kind, operation: kind === "undo"
      ? { type: "undoImport", before: undoRecord.before, after: undoRecord.after, expected: preview.before }
      : { type: "replace", settings: preview.after, expected: preview.before } };
    importPreviewTitle.textContent = kind === "undo" ? "Review undo" : "Review replacement";
    applyImportButton.textContent = kind === "undo" ? "Apply undo" : "Apply import";
    importPreviewDescription.textContent = kind === "undo"
      ? "Restore only imported values that are still unchanged. Later edits are kept. Review the recovery below before applying."
      : "This file replaces your saved settings and site rules. Check every change before applying.";
    const lines = preview.changes.map(({ key, before, after }) => `${importKeys[key]}: ${importValue(key, before)} → ${importValue(key, after)}`);
    lines.push(...preview.rules.removed.map((rule) => `Remove rule: ${ruleDescription(rule)}`));
    lines.push(...preview.rules.added.map((rule) => `Add rule: ${ruleDescription(rule)}`));
    lines.push(...preview.rules.changed.map(({ before, after }) => `Change rule: ${ruleDescription(before)} → ${ruleDescription(after)}`));
    if (!lines.length) lines.push("No saved values will change.");
    importPreviewList.replaceChildren();
    for (const line of lines) {
      const item = document.createElement("li");
      item.textContent = line;
      importPreviewList.append(item);
    }
    importPreview.hidden = false;
    importPreviewTitle.focus();
  };

  importButton.addEventListener("click", () => importFile.click());
  importFile.addEventListener("change", async () => {
    if (!preferences.loaded || importBusy) return;
    const file = importFile.files?.[0];
    if (!file) return;
    const selection = ++importSelection;
    importError.textContent = "";
    importDraft = null;
    importSaveStatus = null;
    renderSaveStatus();
    importPreview.hidden = true;
    try {
      if (file.size > 256 * 1024) throw new Error("Settings file is too large");
      const text = await file.text();
      if (selection !== importSelection) return;
      const payload = JSON.parse(text);
      const imported = settingsApi.validateImport(payload);
      // Backups from before interface designs existed keep the current design.
      if (!Object.hasOwn(payload.settings, "design")) imported.design = confirmedSettings.design;
      showImportPreview(settingsApi.previewImport(confirmedSettings, imported));
    } catch (error) {
      if (selection === importSelection) importError.textContent = error.code ? error.message : "Choose a valid Lexend settings file.";
    } finally {
      if (selection === importSelection) importFile.value = "";
    }
  });

  cancelImportButton.addEventListener("click", () => {
    if (importBusy) return;
    ++importSelection;
    importDraft = null;
    importSaveStatus = null;
    importPreview.hidden = true;
    importError.textContent = "";
    renderSaveStatus();
    importButton.focus();
  });

  undoImportButton.addEventListener("click", () => {
    if (!undoRecord || importBusy) return;
    ++importSelection;
    importError.textContent = "";
    importSaveStatus = null;
    renderSaveStatus();
    showImportPreview(settingsApi.previewImport(confirmedSettings,
      settingsApi.restoreImport(confirmedSettings, undoRecord.before, undoRecord.after)), "undo");
  });

  const finishImport = (draft, confirmed = true) => {
    const message = confirmed ? (draft.kind === "import" ? "Settings imported" : "Import undone")
      : `${draft.kind === "import" ? "Import" : "Undo"} not confirmed; matching settings were observed`;
    importSaveStatus = { state: "saved", message };
    if (draft.kind === "import") {
      undoRecord = { before: draft.preview.before, after: draft.preview.after };
      importUndo.hidden = false;
      importUndoMessage.textContent = `${message}. Undo restores unchanged imported values and keeps later edits. Undo is available while this settings page stays open.`;
      undoImportButton.hidden = false;
    } else {
      undoRecord = null;
      importUndoMessage.textContent = `${message}. Later changes were kept.`;
      undoImportButton.hidden = true;
    }
    importDraft = null;
    importPreview.hidden = true;
  };

  const refreshImportPreview = (draft) => {
    const target = draft.kind === "undo"
      ? settingsApi.restoreImport(confirmedSettings, undoRecord.before, undoRecord.after)
      : draft.preview.after;
    showImportPreview(settingsApi.previewImport(confirmedSettings, target), draft.kind);
    importError.textContent = "Settings changed after this preview. Review the updated changes, then apply again.";
    importSaveStatus = { state: "error", message: "Settings changed. Review the updated preview before applying." };
    renderSaveStatus();
  };

  applyImportButton.addEventListener("click", async () => {
    if (!importDraft || importBusy || !preferences.loaded) return;
    const draft = importDraft;
    if (!settingsApi.settingsEqual(confirmedSettings, draft.operation.expected)) {
      refreshImportPreview(draft);
      return;
    }
    const replacedFields = draft.kind === "import"
      ? Object.keys(draft.preview.after)
      : draft.preview.changes.map(({ key }) => key);
    if (draft.kind === "undo" && Object.values(draft.preview.rules).some((rules) => rules.length)) {
      replacedFields.push("siteRules");
    }
    importSaveStatus = { state: "saving", message: draft.kind === "import" ? "Importing settings…" : "Applying undo…" };
    importBusy = true;
    recovery.supersede(replacedFields);
    draft.observedApplied = false;
    render();
    importError.textContent = "";
    try {
      await preferences.mutate(draft.operation);
      finishImport(draft);
    } catch (error) {
      if (error.code === "STALE_IMPORT" || error.code === "STALE_UNDO") {
        // Refresh disclosure, never apply against a new snapshot without
        // another deliberate Apply action.
        refreshImportPreview(draft);
      } else if (draft.observedApplied && (!error.code || error.code === "BACKGROUND_UNAVAILABLE")) {
        // Observe the whole applied state while the request is in flight so
        // a lost reply followed by later edits retains the original recovery.
        // An explicit stale rejection above can never grant this recovery.
        finishImport(draft, false);
      } else {
        // Keep the exact operation and expected snapshot after ambiguous
        // failures; the central writer makes this retry safe.
        applyImportButton.textContent = draft.kind === "undo" ? "Retry undo" : "Retry import";
        importError.textContent = error.message || "Changes could not be saved. Retry or cancel.";
        importSaveStatus = { state: "error", message: `${draft.kind === "import" ? "Import" : "Undo"} was not confirmed. Retry or cancel in the preview.` };
      }
    } finally {
      importBusy = false;
      renderSaveStatus();
      render();
      if (!importDraft) (undoRecord ? undoImportButton : importButton).focus();
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

  const loadSettings = async () => {
    loadFailed = false;
    advancedPreferenceLoaded = false;
    setSaveState("loading", "Loading settings…");
    try {
      await preferences.load();
      if (preferenceStorage) {
        try {
          const preferences = await preferenceStorage.get(ADVANCED_PREFERENCE_KEY);
          advancedModeInput.checked = new URLSearchParams(location.search).get("advanced") === "1" || Boolean(preferences[ADVANCED_PREFERENCE_KEY]);
        } catch {
          advancedModeInput.checked = false;
        }
      }
      if (new URLSearchParams(location.search).get("advanced") === "1") advancedModeInput.checked = true;
      advancedPreferenceLoaded = true;
      renderReadabilityMode();
      render();
      renderSaveRecovery(recovery.state);
    } catch (error) {
      loadFailed = true;
      console.error("Lexend for the Web could not load settings.", error);
      renderReadabilityMode();
      render();
      setSaveState("error", "Settings could not be loaded");
    }
  };

  const start = async () => {
    await loadSettings();
    try {
      const commands = await extension?.commands?.getAll?.();
      const command = commands?.find((item) => item.name === "toggle-current-site");
      renderShortcut(command?.shortcut ?? "");
    } catch {
      renderShortcut("");
      shortcutInstructions.hidden = false;
    }
  };

  renderQuote();
  start();
})();
