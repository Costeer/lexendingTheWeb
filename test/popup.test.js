import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { runInNewContext } from "node:vm";
import test from "node:test";
import { createMemoryStorage, mutationResponse } from "./helpers/memory-storage.js";
import "../src/settings.js";
import "../src/preferences.js";
import "../src/save-recovery.js";

const source = await readFile(new URL("../popup.js", import.meta.url), "utf8");
const tick = () => new Promise((resolve) => setImmediate(resolve));
async function openPopup({ initial = {}, getSettings, failWrite = false, state, url = "https://example.com/article", queryTabs } = {}) {
  class Element {
    style = {}; dataset = {}; attributes = {}; listeners = {}; children = [];
    classList = { toggle() {}, remove() {} };
    addEventListener(name, listener) { this.listeners[name] = listener; }
    setAttribute(name, value) { this.attributes[name] = value; }
    replaceChildren(...children) { this.children = children; }
    emit(name) { return this.listeners[name]?.(); }
    focus() { this.focused = true; }
  }
  const elements = new Map();
  const get = (selector) => { if (!elements.has(selector)) elements.set(selector, new Element()); return elements.get(selector); };
  const scope = ["body", "all"].map((value) => Object.assign(new Element(), { value }));
  const spacing = [0, 0.04, 0.08].map((value) => Object.assign(new Element(), { value: String(value) }));
  const custom = get("#spacing-custom");
  custom.value = "custom";
  custom.dataset.custom = "true";
  spacing.push(custom);
  const memory = createMemoryStorage(initial);
  const storage = { ...memory.storage,
    async get() { return getSettings ? getSettings() : memory.storage.get(); },
    async set(patch) {
      if (failWrite) throw new Error("Storage unavailable");
      await memory.storage.set(patch);
    }
  };
  const store = globalThis.LexendPreferences.createStore(storage);
  const context = {
    document: { documentElement: { dataset: { theme: "light" } }, querySelector: get,
      querySelectorAll: (selector) => selector.includes("scope") ? scope : spacing,
      createElement: () => new Element(), createTextNode: (textContent) => ({ textContent }) },
    browser: {
      storage: { sync: storage, onChanged: memory.onChanged },
      runtime: { sendMessage: ({ operation }) => mutationResponse(() => store.mutate(operation)) },
      tabs: { async query() { return queryTabs ? queryTabs() : [{ id: 42, url }]; }, async sendMessage() {
        if (state === null) throw new Error("No responder");
        return typeof state === "function" ? state() : state ?? { ready: true, healthy: true, pending: false,
          hostname: "example.com", ...globalThis.LexendSettings.resolveSite(memory.saved(), "example.com") };
      } }
    },
    LexendSaveRecovery: globalThis.LexendSaveRecovery, LexendPreferences: globalThis.LexendPreferences, LexendSettings: globalThis.LexendSettings,
    LexendTheme: { apply() {} }, LexendQuotes: { random: () => ({ text: "Preview", author: "Author" }) },
    setTimeout: () => 0, clearTimeout() {}, console: { error() {} }, URL
  };
  runInNewContext(source, context);
  await tick();
  return { get, writes: memory.writes, scope, spacing, stored: () => globalThis.LexendSettings.decodeSettings(memory.saved()) };
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
  assert.equal(page.get("#site-message").textContent, "Lexend is paused everywhere. Turn it on to pause or resume this site.");
  assert.equal(page.get("#retry-page").hidden, true);
  assert.equal(page.writes.length, 0, "Checking the page only reads its confirmed state");
});

test("site toggle is unavailable while the master switch is off and never resumes every site", async () => {
  const page = await openPopup({ initial: { enabled: false, siteRules: [{ hostname: "other.example", enabled: false }] }, state: () => ({
    hostname: "example.com", scope: "body", active: false, ready: true, healthy: true, pending: false
  }) });
  assert.equal(page.get("#toggle-site").disabled, true);
  page.get("#toggle-site").emit("click");
  await tick();
  assert.equal(page.writes.length, 0);
  assert.equal(page.stored().enabled, false);

  page.get("#enabled").checked = true;
  page.get("#enabled").emit("change");
  await tick();
  assert.equal(page.get("#toggle-site").disabled, false, "turning the master switch on re-enables site controls");
});

