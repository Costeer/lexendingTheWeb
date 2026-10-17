import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import test from "node:test";
import { runInNewContext } from "node:vm";
import "../src/settings.js";
import "../src/preferences.js";

const api = globalThis.LexendSettings;
const preferences = globalThis.LexendPreferences;
const oldFixture = JSON.parse(await readFile(new URL("../scripts/fixtures/rule-format-v0.5.0.json", import.meta.url), "utf8"));
const oldSources = [oldFixture.files["src/settings.js"].source, oldFixture.files["src/preferences.js"].source];
const oldApi = (() => {
  const context = { URL, TextEncoder };
  oldSources.forEach((source) => runInNewContext(source, context));
  return { settings: context.LexendSettings, preferences: context.LexendPreferences };
})();
const fixture = (initial = {}, { quota = false, silentWrites = false } = {}) => {
  let saved = structuredClone(initial);
  let failRead = false;
  let failWrite = false;
  let failCleanup = false;
  const listeners = [];
  const writes = [];
  const storage = {
    async get() { if (failRead) throw new Error("Read failed"); return structuredClone(saved); },
    async set(patch) {
      if (failWrite) throw new Error("Write failed");
      if (quota && Object.entries(patch).some(([key, value]) => Buffer.byteLength(key + JSON.stringify(value)) > 8192)) {
        throw new Error("QUOTA_BYTES_PER_ITEM quota exceeded");
      }
      const changes = Object.fromEntries(Object.entries(patch).map(([key, newValue]) => [key, { oldValue: saved[key], newValue }]));
      saved = { ...saved, ...structuredClone(patch) };
      writes.push(structuredClone(patch));
      if (!silentWrites) listeners.forEach((listener) => listener(changes, "sync"));
    },
    async remove(keys) {
      if (failCleanup) throw new Error("Cleanup interrupted");
      const changes = {};
      for (const key of keys) {
        if (Object.hasOwn(saved, key)) changes[key] = { oldValue: saved[key] };
        delete saved[key];
      }
      if (!silentWrites && Object.keys(changes).length) listeners.forEach((listener) => listener(changes, "sync"));
    }
  };
  const store = preferences.createStore(storage);
  const extension = {
    storage: { sync: storage, onChanged: { addListener(listener) { listeners.push(listener); } } },
    runtime: { async sendMessage({ operation }) {
      try { return { ok: true, settings: await store.mutate(operation) }; }
      catch (error) { return { ok: false, code: error.code, message: error.message }; }
    } }
  };
  return { store, extension, storage, writes, saved: () => saved,
    failRead(value) { failRead = value; }, failWrite(value) { failWrite = value; },
    failCleanup(value) { failCleanup = value; },
    emit(changes) { listeners.forEach((listener) => listener(changes, "sync")); } };
};

test("old-reader controls retain the exact published and audit-baseline source identities", () => {
  assert.equal(oldFixture.revision, "f2670e24aa210b80f6baedfcf09d22a5dd91e640");
  for (const [path, expected] of [
    ["src/settings.js", "c272dc5e054fb24f8aa388df822891d386086fea79c73e14ad5b6acd01916a9b"],
    ["src/preferences.js", "c75df627491bf9ef18e78e7e0276e2ea807cd2da9ed74f4732784f783ff1cb65"]
  ]) {
    assert.equal(oldFixture.files[path].sha256, expected);
    assert.equal(createHash("sha256").update(oldFixture.files[path].source).digest("hex"), expected);
  }
});

test("default rule writes remain readable by the actual old reader and survive its unrelated writes", async () => {
  const rules = api.normalizeSettings({ siteRules: [
    { hostname: "paused.example", includeSubdomains: true, enabled: false, scope: "all" },
    { hostname: "live.paused.example", enabled: true, scope: "body" },
    { hostname: "scoped.example", enabled: null, scope: "all" }
  ] }).siteRules;
  const f = fixture({}, { quota: true });
  await f.store.mutate({ type: "replace", settings: { ...api.defaults, siteRules: rules } });
  assert.ok(Array.isArray(f.saved().siteRules));
  assert.deepEqual({ ...JSON.parse(JSON.stringify(oldApi.settings.normalizeSettings(f.saved()))), layoutRepair: false }, api.decodeSettings(f.saved()));
  await oldApi.preferences.createStore(f.storage).mutate({ type: "patch", changes: { theme: "dark" } });
  assert.deepEqual(api.decodeSettings(f.saved()).siteRules, rules);
  await oldApi.preferences.createStore(f.storage).mutate({ type: "addRule", rule: { hostname: "added.example", enabled: false } });
  assert.deepEqual(api.decodeSettings(f.saved()).siteRules.slice(0, 3), rules);
  await f.store.mutate({ type: "patch", changes: { textScale: 127 } });
  assert.ok(Array.isArray(f.saved().siteRules));
  assert.equal(api.getDirectRule(f.saved(), "added.example").enabled, false);
});

test("actual old compact reader and writer demonstrate the unsafe encoding negative control", async () => {
  const f = fixture(api.encodeSettings({ siteRules: [{ hostname: "paused.example", enabled: false }] }));
  assert.equal(api.decodeSettings(f.saved()).siteRules.length, 1);
  assert.equal(oldApi.settings.normalizeSettings(f.saved()).siteRules.length, 0);
  await oldApi.preferences.createStore(f.storage).mutate({ type: "patch", changes: { theme: "dark" } });
  assert.deepEqual(f.saved().siteRules, []);
  assert.equal(api.decodeSettings(f.saved()).siteRules.length, 0, "the real old writer destroys compact rules after an unrelated edit");
});

test("scalar and rule no-ops retain raw array and legacy representations byte for byte", async () => {
  for (const initial of [
    { ...api.normalizeSettings({}), siteRules: [{ hostname: "saved.example", enabled: false }] },
    { disabledSites: [" Saved.Example. "], spacing: "wide" }
  ]) {
    const f = fixture(initial, { quota: true });
    const key = Object.hasOwn(initial, "siteRules") ? "siteRules" : "disabledSites";
    await f.store.mutate({ type: "patch", changes: { theme: "light" } });
    await f.store.mutate({ type: "removeRule", hostname: "absent.example" });
    await f.store.mutate({ type: "replace", settings: api.decodeSettings(f.saved()) });
    assert.deepEqual(f.saved()[key], initial[key]);
    assert.ok(f.writes.every((patch) => !Object.hasOwn(patch, "siteRules") && !Object.hasOwn(patch, "disabledSites")));
    if (key === "disabledSites") assert.equal(Object.hasOwn(f.saved(), "siteRules"), false);
  }
});

