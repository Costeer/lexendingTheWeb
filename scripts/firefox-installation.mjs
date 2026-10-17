import assert from "node:assert/strict";
import { isAbsolute } from "node:path";
import { Command } from "selenium-webdriver/lib/command.js";

// Keep this exact archive on disk until the driver session ends. Selenium's
// base64 install path can lose its temporary backing XPI on older Firefox.
// Both installed-browser suites use the local geckodriver endpoint instead.
export async function installTemporaryFirefoxAddon(driver, archive) {
  assert(isAbsolute(archive), "Firefox installation requires an absolute retained archive path");
  const addonId = await driver.execute(new Command("install addon")
    .setParameter("path", archive).setParameter("temporary", true));
  return { method: "geckodriver-path", temporary: true, addonId, path: archive };
}
