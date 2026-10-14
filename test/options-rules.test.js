import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { runInNewContext } from "node:vm";
import test from "node:test";
import "../src/settings.js";
import "../src/preferences.js";
import "../src/save-recovery.js";

const source = await readFile(new URL("../options.js", import.meta.url), "utf8");
const themeSource = await readFile(new URL("../src/ui-theme.js", import.meta.url), "utf8");
const tick = () => new Promise((resolve) => setImmediate(resolve));

class Element {
  constructor() {
    this.children = [];
    this.dataset = {};
    this.style = {};
    this.attributes = new Map();
    this.listeners = new Map();
    this.className = "";
    this.value = "";
    this.checked = false;
    this.classList = { add() {}, remove() {}, toggle() {} };
  }
  append(...children) {
    children.forEach((child) => { child.parent = this; });
    this.children.push(...children);
  }
  replaceChildren(...children) { this.children = []; this.append(...children); }
  insertBefore(child, reference) {
    child.parent = this;
    this.children.splice(this.children.indexOf(reference), 0, child);
  }
  remove() {
    this.parent.children.splice(this.parent.children.indexOf(this), 1);
    this.parent = null;
  }
  setAttribute(name, value) { this.attributes.set(name, value); }
  getAttribute(name) { return this.attributes.get(name); }
  removeAttribute(name) { this.attributes.delete(name); }
  addEventListener(name, listener) { this.listeners.set(name, listener); }
  emit(name, event = {}) { return this.listeners.get(name)?.(event); }
  dispatchEvent(event) { return this.emit(event.type, event); }
  click() { return this.emit("click"); }
  closest(selector) {
    if (this.className.split(" ").includes(selector.slice(1))) return this;
    return this.parent?.closest(selector);
  }
  focus() { this.focused = true; }
}

async function openSettings({ count = 6, desktop = false, cachedTheme = "light", initial, getSettings, failWrite, beforeOperation, afterWrite, allowErrors = false, sendOperation, confirm = () => true } = {}) {
  const elements = new Map();
  const get = (selector) => {
    if (!elements.has(selector)) elements.set(selector, new Element());
    return elements.get(selector);
  };
  const panels = ["appearance-panel", "readability-panel", "rules-panel", "tools-panel"]
    .map((id) => Object.assign(new Element(), { id }));
  const navigation = panels.map((panel) => {
    const button = new Element();
    button.dataset.settingsPanel = panel.id;
    return button;
  });
  const inputs = new Map(Object.entries({
    basicTextScale: [100, 110, 120],
    basicLineHeight: [0, 1.5, 2],
    basicLetterSpacing: [0, 0.04, 0.08],
    previewMode: ["reading", "compare", "glyphs"]
  }).map(([name, values]) => [
    `input[name="${name}"]`,
    values.map((value) => Object.assign(new Element(), { value: String(value) }))
  ]));
  for (const [name, id] of [["basicTextScale", "text-scale"], ["basicLineHeight", "line-height"], ["basicLetterSpacing", "letter-spacing"]]) {
    const input = get(`#custom-${id}`);
    input.value = "custom";
    input.dataset.custom = "true";
    inputs.get(`input[name="${name}"]`).push(input);
  }
  const media = { matches: desktop, addEventListener(name, listener) { this.listener = listener; } };
  const writes = [];
  const errors = [];
  const root = { dataset: {} };
  const cache = new Map([["lexend-ui-theme", cachedTheme]]);
  let stored = initial ?? { siteRules: Array.from({ length: count }, (_, index) => ({
    hostname: `site${index + 1}.example.com`, includeSubdomains: false, enabled: false
  })) };
  let changeListener;
  const storage = {
    async get() { return getSettings ? getSettings() : stored; },
    async set(patch) {
      if (failWrite?.()) throw new Error("Storage unavailable");
      stored = { ...stored, ...patch };
      writes.push(globalThis.LexendSettings.decodeSettings(stored));
      changeListener?.(Object.fromEntries(Object.entries(patch).map(([key, newValue]) => [key, { newValue }])), "sync");
    },
    async remove() {}
  };
  const store = globalThis.LexendPreferences.createStore(storage);
  const context = {
    document: {
      documentElement: root,
      querySelector: get,
      querySelectorAll(selector) {
        if (selector === ".settings-panel") return panels;
        if (selector === "[data-settings-panel]") return navigation;
        return inputs.get(selector) ?? [];
      },
      createElement: () => new Element(),
      createTextNode: (textContent) => ({ textContent })
    },
    localStorage: {
      getItem: (key) => cache.get(key) ?? null,
      setItem: (key, value) => cache.set(key, value)
    },
    LexendSettings: globalThis.LexendSettings,
    LexendPreferences: globalThis.LexendPreferences,
    LexendSaveRecovery: globalThis.LexendSaveRecovery,
    window: { confirm },
    setTimeout: () => 0, clearTimeout() {},
    LexendQuotes: { random: () => ({ text: "Preview", author: "Author", lang: "en", url: "https://example.com" }) },
    browser: {
      runtime: { async sendMessage({ operation }) {
        await beforeOperation?.(operation, storage);
        let settings;
        try { settings = await (sendOperation ? sendOperation(operation, store) : store.mutate(operation)); }
        catch (error) { return { ok: false, code: error.code, message: error.message }; }
        const response = await afterWrite?.(operation, storage);
        return response ?? { ok: true, settings };
      } },
      storage: { sync: storage, onChanged: { addListener(listener) { changeListener = listener; } } }
    },
    matchMedia: (query) => query.includes("min-width") ? media : { matches: false },
    location: { search: "" },
    URLSearchParams,
    URL,
    Event,
    setTimeout: () => 0, clearTimeout() {},
    console: { error(...args) { errors.push(args); } }
  };
  runInNewContext(themeSource, context);
  runInNewContext(source, context);
  await tick();
  if (!allowErrors) assert.deepEqual(errors, []);
  return {
    get, writes, panels, navigation, root, cache, inputs,
    stored: () => globalThis.LexendSettings.decodeSettings(stored),
    rawStored: () => stored,
    async import(settings) {
      get("#import-file").files = [{ size: 500, async text() { return JSON.stringify({ schemaVersion: 2, settings: globalThis.LexendSettings.normalizeSettings(settings) }); } }];
      await get("#import-file").emit("change");
    },
    change(changes) {
      stored = { ...stored, ...Object.fromEntries(Object.entries(changes).map(([key, change]) => [key, change.newValue])) };
      changeListener(changes, "sync");
    },
    rows: () => get("#rule-list").children,
    resize(desktopMode) { media.matches = desktopMode; media.listener(); }
  };
}

test("settings retain the dark navigation cache while loading, then honor synced preferences", async () => {
  let resolveSettings;
  const pending = new Promise((resolve) => { resolveSettings = resolve; });
  const page = await openSettings({ cachedTheme: "dark", getSettings: () => pending });
  assert.equal(page.root.dataset.theme, "dark");
  resolveSettings({ theme: "dark" });
  await tick();
  assert.equal(page.root.dataset.theme, "dark");
  assert.equal(page.get("#dark-theme").checked, true);
  page.get("#dark-theme").checked = false;
  page.get("#dark-theme").emit("change");
  assert.equal(page.root.dataset.theme, "light");
  assert.equal(page.cache.get("lexend-ui-theme"), "light");
  await tick();
  assert.equal(page.writes.at(-1).theme, "light");

  const stale = await openSettings({ cachedTheme: "dark", getSettings: async () => ({ theme: "light" }) });
  assert.equal(stale.root.dataset.theme, "light", "the cache does not override synced settings");
  assert.equal(stale.cache.get("lexend-ui-theme"), "light");
});