test("large legacy pause edits stay compatible and rich changes reject before any write or cleanup", async () => {
  const disabledSites = Array.from({ length: 250 }, (_, i) => `s${i}.legacy.example`);
  const f = fixture({ disabledSites, enabled: false, spacing: "wide" }, { quota: true });
  const initial = structuredClone(f.saved());
  for (const operation of [
    { type: "updateRule", hostname: disabledSites[0], includeSubdomains: false, changes: { scope: "all" } },
    { type: "replace", settings: api.normalizeSettings({ ...initial, siteRules: api.decodeSettings(initial).siteRules.map((rule, i) =>
      i === 0 ? { ...rule, includeSubdomains: true } : rule) }) }
  ]) {
    await assert.rejects(f.store.mutate(operation), { code: "RULE_CAPACITY" });
    assert.deepEqual(f.saved(), initial);
    assert.equal(f.writes.length, 0);
  }
  await f.store.mutate({ type: "toggleSite", hostname: disabledSites[0] });
  assert.equal(f.saved().enabled, true);
  assert.equal(f.saved().disabledSites.length, 249);
  assert.equal(Object.hasOwn(f.saved(), "siteRules"), false);
  assert.deepEqual({ ...JSON.parse(JSON.stringify(oldApi.settings.normalizeSettings(f.saved()))), layoutRepair: false }, api.decodeSettings(f.saved()));
  await f.store.mutate({ type: "replace", settings: api.normalizeSettings({ disabledSites, theme: "dark" }) });
  assert.deepEqual(f.saved().disabledSites, disabledSites);
});

test("fresh profiles reject compact-only import capacity without altering their previous configuration", async () => {
  const initial = api.normalizeSettings({ theme: "dark", siteRules: [{ hostname: "saved.example", enabled: false }] });
  const f = fixture(initial, { quota: true });
  const imported = api.normalizeSettings({ siteRules: Array.from({ length: 250 }, (_, i) =>
    ({ hostname: `s${i}.example`, enabled: false, scope: "all", includeSubdomains: true })) });
  assert.ok(api.ruleStorageBytes(imported) < 8192);
  assert.ok(api.storedRuleBytes(api.encodeSettingsForStorage(imported, initial)) > 8192);
  await assert.rejects(f.store.mutate({ type: "replace", settings: imported }), { code: "RULE_CAPACITY" });
  assert.deepEqual(f.saved(), initial);
  assert.equal(f.writes.length, 0);
});

test("existing compact profiles retain lossless full-capacity writes without forced expansion", async () => {
  const initial = api.normalizeSettings({ siteRules: Array.from({ length: 250 }, (_, i) =>
    ({ hostname: `s${i}.example`, enabled: false, includeSubdomains: true, scope: "all" })) });
  const f = fixture(api.encodeSettings(initial), { quota: true });
  await f.store.mutate({ type: "updateRule", hostname: "s0.example", includeSubdomains: true, changes: { scope: "body" } });
  await f.store.mutate({ type: "replace", settings: { ...initial, textScale: 127 } });
  assert.match(f.saved().siteRules, /^@1\n/);
  assert.deepEqual(api.decodeSettings(f.saved()), { ...initial, textScale: 127 });
});

test("successful responses without storage events retain legacy authority for later pause updates", async () => {
  const f = fixture({ disabledSites: ["before.example"], spacing: "wide" }, { silentWrites: true });
  const client = preferences.createClient(f.extension);
  await client.load();
  await client.mutate({ type: "patch", changes: { theme: "dark" } });
  f.emit({ disabledSites: { newValue: ["after.example"] } });
  assert.deepEqual(client.settings.siteRules.map((rule) => rule.hostname), ["after.example"]);
  assert.equal(client.settings.theme, "dark");
  assert.equal(client.settings.letterSpacing, .04);
});

test("a no-event success rereads actual legacy cleanup and retains fallback only when cleanup failed", async () => {
  for (const cleanupFailed of [false, true]) {
    const f = fixture({ disabledSites: ["before.example"] }, { silentWrites: true });
    f.failCleanup(cleanupFailed);
    const client = preferences.createClient(f.extension);
    await client.load();
    await client.mutate({ type: "updateRule", hostname: "before.example", includeSubdomains: false,
      changes: { includeSubdomains: true } });
    assert.ok(Array.isArray(f.saved().siteRules));
    f.emit({ siteRules: { oldValue: f.saved().siteRules } });
    assert.deepEqual(client.settings.siteRules.map((rule) => rule.hostname), cleanupFailed ? ["before.example"] : []);
  }
});

test("a storage event during a response reread wins over the older raw read", async () => {
  const f = fixture({ disabledSites: ["before.example"] }, { silentWrites: true });
  const client = preferences.createClient(f.extension);
  await client.load();
  let finishRead;
  f.storage.get = () => new Promise((resolve) => { finishRead = resolve; });
  f.extension.runtime.sendMessage = async () => ({ ok: true, settings: api.normalizeSettings({ disabledSites: ["before.example"], theme: "dark" }) });
  const save = client.mutate({ type: "patch", changes: { theme: "dark" } });
  await new Promise((resolve) => setImmediate(resolve));
  f.emit({ theme: { newValue: "dark" }, disabledSites: { newValue: ["newer.example"] } });
  finishRead({ disabledSites: ["before.example"], theme: "light" });
  await save;
  assert.deepEqual(client.settings.siteRules.map((rule) => rule.hostname), ["newer.example"]);
  assert.equal(client.settings.theme, "dark");
});

test("failed response rereads preserve the committed save and block writes until storage is readable", async () => {
  const f = fixture({ disabledSites: ["before.example"] }, { silentWrites: true });
  const client = preferences.createClient(f.extension);
  await client.load();
  const send = f.extension.runtime.sendMessage;
  f.extension.runtime.sendMessage = async (message) => {
    const response = await send(message);
    f.failRead(true);
    return response;
  };
  const result = await client.mutate({ type: "patch", changes: { theme: "dark" } });
  assert.equal(result.theme, "dark");
  assert.equal(f.saved().theme, "dark");
  assert.equal(client.settings.theme, "dark");
  assert.equal(client.loaded, false);
  assert.match(client.readError.message, /Read failed/);
  await assert.rejects(client.mutate({ type: "patch", changes: { textScale: 120 } }), { code: "NOT_LOADED" });
  f.failRead(false);
  await client.load();
  assert.equal(client.loaded, true);
  assert.equal(client.readError, null);
  assert.equal(client.settings.theme, "dark");
});

