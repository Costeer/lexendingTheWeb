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
  assert.equal(chrome.options_ui.page, "options.html");
  assert.equal(chrome.commands["toggle-current-site"].suggested_key.default,
    "Ctrl+Shift+L");
  assert.equal(chrome.content_scripts[0].js[0], "src/settings.js");
});

test("content script supports both scope choices and live updates", async () => {
  const source = await readFile(join(root, "src/content.js"), "utf8");

  assert.match(source, /scope === "body"/);
  assert.match(source, /scope === "all"/);
  assert.match(source, /spacingValues/);
  assert.match(source, /letter-spacing: \$\{spacing\.letter\}/);
  assert.match(source, /word-spacing: \$\{spacing\.word\}/);
  assert.match(source, /settings\.textScale/);
  assert.match(source, /settings\.lineHeight/);
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
  const [popupCss, optionsCss] = await Promise.all([
    readFile(join(root, "popup.css"), "utf8"),
    readFile(join(root, "options.css"), "utf8")
  ]);

  for (const css of [popupCss, optionsCss]) {
    const pixelFontSizes = [...css.matchAll(/font-size:\s*(\d+)px/g)]
      .map((match) => Number(match[1]));
    assert.doesNotMatch(css, /border-radius\s*:/);
    assert.match(css, /color-scheme: only light/);
    assert.match(css, /#c70000/gi);
    assert.ok(pixelFontSizes.every((size) => size >= 12));
  }
  assert.match(popupCss, /scrollbar-width:\s*none/);
  assert.match(popupCss, /:root::\-webkit-scrollbar/);
  assert.equal((popupCss.match(/box-shadow\s*:/g) ?? []).length, 2);
  assert.equal((optionsCss.match(/box-shadow\s*:/g) ?? []).length, 1);
});

test("popup and options markup expose their required controls", async () => {
  const [popup, options] = await Promise.all([
    readFile(join(root, "popup.html"), "utf8"),
    readFile(join(root, "options.html"), "utf8")
  ]);

  assert.match(popup, /id="status"/);
  assert.match(popup, /id="site-scope"/);
  assert.match(popup, /id="site-match"/);
  assert.match(popup, /id="open-options"/);
  assert.match(popup, /aria-label="Settings file"/);
  assert.doesNotMatch(popup, /aria-labelledby="transfer-label"/);
  assert.match(options, /id="rule-list"/);
  assert.match(options, /id="text-scale"/);
  assert.match(options, /id="readability-preview"/);
  assert.match(options, /id="export-settings"/);
});

test("popup exposes readable global, site, spacing, and recovery controls", async () => {
  const [html, css, script] = await Promise.all([
    readFile(join(root, "popup.html"), "utf8"),
    readFile(join(root, "popup.css"), "utf8"),
    readFile(join(root, "popup.js"), "utf8")
  ]);

  assert.match(html, /id="enabled-state">On/);
  assert.match(html, /id="site-action"/);
  assert.match(html, /name="spacing" value="default"/);
  assert.match(html, /name="spacing" value="wide"/);
  assert.match(html, /name="spacing" value="wider"/);
  assert.match(html, /Browser pages like settings and new tab can’t be changed/);
  assert.match(html, />\s*Export settings\s*</);
  assert.match(html, />\s*Import settings\s*</);
  assert.match(html, /id="reset-settings"/);
  assert.match(css, /\.choice\.is-selected\s*{[^}]*background:\s*#fff0f0/s);
  assert.match(css, /\.switch-track\s*{[^}]*background:\s*#b8b8b8/s);
  assert.match(script, /settingsApi\.normalizeSettings/);
  assert.match(script, /Reset to defaults/);
});

test("site rules support migration, subdomains, and exact-host overrides", async () => {
  await import("../src/settings.js");
  const api = globalThis.LexendSettings;
  let settings = api.normalizeSettings({
    disabledSites: ["example.com"]
  });

  assert.equal(api.resolveSite(settings, "example.com").siteEnabled, false);
  assert.equal(api.resolveSite(settings, "www.example.com").siteEnabled, true);

  settings = api.setSiteRule(settings, {
    hostname: "example.com",
    includeSubdomains: true,
    enabled: false,
    scope: "body"
  });
  settings = api.setSiteRule(settings, {
    hostname: "docs.example.com",
    includeSubdomains: false,
    enabled: true,
    scope: "all"
  });

  assert.equal(api.resolveSite(settings, "shop.example.com").siteEnabled, false);
  assert.equal(api.resolveSite(settings, "docs.example.com").siteEnabled, true);
  assert.equal(api.resolveSite(settings, "docs.example.com").scope, "all");
  assert.equal(api.resolveSite(settings, "unrelated.test").siteEnabled, true);
  assert.equal(api.validHostname("valid-subdomain.example.com"), true);
  assert.equal(api.validHostname("-invalid.example.com"), false);
});

test("spacing presets migrate numeric drafts and pair letter with word spacing", async () => {
  await import("../src/settings.js");
  const api = globalThis.LexendSettings;

  assert.equal(api.normalizeSettings({ letterSpacing: 0.04 }).spacing, "wide");
  assert.equal(api.normalizeSettings({ letterSpacing: 0.08 }).spacing, "wider");
  assert.deepEqual(api.spacingValues.wide, { letter: 0.04, word: 0.12 });
  assert.deepEqual(api.spacingValues.wider, { letter: 0.08, word: 0.24 });
});

test("site rules remain within synchronized-storage item limits", async () => {
  await import("../src/settings.js");
  const api = globalThis.LexendSettings;
  const siteRules = Array.from({ length: 250 }, (_, index) => ({
    hostname: `site-${index}.${"a".repeat(48)}.example`,
    includeSubdomains: index % 2 === 0,
    enabled: false,
    scope: index % 2 === 0 ? "all" : "body"
  }));
  const settings = api.normalizeSettings({ siteRules });

  assert.ok(JSON.stringify(settings.siteRules).length <= 7000);
  assert.ok(settings.siteRules.length < siteRules.length);
});
