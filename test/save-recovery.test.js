import assert from "node:assert/strict";
import test from "node:test";
import "../src/settings.js";
import "../src/preferences.js";
import "../src/save-recovery.js";

const api = globalThis.LexendSettings;
const failure = () => { throw new Error("Write rejected"); };
function harness() {
  let settings = api.normalizeSettings({ theme: "light" });
  let reject = true;
  const operations = [];
  const store = globalThis.LexendPreferences.createStore({
    get: async () => settings,
    set: async (patch) => { settings = api.decodeSettings({ ...settings, ...patch }); }
  });
  const tracker = globalThis.LexendSaveRecovery.createTracker({ getSettings: () => settings,
    mutate: async (operation) => {
      operations.push(structuredClone(operation));
      if (reject) failure();
      return store.mutate(operation);
    } });
  return { tracker, operations, settings: () => settings, allow: () => { reject = false; },
    reject: () => { reject = true; }, remote: (patch) => { settings = api.normalizeSettings({ ...settings, ...patch }); } };
}

test("unrelated success preserves every failed field until retried", async () => {
  const h = harness();
  await assert.rejects(h.tracker.mutate({ type: "patch", changes: { theme: "dark" } }));
  h.allow();
  await h.tracker.mutate({ type: "patch", changes: { textScale: 120 } });
  assert.equal(h.tracker.state.failures.length, 1);
  assert.equal(h.settings().theme, "light");
  await h.tracker.retry();
  assert.equal(h.settings().theme, "dark");
  assert.equal(h.settings().textScale, 120);
  assert.equal(h.tracker.state.failures.length, 0);
});

test("multi-field retries retain only fields without newer edits", async () => {
  const h = harness();
  h.remote({ lineHeight: 1.8, letterSpacing: .08 });
  await assert.rejects(h.tracker.mutate({ type: "patch", changes: { textScale: 100, letterSpacing: 0, lineHeight: 0 } }));
  h.allow();
  await h.tracker.mutate({ type: "patch", changes: { textScale: 130 } });
  await h.tracker.retry();
  assert.deepEqual(h.operations.at(-1).changes, { letterSpacing: 0, lineHeight: 0 });
  assert.equal(h.settings().textScale, 130);
});

test("retrying an import preserves newer scalar edits and rule operations", async () => {
  const h = harness();
  await assert.rejects(h.tracker.mutate({ type: "replace", settings: api.normalizeSettings({ theme: "dark", textScale: 120,
    siteRules: [{ hostname: "imported.example", enabled: false }] }) }));
  h.allow();
  await h.tracker.mutate({ type: "patch", changes: { theme: "light" } });
  await h.tracker.mutate({ type: "addRule", rule: { hostname: "new.example", enabled: false } });
  await h.tracker.retry();
  assert.equal(h.settings().theme, "light");
  assert.equal(h.settings().textScale, 120);
  assert.deepEqual(h.settings().siteRules.map((rule) => rule.hostname), ["new.example"]);
});

test("retrying a failed import does not clear a newer failed field", async () => {
  const h = harness();
  await assert.rejects(h.tracker.mutate({ type: "replace", settings: api.normalizeSettings({ textScale: 120 }) }));
  await assert.rejects(h.tracker.mutate({ type: "patch", changes: { theme: "dark" } }));
  h.allow();
  await h.tracker.retry();
  assert.equal(h.settings().theme, "dark");
  assert.equal(h.settings().textScale, 120);
  assert.deepEqual(h.operations.at(-1).changes, { theme: "dark" });
  assert.equal(h.tracker.state.failures.length, 0);
});

test("a superseded in-flight failure does not resurrect an obsolete retry", async () => {
  let failFirst;
  const tracker = globalThis.LexendSaveRecovery.createTracker({ getSettings: () => api.defaults,
    mutate: (operation) => operation.changes.theme === "dark"
      ? new Promise((_resolve, reject) => { failFirst = reject; }) : Promise.resolve() });
  const first = tracker.mutate({ type: "patch", changes: { theme: "dark" } });
  await tracker.mutate({ type: "patch", changes: { theme: "light" } });
  failFirst(new Error("Late failure"));
  await assert.rejects(first);
  assert.equal(tracker.state.failures.length, 0);
});

test("retrying an uncertain toggle never reverses a fulfilled target", async () => {
  const h = harness();
  await assert.rejects(h.tracker.mutate({ type: "toggleSite", hostname: "example.com" }));
  h.remote({ siteRules: [{ hostname: "example.com", enabled: false }] });
  h.allow();
  await h.tracker.retry();
  assert.equal(h.operations.length, 1);
  assert.equal(api.resolveSite(h.settings(), "example.com").active, false);
  assert.equal(h.tracker.state.failures.length, 0);
});


