import assert from "node:assert/strict";
export { parseBrowserArguments, assertVersion as assertBrowserVersion } from "./browser-proof-options.mjs";

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