test("a newer explicit load wins over an older successful response reread", async () => {
  const f = fixture({ disabledSites: ["before.example"] }, { silentWrites: true });
  const client = preferences.createClient(f.extension);
  await client.load();
  let finishRead;
  f.storage.get = () => new Promise((resolve) => { finishRead = resolve; });
  f.extension.runtime.sendMessage = async () => ({ ok: true, settings: api.normalizeSettings({ disabledSites: ["before.example"], theme: "dark" }) });
  const save = client.mutate({ type: "patch", changes: { theme: "dark" } });
  await new Promise((resolve) => setImmediate(resolve));
  const finishOlderRead = finishRead;
  f.storage.get = async () => ({ disabledSites: ["loaded.example"], theme: "light" });
  await client.load();
  finishOlderRead({ disabledSites: ["before.example"], theme: "dark" });
  await save;
  assert.deepEqual(client.settings.siteRules.map((rule) => rule.hostname), ["loaded.example"]);
  assert.equal(client.settings.theme, "light");
  assert.equal(client.loaded, true);
});

test("a newer successful response reread wins when an older raw reread is delayed", async () => {
  const f = fixture({ disabledSites: ["before.example"], theme: "light", textScale: 100 }, { silentWrites: true });
  const client = preferences.createClient(f.extension);
  await client.load();
  const get = f.storage.get;
  let finishOlderRead;
  let reads = 0;
  f.storage.get = async () => {
    const snapshot = await get();
    if (++reads === 2) return new Promise((resolve) => { finishOlderRead = () => resolve(snapshot); });
    return snapshot;
  };
  const first = client.mutate({ type: "patch", changes: { theme: "dark" } });
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(typeof finishOlderRead, "function", "hold the first response reread after its real save");
  await client.mutate({ type: "patch", changes: { textScale: 127 } });
  finishOlderRead();
  await first;
  assert.equal(client.settings.theme, "dark");
  assert.equal(client.settings.textScale, 127);
  assert.deepEqual(client.confirmedSettings, api.decodeSettings(f.saved()));
});

test("compatible arrays enforce the exact selected-item byte boundary before a write", async () => {
  const rules = [];
  while (true) {
    const candidate = { hostname: `s${rules.length}.e`, enabled: false };
    if (api.storedRuleBytes(api.encodeSettingsForStorage({ siteRules: [...rules, candidate] })) > 8192) break;
    rules.push(candidate);
  }
  const remaining = 8192 - api.storedRuleBytes(api.encodeSettingsForStorage({ siteRules: rules }));
  const hostname = (length) => {
    const body = length - 3;
    return "s0." + (body <= 63 ? "a".repeat(body) : "a".repeat(60) + "." + "b".repeat(body - 61));
  };
  rules[0].hostname = hostname(rules[0].hostname.length + remaining);
  const full = api.normalizeSettings({ siteRules: rules });
  assert.equal(api.storedRuleBytes(api.encodeSettingsForStorage(full)), 8192);
  const f = fixture({ siteRules: [] }, { quota: true });
  await f.store.mutate({ type: "replace", settings: full });
  const snapshot = structuredClone(f.saved());
  const larger = structuredClone(full);
  larger.siteRules[0].hostname = hostname(full.siteRules[0].hostname.length + 1);
  assert.equal(api.storedRuleBytes(api.encodeSettingsForStorage(larger, snapshot)), 8193);
  await assert.rejects(f.store.mutate({ type: "replace", settings: larger }), { code: "RULE_CAPACITY" });
  assert.deepEqual(f.saved(), snapshot);
  assert.equal(f.writes.length, 1);
});

test("unsafe reductions of an existing oversized array reject while unrelated edits preserve its raw bytes", async () => {
  const siteRules = Array.from({ length: 250 }, (_, i) => ({ hostname: `s${i}.example`, enabled: false }));
  const f = fixture({ siteRules }, { quota: true });
  await f.store.mutate({ type: "patch", changes: { theme: "dark" } });
  const snapshot = structuredClone(f.saved());
  assert.deepEqual(snapshot.siteRules, siteRules);
  await assert.rejects(f.store.mutate({ type: "removeRule", hostname: "s0.example" }), { code: "RULE_CAPACITY" });
  assert.deepEqual(f.saved(), snapshot);
  assert.ok(f.writes.every((patch) => !Object.hasOwn(patch, "siteRules")));
});

test("failed initialization and attempted early mutations never write defaults", async () => {
  const f = fixture({ enabled: false, theme: "dark", siteRules: [{ hostname: "saved.example", enabled: false }] });
  const client = preferences.createClient(f.extension);
  f.failRead(true);
  await assert.rejects(client.load(), /Read failed/);
  assert.equal(client.loaded, false);
  await assert.rejects(client.mutate({ type: "patch", changes: { enabled: true } }), { code: "NOT_LOADED" });
  assert.equal(f.writes.length, 0);
  f.failRead(false);
  await client.load();
  assert.equal(client.settings.enabled, false);
  assert.equal(client.settings.siteRules.length, 1);
  assert.equal(f.writes.length, 0);
});

test("simultaneous clients preserve unrelated preferences and rule mutations", async () => {
  const f = fixture({ siteRules: [{ hostname: "remove.example", enabled: false }] });
  const first = preferences.createClient(f.extension);
  const second = preferences.createClient(f.extension);
  await Promise.all([first.load(), second.load()]);
  await Promise.all([
    first.mutate({ type: "patch", changes: { textScale: 110 } }),
    second.mutate({ type: "patch", changes: { theme: "dark" } }),
    first.mutate({ type: "addRule", rule: { hostname: "keep.example", enabled: false } }),
    second.mutate({ type: "removeRule", hostname: "remove.example" })
  ]);
  assert.equal(f.saved().textScale, 110);
  assert.equal(f.saved().theme, "dark");
  assert.deepEqual(api.decodeSettings(f.saved()).siteRules.map((rule) => rule.hostname), ["keep.example"]);
  for (const client of [first, second]) assert.deepEqual(client.settings, api.normalizeSettings(f.saved()));
  assert.deepEqual(Object.keys(f.writes[1]), ["theme"], "a later preference edit only writes its changed key");
});

test("failed writes roll back optimistic values and do not poison later writes", async () => {
  const f = fixture({ theme: "dark" });
  const client = preferences.createClient(f.extension);
  await client.load();
  f.failWrite(true);
  const write = client.mutate({ type: "patch", changes: { theme: "light" } });
  assert.equal(client.settings.theme, "light");
  await assert.rejects(write, /Write failed/);
  assert.equal(client.settings.theme, "dark");
  f.failWrite(false);
  await client.mutate({ type: "patch", changes: { textScale: 120 } });
  assert.equal(f.saved().textScale, 120);
  assert.equal(f.saved().theme, "dark");
});