test("preview modes and custom samples stay local while the comparison baseline stays fixed", async () => {
  const page = await openSettings({ desktop: true });
  const modes = page.inputs.get('input[name="previewMode"]');
  const select = (value) => {
    modes.forEach((input) => { input.checked = input.value === value; });
    modes.find((input) => input.checked).emit("change");
  };
  select("compare");
  assert.equal(page.get("#preview-original").hidden, false);
  assert.equal(page.get("#preview-reading").hidden, false);
  assert.equal(page.get("#preview-original-copy").textContent, page.get("#preview-copy").textContent);
  page.change({ textScale: { newValue: 140 }, lineHeight: { newValue: 2 }, letterSpacing: { newValue: .08 } });
  assert.equal(page.get("#preview-copy").style.fontSize, "25.2px");
  assert.equal(page.get("#preview-copy").style.lineHeight, 2);
  assert.equal(page.get("#preview-original-copy").style.fontSize, "18px");
  select("glyphs");
  assert.equal(page.get("#preview-reading").hidden, true);
  assert.equal(page.get("#preview-glyphs").hidden, false);
  assert.equal(page.get("#preview-attribution").hidden, true);
  page.get("#preview-text").value = "<b>My own reading sample</b>";
  page.get("#preview-text").emit("input");
  assert.equal(page.get("#preview-glyphs").hidden, true, "typing brings the reading sample into view");
  assert.equal(page.get("#preview-copy").textContent, "<b>My own reading sample</b>", "samples are plain text");
  assert.equal(page.get("#preview-attribution").hidden, true, "custom text never inherits a quote attribution");
  assert.equal(page.get("#preview-copy").lang, "");
  page.get("#preview-text").value = "سارة أحمد";
  page.get("#preview-text").emit("input");
  assert.equal(page.get("#preview-copy").style.letterSpacing, "0em", "preview uses the content engine's Arabic tracking policy");
  page.get("#preview-text").value = "";
  page.get("#preview-text").emit("input");
  assert.equal(page.get("#preview-copy").textContent, "“Preview”");
  assert.equal(page.get("#preview-attribution").hidden, false);
  page.resize(false);
  assert.equal(page.get("#preview-copy").style.fontSize, "22.4px");
  assert.equal(page.get("#preview-original-copy").style.fontSize, "16px");
  assert.equal(page.writes.length, 0, "changing the specimen never writes synchronized preferences");
});

test("failed settings reads keep controls disabled and Retry reads without writing defaults", async () => {
  let attempts = 0;
  const page = await openSettings({ allowErrors: true, getSettings: async () => {
    if (++attempts === 1) throw new Error("Read temporarily failed");
    return { theme: "dark", enabled: false, siteRules: [{ hostname: "saved.example", enabled: false }] };
  } });
  assert.equal(page.get("#dark-theme").disabled, true);
  page.get("#dark-theme").emit("change");
  assert.equal(page.writes.length, 0);
  await page.get("#retry-save").emit("click");
  await tick();
  assert.equal(attempts, 2);
  assert.equal(page.writes.length, 0);
  assert.equal(page.get("#dark-theme").disabled, false);
  assert.equal(page.get("#dark-theme").checked, true);
  assert.equal(page.rows()[0].dataset.hostname, "saved.example");
});

test("controls cannot save before initialization and newer storage events win over the read", async () => {
  let resolve;
  const page = await openSettings({ getSettings: () => new Promise((done) => { resolve = done; }) });
  assert.equal(page.get("#text-scale").disabled, true);
  page.get("#text-scale").value = "110";
  page.get("#text-scale").emit("change");
  assert.equal(page.writes.length, 0);
  page.change({ theme: { newValue: "dark" } });
  resolve({ theme: "light", textScale: 120 });
  await tick();
  assert.equal(page.get("#dark-theme").checked, true);
  assert.equal(page.get("#text-scale").value, "120");
});

test("readability presets select exact values and Custom represents nonpreset saved values", async () => {
  for (const settings of [
    { textScale: 100, lineHeight: 0, letterSpacing: 0 },
    { textScale: 110, lineHeight: 1.5, letterSpacing: 0.04 },
    { textScale: 120, lineHeight: 2, letterSpacing: 0.08 },
    { textScale: 105, lineHeight: 1.6, letterSpacing: 0.045 }
  ]) {
    const page = await openSettings({ getSettings: async () => settings });
    for (const [name, key] of [["basicTextScale", "textScale"], ["basicLineHeight", "lineHeight"], ["basicLetterSpacing", "letterSpacing"]]) {
      const selected = page.inputs.get(`input[name="${name}"]`).filter((input) => input.checked);
      assert.deepEqual(selected.map((input) => input.value), [String(settings[key])]);
      assert.equal(Boolean(selected[0].dataset.custom), [105, 1.6, 0.045].includes(settings[key]));
    }
  }
});

test("custom slider values select Custom and choosing a preset restores it", async () => {
  const page = await openSettings();
  const controls = [
    ["#text-scale", "basicTextScale", "105", "110", "textScale", 105],
    ["#line-height", "basicLineHeight", "61", "1.5", "lineHeight", 1.6],
    ["#letter-spacing", "basicLetterSpacing", "0.045", "0.04", "letterSpacing", 0.045]
  ];
  for (const [selector, name, custom, preset, key, value] of controls) {
    const slider = page.get(selector);
    slider.value = custom;
    slider.emit("change");
    const inputs = page.inputs.get(`input[name="${name}"]`);
    assert.equal(inputs.filter((input) => input.checked).length, 1);
    assert.equal(inputs.find((input) => input.checked).dataset.custom, "true", `${name} selects Custom for ${value}`);
    await tick();
    assert.equal(page.writes.at(-1)[key], value);
    inputs.find((input) => input.value === preset).emit("click");
    assert.deepEqual(inputs.filter((input) => input.checked).map((input) => input.value), [preset]);
    await tick();
    assert.equal(page.writes.at(-1)[key], Number(preset));
  }
});

test("rapid sidebar selections leave only the latest category selected and visible", async () => {
  const page = await openSettings({ desktop: true });
  for (const id of ["rules-panel", "tools-panel", "appearance-panel", "readability-panel", "rules-panel"]) {
    page.navigation.find((button) => button.dataset.settingsPanel === id).emit("click");
    assert.deepEqual(page.panels.filter((panel) => !panel.hidden).map((panel) => panel.id), [id]);
    assert.deepEqual(page.navigation.filter((button) => button.getAttribute("aria-current") === "page")
      .map((button) => button.dataset.settingsPanel), [id]);
  }
  page.resize(false);
  assert.equal(page.panels.filter((panel) => !panel.hidden).length, 4);
  page.resize(true);
  assert.deepEqual(page.panels.filter((panel) => !panel.hidden).map((panel) => panel.id), ["rules-panel"]);
  assert.equal(page.writes.length, 0);
});

test("mobile rules default to two and expand or collapse without saving preferences", async () => {
  const page = await openSettings();
  const toggle = page.get("#toggle-rule-list");
  assert.deepEqual(page.rows().map((row) => row.dataset.hostname), ["site1.example.com", "site2.example.com"]);
  assert.equal(toggle.hidden, false);
  assert.equal(toggle.getAttribute("aria-expanded"), "false");
  assert.equal(page.get("#toggle-rule-list-label").textContent, "Show all 6 rules");
  toggle.emit("click");
  assert.equal(page.rows().length, 6);
  assert.equal(toggle.getAttribute("aria-expanded"), "true");
  assert.equal(page.get("#toggle-rule-list-label").textContent, "Show fewer rules");
  toggle.emit("click");
  assert.equal(page.rows().length, 2);
  assert.equal(toggle.getAttribute("aria-expanded"), "false");
  assert.equal(page.writes.length, 0);
});

test("desktop always shows all rules and viewport changes update the mobile limit", async () => {
  const page = await openSettings({ desktop: true });
  assert.equal(page.rows().length, 6);
  assert.equal(page.get("#toggle-rule-list").hidden, true);
  page.resize(false);
  assert.equal(page.rows().length, 2);
  assert.equal(page.get("#toggle-rule-list").hidden, false);
  page.resize(true);
  assert.equal(page.rows().length, 6);
  assert.equal(page.get("#toggle-rule-list").hidden, true);
});

test("mobile search includes rules beyond the collapsed preview", async () => {
  const page = await openSettings();
  const search = page.get("#rule-search");
  search.value = "site6";
  search.emit("input");
  assert.deepEqual(page.rows().map((row) => row.dataset.hostname), ["site6.example.com"]);
  assert.equal(page.get("#toggle-rule-list").hidden, true);
  search.value = "missing";
  search.emit("input");
  assert.equal(page.rows().length, 0);
  assert.equal(page.get("#search-empty").hidden, false);
  search.value = "";
  search.emit("input");
  assert.equal(page.rows().length, 2);
  assert.equal(page.get("#toggle-rule-list").hidden, false);
});

