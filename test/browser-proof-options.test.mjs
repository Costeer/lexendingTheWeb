import assert from "node:assert/strict";
import test from "node:test";
import { assertBrowserVersion, parseBrowserProofOptions } from "../scripts/browser-proof-options.mjs";

test("installed browser CLI retains stable defaults and explicit minimum-engine/custom-module intent", () => {
  assert.deepEqual(parseBrowserProofOptions(["chrome"]), { browserName: "chrome", requestedBrowserVersion: "stable", output: undefined, checks: undefined, negativeBridgeWorld: false });
  assert.deepEqual(parseBrowserProofOptions(["firefox", "--browser-version", "140", "--output", "/tmp/evidence", "--checks", "scripts/runtime-lifecycle-checks.mjs"]), {
    browserName: "firefox", requestedBrowserVersion: "140", output: "/tmp/evidence", checks: "scripts/runtime-lifecycle-checks.mjs", negativeBridgeWorld: false
  });
  assert.equal(parseBrowserProofOptions(["chrome", "--negative-bridge-world"]).negativeBridgeWorld, true);
});

test("installed browser CLI rejects malformed, missing, duplicate and unknown arguments", () => {
  for (const args of [
    [], ["chromium"], ["firefox", "chrome"], ["chrome", "--unknown"],
    ["chrome", "--browser-version"], ["chrome", "--browser-version", ""],
    ["chrome", "--browser-version", "140junk"], ["chrome", "--browser-version", "140.0."],
    ["chrome", "--browser-version", "stable", "--browser-version", "140"],
    ["chrome", "--checks"], ["chrome", "--checks", "   "], ["chrome", "--checks", "--output", "/tmp/evidence"],
    ["chrome", "--output", "relative/path"], ["chrome", "--output", "/tmp/one", "--output", "/tmp/two"],
    ["chrome", "--checks-only"], ["chrome", "--checks", "diagnostic.mjs", "--checks-only"], ["chrome", "--negative-bridge-world", "--negative-bridge-world"],
    ["chrome", "--checks", "diagnostic.mjs", "--checks-only", "--negative-bridge-world"]
  ]) assert.throws(() => parseBrowserProofOptions(args), Error, JSON.stringify(args));
});

const firefoxManifest = { browser_specific_settings: { gecko: { strict_min_version: "140.0" } } };
test("installed browser proof rejects silent engine substitution and versions below packaged minimum", () => {
  const verify = (requestedBrowserVersion, actualBrowserVersion, manifest = firefoxManifest, browserName = "firefox") => assertBrowserVersion({ browserName, requestedBrowserVersion, actualBrowserVersion, manifest });
  assert.equal(verify("140", "140.0.4"), "140.0");
  assert.equal(verify("140.0.4", "140.0.4"), "140.0");
  assert.equal(verify("stable", "158.0"), "140.0");
  assert.throws(() => verify("140", "158.0"), /Requested browser/);
  assert.throws(() => verify("140.0.4", "140.0.40"), /Requested browser/);
  assert.throws(() => verify("140.0.9007199254740993", "140.0.9007199254740992"), /Requested browser/);
  assert.throws(() => verify("stable", "139.0.8"), /below the packaged minimum/);
  assert.throws(() => verify("stable", undefined), /actual browser version/);
  assert.throws(() => verify("stable", "unknown"), /actual browser version/);
  assert.throws(() => verify("stable", "140.0.1", { minimum_chrome_version: "140.0.2" }, "chrome"), /below the packaged minimum/);
  assert.equal(verify("stable", "140.0.10", { minimum_chrome_version: "140.0.2" }, "chrome"), "140.0.2");
  assert.equal(verify("stable", "155.0.8059.39", {}, "chrome"), null);
});
