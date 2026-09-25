import assert from "node:assert/strict";
import { access, readFile } from "node:fs/promises";
import { join } from "node:path";
import test from "node:test";

const root = process.cwd();
const read = (path) => readFile(join(root, path), "utf8");
const readJson = async (path) => JSON.parse(await read(path));

await import("../src/settings.js");
await import("../src/quotes.js");

const settingsApi = globalThis.LexendSettings;

test("browser manifests describe the same extension", async () => {
  const [chrome, firefox, packageJson] = await Promise.all([
    readJson("manifests/manifest.chrome.json"),
    readJson("manifests/manifest.firefox.json"),
    readJson("package.json")
  ]);

  assert.equal(chrome.manifest_version, 3);
  assert.equal(chrome.version, packageJson.version);
  for (const key of ["name", "version", "description", "permissions", "commands"]) {
    assert.deepEqual(chrome[key], firefox[key]);
  }

  assert.deepEqual(chrome.permissions, ["storage"]);
  assert.equal(chrome.options_ui.page, "options.html");
  assert.equal(chrome.commands["toggle-current-site"].suggested_key.default,
    "Ctrl+Shift+L");
  assert.equal(firefox.browser_specific_settings.gecko.id,
    "lexend-the-web@costeer.dev");
  assert.deepEqual(
    firefox.browser_specific_settings.gecko.data_collection_permissions.required,
    ["none"]
  );
});

test("manifest runtime files exist", async () => {
  for (const target of ["chrome", "firefox"]) {
    const manifest = await readJson(`manifests/manifest.${target}.json`);
    const runtimeFiles = new Set([
      manifest.action.default_popup,
      manifest.options_ui.page,
      ...manifest.content_scripts.flatMap(({ js = [], css = [] }) => [...js, ...css]),
      ...Object.values(manifest.icons),
      ...manifest.web_accessible_resources.flatMap(({ resources }) => resources)
    ]);

    for (const path of runtimeFiles) {
      await access(join(root, path));
    }
  }
});

test("popup and settings pages expose their core controls", async () => {
  const [popup, options] = await Promise.all([
    read("popup.html"),
    read("options.html")
  ]);

  for (const id of [
    "enabled",
    "settings-button",
    "site-strip",
    "toggle-site",
    "scope-fieldset",
    "spacing-fieldset"
  ]) {
    assert.match(popup, new RegExp(`id="${id}"`));
  }

  for (const id of [
    "modern-ui",
    "advanced-mode",
    "text-scale",
    "line-height",
    "letter-spacing",
    "add-rule",
    "rule-list",
    "export-settings",
    "import-settings",
    "retry-save"
  ]) {
    assert.match(options, new RegExp(`id="${id}"`));
  }

  assert.match(popup, /src="src\/settings\.js"/);
  assert.match(options, /src="src\/settings\.js"/);
  assert.match(popup, /href="shared\.css"/);
  assert.match(options, /href="shared\.css"/);
});

test("content script reacts to page and settings changes", async () => {
  const [contentSource, popupSource] = await Promise.all([
    read("src/content.js"),
    read("popup.js")
  ]);

  assert.match(contentSource, /MutationObserver/);
  assert.match(contentSource, /shadowRoot/);
  assert.match(contentSource, /storage\.onChanged\.addListener/);
  assert.match(contentSource, /data-lexend-ignore/);
  assert.match(contentSource, /data-lexend-text-scale/);
  assert.match(contentSource, /getComputedStyle\(element\)\.fontSize/);
  assert.match(contentSource, /requestAnimationFrame/);
  assert.match(contentSource, /LEXEND_GET_STATE/);
  assert.match(popupSource, /LEXEND_GET_STATE/);
});

test("quote selection returns an entry from the shared collection", () => {
  const quotes = globalThis.LexendQuotes;

  assert.ok(Object.isFrozen(quotes.all));
  assert.ok(quotes.all.length > 1);
  assert.ok(quotes.all.includes(quotes.random()));
});

test("site rules migrate and resolve by specificity", () => {
  let settings = settingsApi.normalizeSettings({
    disabledSites: ["Example.com"],
    spacing: "wide"
  });

  assert.equal(settings.letterSpacing, 0.04);
  assert.equal(settingsApi.resolveSite(settings, "example.com").siteEnabled, false);
  assert.equal(settingsApi.resolveSite(settings, "www.example.com").siteEnabled, true);

  settings = settingsApi.setSiteRule(settings, {
    hostname: "example.com",
    includeSubdomains: true,
    enabled: false,
    scope: "body"
  });
  settings = settingsApi.setSiteRule(settings, {
    hostname: "docs.example.com",
    includeSubdomains: false,
    enabled: true,
    scope: "all"
  });

  assert.equal(settingsApi.resolveSite(settings, "shop.example.com").siteEnabled, false);
  const docs = settingsApi.resolveSite(settings, "docs.example.com");
  assert.equal(docs.siteEnabled, true);
  assert.equal(docs.scope, "all");
  assert.equal(docs.enabledRule.hostname, "docs.example.com");
  assert.equal(docs.scopeRule.hostname, "docs.example.com");

  settings = settingsApi.removeSiteRule(settings, "docs.example.com");
  assert.equal(settingsApi.resolveSite(settings, "docs.example.com").siteEnabled, false);
});

test("normalization rejects invalid values and respects the sync storage limit", () => {
  assert.equal(settingsApi.validHostname("valid-subdomain.example.com"), true);
  assert.equal(settingsApi.validHostname("-invalid.example.com"), false);

  const siteRules = Array.from({ length: 250 }, (_, index) => ({
    hostname: `site-${index}.${"a".repeat(48)}.example`,
    includeSubdomains: index % 2 === 0,
    enabled: false,
    scope: index % 2 === 0 ? "all" : "body"
  }));
  const settings = settingsApi.normalizeSettings({
    uiStyle: "lexend",
    textScale: 500,
    lineHeight: -1,
    letterSpacing: 3,
    siteRules
  });

  assert.equal(settings.textScale, 140);
  assert.equal(settings.lineHeight, 1);
  assert.equal(settings.letterSpacing, 0.2);
  assert.equal(settings.uiStyle, "lexend");
  assert.ok(JSON.stringify(settings.siteRules).length <= 7000);
  assert.ok(settings.siteRules.length < siteRules.length);

  assert.equal(settingsApi.normalizeSettings({ uiStyle: "unknown" }).uiStyle, "classic");
  assert.equal(settingsApi.normalizeSettings({ uiStyle: "modern" }).uiStyle, "lexend");
});
