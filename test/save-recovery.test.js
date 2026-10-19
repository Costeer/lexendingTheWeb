import assert from "node:assert/strict";
import test from "node:test";
import { createMemoryStorage, mutationResponse } from "./helpers/memory-storage.js";
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

test("replacement and Undo require dedicated recovery without retiring generic failures", async () => {
  const h = harness();
  await assert.rejects(h.tracker.mutate({ type: "patch", changes: { theme: "dark" } }));
  for (const type of ["replace", "undoImport"]) {
    await assert.rejects(h.tracker.mutate({ type }), { code: "INVALID_OPERATION" });
  }
  assert.equal(h.operations.length, 1);
  assert.deepEqual(h.tracker.state.failures[0].keys, ["theme"]);
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

const publicFields = ["enabled", "layoutRepair", "scope", "theme", "textScale", "lineHeight", "letterSpacing", "siteRules"];
async function directClientHarness(handle) {
  const memory = createMemoryStorage(api.normalizeSettings());
  const operations = [], writes = [], states = [];
  const storage = { ...memory.storage, async set(patch) {
    await memory.storage.set(patch);
    writes.push(api.decodeSettings(memory.saved()));
  } };
  const store = globalThis.LexendPreferences.createStore(storage);
  const client = globalThis.LexendPreferences.createClient({
    storage: { sync: storage, onChanged: memory.onChanged },
    runtime: { sendMessage: async ({ operation }) => {
      operations.push(structuredClone(operation));
      return mutationResponse(() => handle(operation, store));
    } }
  });
  await client.load();
  const tracker = globalThis.LexendSaveRecovery.createTracker({
    mutate: (operation) => client.mutate(operation), getSettings: () => client.settings,
    getConfirmedSettings: () => client.confirmedSettings,
    onChange: (state) => states.push(state)
  });
  return { client, tracker, operations, writes, states, saved: () => api.decodeSettings(memory.saved()) };
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
      return store.mutate(operation);
    });
    await assert.rejects(h.tracker.mutate({ type: "patch", changes: { textScale: 120 } }));
    const reviewed = type === "replace"
      ? { type, settings: api.normalizeSettings({ theme: "dark" }), expected: h.client.confirmedSettings }
      : { type, before: api.normalizeSettings({ textScale: 110 }), after: api.normalizeSettings(),
        expected: h.client.confirmedSettings };
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

test("a failed toggle owns only its rule, and superseding the rule collection retires it", async () => {
  const h = harness();
  await assert.rejects(h.tracker.mutate({ type: "toggleSite", hostname: "example.com" }));
  assert.deepEqual(h.tracker.state.failures[0].keys, ["rule:example.com:false"]);
  h.tracker.supersede(["enabled"]);
  assert.equal(h.tracker.state.failures.length, 1, "the master switch is not part of a site toggle");
  h.tracker.supersede(["siteRules"]);
  assert.equal(h.tracker.state.failures.length, 0);
  h.allow();
  await h.tracker.retry();
  assert.equal(h.operations.length, 1);
  assert.deepEqual(h.settings().siteRules, []);
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

test("failed rule updates keep their original full-rule guard across external changes", async () => {
  const h = harness();
  h.remote({ siteRules: [{ hostname: "example.com", enabled: false, scope: "body" }] });
  await assert.rejects(h.tracker.mutate({ type: "updateRule", hostname: "example.com", includeSubdomains: false,
    changes: { enabled: true } }));
  h.remote({ siteRules: [{ hostname: "example.com", enabled: false, scope: "all" }] });
  h.allow();
  for (let retry = 0; retry < 2; retry++) {
    await h.tracker.retry();
    assert.deepEqual(h.settings().siteRules[0], { hostname: "example.com", includeSubdomains: false, enabled: false, scope: "all" });
    assert.equal(h.tracker.state.failures[0].error.code, "STALE_SETTINGS");
  }
});

test("lost rule update replies recognize identity renames and inherit-both removal", async () => {
  for (const changes of [{ includeSubdomains: true, scope: "all" }, { enabled: null, scope: null }]) {
    let raw = api.normalizeSettings({ siteRules: [{ hostname: "example.com", enabled: false, scope: "body" }] });
    let calls = 0;
    const store = globalThis.LexendPreferences.createStore({ get: async () => raw,
      set: async (patch) => { raw = { ...raw, ...patch }; } });
    const tracker = globalThis.LexendSaveRecovery.createTracker({ getSettings: () => api.decodeSettings(raw),
      mutate: async (operation) => { calls++; await store.mutate(operation); throw new Error("Reply lost"); } });
    await assert.rejects(tracker.mutate({ type: "updateRule", hostname: "example.com", includeSubdomains: false, changes }));
    const committed = api.decodeSettings(raw);
    await tracker.retry();
    assert.equal(calls, 1, "No replay can rename, recreate or edit another identity");
    assert.deepEqual(api.decodeSettings(raw), committed);
    assert.equal(tracker.state.failures.length, 0);
  }
});

test("new rule intent at either side of a failed rename supersedes that indivisible update", async () => {
  for (const mode of [false, true]) {
    const h = harness();
    h.remote({ siteRules: [{ hostname: "example.com", enabled: false }] });
    await assert.rejects(h.tracker.mutate({ type: "updateRule", hostname: "EXAMPLE.COM.", includeSubdomains: false,
      changes: { includeSubdomains: true, scope: "all" } }));
    await assert.rejects(h.tracker.mutate({ type: "addRule", rule: { hostname: "unrelated.example", enabled: false } }));
    h.allow();
    if (mode) await h.tracker.mutate({ type: "addRule", rule: { hostname: "example.com", includeSubdomains: true, enabled: true } });
    else await h.tracker.mutate({ type: "removeRule", hostname: "example.com", includeSubdomains: false });
    assert.equal(h.tracker.state.failures.length, 1, "Only unrelated rule intent survives");
    assert.match(h.tracker.state.failures[0].keys[0], /unrelated.example/);
    await h.tracker.retry();
    assert.equal(h.operations.filter((operation) => operation.type === "updateRule").length, 1);
    assert.equal(api.getDirectRule(h.settings(), "unrelated.example"), null,
      "An unrelated rule edit still uses the conservative whole-collection guard");
    assert.equal(h.tracker.state.failures.length, 1);
    assert.equal(h.tracker.state.failures[0].error.code, "STALE_SETTINGS");
    await h.tracker.mutate({ type: "addRule", rule: { hostname: "unrelated.example", enabled: false } });
    assert.ok(api.getDirectRule(h.settings(), "unrelated.example"), "A reviewed new edit remains actionable");
    assert.equal(h.tracker.state.failures.length, 0);
  }
});

test("repair lost acknowledgements retire fulfilled site intent and global retries preserve newer intent", async () => {
  const h = harness();
  await assert.rejects(h.tracker.mutate({ type: "setSiteLayoutRepair", hostname: "example.com", value: true }));
  h.remote({ siteRules: [{ hostname: "example.com", enabled: false, layoutRepair: true }] });
  const attempts = h.operations.length;
  h.allow();
  await h.tracker.retry();
  assert.equal(h.operations.length, attempts);
  assert.equal(h.settings().enabled, true);
  assert.equal(h.settings().siteRules[0].enabled, false);
  h.reject();
  await assert.rejects(h.tracker.mutate({ type: "patch", changes: { layoutRepair: true, textScale: 120 } }));
  h.allow();
  await h.tracker.mutate({ type: "patch", changes: { layoutRepair: false } });
  await h.tracker.retry();
  assert.equal(h.settings().layoutRepair, false);
  assert.equal(h.settings().textScale, 120);
});

test("failed repair retries reject newer rule values rather than erasing them", async () => {
  const h = harness();
  await assert.rejects(h.tracker.mutate({ type: "setSiteLayoutRepair", hostname: "example.com", value: true }));
  h.remote({ siteRules: [{ hostname: "example.com", layoutRepair: false }] });
  h.allow();
  await h.tracker.retry();
  assert.equal(h.settings().siteRules[0].layoutRepair, false);
  assert.equal(h.tracker.state.failures[0].error.code, "STALE_SETTINGS");
});
