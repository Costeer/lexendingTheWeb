import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { runInNewContext } from "node:vm";
import test from "node:test";
import "../src/settings.js";
import "../src/diagnostics.js";

const { collect, sanitizeBuildIdentity } = globalThis.LexendDiagnostics;
const buildIdentity = { schemaVersion: 1, version: "0.5.0", target: "chrome", sourceHash: "a".repeat(64) };

test("diagnostics exports an allowlist and never page data, URLs, rules, raw UA or error text", async () => {
  const privateValue = "https://private.example/secret-page-text";
  const calls = [];
  const report = await collect({
    buildIdentity: { ...buildIdentity, remote: privateValue, gitPath: privateValue },
    navigator: { userAgent: `Mozilla/5.0 Chrome/150.0.0.0 ${privateValue}` },
    extension: {
      storage: { sync: { async get(keys) {
        calls.push(["settings", keys]);
        return { enabled: false, scope: "all", theme: "dark", textScale: 999, lineHeight: 1.5,
          letterSpacing: .03, siteRules: [{ hostname: privateValue }], disabledSites: [privateValue], text: privateValue };
      } } },
      tabs: {
        async query(filter) { calls.push(["query", filter]); return [{ id: 17, url: privateValue, title: privateValue }]; },
        async sendMessage(...args) {
          calls.push(["message", ...args]);
          return { ready: true, pending: false, healthy: false, active: true, layoutRepair: true, refreshRevision: 45, scope: "body",
            error: privateValue, hostname: privateValue, textContent: privateValue, arbitraryCounter: privateValue };
        }
      }
    }
  });
  assert.deepEqual(report, {
    schemaVersion: 1, build: buildIdentity,
    browser: { name: "Chromium", version: "150.0.0.0", source: "user-agent" },
    settings: { status: "available", enabled: false, layoutRepair: false, scope: "all", theme: "dark", textScale: 140, lineHeight: 1.5, letterSpacing: .03 },
    runtime: { status: "available", ready: true, pending: false, healthy: false, active: true, layoutRepair: true, refreshRevision: 45, scope: "body", hasError: true }
  });
  assert.doesNotMatch(JSON.stringify(report), /private|https:|siteRules|disabledSites|textContent|hostname|gitPath|arbitraryCounter/);
  assert.deepEqual(calls.find(([kind]) => kind === "query"), ["query", { active: true, currentWindow: true }]);
  assert.deepEqual(calls.find(([kind]) => kind === "message"), ["message", 17, { type: "LEXEND_GET_STATE" }, { frameId: 0 }]);
  assert(!calls[0][1].includes("siteRules"), "site rules must not even be requested from storage");
  assert(JSON.stringify(report).length < 1024);
});

test("a tab-based About page reports the most recently used other tab, never itself", async () => {
  const messages = [];
  const report = await collect({ buildIdentity, navigator: {}, extension: { tabs: {
    async getCurrent() { return { id: 9 }; },
    async query(filter) {
      assert.deepEqual(filter, { currentWindow: true });
      return [{ id: 9, lastAccessed: 300 }, { id: 4, lastAccessed: 200, url: "https://private.example" }, { id: 5, lastAccessed: 100 }];
    },
    async sendMessage(tabId) { messages.push(tabId); return { ready: true, pending: false, healthy: true, active: true }; }
  } } });
  assert.deepEqual(messages, [4]);
  assert.deepEqual(report.runtime, { status: "available", source: "recent-tab", ready: true, pending: false, healthy: true, active: true, hasError: false });
  assert.doesNotMatch(JSON.stringify(report), /private/);

  const popup = await collect({ buildIdentity, navigator: {}, extension: { tabs: {
    async getCurrent() { return undefined; },
    async query(filter) { assert.deepEqual(filter, { active: true, currentWindow: true }); return [{ id: 4 }]; },
    async sendMessage() { return { ready: true }; }
  } } });
  assert.deepEqual(popup.runtime, { status: "available", ready: true, hasError: false }, "the popup reports the page it was opened over");
});

test("browser API reports actual Firefox version without returning arbitrary metadata", async () => {
  const report = await collect({ buildIdentity, extension: {
    runtime: { getBrowserInfo: async () => ({ name: "Firefox", version: "145.0.1", vendor: "private.example", buildID: "secret" }) }
  } });
  assert.deepEqual(report.browser, { name: "Firefox", version: "145.0.1", source: "browser-api" });
  assert.deepEqual(report.runtime, { status: "unavailable" });
  assert.deepEqual(report.settings, { status: "unavailable" });
});

