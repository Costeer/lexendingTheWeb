(() => {
  "use strict";

  const api = globalThis.LexendSettings;
  const pickers = new WeakMap();
  let sequence = 0;
  const summaries = { off: "Keep the layout", gentle: "Let boxes grow", fit: "Keep boxes fixed" };

  // A native radio group: one Tab stop, arrow-key selection, and no hidden
  // duplicate form control. The value accessor keeps consumers independent
  // of how the choices are presented.
  const create = (root, { label, inherit = false, announce = false } = {}) => {
    const id = root.id || `layout-picker-${++sequence}`;
    root.id = id;
    root.className = `${root.className} layout-picker`.trim();
    const legend = document.createElement("legend");
    legend.textContent = label;
    const choices = document.createElement("div");
    choices.className = "layout-choices";
    const description = document.createElement("p");
    description.id = `${id}-description`;
    description.className = "layout-explanation";
    const note = document.createElement("p");
    note.id = `${id}-note`;
    note.className = "layout-note";
    if (announce) note.setAttribute("role", "status");
    const inputs = [];
    let defaultDetail;
    for (const value of [...(inherit ? ["default"] : []), ...Object.keys(api.layoutModes)]) {
      const choice = document.createElement("label");
      choice.className = `layout-choice${value === "default" ? " layout-inherit" : ""}`;
      const input = document.createElement("input");
      input.type = "radio";
      input.name = id;
      input.value = value;
      input.setAttribute("aria-describedby", `${description.id} ${note.id}`);
      const copy = document.createElement("span");
      copy.className = "layout-choice-copy";
      const title = document.createElement("strong");
      title.textContent = value === "default" ? "Use default" : api.layoutModes[value].label;
      const detail = document.createElement("span");
      detail.textContent = summaries[value] ?? "";
      if (value === "default") defaultDetail = detail;
      copy.append(title, detail);
      choice.append(input, copy);
      choices.append(choice);
      inputs.push(input);
    }
    root.replaceChildren(legend, choices, description, note);
    const state = { inputs, description, note, defaultDetail, inheritedMode: "off", source: "your global default", notice: "" };
    pickers.set(root, state);
    Object.defineProperty(root, "value", {
      get: () => inputs.find(input => input.checked)?.value,
      set(value) {
        if (!inputs.some(input => input.value === value)) return;
        inputs.forEach(input => { input.checked = input.value === value; });
        update(root);
      }
    });
    inputs.forEach(input => input.addEventListener("change", () => update(root)));
    root.value = inherit ? "default" : "off";
    return root;
  };

  const update = (root, context = {}) => {
    const state = pickers.get(root);
    Object.assign(state, context);
    const inherited = root.value === "default";
    const mode = inherited ? state.inheritedMode : root.value;
    if (state.defaultDetail) state.defaultDetail.textContent = api.layoutModes[state.inheritedMode].label;
    state.description.textContent = `${inherited ? `Follows ${state.source}. ` : ""}${api.layoutModes[mode].description}`;
    state.note.textContent = state.notice;
    state.note.hidden = !state.notice;
  };

  const focus = (root, value = root.value) => {
    pickers.get(root).inputs.find(input => input.value === value)?.focus({ preventScroll: true });
  };

  // When editing a subdomain rule, an exact rule for the same host does not
  // describe the default inherited by its subdomains.
  const inheritance = (settings, hostname, includeSubdomains = false) => {
    const inherited = api.resolveSite({ ...settings, siteRules: settings.siteRules.filter(rule =>
      !(rule.hostname === hostname && (rule.includeSubdomains === includeSubdomains || includeSubdomains))) }, hostname);
    return {
      inheritedMode: inherited.layoutMode,
      source: inherited.layoutRule ? `the rule for ${inherited.layoutRule.hostname} and its subdomains` : "your global default"
    };
  };

  globalThis.LexendLayoutUI = Object.freeze({ create, update, focus, inheritance });
})();