test("mobile lists of at most two rules do not need an expansion control", async () => {
  for (const count of [0, 1, 2]) {
    const page = await openSettings({ count });
    assert.equal(page.rows().length, count);
    assert.equal(page.get("#toggle-rule-list").hidden, true);
    assert.equal(page.get("#empty-rules").hidden, count > 0);
  }
});

test("deleting a previewed rule reveals the next rule and removes an unnecessary toggle", async () => {
  const page = await openSettings({ count: 3 });
  const deleteButton = page.rows()[0].children.at(-1);
  page.get("#rule-list").emit("click", { target: deleteButton });
  assert.equal(page.rows().length, 2);
  assert.equal(page.writes.length, 0);
  assert.equal(deleteButton.dataset.action, "cancel");
  const confirmButton = page.rows()[0].children.find((child) => child.dataset.action === "confirm");
  page.get("#rule-list").emit("click", { target: confirmButton });
  await tick();
  assert.deepEqual(page.rows().map((row) => row.dataset.hostname), ["site2.example.com", "site3.example.com"]);
  assert.equal(page.get("#toggle-rule-list").hidden, true);
  assert.equal(page.writes.at(-1).siteRules.length, 2);
  assert.equal(page.rows()[0].children.at(-1).focused, true);
});

test("cancel and Escape restore the original rule without persisting changes", async () => {
  const page = await openSettings({ count: 2 });
  const list = page.get("#rule-list");
  const row = page.rows()[0];
  const originalDomain = row.children[0].children[0];
  const status = row.children[1];
  const button = row.children.at(-1);
  for (const cancelWithEscape of [false, true]) {
    list.emit("click", { target: button });
    assert.equal(button.dataset.action, "cancel");
    assert.equal(status.hidden, true);
    assert.equal(row.children[0].children[0].className, "rule-delete-prompt");
    assert.match(button.getAttribute("aria-label"), /Cancel deleting rule for site1.example.com/);
    if (cancelWithEscape) {
      let prevented = false;
      list.emit("keydown", { key: "Escape", target: button, preventDefault() { prevented = true; } });
      assert.equal(prevented, true);
    } else {
      list.emit("click", { target: button });
    }
    assert.equal(row.children[0].children[0], originalDomain);
    assert.equal(status.hidden, false);
    assert.equal(button.dataset.action, "delete");
    assert.equal(button.focused, true);
    assert.equal(row.children.length, 3);
    assert.equal(page.rows()[0], row);
  }
  await tick();
  assert.equal(page.writes.length, 0);
});

test("confirmation messages use eleven stable domain-hashed variants across reloads", async () => {
  const collect = async () => {
    const page = await openSettings({ count: 60, desktop: true });
    const prompts = new Map();
    let previousButton;
    for (const row of page.rows()) {
      const button = row.children.at(-1);
      page.get("#rule-list").emit("click", { target: button });
      if (previousButton) assert.equal(previousButton.dataset.action, "delete");
      prompts.set(row.dataset.hostname, row.children[0].children[0].textContent);
      previousButton = button;
    }
    assert.equal(page.writes.length, 0);
    return prompts;
  };
  const first = await collect();
  const templates = new Set([...first].map(([hostname, prompt]) => prompt.replace(hostname, "{site}")));
  assert.equal(templates.size, 11);
  assert.ok(templates.has("Remove the rule for {site}?"));
  for (const [hostname, prompt] of first) {
    assert.ok(!prompt.includes("{site}"));
    if (prompt.startsWith("Remove the rule for ")) {
      assert.equal(prompt, `Remove the rule for ${hostname}?`);
    }
  }
  assert.deepEqual(await collect(), first);
  const filtered = await openSettings({ count: 60 });
  filtered.get("#rule-search").value = "site42.example.com";
  filtered.get("#rule-search").emit("input");
  const row = filtered.rows()[0];
  filtered.get("#rule-list").emit("click", { target: row.children.at(-1) });
  assert.equal(row.children[0].children[0].textContent, first.get("site42.example.com"));
});

test("confirmation distinguishes exact-host and subdomain rules and deletes only the confirmed variant", async () => {
  const page = await openSettings({ getSettings: async () => ({ siteRules: [
    { hostname: "example.com", includeSubdomains: true, enabled: false },
    { hostname: "example.com", includeSubdomains: false, enabled: false }
  ] }) });
  const list = page.get("#rule-list");
  const [exact, subdomains] = page.rows();
  list.emit("click", { target: exact.children.at(-1) });
  const prompt = exact.children[0].children[0].textContent;
  list.emit("click", { target: subdomains.children.at(-1) });
  assert.equal(subdomains.children[0].children[0].textContent, prompt);
  const confirm = subdomains.children.find((child) => child.dataset.action === "confirm");
  assert.match(confirm.getAttribute("aria-label"), /example.com and its subdomains/);
  list.emit("click", { target: confirm });
  await tick();
  assert.equal(page.writes.length, 1);
  assert.equal(page.writes[0].siteRules.length, 1);
  assert.equal(page.writes[0].siteRules[0].includeSubdomains, false);
});

test("filtering or leaving Site rules dismisses a pending confirmation", async () => {
  const page = await openSettings({ desktop: true });
  const list = page.get("#rule-list");
  list.emit("click", { target: page.rows()[0].children.at(-1) });
  page.get("#rule-search").value = "site2";
  page.get("#rule-search").emit("input");
  const row = page.rows()[0];
  assert.equal(row.children.at(-1).dataset.action, "delete");
  list.emit("click", { target: row.children.at(-1) });
  page.navigation.find((button) => button.dataset.settingsPanel === "appearance-panel").emit("click");
  assert.equal(row.children.at(-1).dataset.action, "delete");
  assert.equal(page.writes.length, 0);
});

test("readability and appearance changes preserve the existing site-rule rows", async () => {
  const page = await openSettings({ desktop: true, count: 60 });
  const rows = [...page.rows()];
  page.get("#text-scale").value = "110";
  page.get("#text-scale").emit("change");
  await tick();
  page.get("#dark-theme").checked = true;
  page.get("#dark-theme").emit("change");
  await tick();
  assert.equal(page.rows().length, rows.length);
  page.rows().forEach((row, index) => assert.equal(row, rows[index]));
  assert.equal(page.writes.at(-1).theme, "dark");
  assert.equal(page.writes.at(-1).textScale, 110);
});


test("failed theme remains visible after a successful size save and Retry restores only theme", async () => {
  let failed = false;
  const page = await openSettings({ allowErrors: true, sendOperation: async (operation, store) => {
    if (!failed) { failed = true; throw new Error("Theme write rejected"); }
    return store.mutate(operation);
  } });
  page.get("#dark-theme").checked = true;
  page.get("#dark-theme").emit("change");
  page.get("#text-scale").value = "120";
  page.get("#text-scale").emit("change");
  await tick();
  assert.equal(page.get("#dark-theme").checked, false);
  assert.match(page.get("#save-status-text").textContent, /Not saved: appearance/);
  assert.equal(page.get("#retry-save").hidden, false);
  await page.get("#retry-save").emit("click");
  assert.equal(page.get("#dark-theme").checked, true);
  assert.equal(page.get("#text-scale").value, "120");
  assert.equal(page.get("#save-status-text").textContent, "All changes saved");
});

test("successful Retry clears only its failed-add field error and preserves the submitted subdomain intent", async () => {
  let failAdd = true;
  const page = await openSettings({ count: 0, sendOperation(operation, store) {
    if (operation.type === "addRule" && failAdd) throw new Error("Rule quota exceeded");
    return store.mutate(operation);
  } });
  page.get("#new-hostname").value = "retry.example";
  page.get("#new-subdomains").checked = true;
  await page.get("#add-rule").emit("submit", { preventDefault() {} });
  assert.equal(page.get("#hostname-error").textContent, "Not saved: site rule. Rule quota exceeded");
  assert.equal(page.get("#new-hostname").getAttribute("aria-invalid"), "true");
  failAdd = false;
  await page.get("#retry-save").emit("click");
  assert.equal(page.get("#hostname-error").textContent, "");
  assert.equal(page.get("#new-hostname").getAttribute("aria-invalid"), undefined);
  assert.equal(page.get("#save-status-text").textContent, "All changes saved");
  assert.deepEqual(page.stored().siteRules, [{ hostname: "retry.example", includeSubdomains: true,
    enabled: false, scope: null }]);
  assert.equal(page.get("#new-hostname").value, "retry.example", "Retry retires feedback without resetting a form draft");
  assert.equal(page.get("#new-subdomains").checked, true);
});