test("a site toggle does not supersede an unrelated failed global pause", async () => {
  const h = harness();
  await assert.rejects(h.tracker.mutate({ type: "patch", changes: { enabled: false } }));
  h.allow();
  await h.tracker.mutate({ type: "toggleSite", hostname: "other.example" });
  assert.deepEqual(h.tracker.state.failures[0].keys, ["enabled"]);
  await h.tracker.retry();
  assert.equal(h.settings().enabled, false);
});

test("rule operation supersession uses normalized hostname identity", async () => {
  const h = harness();
  await assert.rejects(h.tracker.mutate({ type: "removeRule", hostname: "EXAMPLE.com." }));
  h.allow();
  await h.tracker.mutate({ type: "addRule", rule: { hostname: "example.com", enabled: false } });
  await h.tracker.retry();
  assert.equal(h.operations.length, 2);
  assert.equal(h.settings().siteRules.length, 1);
});


test("already-confirmed rule mutations do not replay after a lost response", async () => {
  for (const type of ["addRule", "removeRule"]) {
    const h = harness();
    const rule = { hostname: "example.com", enabled: false };
    if (type === "removeRule") h.remote({ siteRules: [rule] });
    await assert.rejects(h.tracker.mutate(type === "addRule" ? { type, rule } : { type, hostname: rule.hostname }));
    h.remote({ siteRules: type === "addRule" ? [rule] : [] });
    h.allow();
    await h.tracker.retry();
    assert.equal(h.operations.length, 1);
    assert.equal(h.tracker.state.failures.length, 0);
  }
});


test("retrying a failed import while a newer rule write is pending cannot erase that rule", async () => {
  let raw = api.normalizeSettings();
  let confirmed = api.normalizeSettings(raw);
  let releaseRuleWrite;
  let first = true;
  const store = globalThis.LexendPreferences.createStore({
    get: async () => structuredClone(raw),
    set: async (patch) => {
      if (releaseRuleWrite === undefined) await new Promise((resolve) => { releaseRuleWrite = resolve; });
      raw = { ...raw, ...patch };
    }
  });
  const tracker = globalThis.LexendSaveRecovery.createTracker({ getSettings: () => confirmed,
    mutate: async (operation) => {
      if (first) { first = false; throw new Error("Import failed"); }
      const saved = await store.mutate(operation);
      confirmed = saved;
      return saved;
    } });
  await assert.rejects(tracker.mutate({ type: "replace", settings: api.normalizeSettings({ textScale: 120,
    siteRules: [{ hostname: "imported.example", enabled: false }] }) }));
  const addition = tracker.mutate({ type: "addRule", rule: { hostname: "new.example", enabled: false } });
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(typeof releaseRuleWrite, "function");
  const retry = tracker.retry();
  releaseRuleWrite();
  await addition;
  await retry;
  assert.deepEqual(api.decodeSettings(raw).siteRules.map((rule) => rule.hostname), ["new.example"]);
  assert.equal(tracker.state.failures.length, 1, "A stale retry remains visible instead of replacing a newer write");
  assert.equal(tracker.state.failures[0].error.code, "STALE_IMPORT");
  await tracker.retry();
  assert.equal(api.decodeSettings(raw).textScale, 120);
  assert.deepEqual(api.decodeSettings(raw).siteRules.map((rule) => rule.hostname), ["new.example"]);
  assert.equal(tracker.state.failures.length, 0);
});


test("a newer confirmed scalar change is never overwritten by an old retry", async () => {
  const h = harness();
  await assert.rejects(h.tracker.mutate({ type: "patch", changes: { textScale: 120 } }));
  h.remote({ textScale: 130 });
  h.allow();
  await h.tracker.retry();
  assert.equal(h.settings().textScale, 130);
  assert.equal(h.tracker.state.failures[0].error.code, "STALE_SETTINGS");
  await h.tracker.retry();
  assert.equal(h.settings().textScale, 130, "Repeated Retry must not adopt the newer value as its baseline");
  await h.tracker.mutate({ type: "patch", changes: { textScale: 120 } });
  assert.equal(h.settings().textScale, 120, "An explicit new edit can intentionally replace the newer value");
  assert.equal(h.tracker.state.failures.length, 0);
});

test("a newer confirmed import field remains protected across retries", async () => {
  const h = harness();
  await assert.rejects(h.tracker.mutate({ type: "replace", settings: api.normalizeSettings({ textScale: 120 }) }));
  h.remote({ textScale: 130 });
  h.allow();
  await h.tracker.retry();
  assert.equal(h.settings().textScale, 130);
  assert.equal(h.tracker.state.failures[0].error.code, "STALE_IMPORT");
  await h.tracker.retry();
  assert.equal(h.settings().textScale, 130);
});


