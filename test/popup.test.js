import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { runInNewContext } from "node:vm";
import test from "node:test";
import "../src/settings.js";
import "../src/preferences.js";
import "../src/save-recovery.js";

const source = await readFile(new URL("../popup.js", import.meta.url), "utf8");
const tick = () => new Promise((resolve) => setImmediate(resolve));
async function openPopup({ initial = {}, getSettings, failWrite = false, state, url = "https://example.com/article", queryTabs } = {}) {
  class Element {
    style = {}; attributes = {}; listeners = {}; children = [];
    classList = { toggle() {}, remove() {} };
    addEventListener(name, listener) { this.listeners[name] = listener; }
    setAttribute(name, value) { this.attributes[name] = value; }
    replaceChildren(...children) { this.children = children; }
    emit(name) { return this.listeners[name]?.(); }
  }
  const elements = new Map();
  const get = (selector) => { if (!elements.has(selector)) elements.set(selector, new Element()); return elements.get(selector); };
  const scope = ["body", "all"].map((value) => Object.assign(new Element(), { value }));
  const spacing = [0, 0.04, 0.08].map((value) => Object.assign(new Element(), { value: String(value) }));
  let stored = structuredClone(initial);
  let listener;
  const writes = [];
  const storage = {
    async get() { return getSettings ? getSettings() : stored; },
    async set(patch) {
      if (failWrite) throw new Error("Storage unavailable");
      stored = { ...stored, ...patch }; writes.push(patch);
      listener(Object.fromEntries(Object.entries(patch).map(([key, newValue]) => [key, { newValue }])), "sync");
    },
    async remove() {}
  };
  const store = globalThis.LexendPreferences.createStore(storage);
  const context = {
    document: { documentElement: { dataset: { theme: "light" } }, querySelector: get,
      querySelectorAll: (selector) => selector.includes("scope") ? scope : spacing,
      createElement: () => new Element(), createTextNode: (textContent) => ({ textContent }) },
    browser: {
      storage: { sync: storage, onChanged: { addListener(callback) { listener = callback; } } },
      runtime: { async sendMessage({ operation }) {
        try { return { ok: true, settings: await store.mutate(operation) }; }
        catch (error) { return { ok: false, code: error.code, message: error.message }; }
      } },
      tabs: { async query() { return queryTabs ? queryTabs() : [{ id: 42, url }]; }, async sendMessage() {
        if (state === null) throw new Error("No responder");
        return typeof state === "function" ? state() : state ?? { ready: true, healthy: true, pending: false,
          hostname: "example.com", ...globalThis.LexendSettings.resolveSite(stored, "example.com") };
      } }
    },
    LexendSaveRecovery: globalThis.LexendSaveRecovery, LexendPreferences: globalThis.LexendPreferences, LexendSettings: globalThis.LexendSettings,
    LexendTheme: { apply() {} }, LexendQuotes: { random: () => ({ text: "Preview", author: "Author" }) },
    setTimeout: () => 0, clearTimeout() {}, console: { error() {} }, URL
  };
  runInNewContext(source, context);
  await tick();
  return { get, writes, scope, spacing, stored: () => globalThis.LexendSettings.decodeSettings(stored) };
}

test("popup load failures disable changes and retry the read without writing defaults", async () => {
  let reads = 0;
  const page = await openPopup({ getSettings: async () => {
    if (++reads === 1) throw new Error("Read failed");
    return { enabled: false, siteRules: [{ hostname: "saved.example", enabled: false }] };
  } });
  assert.equal(page.get("#enabled").disabled, true);
  page.get("#enabled").emit("change");
  assert.equal(page.writes.length, 0);
  await page.get("#retry-load").emit("click");
  assert.equal(page.get("#enabled").disabled, false);
  assert.equal(page.get("#enabled").checked, false);
  assert.equal(page.writes.length, 0);
});

test("popup save failures restore the saved value and expose the error", async () => {
  const page = await openPopup({ initial: { enabled: true }, failWrite: true });
  page.get("#enabled").checked = false;
  page.get("#enabled").emit("change");
  await tick();
  assert.equal(page.get("#enabled").checked, true);
  assert.match(page.get("#popup-feedback").textContent, /Storage unavailable/);
});