test("change listeners distinguish optimistic intent from confirmed storage and ignore older replies", async () => {
  const f = fixture({ textScale: 100, siteRules: [{ hostname: "saved.example", enabled: false }] });
  const seen = [];
  const client = preferences.createClient(f.extension, {
    onChange: (current, loaded) => seen.push(structuredClone({ current, loaded, confirmed: client.confirmedSettings }))
  });
  await client.load();
  const externalCopy = client.confirmedSettings;
  externalCopy.textScale = 135;
  externalCopy.siteRules[0].enabled = true;
  externalCopy.siteRules.push({ hostname: "other.example", includeSubdomains: false, enabled: false, scope: null });
  assert.equal(client.confirmedSettings.textScale, 100);
  assert.equal(client.confirmedSettings.siteRules[0].enabled, false);
  assert.equal(client.confirmedSettings.siteRules.length, 1);
  assert.deepEqual(client.settings, client.confirmedSettings, "mutating a getter snapshot cannot corrupt internal state");
  let reply;
  f.extension.runtime.sendMessage = () => new Promise((resolve) => { reply = resolve; });
  const mutation = client.mutate({ type: "patch", changes: { textScale: 110 } });
  assert.equal(seen.at(-1).loaded, true);
  assert.equal(seen.at(-1).current.textScale, 110);
  assert.equal(seen.at(-1).confirmed.textScale, 100, "pending intent cannot prove an import committed");
  await f.storage.set({ textScale: 127 });
  assert.equal(seen.at(-1).current.textScale, 110, "pending local intent remains visible");
  assert.equal(seen.at(-1).confirmed.textScale, 127, "the real storage event is exposed separately");
  reply({ ok: true, settings: api.normalizeSettings({ textScale: 110 }) });
  await mutation;
  assert.equal(seen.at(-1).current.textScale, 127);
  assert.equal(seen.at(-1).confirmed.textScale, 127, "an older response cannot replace the observed commit");
});

test("an over-capacity pause and import fail without changing any saved settings", async () => {
  const oversized = Array.from({ length: 250 }, (_, index) => ({ hostname: `site${index}.example.com`, enabled: false }));
  const f = fixture(api.encodeSettings({ siteRules: oversized }));
  await assert.rejects(f.store.mutate({ type: "toggleSite", hostname: "new.example.com" }), { code: "RULE_CAPACITY" });
  await assert.rejects(f.store.mutate({ type: "replace", settings: api.normalizeSettings({ ...api.defaults, siteRules: [...oversized, { hostname: "new.example.com", enabled: false }] }) }), { code: "RULE_CAPACITY" });
  assert.deepEqual(api.decodeSettings(f.saved()).siteRules, api.normalizeSettings({ siteRules: oversized }).siteRules);
  assert.equal(f.writes.length, 0);
  await f.store.mutate({ type: "removeRule", hostname: "site1.example.com" });
  assert.equal(api.decodeSettings(f.saved()).siteRules.length, 249, "oversized legacy lists can still be reduced");
});

test("import validation rejects invalid and duplicate rules rather than dropping them", () => {
  for (const siteRules of [
    [{ hostname: "bad/domain", enabled: false }],
    [{ hostname: "valid.example", enabled: "false" }],
    [{ hostname: "valid.example", enabled: false }, { hostname: "valid.example", enabled: true }]
  ]) assert.throws(() => api.validateImport({ schemaVersion: 2, settings: { ...api.defaults, siteRules } }), { code: "INVALID_IMPORT" });
  assert.throws(() => api.validateImport({ schemaVersion: 2, settings: { ...api.defaults, textScale: 500 } }), { code: "INVALID_IMPORT" });
  const imported = api.validateImport({ schemaVersion: 1, settings: { disabledSites: ["legacy.example"], spacing: "wide" } });
  assert.equal(imported.siteRules[0].hostname, "legacy.example");
  assert.equal(imported.letterSpacing, 0.04);
});

test("preference edits normalize scalar legacy keys without converting their rule representation", async () => {
  const f = fixture({ disabledSites: ["legacy.example"], spacing: "wide" });
  await f.store.mutate({ type: "patch", changes: { theme: "dark" } });
  assert.equal(api.decodeSettings(f.saved()).siteRules[0].hostname, "legacy.example");
  assert.equal(f.saved().letterSpacing, 0.04);
  assert.deepEqual(f.saved().disabledSites, ["legacy.example"]);
  assert.equal(Object.hasOwn(f.saved(), "siteRules"), false);
});

test("authentic 120 and 250 legacy pauses remain compatible and editable under the per-item quota", async () => {
  for (const count of [120, 250]) {
    const disabledSites = Array.from({ length: count }, (_, i) => `site${i}.legacy.example`);
    const initial = { disabledSites, enabled: false, scope: "all", spacing: "wider", textScale: 130 };
    assert.ok(Buffer.byteLength("disabledSites" + JSON.stringify(disabledSites)) < 8192);
    assert.ok(Buffer.byteLength(JSON.stringify(api.normalizeSettings(initial).siteRules)) > 8192,
      "the original expanded representation exceeds the real browser quota");
    const f = fixture(initial, { quota: true });
    const first = preferences.createClient(f.extension), second = preferences.createClient(f.extension);
    await Promise.all([first.load(), second.load()]);
    await Promise.all([
      first.mutate({ type: "patch", changes: { theme: "dark" } }),
      second.mutate({ type: "removeRule", hostname: disabledSites[1] }),
      second.mutate({ type: "patch", changes: { lineHeight: 1.7 } })
    ]);
    const saved = api.decodeSettings(f.saved());
    assert.deepEqual(saved.siteRules.map((rule) => rule.hostname), disabledSites.filter((_, i) => i !== 1));
    assert.deepEqual({ ...saved, siteRules: [] }, { ...api.normalizeSettings(initial), siteRules: [], theme: "dark", lineHeight: 1.7 });
    assert.deepEqual(f.saved().disabledSites, disabledSites.filter((_, i) => i !== 1));
    assert.equal(Object.hasOwn(f.saved(), "siteRules"), false);
    assert.ok(Buffer.byteLength("disabledSites" + JSON.stringify(f.saved().disabledSites)) <= 8192);
    assert.deepEqual({ ...JSON.parse(JSON.stringify(oldApi.settings.normalizeSettings(f.saved()))), layoutRepair: false }, saved);
    const restarted = preferences.createClient(f.extension);
    await restarted.load();
    assert.deepEqual(restarted.settings, saved);
    assert.deepEqual(first.settings, saved);
    assert.deepEqual(second.settings, saved);
  }
});

test("migration failure before commit and interruption before cleanup preserve the entire configuration", async () => {
  const initial = { disabledSites: ["one.example", "two.example"], spacing: "wide", enabled: false };
  const f = fixture(initial, { quota: true });
  f.failWrite(true);
  await assert.rejects(f.store.mutate({ type: "patch", changes: { theme: "dark" } }), /Write failed/);
  assert.deepEqual(f.saved(), initial);
  f.failWrite(false);
  f.failCleanup(true);
  await preferences.createStore(f.storage).mutate({ type: "updateRule", hostname: "one.example", includeSubdomains: false,
    changes: { includeSubdomains: true, scope: "all" } });
  assert.deepEqual(f.saved().disabledSites, initial.disabledSites, "legacy source survives interrupted cleanup");
  assert.deepEqual(api.decodeSettings(f.saved()).siteRules.map((rule) => rule.hostname), ["one.example", "two.example"],
    "committed canonical data wins over stale legacy data on restart");
  f.failCleanup(false);
  await preferences.createStore(f.storage).mutate({ type: "patch", changes: { textScale: 130 } });
  assert.equal(f.saved().disabledSites, undefined);
  assert.equal(api.decodeSettings(f.saved()).letterSpacing, .04);
  assert.equal(api.getDirectRule(api.decodeSettings(f.saved()), "one.example", true).scope, "all");
  assert.deepEqual(api.decodeSettings(f.saved()).siteRules.map((rule) => rule.hostname), ["one.example", "two.example"]);
});