test("a later global pause cannot fulfil or invert a failed site-pause intent", async () => {
  const h = harness();
  await assert.rejects(h.tracker.mutate({ type: "toggleSite", hostname: "example.com" }));
  h.remote({ enabled: false });
  h.allow();
  await h.tracker.retry();
  assert.equal(h.settings().enabled, false);
  assert.equal(h.tracker.state.failures[0].error.code, "STALE_SETTINGS");
  await h.tracker.retry();
  assert.equal(h.settings().enabled, false);
  assert.equal(h.tracker.state.failures.length, 1);
});

test("a failed rule deletion cannot delete a newer confirmed rule edit", async () => {
  const h = harness();
  h.remote({ siteRules: [{ hostname: "example.com", enabled: false }] });
  await assert.rejects(h.tracker.mutate({ type: "removeRule", hostname: "example.com" }));
  h.remote({ siteRules: [{ hostname: "example.com", enabled: true, scope: "all" }] });
  h.allow();
  await h.tracker.retry();
  assert.equal(h.settings().siteRules[0].enabled, true);
  assert.equal(h.settings().siteRules[0].scope, "all");
  assert.equal(h.tracker.state.failures[0].error.code, "STALE_SETTINGS");
});


const publicFields = ["enabled", "scope", "theme", "textScale", "lineHeight", "letterSpacing", "siteRules"];
async function directClientHarness(handle) {
  let raw = api.normalizeSettings();
  const listeners = [];
  const operations = [], writes = [], states = [];
  const storage = {
    get: async () => structuredClone(raw),
    set: async (patch) => {
      raw = { ...raw, ...structuredClone(patch) };
      writes.push(api.decodeSettings(raw));
      const changes = Object.fromEntries(Object.entries(patch).map(([key, newValue]) => [key, { newValue }]));
      listeners.forEach((listener) => listener(changes, "sync"));
    }
  };
  const store = globalThis.LexendPreferences.createStore(storage);
  const client = globalThis.LexendPreferences.createClient({
    storage: { sync: storage, onChanged: { addListener: (listener) => listeners.push(listener) } },
    runtime: { sendMessage: async ({ operation }) => {
      operations.push(structuredClone(operation));
      try { return { ok: true, settings: await handle(operation, store) }; }
      catch (error) { return { ok: false, code: error.code ?? "SAVE_FAILED", message: error.message }; }
    } }
  });
  await client.load();
  const tracker = globalThis.LexendSaveRecovery.createTracker({
    mutate: (operation) => client.mutate(operation), getSettings: () => client.settings,
    getConfirmedSettings: () => client.confirmedSettings,
    onChange: (state) => states.push(state)
  });
  return { client, tracker, operations, writes, states, saved: () => api.decodeSettings(raw) };
}

test("accepted direct import retires an old failed edit even when the imported value equals its baseline", async () => {
  let rejectOldEdit = true;
  const h = await directClientHarness((operation, store) => {
    if (rejectOldEdit && operation.changes?.textScale === 120) failure();
    return store.mutate(operation);
  });
  await assert.rejects(h.tracker.mutate({ type: "patch", changes: { textScale: 120 } }));
  const reviewedImport = { type: "replace", settings: api.normalizeSettings({ textScale: 100, theme: "dark" }),
    expected: h.client.confirmedSettings };
  h.tracker.supersede(publicFields);
  assert.equal(h.operations.length, 1, "Supersession does not submit an operation");
  assert.equal(h.tracker.state.failures.length, 0);
  rejectOldEdit = false;
  await h.client.mutate(reviewedImport);
  await h.tracker.retry();
  assert.equal(h.saved().textScale, 100, "Generic Retry cannot resurrect the pre-import 120 intent");
  assert.equal(h.saved().theme, "dark");
  assert.equal(h.operations.length, 2);
  assert.deepEqual(h.operations[1], reviewedImport, "Dedicated import retains its reviewed expected snapshot");
  assert.equal(h.writes.length, 1);
});

test("a pending generic failure arriving after accepted Apply remains superseded", async () => {
  let rejectOld;
  const h = await directClientHarness((operation, store) => operation.changes?.textScale === 120
    ? new Promise((_resolve, reject) => { rejectOld = reject; }) : store.mutate(operation));
  const old = h.tracker.mutate({ type: "patch", changes: { textScale: 120 } });
  const rejected = assert.rejects(old, /Late failure/);
  assert.equal(h.tracker.state.pending, 1);
  h.tracker.supersede(publicFields);
  assert.equal(h.tracker.state.pending, 0);
  await h.client.mutate({ type: "replace", settings: api.normalizeSettings({ theme: "dark" }),
    expected: h.client.confirmedSettings });
  rejectOld(new Error("Late failure"));
  await rejected;
  assert.equal(h.tracker.state.failures.length, 0);
  await h.tracker.retry();
  assert.equal(h.operations.length, 2);
  assert.equal(h.saved().textScale, 100);
  assert.equal(h.saved().theme, "dark");
});

