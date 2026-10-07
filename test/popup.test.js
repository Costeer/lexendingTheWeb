import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { runInNewContext } from "node:vm";
import test from "node:test";
import "../src/settings.js";
import "../src/preferences.js";

const source = await readFile(new URL("../popup.js", import.meta.url), "utf8");
const tick = () => new Promise((resolve) => setImmediate(resolve));
async function openPopup({ initial = {}, getSettings, failWrite = false } = {}) {
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
      tabs: { async query() { return [{ id: 42 }]; }, async sendMessage() { return { ready: true, hostname: "example.com" }; } }
    },
    LexendPreferences: globalThis.LexendPreferences, LexendSettings: globalThis.LexendSettings,
    LexendTheme: { apply() {} }, LexendQuotes: { random: () => ({ text: "Preview", author: "Author" }) },
    setTimeout: () => 0, clearTimeout() {}, console: { error() {} }, URL
  };
  runInNewContext(source, context);
  await tick();
  return { get, writes, scope, spacing, stored: () => stored };
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