test("a rejected add Retry retains its field error and an unrelated successful save cannot clear it", async () => {
  const page = await openSettings({ count: 0, sendOperation(operation, store) {
    if (operation.type === "addRule") throw new Error("Rule quota exceeded");
    return store.mutate(operation);
  } });
  page.get("#new-hostname").value = "retry.example";
  await page.get("#add-rule").emit("submit", { preventDefault() {} });
  const error = page.get("#hostname-error").textContent;
  page.get("#dark-theme").checked = true;
  page.get("#dark-theme").emit("change");
  await tick();
  assert.equal(page.stored().theme, "dark");
  assert.equal(page.get("#hostname-error").textContent, error);
  await page.get("#retry-save").emit("click");
  assert.equal(page.get("#hostname-error").textContent, error);
  assert.equal(page.get("#new-hostname").getAttribute("aria-invalid"), "true");
  assert.equal(page.stored().siteRules.length, 0);
  assert.equal(page.get("#retry-save").hidden, false);
});

test("recovered add feedback clears while an unrelated failed theme retains its own Retry", async () => {
  let failAdd = true;
  const page = await openSettings({ count: 0, sendOperation(operation, store) {
    if (operation.type === "patch") throw new Error("Theme unavailable");
    if (failAdd) throw new Error("Rule quota exceeded");
    return store.mutate(operation);
  } });
  page.get("#dark-theme").checked = true;
  page.get("#dark-theme").emit("change");
  await tick();
  page.get("#new-hostname").value = "retry.example";
  await page.get("#add-rule").emit("submit", { preventDefault() {} });
  assert.equal(page.get("#hostname-error").textContent, "Not saved: site rule. Rule quota exceeded",
    "the add field reports its own error rather than another intent's shared status");
  failAdd = false;
  await page.get("#retry-save").emit("click");
  assert.equal(page.get("#hostname-error").textContent, "");
  assert.equal(page.get("#new-hostname").getAttribute("aria-invalid"), undefined);
  assert.equal(page.stored().siteRules[0].hostname, "retry.example");
  assert.equal(page.stored().theme, "light");
  assert.match(page.get("#save-status-text").textContent, /Not saved: appearance.*Theme unavailable/);
  assert.equal(page.get("#retry-save").hidden, false);
});

for (const newerDraft of ["valid", "invalid", "duplicate", "subdomains"]) {
  test(`a delayed successful Retry preserves a newer ${newerDraft} draft and its validation`, async () => {
    let failAdd = true;
    let releaseRetry;
    const page = await openSettings({ count: 1, sendOperation: async (operation, store) => {
      if (operation.type === "addRule") {
        if (failAdd) throw new Error("Rule quota exceeded");
        await new Promise((resolve) => { releaseRetry = resolve; });
      }
      return store.mutate(operation);
    } });
    page.get("#new-hostname").value = "retry.example";
    await page.get("#add-rule").emit("submit", { preventDefault() {} });
    failAdd = false;
    const retry = page.get("#retry-save").emit("click");
    await tick();
    if (newerDraft === "subdomains") {
      page.get("#new-subdomains").checked = true;
      page.get("#new-subdomains").emit("change");
    } else {
      page.get("#new-hostname").value = newerDraft === "valid" ? "new-draft.example"
        : newerDraft === "duplicate" ? "site1.example.com" : "invalid hostname";
      page.get("#new-hostname").emit("input");
      page.get("#new-subdomains").checked = newerDraft === "valid";
      if (newerDraft !== "valid") await page.get("#add-rule").emit("submit", { preventDefault() {} });
    }
    const value = page.get("#new-hostname").value;
    const error = page.get("#hostname-error").textContent;
    const invalid = page.get("#new-hostname").getAttribute("aria-invalid");
    const subdomains = page.get("#new-subdomains").checked;
    releaseRetry();
    await retry;
    assert.equal(page.get("#new-hostname").value, value);
    assert.equal(page.get("#new-subdomains").checked, subdomains);
    assert.equal(page.get("#hostname-error").textContent, error);
    assert.equal(page.get("#new-hostname").getAttribute("aria-invalid"), invalid);
    assert.equal(page.stored().siteRules.find((rule) => rule.hostname === "retry.example").includeSubdomains, false,
      "the original retry preserves its submitted mode rather than adopting a later checkbox draft");
    assert.equal(page.get("#save-status-text").textContent, "All changes saved");
  });
}

test("an older delayed Retry cannot clear the field error from a newer failed add", async () => {
  let oldAttempts = 0;
  let releaseRetry;
  const page = await openSettings({ count: 0, sendOperation: async (operation, store) => {
    if (operation.rule.hostname === "old.example" && ++oldAttempts > 1) {
      await new Promise((resolve) => { releaseRetry = resolve; });
      return store.mutate(operation);
    }
    throw new Error(`${operation.rule.hostname} unavailable`);
  } });
  page.get("#new-hostname").value = "old.example";
  await page.get("#add-rule").emit("submit", { preventDefault() {} });
  const retry = page.get("#retry-save").emit("click");
  await tick();
  page.get("#new-hostname").value = "new.example";
  page.get("#new-hostname").emit("input");
  page.get("#new-subdomains").checked = true;
  await page.get("#add-rule").emit("submit", { preventDefault() {} });
  releaseRetry();
  await retry;
  assert.equal(page.get("#hostname-error").textContent, "Not saved: site rule. new.example unavailable");
  assert.equal(page.get("#new-hostname").getAttribute("aria-invalid"), "true");
  assert.equal(page.get("#new-hostname").value, "new.example");
  assert.equal(page.get("#new-subdomains").checked, true);
  assert.deepEqual(page.stored().siteRules.map((rule) => rule.hostname), ["old.example"]);
});

for (const oldSaveSucceeds of [false, true]) {
  test(`a late ${oldSaveSucceeds ? "successful" : "failed"} add cannot replace a newer invalid draft`, async () => {
    let settleAdd;
    const page = await openSettings({ count: 0, sendOperation: async (operation, store) => {
      await new Promise((resolve, reject) => { settleAdd = oldSaveSucceeds ? resolve : () => reject(new Error("Late quota error")); });
      return store.mutate(operation);
    } });
    page.get("#new-hostname").value = "old.example";
    const add = page.get("#add-rule").emit("submit", { preventDefault() {} });
    await tick();
    page.get("#new-hostname").value = "invalid hostname";
    page.get("#new-hostname").emit("input");
    page.get("#new-subdomains").checked = true;
    await page.get("#add-rule").emit("submit", { preventDefault() {} });
    settleAdd();
    await add;
    assert.equal(page.get("#hostname-error").textContent, "Enter just the domain, like example.com");
    assert.equal(page.get("#new-hostname").getAttribute("aria-invalid"), "true");
    assert.equal(page.get("#new-hostname").value, "invalid hostname");
    assert.equal(page.get("#new-subdomains").checked, true);
    assert.equal(page.stored().siteRules.length, Number(oldSaveSucceeds));
  });
}

test("Retry retires a failed-add field error when its write committed before a lost response", async () => {
  let responses = 0;
  const page = await openSettings({ count: 0, afterWrite: () => {
    responses++;
    return { ok: false, message: "Writer reply lost" };
  } });
  page.get("#new-hostname").value = "committed.example";
  await page.get("#add-rule").emit("submit", { preventDefault() {} });
  assert.match(page.get("#hostname-error").textContent, /Writer reply lost/);
  assert.equal(page.stored().siteRules[0].hostname, "committed.example");
  await page.get("#retry-save").emit("click");
  assert.equal(responses, 1, "confirmed fulfillment retires the failed operation without replaying it");
  assert.equal(page.get("#hostname-error").textContent, "");
  assert.equal(page.get("#new-hostname").getAttribute("aria-invalid"), undefined);
  assert.equal(page.get("#save-status-text").textContent, "All changes saved");
});