test("failed dedicated import and undo operations never enter or get reconstructed by generic Retry", async () => {
  for (const type of ["replace", "undoImport"]) {
    let rejectDedicated = true;
    const h = await directClientHarness((operation, store) => {
      if (operation.type === "patch") failure();
      if (rejectDedicated) throw new Error("Dedicated operation failed");
      // Workflow05 owns undo's writer implementation. This boundary test only
      // verifies its operation and reviewed snapshot stay caller-owned.
      if (operation.type === "undoImport") return api.normalizeSettings();
      return store.mutate(operation);
    });
    await assert.rejects(h.tracker.mutate({ type: "patch", changes: { textScale: 120 } }));
    const reviewed = type === "replace"
      ? { type, settings: api.normalizeSettings({ theme: "dark" }), expected: h.client.confirmedSettings }
      : { type, fields: { textScale: 100 }, expected: h.client.confirmedSettings };
    const snapshot = structuredClone(reviewed);
    h.tracker.supersede(type === "replace" ? publicFields : ["textScale"]);
    await assert.rejects(h.client.mutate(reviewed), /Dedicated operation failed/);
    await h.tracker.retry();
    assert.equal(h.tracker.state.failures.length, 0);
    assert.equal(h.operations.length, 2, "Generic Retry cannot replay a dedicated operation");
    rejectDedicated = false;
    await h.client.mutate(reviewed);
    assert.deepEqual(h.operations[1], snapshot);
    assert.deepEqual(h.operations[2], snapshot, "Dedicated retry sends exactly the original operation and expected values");
    assert.deepEqual(reviewed, snapshot);
    await h.tracker.retry();
    assert.equal(h.operations.length, 3);
  }
});

test("partial Undo supersedes only restored fields and all rule identities", async () => {
  const h = harness();
  await assert.rejects(h.tracker.mutate({ type: "patch", changes: { theme: "dark", textScale: 120 } }));
  await assert.rejects(h.tracker.mutate({ type: "addRule", rule: { hostname: "new.example", enabled: false } }));
  await assert.rejects(h.tracker.mutate({ type: "removeRule", hostname: "other.example" }));
  h.tracker.supersede(["textScale", "siteRules"]);
  assert.equal(h.tracker.state.failures.length, 1);
  assert.deepEqual(h.tracker.state.failures[0].keys, ["theme"]);
  assert.equal(h.operations.length, 3, "Supersession itself does not write");
  h.allow();
  await h.tracker.retry();
  assert.deepEqual(h.operations.at(-1).changes, { theme: "dark" });
  assert.equal(h.settings().textScale, 100);
  assert.equal(h.settings().theme, "dark");
  assert.deepEqual(h.settings().siteRules, []);
});

test("superseding part of a non-splittable toggle retires the complete operation", async () => {
  for (const restored of ["enabled", "siteRules"]) {
    const h = harness();
    h.remote({ enabled: false });
    await assert.rejects(h.tracker.mutate({ type: "toggleSite", hostname: "example.com" }));
    assert.equal(h.tracker.state.failures[0].keys.length, 2);
    h.tracker.supersede([restored]);
    assert.equal(h.tracker.state.failures.length, 0);
    h.allow();
    await h.tracker.retry();
    assert.equal(h.operations.length, 1);
    assert.equal(h.settings().enabled, false);
  }
});

test("invalid supersession validates every field before changing retry ownership", async () => {
  const h = harness();
  await assert.rejects(h.tracker.mutate({ type: "patch", changes: { theme: "dark", textScale: 120 } }));
  const before = h.tracker.state;
  for (const value of [undefined, null, "theme", {}, ["theme", "unknown"], ["textScale", null], ["theme", ,]]) {
    assert.throws(() => h.tracker.supersede(value), { code: "INVALID_OPERATION" });
    assert.deepEqual(h.tracker.state, before, "An invalid later element cannot clear an earlier valid field");
  }
  h.tracker.supersede([]);
  assert.deepEqual(h.tracker.state, before, "An empty supersession is a no-op");
  h.allow();
  await h.tracker.retry();
  assert.equal(h.settings().theme, "dark");
  assert.equal(h.settings().textScale, 120);
});
