import { defineConfig } from "@playwright/test";

export default defineConfig({
  testDir: "./test/ui",
  fullyParallel: true,
  forbidOnly: Boolean(process.env.CI),
  retries: 0,
  workers: 2,
  timeout: 30000,
  // Missing baselines must fail CI, never silently establish a new expectation.
  updateSnapshots: "none",
  snapshotPathTemplate: "{testDir}/snapshots/{projectName}/{arg}{ext}",
  outputDir: "dist/ui-tests/results",
  reporter: [["list"], ["html", { outputFolder: "dist/ui-tests/report", open: "never" }]],
  expect: {
    toHaveScreenshot: { animations: "disabled", caret: "hide", maxDiffPixels: 100 }
  },
  use: {
    browserName: "chromium",
    baseURL: "http://127.0.0.1:4173",
    locale: "en-US",
    timezoneId: "UTC",
    reducedMotion: "reduce",
    deviceScaleFactor: 1,
    trace: "retain-on-failure",
    screenshot: "only-on-failure"
  },
  projects: ["light", "dark"].flatMap((theme) => [
    { name: `desktop-${theme}`, use: { colorScheme: theme, viewport: { width: 1280, height: 900 } } },
    { name: `mobile-${theme}`, use: { colorScheme: theme, viewport: { width: 390, height: 844 }, isMobile: true, hasTouch: true } }
  ]),
  webServer: {
    command: "node scripts/ui-test-server.mjs",
    url: "http://127.0.0.1:4173/options.html",
    reuseExistingServer: false
  }
});