test("persisted decoding preserves every rule variant and fails closed for corruption", async () => {
  const siteRules = [];
  for (const includeSubdomains of [false, true]) {
    for (const enabled of [false, true, null]) for (const scope of [null, "body", "all"]) {
      if (enabled === null && scope === null) continue;
      siteRules.push({ hostname: `v${siteRules.length}.example`, includeSubdomains, enabled, scope });
    }
  }
  const settings = { ...api.defaults, siteRules };
  assert.deepEqual(api.decodeSettings(api.encodeSettings(settings)), settings);
  for (const siteRules of ["@3\none.example", "@1\none.example\t18", "@1\none.example\t6", "@1\none.example\tno", "@1\nbad/domain", "@1\none.example\none.example", "@1\none.example\n"]) {
    const f = fixture({ enabled: false, siteRules, disabledSites: ["legacy.example"] });
    const client = preferences.createClient(f.extension);
    await assert.rejects(client.load(), { code: "INVALID_STORAGE" });
    await assert.rejects(f.store.mutate({ type: "patch", changes: { theme: "dark" } }), { code: "INVALID_STORAGE" });
    assert.equal(f.saved().siteRules, siteRules);
    assert.deepEqual(f.saved().disabledSites, ["legacy.example"]);
    assert.equal(f.writes.length, 0);
  }
});

test("raw storage removals reveal legacy fallbacks without losing other confirmed preferences", async () => {
  const f = fixture({ ...api.encodeSettings({ enabled: false, siteRules: [] }), disabledSites: ["legacy.example"], spacing: "wide" });
  const client = preferences.createClient(f.extension);
  await client.load();
  assert.equal(client.settings.siteRules.length, 0);
  await f.storage.remove(["siteRules", "letterSpacing"]);
  assert.equal(client.settings.siteRules[0].hostname, "legacy.example");
  assert.equal(client.settings.letterSpacing, .04);
  assert.equal(client.settings.enabled, false);
});

test("preference edits preserve pre-existing rules that cannot fit a new canonical item", async () => {
  const siteRules = Array.from({ length: 250 }, (_, i) => ({
    hostname: `site${i}.${"a".repeat(63)}.example`, enabled: false
  }));
  const f = fixture({ siteRules, disabledSites: ["stale.example"], spacing: "wide" }, { quota: true });
  await f.store.mutate({ type: "patch", changes: { theme: "dark" } });
  assert.equal(f.saved().theme, "dark");
  assert.deepEqual(f.saved().siteRules, siteRules);
  assert.deepEqual(f.saved().disabledSites, ["stale.example"]);
  assert.equal(f.saved().letterSpacing, .04);
  assert.equal(Object.hasOwn(f.writes[0], "siteRules"), false);
});

test("capacity checks the encoded item including key bytes at the actual quota boundary", async () => {
  // 32 maximum-length hostnames are just below the boundary; the final rule
  // makes the serialized item exactly 8192 bytes rather than testing a loose cap.
  const hostname = (i, length) => {
    const prefix = `s${i}.`;
    let remaining = length - prefix.length;
    const labels = [];
    while (remaining > 63) { labels.push("a".repeat(63)); remaining -= 64; }
    labels.push("b".repeat(remaining));
    return prefix + labels.join(".");
  };
  const rules = Array.from({ length: 32 }, (_, i) => ({ hostname: hostname(i, 253), enabled: false }));
  const remaining = 8192 - api.ruleStorageBytes({ siteRules: rules }) - 2;
  rules.push({ hostname: hostname(32, remaining), enabled: false });
  assert.equal(api.ruleStorageBytes({ siteRules: rules }), 8192);
  const full = api.normalizeSettings({ ...api.defaults, siteRules: rules });
  const f = fixture(api.encodeSettings({}), { quota: true });
  await f.store.mutate({ type: "replace", settings: full });
  const saved = structuredClone(f.saved());
  const larger = structuredClone(full);
  larger.siteRules.at(-1).hostname += "b";
  assert.equal(api.ruleStorageBytes(larger), 8193);
  await assert.rejects(f.store.mutate({ type: "replace", settings: larger }), { code: "RULE_CAPACITY" });
  assert.deepEqual(f.saved(), saved);
});

test("client startup merges compact events and removals over the initial saved snapshot", async () => {
  const f = fixture({ enabled: false, scope: "all", textScale: 130, disabledSites: ["saved.example"], spacing: "wide" });
  let finishRead;
  const snapshot = structuredClone(f.saved());
  f.storage.get = () => new Promise((resolve) => { finishRead = resolve; });
  const client = preferences.createClient(f.extension);
  const loading = client.load();
  f.emit({ theme: { newValue: "dark" }, siteRules: { newValue: api.encodeSettings({ siteRules: [{ hostname: "new.example", enabled: false }] }).siteRules }, spacing: { oldValue: "wide" } });
  finishRead(snapshot);
  await loading;
  assert.equal(client.settings.enabled, false);
  assert.equal(client.settings.scope, "all");
  assert.equal(client.settings.textScale, 130);
  assert.equal(client.settings.theme, "dark");
  assert.equal(client.settings.letterSpacing, 0);
  assert.deepEqual(client.settings.siteRules.map((rule) => rule.hostname), ["new.example"]);
});

test("a corrupt storage event exposes actionable read failure and blocks writes until reload", async () => {
  const f = fixture(api.encodeSettings({ enabled: false, siteRules: [{ hostname: "saved.example", enabled: false }] }));
  const changes = [];
  const client = preferences.createClient(f.extension, { onChange(settings, loaded, error) { changes.push({ settings, loaded, error }); } });
  await client.load();
  const before = client.settings;
  await f.storage.set({ siteRules: "@unknown\nbroken" });
  assert.equal(client.loaded, false);
  assert.equal(client.readError.code, "INVALID_STORAGE");
  assert.equal(changes.at(-1).error.code, "INVALID_STORAGE");
  assert.deepEqual(client.settings, before);
  await assert.rejects(client.mutate({ type: "patch", changes: { enabled: true } }), { code: "NOT_LOADED" });
  await f.storage.set(api.encodeSettings(before));
  await client.load();
  assert.equal(client.loaded, true);
  assert.equal(client.readError, null);
  assert.deepEqual(client.settings, before);
});

