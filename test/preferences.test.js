import assert from "node:assert/strict";
import test from "node:test";
import "../src/settings.js";
import "../src/preferences.js";

const api = globalThis.LexendSettings;
const preferences = globalThis.LexendPreferences;
const fixture = (initial = {}) => {
  let saved = structuredClone(initial);
  let failRead = false;
  let failWrite = false;
  const listeners = [];
  const writes = [];
  const storage = {
    async get() { if (failRead) throw new Error("Read failed"); return structuredClone(saved); },
    async set(patch) {
      if (failWrite) throw new Error("Write failed");
      const changes = Object.fromEntries(Object.entries(patch).map(([key, newValue]) => [key, { oldValue: saved[key], newValue }]));
      saved = { ...saved, ...structuredClone(patch) };
      writes.push(structuredClone(patch));
      listeners.forEach((listener) => listener(changes, "sync"));
    },
    async remove(keys) { for (const key of keys) delete saved[key]; }
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
    failRead(value) { failRead = value; }, failWrite(value) { failWrite = value; } };
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
  assert.deepEqual(f.saved().siteRules.map((rule) => rule.hostname), ["keep.example"]);
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
  await assert.rejects(f.store.mutate({ type: "replace", settings: { siteRules: oversized } }), { code: "RULE_CAPACITY" });
  assert.deepEqual(f.saved().siteRules, oversized);
  assert.equal(f.writes.length, 0);
  await f.store.mutate({ type: "removeRule", hostname: "site1.example.com" });
  assert.equal(f.saved().siteRules.length, 249, "oversized legacy lists can still be reduced");
});

test("import validation rejects invalid and duplicate rules rather than dropping them", () => {
  for (const siteRules of [
    [{ hostname: "bad/domain", enabled: false }],
    [{ hostname: "valid.example", enabled: "false" }],
    [{ hostname: "valid.example", enabled: false }, { hostname: "valid.example", enabled: true }]
  ]) assert.throws(() => api.validateImport({ schemaVersion: 2, settings: { siteRules } }), { code: "INVALID_IMPORT" });
  assert.throws(() => api.validateImport({ schemaVersion: 2, settings: { textScale: 500 } }), { code: "INVALID_IMPORT" });
  const imported = api.validateImport({ schemaVersion: 1, settings: { disabledSites: ["legacy.example"], spacing: "wide" } });
  assert.equal(imported.siteRules[0].hostname, "legacy.example");
  assert.equal(imported.letterSpacing, 0.04);
});

test("preference edits migrate legacy keys without losing their rules", async () => {
  const f = fixture({ disabledSites: ["legacy.example"], spacing: "wide" });
  await f.store.mutate({ type: "patch", changes: { theme: "dark" } });
  assert.equal(f.saved().siteRules[0].hostname, "legacy.example");
  assert.equal(f.saved().letterSpacing, 0.04);
  assert.equal(f.saved().disabledSites, undefined);
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
  assert.equal(f.saved().siteRules[0].hostname, "saved.example");
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