test("a full rule list reports a failed pause and preserves every rule", async () => {
  const rules = Array.from({ length: 250 }, (_, index) => ({ hostname: `site${index}.example.com`, enabled: false }));
  const page = await openPopup({ initial: { siteRules: rules } });
  page.get("#toggle-site").emit("click");
  await tick();
  assert.match(page.get("#popup-feedback").textContent, /room/);
  assert.equal(page.writes.length, 0);
  assert.equal(page.stored().siteRules.length, 250);
  assert.equal(page.get("#toggle-site").textContent, "Pause here");
});


test("ordinary pages without a content responder never claim Active or browser restriction", async () => {
  const page = await openPopup({ state: null });
  assert.equal(page.get("#site-strip").hidden, false);
  assert.equal(page.get("#site-status-text").textContent, "Page unavailable");
  assert.match(page.get("#site-message").textContent, /allow Lexend access/);
  assert.equal(page.get("#restricted-note").hidden, true);
  assert.equal(page.get("#retry-page").hidden, false);
  assert.equal(page.get("#toggle-site").disabled, true);
});

test("unready, unhealthy and pending responders cannot claim Active", async () => {
  for (const flags of [{ ready: false, pending: true }, { healthy: false, error: "Repair failed" },
    { pending: true }, { ready: false, error: "SETTINGS_LOAD_FAILED" }]) {
    const page = await openPopup({ state: { ready: true, healthy: true, pending: false, active: true,
      hostname: "example.com", scope: "body", ...flags } });
    assert.equal(page.get("#toggle-site").disabled, true);
    assert.notEqual(page.get("#site-status-text").children?.[0]?.textContent, "Active on ");
    assert.equal(page.get("#retry-page").hidden, false);
    assert.equal(page.get("#restricted-note").hidden, true);
  }
});

test("page retry confirms a healthy settled response and restrictions remain distinct", async () => {
  let ready = false;
  const page = await openPopup({ state: () => ({ hostname: "example.com", scope: "body", active: true,
    healthy: true, ready, pending: !ready }) });
  ready = true;
  await page.get("#retry-page").emit("click");
  assert.equal(page.get("#site-status-text").children[0].textContent, "Active on ");
  assert.equal(page.get("#retry-page").hidden, true);
  assert.equal(page.get("#toggle-site").disabled, false);
  for (const url of ["chrome://settings", "https://addons.mozilla.org/addon"]) {
    const restricted = await openPopup({ url, state: null });
    assert.equal(restricted.get("#restricted-note").hidden, false);
    assert.equal(restricted.get("#site-strip").hidden, true);
  }
});


test("missing tab URL and responder still show actionable page guidance", async () => {
  const page = await openPopup({ url: "", state: null });
  assert.equal(page.get("#site-status-text").textContent, "Page unavailable");
  assert.equal(page.get("#site-strip").hidden, false);
  assert.equal(page.get("#restricted-note").hidden, true);
  assert.match(page.get("#site-message").textContent, /Reload this page/);
});


test("absent tabs and failed tab queries show recovery guidance", async () => {
  for (const queryTabs of [async () => [], async () => { throw new Error("Tabs unavailable"); }]) {
    const page = await openPopup({ queryTabs });
    assert.equal(page.get("#site-strip").hidden, false);
    assert.equal(page.get("#site-status-text").textContent, "Page unavailable");
    assert.match(page.get("#site-message").textContent, /Open a website/);
    assert.equal(page.get("#restricted-note").hidden, true);
  }
});


test("global pause waits for the page to confirm before claiming it is off", async () => {
  let active = true;
  const page = await openPopup({ initial: { enabled: false }, state: () => ({
    hostname: "example.com", scope: "body", active, ready: true, healthy: true, pending: false
  }) });
  assert.equal(page.get("#enabled").checked, false);
  assert.equal(page.get("#master-state").textContent, "Off");
  assert.equal(page.get("#site-status-text").children[0].textContent, "Updating on ");
  assert.equal(page.get("#site-message").textContent, "Waiting for this page to apply your settings.");
  assert.equal(page.get("#retry-page").hidden, false);

  active = false;
  await page.get("#retry-page").emit("click");
  assert.equal(page.get("#master-state").textContent, "Off");
  assert.equal(page.get("#site-status-text").textContent, "Off");
  assert.equal(page.get("#site-message").textContent, "Lexend is paused everywhere.");
  assert.equal(page.get("#retry-page").hidden, true);
  assert.equal(page.writes.length, 0, "Checking the page only reads its confirmed state");
});