test("a late add failure superseded by an applied import cannot attach a saved status as a field error", async () => {
  let rejectAdd;
  const page = await openSettings({ count: 0, beforeOperation(operation) {
    if (operation.type === "addRule") return new Promise((_, reject) => { rejectAdd = reject; });
  } });
  page.get("#new-hostname").value = "old.example";
  const add = page.get("#add-rule").emit("submit", { preventDefault() {} });
  await tick();
  await page.import(globalThis.LexendSettings.normalizeSettings({ theme: "dark" }));
  await page.get("#apply-import").emit("click");
  const importMessage = page.get("#save-status-text").textContent;
  rejectAdd(new Error("Superseded add failed"));
  await add;
  assert.equal(page.get("#hostname-error").textContent, "");
  assert.equal(page.get("#new-hostname").getAttribute("aria-invalid"), undefined);
  assert.equal(page.get("#new-hostname").value, "old.example");
  assert.equal(page.get("#save-status-text").textContent, importMessage);
  assert.equal(page.stored().theme, "dark");
  assert.equal(page.stored().siteRules.length, 0);
});

for (const changedOverride of [{ enabled: true }, { scope: "all" }, { includeSubdomains: true }]) {
  test(`a retired add failure does not clear field feedback for a different confirmed ${Object.keys(changedOverride)[0]} intent`, async () => {
    let operations = 0;
    const page = await openSettings({ count: 0, sendOperation(operation, store) {
      operations++;
      if (operation.type === "addRule") throw new Error("Rule quota exceeded");
      return store.mutate(operation);
    } });
    page.get("#new-hostname").value = "retry.example";
    await page.get("#add-rule").emit("submit", { preventDefault() {} });
    const error = page.get("#hostname-error").textContent;
    await page.import(globalThis.LexendSettings.normalizeSettings({ siteRules: [
      { hostname: "retry.example", includeSubdomains: false, enabled: false, ...changedOverride }
    ] }));
    await page.get("#apply-import").emit("click");
    assert.equal(page.get("#retry-save").hidden, true, "import retired the ordinary failed add");
    await page.get("#retry-save").emit("click");
    assert.equal(operations, 2, "retired add intent is never replayed");
    assert.equal(page.get("#hostname-error").textContent, error);
    assert.equal(page.get("#new-hostname").getAttribute("aria-invalid"), "true");
  });
}

test("import replacement is disclosed and cancelling leaves settings untouched", async () => {
  const page = await openSettings();
  page.get("#import-file").files = [{ size: 200, text: async () => JSON.stringify({ schemaVersion: 2,
    settings: globalThis.LexendSettings.normalizeSettings({ theme: "dark" }) }) }];
  await page.get("#import-file").emit("change");
  assert.equal(page.get("#import-preview").hidden, false);
  assert.match(page.get("#import-preview-description").textContent, /replaces your saved settings and site rules/);
  await page.get("#cancel-import").emit("click");
  assert.equal(page.writes.length, 0);
  assert.equal(page.rows().length, 2);
  assert.equal(page.get("#dark-theme").checked, false);
});

test("invalid partial imports never reach confirmation or the writer", async () => {
  let prompts = 0;
  const page = await openSettings({ confirm: () => { prompts++; return true; } });
  for (const settings of [{}, { theme: "dark" }]) {
    page.get("#import-file").files = [{ size: 100, text: async () => JSON.stringify({ schemaVersion: 2, settings }) }];
    await page.get("#import-file").emit("change");
    assert.match(page.get("#import-error").textContent, /missing|complete/i);
  }
  assert.equal(prompts, 0);
  assert.equal(page.writes.length, 0);
});

test("supported legacy import also requires reviewed Apply", async () => {
  const page = await openSettings();
  page.get("#import-file").files = [{ size: 100, text: async () => JSON.stringify({ schemaVersion: 1,
    settings: { disabledSites: ["legacy.example"], enabled: false } }) }];
  await page.get("#import-file").emit("change");
  assert.equal(page.get("#import-preview").hidden, false);
  assert.equal(page.writes.length, 0);
  await page.get("#apply-import").emit("click");
  assert.equal(page.writes.length, 1);
  assert.equal(page.writes[0].enabled, false);
  assert.deepEqual(page.writes[0].siteRules.map((rule) => rule.hostname), ["legacy.example"]);
});

test("corrupt synchronized settings expose read recovery instead of a saved status", async () => {
  const page = await openSettings();
  page.change({ siteRules: { newValue: "@unknown\nexample.com" } });
  assert.equal(page.get("#dark-theme").disabled, true);
  assert.equal(page.get("#retry-save").hidden, false);
  assert.match(page.get("#save-status-text").textContent, /could not be read/);
});
const editorFor = (row) => {
  const editor = row.children[0].children.find((child) => child.className === "rule-editor");
  const form = editor.children[1];
  const fields = Object.fromEntries(form.children.filter((child) => child.children[1]?.name)
    .map((label) => [label.children[1].name, label.children[1]]));
  return { editor, form, fields, sources: form.children[3] };
};

test("scope-only imported rules edit each override and expose the independent inherited sources", async () => {
  const page = await openSettings({ initial: { scope: "body", siteRules: [
    { hostname: "example.com", includeSubdomains: true, enabled: false, scope: "all" },
    { hostname: "read.example.com", includeSubdomains: false, scope: "body" }
  ] } });
  const row = () => page.rows().find((entry) => entry.dataset.hostname === "read.example.com");
  let editor = editorFor(row());
  assert.equal(editor.fields.enabled.value, "inherit");
  assert.equal(editor.fields.scope.value, "body");
  assert.match(editor.sources.textContent, /Paused from example.com \(including subdomains\)/);
  assert.match(editor.sources.textContent, /Body text from read.example.com \(exact host\)/);
  editor.fields.enabled.value = "true";
  editor.fields.scope.value = "inherit";
  editor.fields.includeSubdomains.value = "true";
  await editor.form.emit("submit", { preventDefault() {} });
  const changed = page.stored().siteRules.find((rule) => rule.hostname === "read.example.com");
  assert.deepEqual(changed, { hostname: "read.example.com", includeSubdomains: true, enabled: true, scope: null });
  editor = editorFor(row());
  assert.match(editor.sources.textContent, /Body and headings from example.com/);
  editor.fields.enabled.value = "inherit";
  await editor.form.emit("submit", { preventDefault() {} });
  assert.equal(row(), undefined, "inheriting both values removes the empty rule");
  const inherited = globalThis.LexendSettings.resolveSite(page.stored(), "read.example.com");
  assert.equal(inherited.siteEnabled, false);
  assert.equal(inherited.scope, "all");
});

test("rule editor cancellation and unchanged submission write nothing", async () => {
  const page = await openSettings({ count: 1 });
  const { editor, form, fields } = editorFor(page.rows()[0]);
  fields.enabled.value = "true";
  form.children.at(-1).children[1].emit("click");
  assert.equal(editor.open, false);
  assert.equal(fields.enabled.value, "false");
  await form.emit("submit", { preventDefault() {} });
  assert.equal(page.writes.length, 0);
});

test("synced precise Custom values stay selected and switching Advanced preserves every value", async () => {
  const initial = { textScale: 127, lineHeight: 1.73, letterSpacing: .057 };
  const page = await openSettings({ initial });
  for (const [id, value] of [["text-scale", "127%"], ["line-height", "1.73"], ["letter-spacing", "0.057em"]]) {
    assert.equal(page.get(`#custom-${id}`).checked, true);
    assert.equal(page.get(`#custom-${id}-choice`).hidden, false);
    assert.equal(page.get(`#custom-${id}-label`).textContent, `Custom · ${value}`);
  }
  assert.equal(page.get("#line-height").value, "74", "the thumb represents 1.73 exactly");
  page.get("#adjust-custom-values").emit("click");
  assert.equal(page.get("#advanced-mode").checked, true);
  assert.equal(page.get("#basic-readability").hidden, true);
  assert.equal(page.get("#line-height").getAttribute("aria-valuetext"), "1.73");
  page.get("#advanced-mode").checked = false;
  await page.get("#advanced-mode").emit("change");
  assert.equal(page.get("#custom-line-height").checked, true);
  assert.equal(page.writes.length, 0);
  assert.deepEqual(page.stored(), globalThis.LexendSettings.normalizeSettings(initial));
});

