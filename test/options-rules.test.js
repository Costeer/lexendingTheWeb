import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { runInNewContext } from "node:vm";
import test from "node:test";
import "../src/settings.js";

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
    this.classList = { add() {}, remove() {} };
  }
  append(...children) {
    children.forEach((child) => { child.parent = this; });
    this.children.push(...children);
  }
  replaceChildren(...children) { this.children = []; this.append(...children); }
  setAttribute(name, value) { this.attributes.set(name, value); }
  getAttribute(name) { return this.attributes.get(name); }
  removeAttribute(name) { this.attributes.delete(name); }
  addEventListener(name, listener) { this.listeners.set(name, listener); }
  emit(name, event = {}) { return this.listeners.get(name)?.(event); }
  closest(selector) {
    if (this.className.split(" ").includes(selector.slice(1))) return this;
    return this.parent?.closest(selector);
  }
  focus() {}
}

async function openSettings({ count = 6, desktop = false, cachedTheme = "light", getSettings } = {}) {
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
    basicLetterSpacing: [0, 0.04, 0.08]
  }).map(([name, values]) => [
    `input[name="${name}"]`,
    values.map((value) => Object.assign(new Element(), { value: String(value) }))
  ]));
  const media = { matches: desktop, addEventListener(name, listener) { this.listener = listener; } };
  const writes = [];
  const errors = [];
  const root = { dataset: {} };
  const cache = new Map([["lexend-ui-theme", cachedTheme]]);
  const context = {
    document: {
      documentElement: root,
      querySelector: get,
      querySelectorAll(selector) {
        if (selector === ".settings-panel") return panels;
        if (selector === "[data-settings-panel]") return navigation;
        return inputs.get(selector) ?? [];
      },
      createElement: () => new Element()
    },
    localStorage: {
      getItem: (key) => cache.get(key) ?? null,
      setItem: (key, value) => cache.set(key, value)
    },
    LexendSettings: globalThis.LexendSettings,
    LexendQuotes: { random: () => ({ text: "Preview", author: "Author", lang: "en", url: "https://example.com" }) },
    browser: { storage: {
      sync: {
        async get() {
          if (getSettings) return getSettings();
          return { siteRules: Array.from({ length: count }, (_, index) => ({
            hostname: `site${index + 1}.example.com`, includeSubdomains: false, enabled: false
          })) };
        },
        async set(settings) { writes.push(settings); },
        async remove() {}
      },
      onChanged: { addListener() {} }
    } },
    matchMedia: (query) => query.includes("min-width") ? media : { matches: false },
    location: { search: "" },
    URLSearchParams,
    URL,
    console: { error(...args) { errors.push(args); } }
  };
  runInNewContext(themeSource, context);
  runInNewContext(source, context);
  await tick();
  assert.deepEqual(errors, []);
  return {
    get, writes, panels, navigation, root, cache, inputs,
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

test("readability presets select only exact saved values, never the nearest choice", async () => {
  for (const settings of [
    { textScale: 100, lineHeight: 0, letterSpacing: 0 },
    { textScale: 110, lineHeight: 1.5, letterSpacing: 0.04 },
    { textScale: 120, lineHeight: 2, letterSpacing: 0.08 },
    { textScale: 105, lineHeight: 1.6, letterSpacing: 0.045 }
  ]) {
    const page = await openSettings({ getSettings: async () => settings });
    for (const [name, key] of [["basicTextScale", "textScale"], ["basicLineHeight", "lineHeight"], ["basicLetterSpacing", "letterSpacing"]]) {
      const selected = page.inputs.get(`input[name="${name}"]`).filter((input) => input.checked);
      const expected = [105, 1.6, 0.045].includes(settings[key]) ? [] : [String(settings[key])];
      assert.deepEqual(selected.map((input) => input.value), expected);
    }
  }
});

test("custom slider values clear the preset selection and choosing a preset restores it", async () => {
  const page = await openSettings();
  const controls = [
    ["#text-scale", "basicTextScale", "105", "110", "textScale", 105],
    ["#line-height", "basicLineHeight", "13", "1.5", "lineHeight", 1.6],
    ["#letter-spacing", "basicLetterSpacing", "0.045", "0.04", "letterSpacing", 0.045]
  ];
  for (const [selector, name, custom, preset, key, value] of controls) {
    const slider = page.get(selector);
    slider.value = custom;
    slider.emit("change");
    const inputs = page.inputs.get(`input[name="${name}"]`);
    assert.equal(inputs.some((input) => input.checked), false, `${name} has no selected preset for ${value}`);
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
  await tick();
  assert.deepEqual(page.rows().map((row) => row.dataset.hostname), ["site2.example.com", "site3.example.com"]);
  assert.equal(page.get("#toggle-rule-list").hidden, true);
  assert.equal(page.writes.at(-1).siteRules.length, 2);
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
