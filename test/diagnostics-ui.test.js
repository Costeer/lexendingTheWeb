import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { runInNewContext } from "node:vm";
import test from "node:test";
import "../src/settings.js";

const diagnosticsSource = await readFile(new URL("../src/diagnostics.js", import.meta.url), "utf8");
const uiSource = await readFile(new URL("../src/diagnostics-ui.js", import.meta.url), "utf8");
const build = { schemaVersion: 1, version: "0.5.0", target: "chrome", sourceHash: "b".repeat(64) };

function openPopup({ restricted = false, downloadFails = false } = {}) {
  const calls = [];
  const timers = new Set();
  let click;
  let downloaded;
  let blob;
  const status = { textContent: "" };
  const button = {
    dataset: { diagnosticsStatus: "popup-diagnostics-status" }, disabled: false,
    addEventListener(type, listener) { assert.equal(type, "click"); click = listener; }
  };
  const link = {
    click() {
      if (downloadFails) throw new Error("Download blocked");
      downloaded = { href: this.href, filename: this.download };
    },
    remove() { calls.push("remove-link"); }
  };
  const context = {
    Blob, AbortController, LexendSettings: globalThis.LexendSettings,
    setTimeout(callback) { timers.add(callback); return callback; },
    clearTimeout(callback) { timers.delete(callback); },
    URL: { createObjectURL(value) { blob = value; return "blob:local-report"; }, revokeObjectURL(value) { calls.push(["revoke", value]); } },
    document: {
      getElementById(id) { return id === "popup-diagnostics-status" ? status : null; },
      querySelectorAll(selector) { assert.equal(selector, "[data-diagnostics-export]"); return [button]; },
      createElement(tag) { assert.equal(tag, "a"); return link; },
      body: { append(value) { assert.equal(value, link); } }
    },
    fetch: async (url) => {
      calls.push(["fetch", url]);
      return { ok: true, json: async () => build };
    },
    browser: {
      runtime: { getURL: (path) => `chrome-extension://extension-id/${path}` },
      storage: { sync: { get: async () => ({ enabled: true }) } },
      tabs: {
        async query(filter) { calls.push(["query", JSON.parse(JSON.stringify(filter))]); return [{ id: 31, url: "https://private.example" }]; },
        async sendMessage(id, message, options) {
          calls.push(["message", id, JSON.parse(JSON.stringify(message)), JSON.parse(JSON.stringify(options))]);
          if (restricted) throw new Error("Cannot access https://private.example");
          return { ready: true, active: true, pending: false, healthy: true, refreshRevision: 3, hostname: "private.example", error: null };
        }
      }
    }
  };
  runInNewContext(diagnosticsSource, context);
  runInNewContext(uiSource, context);
  return { calls, button, status, click: () => click(), report: async () => JSON.parse(await blob.text()),
    download: () => downloaded, flushTimers: () => { for (const timer of timers) timer(); } };
}

test("popup export uses the active website only after click and downloads a sanitized local report", async () => {
  const popup = openPopup();
  assert.deepEqual(popup.calls, [], "popup must not prefetch identity or collect diagnostics before a click");
  await popup.click();
  const report = await popup.report();
  assert.deepEqual(popup.calls.find((call) => call[0] === "query"), ["query", { active: true, currentWindow: true }]);
  assert.deepEqual(popup.calls.find((call) => call[0] === "message"), ["message", 31, { type: "LEXEND_GET_STATE" }, { frameId: 0 }]);
  assert.deepEqual(popup.calls.find((call) => call[0] === "fetch"), ["fetch", "chrome-extension://extension-id/build-identity.json"]);
  assert.deepEqual(report.build, build);
  assert.equal(report.runtime.status, "available");
  assert.equal(report.runtime.refreshRevision, 3);
  assert.doesNotMatch(JSON.stringify(report), /private|https:|hostname/);
  assert.deepEqual(popup.download(), { href: "blob:local-report", filename: "lexend-the-web-diagnostics.json" });
  assert.equal(popup.button.disabled, false);
  assert.equal(popup.status.textContent, "Diagnostics saved locally. Nothing was sent.");
  popup.flushTimers();
  assert(popup.calls.some((call) => call[0] === "revoke"));
});

test("restricted active pages still export build/settings without fabricating a healthy runtime", async () => {
  const popup = openPopup({ restricted: true });
  await popup.click();
  assert.deepEqual((await popup.report()).runtime, { status: "unavailable" });
  assert.equal((await popup.report()).build.sourceHash, build.sourceHash);
});

test("failed downloads restore the popup button and show a retryable local error", async () => {
  const popup = openPopup({ downloadFails: true });
  await popup.click();
  assert.equal(popup.button.disabled, false);
  assert.equal(popup.status.textContent, "Diagnostics could not be saved. Try again.");
  assert.equal(popup.download(), undefined);
  assert(popup.calls.includes("remove-link"));
});