test("popup identifies independent matching sources beside global controls and removes exact overrides", async () => {
  const page = await openPopup({ initial: { scope: "body", siteRules: [
    { hostname: "example.com", includeSubdomains: true, enabled: false, scope: "all" },
    { hostname: "example.com", includeSubdomains: false, enabled: true, scope: null }
  ] } });
  assert.equal(page.scope.find((input) => input.value === "body").checked, true);
  assert.match(page.get("#site-sources").textContent, /Enabled from example.com \(exact host\)/);
  assert.match(page.get("#site-sources").textContent, /Body and headings from example.com \(including subdomains\)/);
  assert.equal(page.get("#use-inherited-site").hidden, false);
  await page.get("#use-inherited-site").emit("click");
  assert.equal(page.stored().siteRules.length, 1);
  assert.equal(page.stored().siteRules[0].includeSubdomains, true);
  assert.match(page.get("#site-sources").textContent, /Paused from example.com \(including subdomains\)/);
  assert.equal(page.get("#toggle-site").textContent, "Resume here");
  assert.equal(page.get("#use-inherited-site").hidden, true);
});

test("popup Custom spacing is the only selected radio and selecting a preset keeps unrelated settings", async () => {
  const page = await openPopup({ initial: { textScale: 127, lineHeight: 1.73, letterSpacing: .057 } });
  assert.equal(page.get("#spacing-custom").checked, true);
  assert.equal(page.get("#spacing-custom-choice").hidden, false);
  assert.equal(page.get("#spacing-custom-label").textContent, "Custom · 0.057em");
  assert.equal(page.spacing.filter((input) => input.checked).length, 1);
  page.spacing.find((input) => input.value === "0.04").emit("change");
  await tick();
  assert.equal(page.get("#spacing-custom-choice").hidden, true);
  assert.equal(page.stored().letterSpacing, .04);
  assert.equal(page.stored().textScale, 127);
  assert.equal(page.stored().lineHeight, 1.73);
});

test("popup explains the global Off switch even with an enabled matching rule", async () => {
  const page = await openPopup({ initial: { enabled: false, siteRules: [{ hostname: "example.com", enabled: true }] } });
  assert.equal(page.get("#site-status-text").textContent, "Off");
  assert.match(page.get("#site-sources").textContent, /Site preference: Enabled/);
  assert.match(page.get("#site-sources").textContent, /global Off switch takes priority/);
  assert.match(page.get("#enabled").attributes["aria-label"], /everywhere/);
});

test("scope-only preferences never expose stale source actions for a missing or pending page", async () => {
  for (const state of [null, { ready: false, pending: true, hostname: "example.com" }]) {
    const page = await openPopup({ initial: { siteRules: [{ hostname: "example.com", scope: "all" }] }, state });
    assert.equal(page.get("#site-sources").hidden, true);
    assert.equal(page.get("#use-inherited-site").hidden, true);
    assert.equal(page.get("#use-inherited-site").disabled, true);
    await page.get("#use-inherited-site").emit("click");
    assert.equal(page.writes.length, 0);
    assert.notEqual(page.get("#site-status-text").children[0]?.textContent, "Active on ");
  }
});

test("popup layout opt-in preserves activation and scope and survives reopening", async () => {
  const initial = { enabled: false, siteRules: [{ hostname: "example.com", enabled: false, scope: "all" }] };
  const page = await openPopup({ initial });
  const control = page.get("#site-layout-repair");
  assert.equal(control.disabled, false);
  control.checked = true;
  control.emit("change");
  await tick();
  const saved = page.stored();
  assert.equal(saved.enabled, false);
  assert.deepEqual(saved.siteRules[0], { hostname: "example.com", includeSubdomains: false, enabled: false, scope: "all", layoutRepair: true });
  const reopened = await openPopup({ initial: saved });
  assert.equal(reopened.get("#site-layout-repair").checked, true);
  assert.equal(reopened.get("#site-layout-repair").disabled, false);
});

test("global layout repair disables the popup override without creating site rules", async () => {
  const page = await openPopup({ initial: { layoutRepair: true } });
  assert.equal(page.get("#site-layout-repair").checked, true);
  assert.equal(page.get("#site-layout-repair").disabled, true);
  assert.equal(page.get("#site-layout-repair-help").textContent, "Enabled on all sites in Settings");
  page.get("#site-layout-repair").checked = false;
  page.get("#site-layout-repair").emit("change");
  await tick();
  assert.equal(page.writes.length, 0);
  assert.deepEqual(page.stored().siteRules, []);
});

test("popup can opt out of inherited repair using an independent exact rule", async () => {
  const page = await openPopup({ initial: { siteRules: [{ hostname: "example.com", includeSubdomains: true, layoutRepair: true }] } });
  assert.equal(page.get("#site-layout-repair").checked, true);
  page.get("#site-layout-repair").checked = false;
  page.get("#site-layout-repair").emit("change");
  await tick();
  assert.deepEqual(globalThis.LexendSettings.getDirectRule(page.stored(), "example.com"), {
    hostname: "example.com", includeSubdomains: false, enabled: null, scope: null, layoutRepair: false
  });
});