test("import preview enumerates reset values and removed rules; cancelling preserves saved settings", async () => {
  const initial = { theme: "dark", textScale: 120, siteRules: [{ hostname: "saved.example", enabled: false }] };
  const page = await openSettings({ initial });
  await page.import({ textScale: 127 });
  const lines = page.get("#import-preview-list").children.map((item) => item.textContent).join("\n");
  assert.match(lines, /Theme: dark → light/);
  assert.match(lines, /Text size: 120% → 127%/);
  assert.match(lines, /Remove rule: saved.example/);
  assert.equal(page.writes.length, 0);
  page.get("#cancel-import").emit("click");
  assert.equal(page.get("#import-preview").hidden, true);
  assert.equal(page.writes.length, 0);
  assert.deepEqual(page.stored(), globalThis.LexendSettings.normalizeSettings(initial));
});

test("import recovery restores imported fields while preserving later independent edits", async () => {
  const page = await openSettings({ initial: { textScale: 110, siteRules: [{ hostname: "saved.example", enabled: false }] } });
  await page.import({ textScale: 127, lineHeight: 1.73, letterSpacing: .057, siteRules: [{ hostname: "added.example", scope: "all" }] });
  await page.get("#apply-import").emit("click");
  assert.equal(page.stored().textScale, 127);
  assert.equal(page.get("#import-undo").hidden, false);
  page.change({ textScale: { newValue: 139 }, siteRules: { newValue: [
    ...page.stored().siteRules, { hostname: "later.example", enabled: false }
  ] } });
  page.get("#undo-import").emit("click");
  assert.equal(page.get("#import-preview-title").textContent, "Review undo");
  assert.equal(page.stored().lineHeight, 1.73, "undo also requires deliberate review");
  await page.get("#apply-import").emit("click");
  assert.equal(page.stored().textScale, 139);
  assert.equal(page.stored().lineHeight, 0);
  assert.equal(page.stored().letterSpacing, 0);
  assert.deepEqual(page.stored().siteRules.map((rule) => rule.hostname).sort(), ["later.example", "saved.example"]);
});

test("failed imports retry their original expectation and require renewed review after a later edit", async () => {
  let fail = true;
  const page = await openSettings({ initial: { textScale: 110 }, failWrite: () => fail });
  await page.import({ textScale: 127 });
  await page.get("#apply-import").emit("click");
  assert.equal(page.get("#apply-import").textContent, "Retry import");
  assert.equal(page.writes.length, 0);
  page.change({ textScale: { newValue: 139 } });
  fail = false;
  await page.get("#apply-import").emit("click");
  assert.equal(page.stored().textScale, 139);
  assert.equal(page.writes.length, 0);
  assert.match(page.get("#import-error").textContent, /Review the updated changes/);
  assert.match(page.get("#import-preview-list").children[0].textContent, /139% → 127%/);
  await page.get("#apply-import").emit("click");
  assert.equal(page.stored().textScale, 127);
});

test("failed undo retries cannot overwrite changes made after its preview", async () => {
  let fail = false;
  const page = await openSettings({ initial: { textScale: 110 }, failWrite: () => fail });
  await page.import({ textScale: 127, lineHeight: 1.73 });
  await page.get("#apply-import").emit("click");
  page.get("#undo-import").emit("click");
  fail = true;
  await page.get("#apply-import").emit("click");
  assert.equal(page.get("#apply-import").textContent, "Retry undo");
  page.change({ textScale: { newValue: 139 } });
  fail = false;
  await page.get("#apply-import").emit("click");
  assert.equal(page.stored().lineHeight, 1.73);
  assert.equal(page.stored().textScale, 139);
  assert.match(page.get("#import-error").textContent, /Review the updated changes/);
  await page.get("#apply-import").emit("click");
  assert.equal(page.stored().lineHeight, 0);
  assert.equal(page.stored().textScale, 139);
});

test("a committed import with a lost reply keeps its original recovery snapshot", async () => {
  const page = await openSettings({ initial: { textScale: 110 }, afterWrite(operation) {
    if (operation.type === "replace") throw new Error("Reply lost after saving");
  } });
  await page.import({ textScale: 127 });
  await page.get("#apply-import").emit("click");
  assert.equal(page.stored().textScale, 127);
  assert.equal(page.get("#import-preview").hidden, true);
  assert.equal(page.get("#import-undo").hidden, false);
  page.get("#undo-import").emit("click");
  await page.get("#apply-import").emit("click");
  assert.equal(page.stored().textScale, 110);
});

test("older asynchronous file reads cannot replace the latest import preview", async () => {
  const page = await openSettings({ initial: { textScale: 110 } });
  let finishFirst;
  page.get("#import-file").files = [{ size: 200, text: () => new Promise((resolve) => { finishFirst = resolve; }) }];
  const first = page.get("#import-file").emit("change");
  await page.import({ textScale: 127 });
  finishFirst(JSON.stringify({ schemaVersion: 2, settings: globalThis.LexendSettings.normalizeSettings({ textScale: 139 }) }));
  await first;
  const lines = page.get("#import-preview-list").children.map((item) => item.textContent).join("\n");
  assert.match(lines, /127%/);
  assert.doesNotMatch(lines, /139%/);
  assert.equal(page.writes.length, 0);
});


test("a rejected stale import matching another writer's target never grants undo", async () => {
  const page = await openSettings({ initial: { textScale: 110 } });
  await page.import({ textScale: 127 });
  page.change({ textScale: { newValue: 127 } });
  await page.get("#apply-import").emit("click");
  assert.equal(page.writes.length, 0);
  assert.equal(page.stored().textScale, 127);
  assert.match(page.get("#import-error").textContent, /Review the updated changes/);
  assert.notEqual(page.get("#import-undo").hidden, false);
  page.get("#undo-import").emit("click");
  assert.equal(page.get("#import-preview-title").textContent, "Review replacement");
});

test("lost import reply after a later edit retains original recovery and preserves that edit", async () => {
  const page = await openSettings({ initial: { textScale: 110 }, async afterWrite(operation, storage) {
    if (operation.type === "replace") {
      await storage.set({ theme: "dark" });
      throw new Error("Reply lost after saving");
    }
  } });
  await page.import({ textScale: 127, lineHeight: 1.73 });
  await page.get("#apply-import").emit("click");
  assert.equal(page.stored().theme, "dark");
  assert.equal(page.get("#import-preview").hidden, true);
  page.get("#undo-import").emit("click");
  await page.get("#apply-import").emit("click");
  assert.equal(page.stored().textScale, 110);
  assert.equal(page.stored().lineHeight, 0);
  assert.equal(page.stored().theme, "dark");
});


test("optimistic pending values cannot confirm an import whose transport fails", async () => {
  let rejectPatch;
  const page = await openSettings({ initial: { textScale: 110 }, allowErrors: true, beforeOperation(operation) {
    if (operation.type === "patch") return new Promise((_, reject) => { rejectPatch = reject; });
    if (operation.type === "replace") throw new Error("Transport lost before writing");
  } });
  await page.import({ textScale: 127 });
  page.get("#text-scale").value = "127";
  page.get("#text-scale").emit("change");
  await tick();
  assert.equal(page.get("#text-scale").value, "127", "pending patch is rendered optimistically");
  await page.get("#apply-import").emit("click");
  assert.equal(page.get("#apply-import").textContent, "Retry import");
  assert.notEqual(page.get("#import-undo").hidden, false);
  assert.equal(page.writes.length, 0);
  rejectPatch(new Error("Pending patch also failed"));
  await tick();
  assert.equal(page.get("#text-scale").value, "110");
});

test("an explicit save rejection never becomes success merely because the target was observed", async () => {
  const page = await openSettings({ initial: { textScale: 110 }, afterWrite() {
    return { ok: false, code: "SAVE_FAILED", message: "Explicit rejection" };
  } });
  await page.import({ textScale: 127 });
  await page.get("#apply-import").emit("click");
  assert.equal(page.get("#apply-import").textContent, "Retry import");
  assert.match(page.get("#import-error").textContent, /Explicit rejection/);
  assert.notEqual(page.get("#import-undo").hidden, false);
});


test("an already stale preview cannot mistake an existing target for a transport-lost import", async () => {
  let attempts = 0;
  const page = await openSettings({ initial: { textScale: 110 }, beforeOperation() {
    attempts++;
    throw new Error("Unknown transport failure");
  } });
  await page.import({ textScale: 127 });
  page.change({ textScale: { newValue: 127 } });
  await page.get("#apply-import").emit("click");
  assert.equal(attempts, 0, "preflight requests a new preview before sending anything");
  assert.match(page.get("#import-error").textContent, /Review the updated changes/);
  assert.notEqual(page.get("#import-undo").hidden, false);
});