test("schema2 replacement rejects every missing field and empty imports without modifying storage", async () => {
  const initial = api.normalizeSettings({ enabled: false, siteRules: [{ hostname: "saved.example", enabled: false }] });
  const f = fixture(initial);
  for (const key of Object.keys(api.defaults)) {
    const partial = { ...api.defaults };
    delete partial[key];
    await assert.rejects(f.store.mutate({ type: "replace", settings: partial }), { code: "INVALID_IMPORT" });
  }
  for (const settings of [{}, { textScale: 120 }, { ...api.defaults, siteRules: undefined }, { ...api.defaults, enabled: undefined }]) {
    assert.throws(() => api.validateImport({ schemaVersion: 2, settings }), { code: "INVALID_IMPORT" });
  }
  assert.throws(() => api.validateImport({ schemaVersion: 1, settings: {} }), { code: "INVALID_IMPORT" });
  assert.throws(() => api.validateImport({ schemaVersion: 1, settings: { spacing: "invalid" } }), { code: "INVALID_IMPORT" });
  assert.equal(f.writes.length, 0);
  assert.deepEqual(f.saved(), initial);
  const legacy = api.validateImport({ schemaVersion: 1, settings: { disabledSites: ["legacy.example"], spacing: "wider" } });
  await f.store.mutate({ type: "replace", settings: legacy });
  assert.deepEqual(api.decodeSettings(f.saved()), legacy);
});

test("a guarded replacement rejects a concurrent queued rule addition without changing its result", async () => {
  const f = fixture(api.encodeSettings({ enabled: false, theme: "dark" }));
  const expected = api.decodeSettings(f.saved());
  const added = f.store.mutate({ type: "addRule", rule: { hostname: "new.example", enabled: false } });
  const stale = f.store.mutate({ type: "replace", settings: { ...expected, textScale: 120 }, expected });
  await added;
  const afterAdd = structuredClone(f.saved());
  await assert.rejects(stale, { code: "STALE_IMPORT" });
  assert.deepEqual(f.saved(), afterAdd);
  assert.equal(f.writes.length, 1, "stale replacement never writes or cleans up saved data");
  assert.equal(api.decodeSettings(f.saved()).siteRules[0].hostname, "new.example");
});

test("replacement guards compare normalized rule identities and values rather than array order", async () => {
  const initial = api.normalizeSettings({ theme: "dark", siteRules: [
    { hostname: "example.com", includeSubdomains: true, enabled: false },
    { hostname: "example.com", enabled: true, scope: "all" }
  ] });
  const f = fixture(api.encodeSettings(initial));
  const expected = { ...initial, siteRules: [...initial.siteRules].reverse().map((rule) => ({
    ...rule, hostname: rule.hostname.toUpperCase() + "."
  })) };
  assert.equal(api.settingsEqual(initial, expected), true);
  const replacement = { ...initial, textScale: 120 };
  await assert.rejects(f.store.mutate({ type: "replace", settings: replacement, expected }), { code: "INVALID_OPERATION" },
    "Guard snapshots must already be complete and normalized");
  await f.store.mutate({ type: "replace", settings: replacement, expected: api.normalizeSettings(expected) });
  assert.deepEqual(api.decodeSettings(f.saved()), replacement);
  for (const changed of [
    { ...replacement, theme: "light" },
    { ...replacement, siteRules: replacement.siteRules.map((rule, i) => i === 0 ? { ...rule, scope: "body" } : rule) },
    { ...replacement, siteRules: replacement.siteRules.filter((rule) => !rule.includeSubdomains) }
  ]) assert.equal(api.settingsEqual(replacement, changed), false);
  await assert.rejects(f.store.mutate({ type: "replace", settings: initial, expected: null }), { code: "INVALID_OPERATION" });
  assert.deepEqual(api.decodeSettings(f.saved()), replacement);
  await f.store.mutate({ type: "replace", settings: initial });
  assert.deepEqual(api.decodeSettings(f.saved()), initial, "existing callers without a guard retain replacement semantics");
});

test("a guarded scalar retry preserves a newer value from another client", async () => {
  const f = fixture(api.encodeSettings({ textScale: 100 }));
  const first = preferences.createClient(f.extension), second = preferences.createClient(f.extension);
  await Promise.all([first.load(), second.load()]);
  const expected = first.confirmedSettings;
  f.failWrite(true);
  await assert.rejects(first.mutate({ type: "patch", changes: { textScale: 120 } }), /Write failed/);
  f.failWrite(false);
  await second.mutate({ type: "patch", changes: { textScale: 130 } });
  const writes = f.writes.length;
  await assert.rejects(first.mutate({ type: "patch", changes: { textScale: 120 }, expected }), { code: "STALE_SETTINGS" });
  assert.equal(f.writes.length, writes);
  assert.equal(api.decodeSettings(f.saved()).textScale, 130);
  assert.equal(first.settings.textScale, 130);
  assert.equal(second.settings.textScale, 130);
});

test("patch guards compare only changed fields and confirmed snapshots omit optimistic pending values", async () => {
  const f = fixture(api.encodeSettings({ theme: "light", textScale: 100, siteRules: [{ hostname: "saved.example", enabled: false }] }));
  const client = preferences.createClient(f.extension);
  await client.load();
  const expected = client.confirmedSettings;
  expected.siteRules[0].enabled = true;
  assert.equal(client.confirmedSettings.siteRules[0].enabled, false, "callers cannot mutate confirmed settings through a returned snapshot");
  await f.store.mutate({ type: "patch", changes: { textScale: 130 } });
  let release;
  const send = f.extension.runtime.sendMessage;
  f.extension.runtime.sendMessage = (message) => new Promise((resolve) => { release = () => resolve(send(message)); });
  const mutation = client.mutate({ type: "patch", changes: { theme: "dark" }, expected });
  assert.equal(client.settings.theme, "dark", "guarded writes retain normal optimistic feedback");
  assert.equal(client.confirmedSettings.theme, "light");
  release();
  await mutation;
  assert.equal(client.confirmedSettings.theme, "dark");
  assert.equal(client.confirmedSettings.textScale, 130, "an unrelated newer preference does not block the theme retry");
  await assert.rejects(f.store.mutate({ type: "patch", changes: { theme: "light" }, expected: {} }), { code: "INVALID_OPERATION" });
  await assert.rejects(f.store.mutate({ type: "patch", changes: { theme: "light" }, expected: null }), { code: "INVALID_OPERATION" });
  await f.store.mutate({ type: "patch", changes: { theme: "light" }, expected: { theme: "dark" } });
  assert.equal(api.decodeSettings(f.saved()).theme, "light", "partial expected snapshots are supported when all patched fields are present");
});

