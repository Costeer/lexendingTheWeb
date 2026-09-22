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
  assert.equal(firefox.browser_specific_settings.gecko.strict_min_version,
    "140.0");
  assert.deepEqual(
    firefox.browser_specific_settings.gecko.data_collection_permissions.required,
    ["none"]
  );
  assert.equal(
    firefox.browser_specific_settings.gecko_android.strict_min_version,
    "142.0"
  );
  assert.equal(chrome.options_ui.page, "options.html");
  assert.equal(chrome.commands["toggle-current-site"].suggested_key.default,
    "Ctrl+Shift+L");
  assert.equal(chrome.content_scripts[0].js[0], "src/settings.js");
});

test("content script supports both scope choices and live updates", async () => {
  const source = await readFile(join(root, "src/content.js"), "utf8");

  assert.match(source, /scope === "body"/);
  assert.match(source, /scope === "all"/);
  assert.match(source, /settings\.textScale/);
  assert.match(source, /settings\.lineHeight/);
  assert.match(source, /settings\.letterSpacing/);
  assert.match(source, /storage\.onChanged\.addListener/);
  assert.match(source, /MutationObserver/);
});

test("content font faces clamp thin text while preserving heavier weights", async () => {
  const source = await readFile(join(root, "src/content.js"), "utf8");

  assert.match(source, /fontWeightRanges = \["400", "401 900"\]/);
  assert.match(source, /font-weight: \$\{weight\}/);
  assert.doesNotMatch(source, /font-weight:\s*100 900/);
});

test("text inside icon-labelled controls remains eligible for styling", async () => {
  const source = await readFile(join(root, "src/content.js"), "utf8");

  assert.match(source, /\[class\*='icon' i\]/);
  assert.match(source, /\[class\*='symbol' i\]/);
  assert.doesNotMatch(source, /\[class\*='icon' i\] \*/);
  assert.doesNotMatch(source, /\[class\*='symbol' i\] \*/);
});

test("both surfaces share the required tokens, font, and minimum type size", async () => {
  const [shared, popupCss, optionsCss, popupHtml, optionsHtml] = await Promise.all([
    readFile(join(root, "shared.css"), "utf8"),
    readFile(join(root, "popup.css"), "utf8"),
    readFile(join(root, "options.css"), "utf8"),
    readFile(join(root, "popup.html"), "utf8"),
    readFile(join(root, "options.html"), "utf8")
  ]);

  for (const token of ["#C40000", "#111111", "#FFFFFF", "#F4F4F4", "#FAF8F4", "#444444"]) {
    assert.match(shared, new RegExp(token, "i"));
  }
  assert.match(shared, /color-scheme:\s*only light/);
  assert.match(shared, /system-ui, sans-serif/);
  assert.match(popupHtml, /href="shared\.css"/);
  assert.match(optionsHtml, /href="shared\.css"/);
  assert.match(popupCss, /scrollbar-width:\s*none/);
  assert.match(popupCss, /:root::\-webkit-scrollbar/);
  assert.equal((popupCss.match(/border-radius\s*:/g) ?? []).length, 2);
  assert.doesNotMatch(optionsCss, /border-radius\s*:/);

  for (const css of [popupCss, optionsCss]) {
    const sizes = [...css.matchAll(/font-size:\s*([\d.]+)px/g)]
      .map((match) => Number(match[1]));
    assert.ok(sizes.length > 0);
    assert.ok(sizes.every((size) => size >= 12));
  }
});