test("a stale writer rejection beats an identical target observed during the request", async () => {
  const page = await openSettings({ initial: { textScale: 110 }, async beforeOperation(operation, storage) {
    if (operation.type === "replace") await storage.set({ textScale: 127 });
  } });
  await page.import({ textScale: 127 });
  await page.get("#apply-import").emit("click");
  assert.equal(page.writes.length, 1, "only the independent writer changed storage");
  assert.match(page.get("#import-error").textContent, /Review the updated changes/);
  assert.notEqual(page.get("#import-undo").hidden, false);
});


test("import supersedes failed ordinary intent even for deliberately unchanged imported fields", async () => {
  let fail = true;
  const operations = [];
  const page = await openSettings({ initial: { textScale: 100 }, failWrite: () => fail,
    beforeOperation(operation) { operations.push(structuredClone(operation)); } });
  page.get("#text-scale").value = "120";
  page.get("#text-scale").emit("change");
  await tick();
  assert.equal(page.get("#retry-save").hidden, false);
  fail = false;
  await page.import({ ...globalThis.LexendSettings.normalizeSettings({ textScale: 100 }), theme: "dark" });
  await page.get("#apply-import").emit("click");
  page.get("#retry-save").emit("click");
  await tick();
  assert.equal(page.stored().textScale, 100);
  assert.equal(page.stored().theme, "dark");
  assert.deepEqual(operations.map((operation) => operation.type), ["patch", "replace"]);
  assert.equal(page.get("#retry-save").hidden, true);
});

test("ordinary saves failing after Apply cannot resurrect superseded import intent", async () => {
  let rejectOldSave;
  const operations = [];
  const page = await openSettings({ initial: { textScale: 100 }, beforeOperation(operation) {
    operations.push(structuredClone(operation));
    if (operation.type === "patch") return new Promise((_, reject) => { rejectOldSave = reject; });
  } });
  page.get("#text-scale").value = "120";
  page.get("#text-scale").emit("change");
  await tick();
  await page.import({ ...globalThis.LexendSettings.normalizeSettings({ textScale: 100 }), theme: "dark" });
  await page.get("#apply-import").emit("click");
  rejectOldSave(new Error("Earlier save failed after import"));
  await tick();
  page.get("#retry-save").emit("click");
  await tick();
  assert.equal(page.stored().textScale, 100);
  assert.equal(page.stored().theme, "dark");
  assert.equal(page.get("#retry-save").hidden, true);
  assert.deepEqual(operations.map((operation) => operation.type), ["patch", "replace"]);
});

for (const pending of [false, true]) {
  test(`undo trims only restored fields from ${pending ? "pending" : "failed"} ordinary patches`, async () => {
    let rejectReset;
    let failReset = true;
    const operations = [];
    const initial = globalThis.LexendSettings.normalizeSettings({ textScale: 110, letterSpacing: .08 });
    const page = await openSettings({ initial, beforeOperation(operation) {
      operations.push(structuredClone(operation));
      if (operation.type === "patch" && failReset) {
        if (pending) return new Promise((_, reject) => { rejectReset = reject; });
        throw new Error("Reset could not be saved");
      }
    } });
    await page.import({ ...initial, textScale: 127 });
    await page.get("#apply-import").emit("click");
    page.get("#reset-readability").emit("click");
    await tick();
    page.get("#undo-import").emit("click");
    await page.get("#apply-import").emit("click");
    if (pending) {
      rejectReset(new Error("Reset failed after undo"));
      await tick();
    }
    assert.equal(page.stored().textScale, 110);
    assert.equal(page.stored().letterSpacing, .08);
    assert.equal(page.get("#retry-save").hidden, false, "unrelated reset fields still need recovery");
    failReset = false;
    page.get("#retry-save").emit("click");
    await tick();
    assert.deepEqual(operations.at(-1), { type: "patch", changes: { letterSpacing: 0 }, expected: { letterSpacing: .08 } },
      "Confirmed no-op fields are retired; remaining retry keeps its original guard");
    assert.equal(page.stored().textScale, 110, "Retry cannot restore the superseded text-size reset");
    assert.equal(page.stored().letterSpacing, 0);
  });
}

test("undo preserves an unrelated failed theme intent for ordinary Retry", async () => {
  let failTheme = true;
  const initial = globalThis.LexendSettings.normalizeSettings({ textScale: 110 });
  const page = await openSettings({ initial, beforeOperation(operation) {
    if (operation.type === "patch" && failTheme) throw new Error("Theme save failed");
  } });
  await page.import({ ...initial, textScale: 127 });
  await page.get("#apply-import").emit("click");
  page.get("#dark-theme").checked = true;
  page.get("#dark-theme").emit("change");
  await tick();
  page.get("#undo-import").emit("click");
  await page.get("#apply-import").emit("click");
  assert.equal(page.get("#retry-save").hidden, false);
  failTheme = false;
  page.get("#retry-save").emit("click");
  await tick();
  assert.equal(page.stored().textScale, 110);
  assert.equal(page.stored().theme, "dark");
});

for (const restoresRules of [false, true]) {
  test(`undo ${restoresRules ? "supersedes" : "retains"} failed rule intent when its preview ${restoresRules ? "restores rules" : "only restores a scalar"}`, async () => {
    let failRule = true;
    const operations = [];
    const initial = globalThis.LexendSettings.normalizeSettings({ textScale: 110 });
    const page = await openSettings({ initial, beforeOperation(operation) {
      operations.push(structuredClone(operation));
      if (operation.type === "addRule" && failRule) throw new Error("Rule save failed");
    } });
    await page.import({ ...initial, textScale: 127, siteRules: restoresRules
      ? [{ hostname: "imported.example", enabled: false }] : [] });
    await page.get("#apply-import").emit("click");
    page.get("#new-hostname").value = "unsaved.example";
    await page.get("#add-rule").emit("submit", { preventDefault() {} });
    page.get("#undo-import").emit("click");
    await page.get("#apply-import").emit("click");
    failRule = false;
    page.get("#retry-save").emit("click");
    await tick();
    assert.equal(page.stored().siteRules.some((rule) => rule.hostname === "unsaved.example"), !restoresRules);
    assert.equal(operations.filter((operation) => operation.type === "addRule").length, restoresRules ? 1 : 2);
  });
}

for (const kind of ["import", "undo"]) {
  test(`${kind} failures stay on Apply with the same guarded operation and generic Retry is blocked while busy`, async () => {
    const operationType = kind === "import" ? "replace" : "undoImport";
    const operations = [];
    let rejectApply;
    let failApply = false;
    const initial = globalThis.LexendSettings.normalizeSettings({ textScale: 100 });
    const page = await openSettings({ initial, beforeOperation(operation) {
      operations.push(structuredClone(operation));
      if (operation.type === "patch") throw new Error("Ordinary save failed");
      if (operation.type === operationType && failApply) {
        return new Promise((_, reject) => { rejectApply = reject; });
      }
    } });
    if (kind === "undo") {
      await page.import({ ...initial, textScale: 127 });
      await page.get("#apply-import").emit("click");
    }
    page.get("#text-scale").value = "120";
    page.get("#text-scale").emit("change");
    await tick();
    if (kind === "undo") page.get("#undo-import").emit("click");
    else await page.import({ ...initial, theme: "dark" });
    failApply = true;
    const applying = page.get("#apply-import").emit("click");
    await tick();
    assert.equal(page.get("#retry-save").disabled, true);
    assert.equal(page.get("#save-status").className, "save-status is-saving");
    assert.equal(page.get("#save-status-text").textContent, kind === "undo" ? "Applying undo…" : "Importing settings…");
    const guarded = structuredClone(operations.at(-1));
    const count = operations.length;
    page.get("#retry-save").emit("click");
    await tick();
    assert.equal(operations.length, count, "generic Retry cannot run during Apply");
    rejectApply(new Error("Apply transport failed"));
    await applying;
    assert.equal(page.get("#retry-save").disabled, false);
    assert.equal(page.get("#retry-save").hidden, true, "Apply errors never expose an ordinary Retry");
    assert.equal(page.get("#save-status").className, "save-status is-error");
    assert.match(page.get("#save-status-text").textContent, /was not confirmed/);
    assert.equal(page.get("#apply-import").textContent, kind === "undo" ? "Retry undo" : "Retry import");
    page.get("#retry-save").emit("click");
    await tick();
    assert.equal(operations.length, count, "import and undo failures never enter generic Retry");
    failApply = false;
    await page.get("#apply-import").emit("click");
    assert.deepEqual(operations.at(-1), guarded, "Apply retries the exact operation including its original expected snapshot");
    assert.equal(page.stored().textScale, 100);
    assert.equal(page.get("#save-status").className, "save-status is-saved");
    assert.equal(page.get("#save-status-text").textContent, kind === "undo" ? "Import undone" : "Settings imported");
  });
}


