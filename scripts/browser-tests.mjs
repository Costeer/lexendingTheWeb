import assert from "node:assert/strict";
import { createServer } from "node:http";
import { mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { Builder, By, Key } from "selenium-webdriver";
import chrome from "selenium-webdriver/chrome.js";
import firefox from "selenium-webdriver/firefox.js";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const browserName = process.argv[2] ?? "chrome";
if (!["chrome", "firefox"].includes(browserName)) throw new Error("Choose chrome or firefox.");
const fixture = await readFile(join(root, "scripts/fixtures/compatibility.html"), "utf8");
const server = createServer((request, response) => {
  response.setHeader("Content-Type", "text/html; charset=utf-8");
  response.end(request.url === "/frame" ? "<!doctype html><p id='frame-text'>Frame text</p>" : fixture);
});
await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
const fixtureUrl = `http://127.0.0.1:${server.address().port}/`;
const artifactDirectory = join(root, "dist/browser-tests", browserName);
await mkdir(artifactDirectory, { recursive: true });
const profile = await mkdtemp(join(tmpdir(), "lexend-browser-tests-"));
let driver;
const checks = [];
const check = async (name, run) => { await run(); checks.push(name); console.log(`PASS ${browserName}: ${name}`); };
const wait = (expression, description) => driver.wait(() => driver.executeScript(`return (${expression});`), 15000, description, 100);
const script = (fn, ...args) => driver.executeScript(typeof fn === "string" ? `return (${fn});` : fn, ...args);
const navigateExtension = async (url) => {
  if (browserName === "firefox") {
    // WebDriver intentionally disallows privileged URL navigation from content
    // context. Open our page through browser chrome in this isolated profile.
    await driver.setContext(firefox.Context.CHROME);
    try {
      await driver.executeScript(function (url) {
        window.gBrowser.selectedBrowser.loadURI(Services.io.newURI(url), {
          triggeringPrincipal: Services.scriptSecurityManager.getSystemPrincipal()
        });
      }, url);
    } finally {
      await driver.setContext(firefox.Context.CONTENT);
    }
    await wait(`location.href === ${JSON.stringify(url)} && document.readyState === 'complete'`, "Extension page opens");
  } else await driver.get(url);
};
const extensionCall = async (fn, ...args) => {
  const result = await driver.executeAsyncScript(`
    const done = arguments[arguments.length - 1];
    Promise.resolve().then(() => (${fn.toString()})(...Array.from(arguments).slice(0, -1))).then(
      value => done({ value }), error => done({ error: String(error) })
    );
  `, ...args);
  if (result.error) throw new Error(result.error);
  return result.value;
};
const patch = (changes) => extensionCall(async (changes) => {
  const api = globalThis.browser ?? globalThis.chrome;
  const result = await api.runtime.sendMessage({ type: "LEXEND_SETTINGS_MUTATE", operation: { type: "patch", changes } });
  if (!result.ok) throw new Error(result.message);
  return result.settings;
}, changes);
const saved = () => extensionCall(() => (globalThis.browser ?? globalThis.chrome).storage.sync.get(null));
const measurements = () => script(() => Object.fromEntries(["rem", "nested", "fixed", "ignored-text", "code", "svg-text", "layout"].map((id) => {
  const style = getComputedStyle(document.getElementById(id));
  return [id, { size: parseFloat(style.fontSize), family: style.fontFamily, padding: parseFloat(style.paddingTop) }];
})));

try {
  // Selenium Manager resolves current browser/driver versions. Chrome for
  // Testing retains unpacked-extension loading support; ordinary Chrome does not.
  process.env.SE_FORCE_BROWSER_DOWNLOAD ??= "true";
  process.env.SE_AVOID_STATS ??= "true";
  const builder = new Builder().forBrowser(browserName);
  if (browserName === "chrome") {
    const extensionDirectory = join(root, "dist/chrome");
    const options = new chrome.Options().setBrowserVersion("stable").addArguments(
      "--no-sandbox", "--disable-dev-shm-usage", "--window-size=1280,900",
      `--user-data-dir=${profile}`, `--disable-extensions-except=${extensionDirectory}`, `--load-extension=${extensionDirectory}`
    );
    builder.setChromeOptions(options);
  } else {
    builder.setFirefoxOptions(new firefox.Options().setBrowserVersion("stable").addArguments("--remote-allow-system-access"));
  }
  driver = await builder.build();
  await driver.manage().setTimeouts({ script: 20000 });
  if (browserName === "firefox") {
    const { version } = JSON.parse(await readFile(join(root, "package.json"), "utf8"));
    await driver.installAddon(join(root, "dist/releases", `lexend-the-web-firefox-v${version}.zip`), true);
  }
  await driver.manage().window().setRect({ width: 1280, height: 900 });
  await driver.get(fixtureUrl);
  await wait("getComputedStyle(document.querySelector('#rem')).fontFamily.includes('Lexend for the Web')", "Installed content script must style the fixture");
  const websiteTab = await driver.getWindowHandle();
  const origin = await script(() => {
    const css = [...document.querySelectorAll("style")].map((style) => style.textContent);
    for (const sheet of document.adoptedStyleSheets) {
      try { css.push([...sheet.cssRules].map((rule) => rule.cssText).join("\n")); } catch {}
    }
    return css.join("\n").match(/(?:chrome|moz)-extension:\/\/[^/"\s]+\//)?.[0];
  });
  assert(origin, "Installed font URLs identify the extension's real origin");
  await driver.switchTo().newWindow("tab");
  const optionsTab = await driver.getWindowHandle();
  await navigateExtension(`${origin}options.html`);
  await wait("!document.querySelector('#dark-theme').disabled", "Settings must initialize");

  await check("real background serializes concurrent preferences and rule changes", async () => {
    const result = await extensionCall(async () => {
      const api = globalThis.browser ?? globalThis.chrome;
      const first = LexendPreferences.createClient(api);
      const second = LexendPreferences.createClient(api);
      await Promise.all([first.load(), second.load()]);
      await Promise.all([
        first.mutate({ type: "patch", changes: { textScale: 110, scope: "all" } }),
        second.mutate({ type: "patch", changes: { theme: "dark" } }),
        first.mutate({ type: "addRule", rule: { hostname: "keep.example", enabled: false } }),
        second.mutate({ type: "addRule", rule: { hostname: "remove.example", enabled: false } })
      ]);
      await second.mutate({ type: "removeRule", hostname: "remove.example" });
      return api.storage.sync.get(null);
    });
    assert.equal(result.textScale, 110);
    assert.equal(result.theme, "dark");
    assert.deepEqual(result.siteRules.map((rule) => rule.hostname), ["keep.example"]);
  });

  await check("px/rem/em typography scales once while opt-outs and layout keep their original metrics", async () => {
    await driver.switchTo().window(websiteTab);
    await wait("parseFloat(getComputedStyle(document.querySelector('#rem')).fontSize) === 22", "110% text scaling");
    const result = await measurements();
    assert.equal(result.rem.size, 22);
    assert.equal(result.fixed.size, 18.7);
    assert.equal(result.nested.size, 16.5);
    assert.equal(result.layout.padding, 20);
    for (const id of ["ignored-text", "code", "svg-text"]) assert(!result[id].family.includes("Lexend"), `${id} keeps its original font`);
    assert.equal(await script("getComputedStyle(document.documentElement).fontSize"), "20px");
    await script("document.body.classList.add('font-big')");
    await wait("parseFloat(getComputedStyle(document.querySelector('#rem')).fontSize) === 26.4", "Changed website styles must be remeasured");
    await script("document.body.classList.remove('font-big')");
    await wait("parseFloat(getComputedStyle(document.querySelector('#rem')).fontSize) === 22", "Restored website styles must be remeasured");
  });

  await check("removed stylesheets and later shadow roots recover without changing active settings", async () => {
    await script(() => {
      document.adoptedStyleSheets = [];
      document.querySelector("#lexend-the-web-styles")?.remove();
      Element.prototype.attachShadow = function (options) { return Reflect.apply(window.fixtureAttachShadow, this, [options]); };
      const shadow = document.querySelector("#host").attachShadow({ mode: "open" });
      const paragraph = document.createElement("p"); paragraph.textContent = "Later shadow text"; shadow.append(paragraph);
    });
    await wait("getComputedStyle(document.querySelector('#rem')).fontFamily.includes('Lexend')", "Document styles recover");
    await wait("getComputedStyle(document.querySelector('#host').shadowRoot.querySelector('p')).fontFamily.includes('Lexend')", "Open shadow text is styled");
    await driver.switchTo().window(optionsTab);
    await patch({ textScale: 100 });
    await driver.switchTo().window(websiteTab);
    await wait("!document.querySelector('#rem').hasAttribute('data-lexend-scaled')", "Default sizing removes extension properties");
    await script("history.pushState({}, '', '/new-route')");
    assert((await measurements()).rem.family.includes("Lexend"));
  });

  await check("rule form validation and keyboard deletion confirmation work in the rendered settings", async () => {
    await driver.switchTo().window(optionsTab);
    await driver.findElement(By.css('[data-settings-panel="rules-panel"]')).click();
    const input = await driver.findElement(By.id("new-hostname"));
    assert.equal(await driver.findElement(By.id("add-rule-button")).isEnabled(), false);
    await input.sendKeys("added.example");
    await driver.findElement(By.id("add-rule-button")).click();
    await wait("[...document.querySelectorAll('.rule-row')].some(row=>row.dataset.hostname === 'added.example')", "Rule is saved");
    let remove = await driver.findElement(By.css('[data-hostname="added.example"] .delete-rule'));
    await remove.click();
    await remove.sendKeys(Key.ESCAPE);
    assert.equal(await remove.getAttribute("data-action"), "delete");
    await remove.click();
    await driver.findElement(By.css('[data-hostname="added.example"] [data-action="confirm"]')).sendKeys(Key.ENTER);
    await wait("![...document.querySelectorAll('.rule-row')].some(row=>row.dataset.hostname === 'added.example')", "Only confirmed rule is removed");
    assert.equal((await saved()).siteRules.length, 1);
    assert.equal(await script("document.activeElement.classList.contains('delete-rule')"), true);
  });

  await check("oversized imports explicitly fail and preserve existing rules", async () => {
    const invalid = join(profile, "oversized.json");
    const payload = { schemaVersion: 2, settings: { siteRules: Array.from({ length: 250 }, (_, i) => ({ hostname: `site${i}.example.com`, enabled: false })) } };
    await writeFile(invalid, JSON.stringify(payload));
    await driver.findElement(By.css('[data-settings-panel="tools-panel"]')).click();
    await driver.findElement(By.id("import-file")).sendKeys(invalid);
    await wait("document.querySelector('#import-error').textContent.includes('room')", "Import reports capacity error");
    assert.deepEqual((await saved()).siteRules.map((rule) => rule.hostname), ["keep.example"]);
  });

  await check("related frames follow global pause and resume", async () => {
    await patch({ enabled: false });
    await driver.switchTo().window(websiteTab);
    await wait("!getComputedStyle(document.querySelector('#rem')).fontFamily.includes('Lexend')", "Main page pauses");
    await driver.switchTo().frame(await driver.findElement(By.id("frame")));
    await wait("!getComputedStyle(document.querySelector('#frame-text')).fontFamily.includes('Lexend')", "Related frame pauses");
    await driver.switchTo().defaultContent();
    await driver.switchTo().window(optionsTab);
    await patch({ enabled: true });
  });

  await check("desktop navigation, narrow layout, and dark About navigation remain stable", async () => {
    for (const id of ["readability-panel", "rules-panel", "appearance-panel", "tools-panel", "readability-panel"]) {
      await driver.findElement(By.css(`[data-settings-panel="${id}"]`)).click();
      assert.deepEqual(await script("[...document.querySelectorAll('.settings-panel')].filter(p=>!p.hidden).map(p=>p.id)"), [id]);
    }
    await navigateExtension(`${origin}about.html`);
    assert.equal(await script("document.documentElement.dataset.theme"), "dark");
    await navigateExtension(`${origin}options.html`);
    await wait("!document.querySelector('#dark-theme').disabled", "Settings reload");
    assert.equal(await script("document.documentElement.dataset.theme"), "dark");
    await driver.manage().window().setRect({ width: 390, height: 844 });
    assert.equal(await script("document.documentElement.scrollWidth <= innerWidth + 1"), true, "Narrow settings must not overflow horizontally");
    assert.equal(await script("[...document.querySelectorAll('.settings-panel')].every(p=>!p.hidden)"), true);
    await writeFile(join(artifactDirectory, "settings-mobile.png"), await driver.takeScreenshot(), "base64");
    await driver.manage().window().setRect({ width: 1280, height: 900 });
  });

  if (browserName === "chrome") await check("forced colors retain a visible selected option and reduced motion disables transitions", async () => {
    await driver.sendDevToolsCommand("Emulation.setEmulatedMedia", { features: [{ name: "forced-colors", value: "active" }, { name: "prefers-reduced-motion", value: "reduce" }] });
    const result = await script(() => {
      const selected = document.querySelector('.segment-group input:checked + span');
      return { background: getComputedStyle(selected).backgroundColor, outline: getComputedStyle(selected).outlineWidth,
        duration: getComputedStyle(selected.closest('.segment-group'), '::before').transitionDuration };
    });
    assert.notEqual(result.background, "rgba(0, 0, 0, 0)");
    assert.equal(result.outline, "2px");
    assert(parseFloat(result.duration) < .01);
    await driver.sendDevToolsCommand("Emulation.setEmulatedMedia", { features: [] });
  });

  await check("popup uses the real stored preferences and fits a narrow viewport", async () => {
    await navigateExtension(`${origin}popup.html`);
    await wait("!document.querySelector('#enabled').disabled", "Popup initializes");
    assert.equal(await script("document.documentElement.dataset.theme"), "dark");
    await driver.manage().window().setRect({ width: 390, height: 844 });
    assert.equal(await script("document.documentElement.scrollWidth <= innerWidth + 1"), true);
    await writeFile(join(artifactDirectory, "popup-mobile.png"), await driver.takeScreenshot(), "base64");
  });
  await writeFile(join(artifactDirectory, "results.json"), JSON.stringify({ browserName, checks, installedExtension: true }, null, 2));
} catch (error) {
  if (driver) {
    await writeFile(join(artifactDirectory, "failure.png"), await driver.takeScreenshot(), "base64").catch(() => {});
    await writeFile(join(artifactDirectory, "failure.html"), await driver.getPageSource()).catch(() => {});
  }
  throw error;
} finally {
  await driver?.quit();
  await new Promise((resolve) => server.close(resolve));
  await rm(profile, { recursive: true, force: true });
}
