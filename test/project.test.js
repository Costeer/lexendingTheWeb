import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import test from "node:test";

const root = process.cwd();

test("both manifests expose the same user-facing capability", async () => {
  const chrome = JSON.parse(await readFile(
    join(root, "manifests/manifest.chrome.json"),
    "utf8"
  ));
  const firefox = JSON.parse(await readFile(
    join(root, "manifests/manifest.firefox.json"),
    "utf8"
  ));

  for (const key of ["name", "version", "description", "permissions"]) {
    assert.deepEqual(chrome[key], firefox[key]);
  }

  assert.equal(firefox.browser_specific_settings.gecko.id,
    "lexend-the-web@costeer.dev");
});

test("content script supports both scope choices and live updates", async () => {
  const source = await readFile(join(root, "src/content.js"), "utf8");

  assert.match(source, /scope === "body"/);
  assert.match(source, /scope === "all"/);
  assert.match(source, /storage\.onChanged\.addListener/);
  assert.match(source, /MutationObserver/);
});

test("text inside icon-labelled controls remains eligible for styling", async () => {
  const source = await readFile(join(root, "src/content.js"), "utf8");

  assert.match(source, /\[class\*='icon' i\]/);
  assert.match(source, /\[class\*='symbol' i\]/);
  assert.doesNotMatch(source, /\[class\*='icon' i\] \*/);
  assert.doesNotMatch(source, /\[class\*='symbol' i\] \*/);
});

test("the interface has square corners and a fixed light palette", async () => {
  const css = await readFile(join(root, "popup.css"), "utf8");

  assert.doesNotMatch(css, /border-radius\s*:/);
  assert.match(css, /color-scheme: only light/);
  assert.match(css, /#c70000/gi);
});