for (const themeSucceeds of [false, true]) {
  test(`an older pending theme ${themeSucceeds ? "success" : "failure"} remains visible after Undo supersedes the newer pending scale`, async () => {
    const initial = globalThis.LexendSettings.normalizeSettings({ textScale: 110 });
    const operations = [];
    let settleTheme;
    let rejectScale;
    let themeStarted = false;
    const page = await openSettings({ initial, beforeOperation(operation) {
      operations.push(structuredClone(operation));
      if (operation.type !== "patch") return;
      if (operation.changes.theme && !themeStarted) {
        themeStarted = true;
        return new Promise((resolve, reject) => { settleTheme = themeSucceeds ? resolve : () => reject(new Error("Earlier theme failed")); });
      }
      if (Object.hasOwn(operation.changes, "textScale")) {
        return new Promise((_, reject) => { rejectScale = reject; });
      }
    } });
    await page.import({ ...initial, textScale: 127 });
    await page.get("#apply-import").emit("click");
    page.get("#dark-theme").checked = true;
    page.get("#dark-theme").emit("change");
    await tick();
    page.get("#text-scale").value = "100";
    page.get("#text-scale").emit("change");
    await tick();
    page.get("#undo-import").emit("click");
    await page.get("#apply-import").emit("click");
    assert.equal(page.stored().textScale, 110);
    assert.equal(page.get("#save-status").className, "save-status is-saving", "the retained theme is still pending");
    settleTheme();
    await tick();
    assert.equal(page.get("#save-status").className, themeSucceeds ? "save-status is-saved" : "save-status is-error");
    assert.equal(page.get("#retry-save").hidden, themeSucceeds);
    if (!themeSucceeds) assert.match(page.get("#save-status-text").textContent, /Earlier theme failed/);
    rejectScale(new Error("Obsolete scale failed later"));
    await tick();
    assert.equal(page.get("#save-status").className, themeSucceeds ? "save-status is-saved" : "save-status is-error");
    assert.doesNotMatch(page.get("#save-status-text").textContent, /Obsolete scale/);
    page.get("#retry-save").emit("click");
    await tick();
    assert.equal(page.stored().theme, "dark");
    assert.equal(page.stored().textScale, 110);
    assert.equal(operations.filter((operation) => operation.type === "patch" && Object.hasOwn(operation.changes, "textScale")).length, 1);
    assert.equal(page.get("#save-status").className, "save-status is-saved");
  });
}

for (const ordinaryState of ["none", "pending", "failed"]) {
  test(`cancel after failed Undo restores the ${ordinaryState} ordinary save state`, async () => {
    const initial = globalThis.LexendSettings.normalizeSettings({ textScale: 110 });
    let finishTheme;
    let failTheme = ordinaryState === "failed";
    const operations = [];
    const page = await openSettings({ initial, beforeOperation(operation) {
      operations.push(structuredClone(operation));
      if (operation.type === "undoImport") throw new Error("Undo transport failed");
      if (operation.type === "patch" && operation.changes.theme) {
        if (failTheme) throw new Error("Unrelated theme still failed");
        if (ordinaryState === "pending") return new Promise((resolve) => { finishTheme = resolve; });
      }
    } });
    await page.import({ ...initial, textScale: 127 });
    await page.get("#apply-import").emit("click");
    if (ordinaryState !== "none") {
      page.get("#dark-theme").checked = true;
      page.get("#dark-theme").emit("change");
      await tick();
    }
    page.get("#undo-import").emit("click");
    await page.get("#apply-import").emit("click");
    assert.equal(page.get("#save-status").className, "save-status is-error");
    if (ordinaryState === "failed") {
      assert.match(page.get("#save-status-text").textContent, /Undo was not confirmed/);
      assert.equal(page.get("#retry-save").hidden, false, "the existing ordinary failure remains accessible");
    } else {
      assert.match(page.get("#save-status-text").textContent, /Undo was not confirmed/);
      assert.equal(page.get("#retry-save").hidden, true);
    }
    page.get("#cancel-import").emit("click");
    assert.equal(page.get("#import-preview").hidden, true);
    assert.equal(page.get("#save-status").className, ordinaryState === "failed" ? "save-status is-error"
      : ordinaryState === "pending" ? "save-status is-saving" : "save-status is-saved");
    assert.doesNotMatch(page.get("#save-status-text").textContent, /Undo|Applying/);
    const count = operations.length;
    if (ordinaryState === "pending") {
      finishTheme();
      await tick();
    } else {
      failTheme = false;
      page.get("#retry-save").emit("click");
      await tick();
      assert.equal(operations.length, count + (ordinaryState === "failed" ? 1 : 0));
    }
    assert.equal(page.get("#save-status").className, "save-status is-saved");
    assert.equal(page.stored().textScale, 127, "failed and cancelled Undo never restored the imported value");
  });
}

test("import retaining a paused rule retires failed removal so generic Retry cannot resume the site", async () => {
  const api = globalThis.LexendSettings;
  const initial = api.normalizeSettings({ siteRules: [{ hostname: "paused.example", enabled: false }] });
  let fail = true;
  const operations = [];
  const page = await openSettings({ initial, failWrite: () => fail,
    beforeOperation(operation) { operations.push(structuredClone(operation)); } });
  const list = page.get("#rule-list");
  list.emit("click", { target: page.rows()[0].children.at(-1) });
  await list.emit("click", { target: page.rows()[0].children.find((child) => child.dataset.action === "confirm") });
  assert.equal(page.get("#retry-save").hidden, false);
  assert.equal(api.resolveSite(page.stored(), "paused.example").active, false);
  await page.import({ ...initial, theme: "dark" });
  assert.equal(operations.length, 1, "Preview does not retire or submit the failed intent");
  fail = false;
  await page.get("#apply-import").emit("click");
  await page.get("#retry-save").emit("click");
  assert.deepEqual(operations.map((operation) => operation.type), ["removeRule", "replace"]);
  assert.equal(page.get("#retry-save").hidden, true);
  assert.equal(page.stored().theme, "dark");
  assert.deepEqual(page.stored().siteRules, initial.siteRules);
  assert.equal(api.resolveSite(page.stored(), "paused.example").active, false);
});

test("250 legacy pauses survive rule editing, complete import and guarded Undo in compact storage", async () => {
  const api = globalThis.LexendSettings;
  const disabledSites = Array.from({ length: 250 }, (_, index) => `legacy${index}.example.com`);
  const page = await openSettings({ desktop: true, initial: { disabledSites } });
  let editor = editorFor(page.rows()[0]);
  editor.fields.scope.value = "all";
  editor.fields.includeSubdomains.value = "true";
  await editor.form.emit("submit", { preventDefault() {} });
  const edited = page.stored();
  assert.equal(edited.siteRules.length, 250);
  assert.equal(api.getDirectRule(edited, disabledSites[0], true).scope, "all");
  assert.match(page.rawStored().siteRules, /^@1\n/);
  assert.ok(Buffer.byteLength("siteRules" + JSON.stringify(page.rawStored().siteRules)) <= 8192);
  const backup = JSON.parse(JSON.stringify({ schemaVersion: 2, settings: edited }));
  assert.deepEqual(api.validateImport(backup), edited);
  await page.import({ ...edited, theme: "dark", textScale: 127 });
  await page.get("#apply-import").emit("click");
  assert.equal(page.stored().textScale, 127);
  page.get("#undo-import").emit("click");
  await page.get("#apply-import").emit("click");
  assert.deepEqual(page.stored(), edited);
  assert.match(page.rawStored().siteRules, /^@1\n/);
  assert.equal(page.rows().length, 250);
});