test("popup and options markup expose their required controls", async () => {
  const [popup, options] = await Promise.all([
    readFile(join(root, "popup.html"), "utf8"),
    readFile(join(root, "options.html"), "utf8")
  ]);

  assert.match(popup, /id="enabled"[^>]+type="checkbox"/);
  assert.match(popup, /id="settings-button"[^>]+aria-label="Open settings"/);
  assert.match(popup, /id="site-strip"/);
  assert.match(popup, /id="toggle-site"/);
  assert.match(popup, /name="scope"[^>]+type="radio"|type="radio"[^>]+name="scope"/);
  assert.match(popup, /name="spacing"[^>]+value="0\.08"/);
  assert.match(popup, /id="quote-preview"/);
  assert.match(popup, /id="spacing-preview-text"[^>]+tabindex="0"/);
  assert.match(popup, /id="quote-author"[^>]+href="https:\/\/en\.wikipedia\.org\/wiki\/Rosa_Luxemburg"/);
  assert.match(popup, /src="src\/quotes\.js"/);
  assert.doesNotMatch(popup, /id="next-quote"/);
  assert.match(popup, /id="restricted-note"[^>]+hidden/);
  assert.match(popup, /href="https:\/\/costeer\.dev"/);
  assert.match(popup, /made with\s*<span class="attribution-mark">☭<\/span>\s*by\s+costeer/s);
  assert.doesNotMatch(popup, /<footer|id="export-settings"|id="reset-settings"/);
  assert.doesNotMatch(popup, /<select/);
  assert.match(options, /id="rule-list"/);
  assert.match(options, /id="advanced-mode"[^>]+type="checkbox"/);
  assert.equal((options.match(/name="basicTextScale"/g) ?? []).length, 3);
  assert.equal((options.match(/name="basicLineHeight"/g) ?? []).length, 3);
  assert.equal((options.match(/name="basicLetterSpacing"/g) ?? []).length, 3);
  assert.match(options, /name="basicLetterSpacing"[\s\S]+?<span>Compact<\/span>/);
  assert.match(options, /name="basicLetterSpacing"[\s\S]+?<span>Comfortable<\/span>/);
  assert.match(options, /name="basicLetterSpacing"[\s\S]+?<span>Spacious<\/span>/);
  assert.match(popup, /name="spacing"[\s\S]+?<span>Compact<\/span>/);
  assert.match(popup, /name="spacing"[\s\S]+?<span>Comfortable<\/span>/);
  assert.match(popup, /name="spacing"[\s\S]+?<span>Spacious<\/span>/);
  assert.match(options, /id="text-scale"[^>]+type="range"[^>]+min="80"[^>]+max="140"/);
  assert.match(options, /id="line-height"[^>]+type="range"[^>]+max="29"/);
  assert.match(options, /id="letter-spacing"[^>]+type="range"[^>]+max="0\.2"/);
  assert.match(options, /id="preview-copy"[^>]+tabindex="0"/);
  assert.match(options, /id="preview-author"[^>]+href="https:\/\/en\.wikipedia\.org\/wiki\/Rosa_Luxemburg"/);
  assert.match(options, /src="src\/quotes\.js"/);
  assert.match(options, /id="export-settings"/);
  assert.match(options, /<footer class="page-attribution">/);
  assert.match(options, /href="https:\/\/costeer\.dev"/);
  assert.match(options, /made with\s*<span class="attribution-mark">☭<\/span>\s*by\s+costeer/s);
  assert.match(options, /id="retry-save"/);
  assert.match(options, /id="hostname-error"[^>]+role="alert"/);
  assert.match(options, /id="toast"[^>]+role="status"/);
  assert.doesNotMatch(options, /<select/);
});

test("popup and options mutate the same site-rule model", async () => {
  const [popup, options] = await Promise.all([
    readFile(join(root, "popup.js"), "utf8"),
    readFile(join(root, "options.js"), "utf8")
  ]);

  for (const source of [popup, options]) {
    assert.match(source, /settingsApi\.setSiteRule/);
    assert.match(source, /settingsApi\.removeSiteRule/);
    assert.match(source, /storage\?\.onChanged/);
  }
  assert.match(popup, /includeSubdomains:\s*false/);
  assert.match(options, /enabled:\s*event\.target\.checked/);
});