test("Chromium full-version API requests and exports only recognized product/version data", async () => {
  let requested;
  const report = await collect({ buildIdentity, extension: {}, navigator: {
    userAgent: "Chrome/150.0.0.0",
    userAgentData: { async getHighEntropyValues(fields) {
      requested = fields;
      return { architecture: "private-architecture", model: "private-model", fullVersionList: [
        { brand: "private-brand", version: "private-version" },
        { brand: "Chromium", version: "150.0.1234.56" },
        { brand: "Google Chrome", version: "150.0.1234.56" }
      ] };
    } }
  } });
  assert.deepEqual(requested, ["fullVersionList"]);
  assert.deepEqual(report.browser, { name: "Chrome", version: "150.0.1234.56", source: "user-agent-data" });
  assert.doesNotMatch(JSON.stringify(report), /private|architecture|model|fullVersionList/);

  const fallback = await collect({ extension: {}, navigator: {
    userAgent: "Chrome/150.0.0.0",
    userAgentData: { async getHighEntropyValues() { return { fullVersionList: [{ brand: "Google Chrome", version: "https://secret.example" }] }; } }
  } });
  assert.deepEqual(fallback.browser, { name: "Chromium", version: "150.0.0.0", source: "user-agent" });
});

test("unavailable/restricted contexts and rejected APIs stay useful and disclose no errors", async () => {
  const fail = async () => { throw new Error("https://secret.example"); };
  const report = await collect({ buildIdentity: { ...buildIdentity, sourceHash: "https://secret.example" },
    extension: { runtime: { getBrowserInfo: fail }, storage: { sync: { get: fail } }, tabs: { query: fail, sendMessage: fail } },
    navigator: { userAgent: "private user agent" }
  });
  assert.deepEqual(report, { schemaVersion: 1, build: null, browser: { status: "unavailable" }, settings: { status: "unavailable" }, runtime: { status: "unavailable" } });
});

test("malformed runtime fields cannot carry strings into diagnostic counters or booleans", async () => {
  const report = await collect({ buildIdentity, navigator: {}, extension: { tabs: {
    query: async () => [{ id: 1 }],
    sendMessage: async () => ({ ready: false, pending: "private", healthy: [], active: {}, refreshRevision: Infinity, scope: "private", error: null })
  } } });
  assert.deepEqual(report.runtime, { status: "available", ready: false, hasError: false });
  assert.equal(sanitizeBuildIdentity({ ...buildIdentity, version: "private.example" }), null);
  assert.equal(sanitizeBuildIdentity({ ...buildIdentity, target: "https://private.example" }), null);
});

test("loading the diagnostics helper neither reads browser state nor starts background collection", async () => {
  const source = await readFile(new URL("../src/diagnostics.js", import.meta.url), "utf8");
  const unexpected = () => assert.fail("collection must require a user action");
  const context = { browser: new Proxy({}, { get: unexpected }), fetch: unexpected, setTimeout: unexpected };
  runInNewContext(source, context);
  assert.equal(typeof context.LexendDiagnostics.collect, "function");
});

test("stalled browser APIs time out without preventing a local diagnostic report", async () => {
  const source = await readFile(new URL("../src/diagnostics.js", import.meta.url), "utf8");
  const timers = new Map();
  const pending = () => new Promise(() => {});
  const context = {
    setTimeout(callback, milliseconds) { timers.set(callback, milliseconds); return callback; },
    clearTimeout(callback) { timers.delete(callback); },
    LexendSettings: globalThis.LexendSettings
  };
  runInNewContext(source, context);
  const completion = context.LexendDiagnostics.collect({ buildIdentity, navigator: {}, extension: {
    runtime: { getBrowserInfo: pending }, storage: { sync: { get: pending } }, tabs: { query: pending, sendMessage: pending }
  } });
  assert.equal(timers.size, 3);
  for (const [callback, milliseconds] of timers) {
    assert.equal(milliseconds, 1500);
    callback();
  }
  const report = await completion;
  for (const key of ["settings", "runtime", "browser"]) assert.equal(report[key].status, "unavailable");
  assert.equal(timers.size, 0);
});
