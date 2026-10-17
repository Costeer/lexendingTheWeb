import assert from "node:assert/strict";
import { isAbsolute } from "node:path";

export function parseBrowserArguments(args) {
  const browserName = args[0] ?? "chrome";
  assert(["chrome", "firefox"].includes(browserName), "Choose chrome or firefox.");
  let browserVersion = "stable", output;
  const seen = new Set();
  for (let index = 1; index < args.length; index += 2) {
    const option = args[index], value = args[index + 1];
    assert(["--browser-version", "--output"].includes(option) && value && !seen.has(option), `Invalid or repeated option: ${option}`);
    seen.add(option);
    if (option === "--browser-version") {
      assert(value === "stable" || /^\d+(?:\.\d+)*$/.test(value), "Browser version must be stable or a numeric version.");
      browserVersion = value;
    } else {
      assert(isAbsolute(value), "--output must be an absolute report directory.");
      output = value;
    }
  }
  return { browserName, browserVersion, output };
}

export function assertBrowserVersion(actual, requested, minimum) {
  assert(/^\d+(?:\.\d+)*(?:[a-z].*)?$/i.test(actual ?? ""), `Browser did not report a usable version: ${actual}`);
  const parts = actual.split(".").map((part) => parseInt(part, 10));
  if (requested !== "stable") {
    assert(requested.split(".").every((part, index) => Number(part) === parts[index]),
      `Requested browser ${requested}, but actually launched ${actual}`);
  }
  if (minimum) {
    const floor = minimum.split(".").map(Number);
    let comparison = 0;
    for (let index = 0; index < Math.max(parts.length, floor.length); index++) {
      comparison = (parts[index] ?? 0) - (floor[index] ?? 0);
      if (comparison) break;
    }
    assert(comparison >= 0, `Launched browser ${actual} is below the packaged manifest minimum ${minimum}`);
  }
}

// Only a trusted pageshow from the original document proves BFCache reuse.
// A synthetic event or a re-created document must never count as a pass.
export function isPersistedRestoration(before, after) {
  assert(before.token && after.token, "History fixture must identify both documents");
  assert(Array.isArray(after.pageshow) && after.pageshow.length, "History fixture must record pageshow");
  const event = after.pageshow.at(-1);
  assert.equal(event.trusted, true, "History evidence must come from a browser-generated pageshow");
  if (!event.persisted) return false;
  assert.equal(after.token, before.token, "Persisted restoration must reuse the original document");
  assert(after.pageshow.length > before.pageshow.length, "Restoration must append a new pageshow event");
  assert(after.pagehide.some((entry) => entry.trusted && entry.persisted), "Cached document must have entered BFCache");
  return true;
}
