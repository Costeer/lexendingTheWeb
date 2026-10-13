import assert from "node:assert/strict";
import test from "node:test";
import "../src/settings.js";
import "../src/preferences.js";

const api = globalThis.LexendSettings;
const preferences = globalThis.LexendPreferences;
const fixture = (initial = {}, { quota = false } = {}) => {
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
      listeners.forEach((listener) => listener(changes, "sync"));
    },
    async remove(keys) {
      if (failCleanup) throw new Error("Cleanup interrupted");
      const changes = {};
      for (const key of keys) {
        if (Object.hasOwn(saved, key)) changes[key] = { oldValue: saved[key] };
        delete saved[key];
      }
      if (Object.keys(changes).length) listeners.forEach((listener) => listener(changes, "sync"));
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

test("an over-capacity pause and import fail without changing any saved settings", async () => {
  const oversized = Array.from({ length: 250 }, (_, index) => ({ hostname: `site${index}.example.com`, enabled: false }));
  const f = fixture({ siteRules: oversized });
  await assert.rejects(f.store.mutate({ type: "toggleSite", hostname: "new.example.com" }), { code: "RULE_CAPACITY" });
  await assert.rejects(f.store.mutate({ type: "replace", settings: { ...api.defaults, siteRules: [...oversized, { hostname: "new.example.com", enabled: false }] } }), { code: "RULE_CAPACITY" });
  assert.deepEqual(f.saved().siteRules, oversized);
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

test("preference edits migrate legacy keys without losing their rules", async () => {
  const f = fixture({ disabledSites: ["legacy.example"], spacing: "wide" });
  await f.store.mutate({ type: "patch", changes: { theme: "dark" } });
  assert.equal(api.decodeSettings(f.saved()).siteRules[0].hostname, "legacy.example");
  assert.equal(f.saved().letterSpacing, 0.04);
  assert.equal(f.saved().disabledSites, undefined);
});

test("authentic 120 and 250 legacy pauses migrate and remain editable under the per-item quota", async () => {
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
    assert.equal(f.saved().disabledSites, undefined);
    assert.equal(typeof f.saved().siteRules, "string");
    assert.ok(Buffer.byteLength("siteRules" + JSON.stringify(f.saved().siteRules)) <= 8192);
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
  await preferences.createStore(f.storage).mutate({ type: "removeRule", hostname: "one.example" });
  assert.deepEqual(f.saved().disabledSites, initial.disabledSites, "legacy source survives interrupted cleanup");
  assert.deepEqual(api.decodeSettings(f.saved()).siteRules.map((rule) => rule.hostname), ["two.example"],
    "committed canonical data wins over stale legacy data on restart");
  f.failCleanup(false);
  await preferences.createStore(f.storage).mutate({ type: "patch", changes: { textScale: 130 } });
  assert.equal(f.saved().disabledSites, undefined);
  assert.equal(api.decodeSettings(f.saved()).letterSpacing, .04);
  assert.deepEqual(api.decodeSettings(f.saved()).siteRules.map((rule) => rule.hostname), ["two.example"]);
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
  for (const siteRules of ["@2\none.example", "@1\none.example\t18", "@1\none.example\t6", "@1\none.example\tno", "@1\nbad/domain", "@1\none.example\none.example", "@1\none.example\n"]) {
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
  const full = { ...api.defaults, siteRules: rules };
  const f = fixture({}, { quota: true });
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
  await f.store.mutate({ type: "replace", settings: replacement, expected });
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
