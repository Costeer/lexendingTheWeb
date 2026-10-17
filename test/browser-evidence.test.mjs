import assert from "node:assert/strict";
import test from "node:test";
import { assertBrowserVersion, isPersistedRestoration, parseBrowserArguments } from "../scripts/browser-evidence.mjs";

test("installed browser requests cannot silently use stable instead of the supported minimum", () => {
  assert.deepEqual(parseBrowserArguments(["firefox", "--browser-version", "140.0", "--output", "/tmp/browser-report"]),
    { browserName: "firefox", browserVersion: "140.0", output: "/tmp/browser-report" });
  assertBrowserVersion("140.0.4", "140.0", "140.0");
  assertBrowserVersion("151.0", "stable", "140.0");
  assert.throws(() => assertBrowserVersion("151.0", "140.0", "140.0"), /actually launched/);
  assert.throws(() => assertBrowserVersion("139.9", "stable", "140.0"), /below/);
  assert.throws(() => assertBrowserVersion(undefined, "stable", "140.0"), /usable version/);
  assert.throws(() => parseBrowserArguments(["firefox", "--browser-version", "stable", "--browser-version", "140"]), /repeated/);
  assert.throws(() => parseBrowserArguments(["chrome", "--output", "relative"]), /absolute/);
});

test("BFCache evidence rejects synthetic events, reloads and reused old observations", () => {
  const initial = { token: "document-a", pageshow: [{ persisted: false, trusted: true }], pagehide: [] };
  const restored = { token: "document-a", pageshow: [...initial.pageshow, { persisted: true, trusted: true }], pagehide: [{ persisted: true, trusted: true }] };
  assert.equal(isPersistedRestoration(initial, restored), true);
  assert.equal(isPersistedRestoration(initial, { ...initial, token: "new-document" }), false);
  assert.throws(() => isPersistedRestoration(initial, { ...restored, token: "new-document" }), /original document/);
  assert.throws(() => isPersistedRestoration(initial, { ...restored, pageshow: [...initial.pageshow, { persisted: true, trusted: false }] }), /browser-generated/);
  assert.throws(() => isPersistedRestoration(restored, restored), /new pageshow/);
  assert.throws(() => isPersistedRestoration(initial, { ...restored, pagehide: [] }), /entered BFCache/);
});