test("guarded rule retries reject newer rules and toggles also protect global enablement", async () => {
  const initial = api.normalizeSettings({ enabled: false, siteRules: [{ hostname: "saved.example", enabled: false }] });
  for (const operation of [
    { type: "addRule", rule: { hostname: "retry.example", enabled: false } },
    { type: "removeRule", hostname: "saved.example" },
    { type: "toggleSite", hostname: "saved.example" }
  ]) {
    const f = fixture(api.encodeSettings(initial));
    await f.store.mutate({ type: "addRule", rule: { hostname: "new.example", enabled: false } });
    const saved = structuredClone(f.saved());
    await assert.rejects(f.store.mutate({ ...operation, expected: initial }), { code: "STALE_SETTINGS" });
    assert.deepEqual(f.saved(), saved);
    assert.equal(f.writes.length, 1);
    await assert.rejects(f.store.mutate({ ...operation, expected: {} }), { code: "INVALID_OPERATION" });
  }
  const f = fixture(api.encodeSettings(initial));
  await f.store.mutate({ type: "patch", changes: { enabled: true } });
  await assert.rejects(f.store.mutate({ type: "toggleSite", hostname: "saved.example", expected: initial }), { code: "STALE_SETTINGS" });
  await f.store.mutate({ type: "patch", changes: { theme: "dark" } });
  await f.store.mutate({ type: "removeRule", hostname: "saved.example", expected: initial });
  assert.deepEqual(api.decodeSettings(f.saved()).siteRules, [], "unrelated scalar changes do not prevent a rule removal retry");
  assert.equal(api.decodeSettings(f.saved()).theme, "dark");
});

const connectFixture = (f, { missingWriter = false } = {}) => {
  const ports = [];
  const event = () => ({ listeners: [], addListener(listener) { this.listeners.push(listener); },
    emit(value) { this.listeners.forEach((listener) => listener(value)); } });
  f.extension.runtime.connect = ({ name }) => {
    assert.equal(name, preferences.connectionName);
    let disconnected = false;
    const port = { onMessage: event(), onDisconnect: event(),
      disconnect() { disconnected = true; this.onDisconnect.emit(); },
      postMessage({ id, operation }) {
        if (disconnected) throw new Error("Disconnected port");
        if (missingWriter) return;
        f.store.mutate(operation).then(
          (settings) => { if (!disconnected) this.onMessage.emit({ id, ok: true, settings }); },
          (error) => { if (!disconnected) this.onMessage.emit({ id, ok: false, message: error.message }); }
        );
      }
    };
    ports.push(port);
    if (missingWriter) queueMicrotask(() => port.disconnect());
    return port;
  };
  return ports;
};

test("dedicated save connections correlate concurrent responses and preserve unrelated settings", async () => {
  const f = fixture({ theme: "dark" });
  const ports = connectFixture(f);
  const first = preferences.createClient(f.extension), second = preferences.createClient(f.extension);
  await Promise.all([first.load(), second.load()]);
  await Promise.all([
    first.mutate({ type: "patch", changes: { textScale: 110 } }),
    first.mutate({ type: "patch", changes: { letterSpacing: .08 } }),
    second.mutate({ type: "addRule", rule: { hostname: "saved.example", enabled: false } })
  ]);
  assert.equal(ports.length, 2, "each page reuses one connection for its writes");
  assert.equal(f.saved().textScale, 110);
  assert.equal(f.saved().letterSpacing, .08);
  assert.equal(f.saved().theme, "dark");
  assert.equal(api.decodeSettings(f.saved()).siteRules[0].hostname, "saved.example");
});

test("an idle connection disconnect reconnects on the next save", async () => {
  const f = fixture();
  const ports = connectFixture(f);
  const client = preferences.createClient(f.extension);
  await client.load();
  await client.mutate({ type: "patch", changes: { textScale: 110 } });
  ports[0].disconnect();
  await client.mutate({ type: "patch", changes: { letterSpacing: .08 } });
  assert.equal(ports.length, 2);
  assert.equal(f.saved().textScale, 110);
  assert.equal(f.saved().letterSpacing, .08);
});

test("missing writer responses expose a reload instruction and roll back the optimistic edit", async () => {
  const f = fixture({ theme: "dark" });
  const client = preferences.createClient(f.extension);
  await client.load();
  f.extension.runtime.sendMessage = async () => undefined;
  await assert.rejects(client.mutate({ type: "patch", changes: { theme: "light" } }),
    (error) => error.code === "BACKGROUND_UNAVAILABLE" && /Reload the extension/.test(error.message));
  assert.equal(client.settings.theme, "dark");
  assert.equal(f.writes.length, 0);
  connectFixture(f, { missingWriter: true });
  await assert.rejects(client.mutate({ type: "patch", changes: { theme: "light" } }), { code: "BACKGROUND_UNAVAILABLE" });
  assert.equal(client.settings.theme, "dark");
});

test("Chrome disconnect errors preserve the browser's actual failure reason", async () => {
  const f = fixture({ theme: "dark" });
  const ports = connectFixture(f, { missingWriter: true });
  const client = preferences.createClient(f.extension);
  await client.load();
  const cause = { message: "Could not establish connection. Receiving end does not exist." };
  let lastErrorReads = 0;
  Object.defineProperty(f.extension.runtime, "lastError", { get() { lastErrorReads++; return cause; } });
  await assert.rejects(client.mutate({ type: "patch", changes: { theme: "light" } }),
    (error) => error.code === "BACKGROUND_UNAVAILABLE"
      && error.message.includes(cause.message) && error.cause === cause);
  assert.equal(client.settings.theme, "dark");
  assert.equal(f.writes.length, 0);
  assert.equal(ports.length, 1);
  assert.equal(lastErrorReads, 1, "the error is captured in the disconnect callback");
});

test("Firefox disconnect errors preserve the port's failure reason", async () => {
  const f = fixture({ theme: "dark" });
  const ports = connectFixture(f, { missingWriter: true });
  const client = preferences.createClient(f.extension);
  await client.load();
  const cause = new Error("Could not establish connection. Receiving end does not exist.");
  const mutation = client.mutate({ type: "patch", changes: { theme: "light" } });
  ports[0].error = cause;
  await assert.rejects(mutation,
    (error) => error.code === "BACKGROUND_UNAVAILABLE"
      && error.message.includes(cause.message) && error.cause === cause);
  assert.equal(client.settings.theme, "dark");
  assert.equal(f.writes.length, 0);
});