test("popup settings button opens the options page", async () => {
  const popup = await readFile(join(root, "popup.js"), "utf8");

  assert.match(popup, /settingsButton\.addEventListener\("click"/);
  assert.match(popup, /runtime\?\.openOptionsPage/);
  assert.match(popup, /runtime\.getURL\("options\.html"\)/);
});

test("popup and options choose from one shared random quote collection", async () => {
  const [quotes, popup, options] = await Promise.all([
    readFile(join(root, "src/quotes.js"), "utf8"),
    readFile(join(root, "popup.js"), "utf8"),
    readFile(join(root, "options.js"), "utf8")
  ]);

  for (const author of [
    "Rosa Luxemburg",
    "Karl Marx",
    "Friedrich Engels",
    "Vladimir Lenin",
    "Clara Zetkin",
    "Thomas Sankara",
    "Bertrand Russell",
    "Malcolm X",
    "Sergei Eisenstein",
    "Eugene V. Debs"
  ]) {
    assert.match(quotes, new RegExp(author.replace(".", "\\.")));
  }
  assert.match(quotes, /Math\.random\(\) \* quotes\.length/);
  assert.match(quotes, /lexendLastQuoteIndex/);
  assert.match(quotes, /globalThis\.LexendQuotes/);
  for (const source of [popup, options]) {
    assert.match(source, /quotesApi\.random\(\)/);
    assert.doesNotMatch(source, /setInterval|setTimeout\(showNextQuote|nextQuoteButton/);
  }
});

test("advanced readability is a local UI preference with full-range sliders", async () => {
  const options = await readFile(join(root, "options.js"), "utf8");

  assert.match(options, /storage\?\.local/);
  assert.match(options, /ADVANCED_PREFERENCE_KEY = "advancedReadability"/);
  assert.match(options, /lineHeightFromSlider/);
  assert.match(options, /PREVIEW_DEFAULT_LINE_HEIGHT = 1\.25/);
  assert.match(options, /readability\.lineHeight \|\| PREVIEW_DEFAULT_LINE_HEIGHT/);
  assert.match(options, /letterSpacingSlider/);
  assert.match(options, /duration:\s*190/);
  assert.match(options, /prefers-reduced-motion:\s*reduce/);
  assert.match(options, /translateX/);
  assert.doesNotMatch(options, /scale\(/);
  assert.match(options, /input\.addEventListener\("input"[\s\S]+renderPreview\(draft\)/);
  assert.match(options, /input\.addEventListener\("change"[\s\S]+save\(\{ \.\.\.settings/);
  assert.doesNotMatch(options, /sliderSaveTimer|scheduleSliderSave/);
  assert.doesNotMatch(options, /advancedReadability.*storage\.set\(settings\)/s);
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

test("legacy spacing presets migrate to independent letter spacing", async () => {
  await import("../src/settings.js");
  const api = globalThis.LexendSettings;

  assert.equal(api.normalizeSettings({ spacing: "default" }).letterSpacing, 0);
  assert.equal(api.normalizeSettings({ spacing: "wide" }).letterSpacing, 0.04);
  assert.equal(api.normalizeSettings({ spacing: "wider" }).letterSpacing, 0.08);
  assert.equal(api.normalizeSettings({ letterSpacing: 0.06 }).letterSpacing, 0.06);
});

test("legacy data and schema-2 exports round-trip without loss", async () => {
  await import("../src/settings.js");
  const api = globalThis.LexendSettings;
  const legacy = api.normalizeSettings({
    enabled: false,
    scope: "all",
    disabledSites: ["Example.com"],
    spacing: "wide",
    textScale: 115,
    lineHeight: 1.75
  });

  assert.deepEqual(legacy, {
    enabled: false,
    scope: "all",
    siteRules: [{
      hostname: "example.com",
      includeSubdomains: false,
      enabled: false,
      scope: null
    }],
    textScale: 115,
    lineHeight: 1.75,
    letterSpacing: 0.04
  });

  const original = api.normalizeSettings({
    ...legacy,
    enabled: true,
    siteRules: [
      ...legacy.siteRules,
      {
        hostname: "docs.example.com",
        includeSubdomains: true,
        enabled: null,
        scope: "all"
      }
    ],
    letterSpacing: 0.06
  });
  const file = JSON.stringify({
    schemaVersion: 2,
    exportedAt: "2026-01-01T00:00:00.000Z",
    settings: original
  });
  const imported = api.normalizeSettings(JSON.parse(file).settings);
  assert.deepEqual(imported, original);
});

test("an exact popup override and an options toggle preserve rule data", async () => {
  await import("../src/settings.js");
  const api = globalThis.LexendSettings;
  let settings = api.normalizeSettings({
    siteRules: [{
      hostname: "example.com",
      includeSubdomains: true,
      enabled: false,
      scope: "body"
    }]
  });

  settings = api.setSiteRule(settings, {
    hostname: "docs.example.com",
    includeSubdomains: false,
    enabled: true
  });
  assert.equal(api.resolveSite(settings, "docs.example.com").siteEnabled, true);
  assert.equal(api.resolveSite(settings, "shop.example.com").siteEnabled, false);

  settings = api.setSiteRule(settings, {
    hostname: "example.com",
    includeSubdomains: true,
    enabled: true
  });
  const updated = api.getDirectRule(settings, "example.com", true);
  assert.equal(updated.enabled, true);
  assert.equal(updated.scope, "body");
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
