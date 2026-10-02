import { writeFile } from "node:fs/promises";

async function boundedSend(session, method, parameters) {
  let timer;
  try {
    return await Promise.race([
      session.send(method, parameters),
      new Promise((_, reject) => {
        timer = setTimeout(() => reject(new Error(`Screenshot protocol timed out: ${method}`)), 10000);
      })
    ]);
  } finally { clearTimeout(timer); }
}

// Keep the native animation timeline. If screenshot readiness never settles,
// retain its currently painted Chromium surface and explicitly flag that state.
// The independent text audit still requires loaded Lexend faces/glyph coverage.
export async function captureScreenshot(page, options = {}) {
  const { onFontWaitFallback, ...screenshotOptions } = options;
  try {
    return await page.screenshot({ ...screenshotOptions, animations: "allow",
      timeout: Math.min(screenshotOptions.timeout ?? 5000, 5000) });
  } catch (error) {
    if (!/Timeout.*exceeded/.test(error.message)) throw error;
    const pendingFont = error.message.includes("waiting for fonts to load");
    const session = await page.context().newCDPSession(page);
    try {
      let clip = screenshotOptions.clip;
      if (!clip && screenshotOptions.fullPage) {
        const { cssContentSize } = await boundedSend(session, "Page.getLayoutMetrics");
        clip = cssContentSize;
      }
      const { data } = await boundedSend(session, "Page.captureScreenshot", {
        format: "png", fromSurface: true,
        captureBeyondViewport: Boolean(screenshotOptions.fullPage || clip),
        ...(clip ? { clip: { ...clip, scale: 1 } } : {})
      });
      const bitmap = Buffer.from(data, "base64");
      if (screenshotOptions.path) await writeFile(screenshotOptions.path, bitmap);
      onFontWaitFallback?.({ reason: pendingFont
        ? "A page font did not finish loading within the screenshot wait. Captured the currently painted browser surface; font-state evidence remains incomplete."
        : "The browser screenshot did not settle within its bounded wait. Captured the currently painted browser surface; screenshot readiness remains incomplete." });
      return bitmap;
    } finally { await session.detach().catch(() => {}); }
  }
}
