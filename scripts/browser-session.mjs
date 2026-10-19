import { join } from "node:path";
import { Builder } from "selenium-webdriver";
import chrome from "selenium-webdriver/chrome.js";
import firefox from "selenium-webdriver/firefox.js";

export function createBrowserDriver({ browserName, browserVersion, profile, extensionDirectory, headlessFirefox }) {
  process.env.SE_FORCE_BROWSER_DOWNLOAD ??= "true";
  process.env.SE_AVOID_STATS ??= "true";
  const builder = new Builder().forBrowser(browserName);
  if (browserName === "chrome") {
    builder.setChromeOptions(new chrome.Options().setBrowserVersion(browserVersion).addArguments(
      "--no-sandbox", "--disable-dev-shm-usage", "--window-size=1280,900",
      `--user-data-dir=${join(profile, "chrome-profile")}`, `--disable-extensions-except=${extensionDirectory}`, `--load-extension=${extensionDirectory}`
    ));
  } else {
    const options = new firefox.Options().setBrowserVersion(browserVersion);
    // Headless Linux otherwise reports no pointer and selects touch layouts.
    // Both runners record this desktop mouse preset in their evidence.
    if (headlessFirefox) options.setPreference("ui.primaryPointerCapabilities", 6)
      .setPreference("ui.allPointerCapabilities", 6);
    builder.setFirefoxOptions(options);
    builder.setFirefoxService(new firefox.ServiceBuilder().addArguments("--allow-system-access"));
  }
  return builder.build();
}

// Resolve the current driver on every call: the release suite restarts Chrome
// with the same profile to verify persistence and live writer recovery.
export function createBrowserCalls(getDriver, browserName) {
  const script = (fn, ...args) => getDriver().executeScript(typeof fn === "string" ? `return (${fn});` : fn, ...args);
  const wait = (expression, description) => getDriver().wait(() => script(expression), 15000, description, 100);
  const extensionCall = async (fn, ...args) => {
    const result = await getDriver().executeAsyncScript(`
      const done = arguments[arguments.length - 1];
      Promise.resolve().then(() => (${fn.toString()})(...Array.from(arguments).slice(0, -1))).then(
        value => done({ value }), error => done({ error: String(error) })
      );
    `, ...args);
    if (result.error) throw new Error(result.error);
    return result.value;
  };
  const navigateExtension = async (url) => {
    const driver = getDriver();
    if (browserName === "firefox") {
      // Privileged extension navigation needs browser chrome in this profile.
      await driver.setContext(firefox.Context.CHROME);
      try {
        await driver.executeScript(function (url) {
          window.gBrowser.selectedBrowser.loadURI(Services.io.newURI(url), {
            triggeringPrincipal: Services.scriptSecurityManager.getSystemPrincipal()
          });
        }, url);
      } finally { await driver.setContext(firefox.Context.CONTENT); }
      await wait(`location.href === ${JSON.stringify(url)} && document.readyState === 'complete'`, "Extension page opens");
    } else await driver.get(url);
  };
  const mutate = (operation) => extensionCall(async (operation) => {
    const api = globalThis.browser ?? globalThis.chrome;
    const result = await api.runtime.sendMessage({ type: "LEXEND_SETTINGS_MUTATE", operation });
    if (!result.ok) throw new Error(result.message);
    return result.settings;
  }, operation);
  return { script, wait, extensionCall, navigateExtension, mutate };
}

export const findExtensionOrigin = (script) => script(() => {
  const css = [...document.querySelectorAll("style")].map((style) => style.textContent);
  for (const sheet of document.adoptedStyleSheets) {
    try { css.push([...sheet.cssRules].map((rule) => rule.cssText).join("\n")); } catch {}
  }
  return css.join("\n").match(/(?:chrome|moz)-extension:\/\/[^/"\s]+\//)?.[0];
});