test("posting to a disconnected port preserves the synchronous connection error", async () => {
  const f = fixture({ theme: "dark" });
  const ports = connectFixture(f);
  const client = preferences.createClient(f.extension);
  await client.load();
  await client.mutate({ type: "patch", changes: { textScale: 110 } });
  const cause = new Error("Attempting to use a disconnected port object");
  ports[0].postMessage = () => { throw cause; };
  await assert.rejects(client.mutate({ type: "patch", changes: { theme: "light" } }),
    (error) => error.code === "BACKGROUND_UNAVAILABLE"
      && error.message.includes(cause.message) && error.cause === cause);
  assert.equal(client.settings.theme, "dark");
  await client.mutate({ type: "patch", changes: { theme: "light" } });
  assert.equal(client.settings.theme, "light");
  assert.equal(ports.length, 2, "the next save opens a fresh connection");
});

test("layout repair defaults off, resolves independently, and global enablement preserves site intent", async () => {
  assert.equal(api.normalizeSettings({}).layoutRepair, false);
  const settings = api.normalizeSettings({ enabled: false, scope: "body", siteRules: [
    { hostname: "example.com", includeSubdomains: true, layoutRepair: true },
    { hostname: "child.example.com", includeSubdomains: true, layoutRepair: false },
    { hostname: "child.example.com", layoutRepair: true, enabled: false, scope: "all" }
  ] });
  assert.equal(api.resolveSite(settings, "a.example.com").layoutRepair, true);
  assert.equal(api.resolveSite(settings, "a.child.example.com").layoutRepair, false);
  const direct = api.resolveSite(settings, "child.example.com");
  assert.equal(direct.layoutRepair, true);
  assert.equal(direct.active, false);
  assert.equal(direct.scope, "all");
  for (const raw of [settings, api.encodeSettings(settings), { disabledSites: ["saved.example"] }]) {
    const f = fixture(raw);
    const before = structuredClone(f.saved());
    await f.store.mutate({ type: "patch", changes: { layoutRepair: true } });
    assert.equal(api.resolveSite(f.saved(), "unknown.example").layoutRepair, true);
    assert.equal(api.resolveSite(f.saved(), "a.child.example.com").layoutRepair, true);
    await f.store.mutate({ type: "patch", changes: { layoutRepair: false } });
    for (const key of ["siteRules", "disabledSites"]) assert.deepEqual(f.saved()[key], before[key]);
    assert(f.writes.every((patch) => !Object.hasOwn(patch, "siteRules") && !Object.hasOwn(patch, "disabledSites")));
  }
});

test("site layout decisions preserve master and other rule fields, clear inheritance, and serialize concurrent changes", async () => {
  const f = fixture(api.normalizeSettings({ enabled: false, siteRules: [
    { hostname: "example.com", enabled: false, scope: "all" },
    { hostname: "example.com", includeSubdomains: true, layoutRepair: false }
  ] }));
  await Promise.all([
    f.store.mutate({ type: "setSiteLayoutRepair", hostname: "example.com", value: true }),
    f.store.mutate({ type: "patch", changes: { textScale: 125 } })
  ]);
  assert.deepEqual(api.getDirectRule(f.saved(), "example.com"), {
    hostname: "example.com", includeSubdomains: false, enabled: false, scope: "all", layoutRepair: true
  });
  assert.equal(f.saved().enabled, false);
  assert.equal(f.saved().textScale, 125);
  assert.equal(api.getDirectRule(f.saved(), "example.com", true).layoutRepair, false);
  await f.store.mutate({ type: "setSiteLayoutRepair", hostname: "example.com", value: null });
  assert.equal(Object.hasOwn(api.getDirectRule(f.saved(), "example.com"), "layoutRepair"), false);
  await f.store.mutate({ type: "setSiteLayoutRepair", hostname: "new.example", value: false });
  await f.store.mutate({ type: "setSiteLayoutRepair", hostname: "new.example", value: null });
  assert.equal(api.getDirectRule(f.saved(), "new.example"), null);
  for (const operation of [
    { hostname: "bad/domain", value: true }, { hostname: "good.example", value: "true" }, { hostname: "good.example" }
  ]) await assert.rejects(f.store.mutate({ type: "setSiteLayoutRepair", ...operation }), { code: "INVALID_RULE" });
});

test("repair compact encoding is versioned and strict, preserving old normalized rule shapes", () => {
  const rules = [];
  for (const layoutRepair of [undefined, false, true]) for (const includeSubdomains of [false, true]) {
    for (const enabled of [false, true, null]) for (const scope of [null, "body", "all"]) {
      if (enabled === null && scope === null && layoutRepair === undefined) continue;
      rules.push({ hostname: `v${rules.length}.example`, includeSubdomains, enabled, scope,
        ...(layoutRepair === undefined ? {} : { layoutRepair }) });
    }
  }
  const normalized = api.normalizeSettings({ siteRules: rules });
  const encoded = api.encodeSettings(normalized);
  assert(encoded.siteRules.startsWith("@2\n"));
  assert.deepEqual(api.decodeSettings(encoded), normalized);
  assert(api.encodeSettings({ siteRules: rules.filter((rule) => rule.layoutRepair === undefined) }).siteRules.startsWith("@1\n"));
  for (const siteRules of ["@2\na.example\t54", "@2\na.example\t-1", "@2\na.example\t01", "@2\na.example\t6", "@2\na.example\t36\na.example\t36", "@2\na.example\t36\n"]) {
    assert.throws(() => api.decodeSettings({ siteRules }), { code: "INVALID_STORAGE" });
  }
});

test("schema 3 and repair undo preserve later decisions while old backups remain readable", () => {
  const before = api.normalizeSettings({ siteRules: [{ hostname: "example.com", enabled: false, layoutRepair: false }] });
  const after = api.normalizeSettings({ ...before, layoutRepair: true, siteRules: [{ hostname: "example.com", enabled: true, layoutRepair: true }] });
  const later = api.setSiteRule(after, { hostname: "example.com", layoutRepair: false });
  const restored = api.restoreImport(later, before, after);
  assert.equal(restored.layoutRepair, false);
  assert.equal(restored.siteRules[0].layoutRepair, false);
  assert.equal(restored.siteRules[0].enabled, false);
  assert.deepEqual(api.validateImport({ schemaVersion: 3, settings: after }), after);
  const legacy = { ...before }; delete legacy.layoutRepair;
  assert.equal(api.validateImport({ schemaVersion: 2, settings: legacy }).layoutRepair, false);
  assert.throws(() => api.validateImport({ schemaVersion: 3, settings: legacy }), { code: "INVALID_IMPORT" });
  for (const settings of [{ ...after, layoutRepair: null }, { ...after, siteRules: [{ hostname: "example.com", layoutRepair: null }] },
    { ...after, siteRules: [{ hostname: "example.com", layoutRepair: true, unknown: true }] }]) {
    assert.throws(() => api.validateImport({ schemaVersion: 3, settings }), { code: "INVALID_IMPORT" });
  }
  assert(api.previewImport(before, after).changes.some((change) => change.key === "layoutRepair"));
  assert.equal(api.previewImport(before, after).rules.changed.length, 1);
});
