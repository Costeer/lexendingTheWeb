import { randomUUID } from "node:crypto";
import { mkdir, readFile, readdir, rename, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";

export async function startBrowserReport(output, report) {
  await mkdir(output, { recursive: true });
  let previous;
  try { previous = JSON.parse(await readFile(join(output, "results.json"), "utf8")); }
  catch (error) { if (error.code !== "ENOENT" && !(error instanceof SyntaxError)) throw error; }
  const previousId = /^[a-zA-Z0-9-]{1,100}$/.test(previous?.runId ?? "") ? previous.runId : `legacy-${randomUUID()}`;
  const previousOutput = join(output, "previous-runs", previousId);
  const existing = new Set(await readdir(output));
  const files = ["results.json", "failure.json", "failure.png", "failure.html"];
  // Move the old canonical result first; historical evidence keeps its run ID.
  for (const file of files) {
    if (!existing.has(file)) continue;
    try {
      await mkdir(previousOutput, { recursive: true });
      await rename(join(output, file), join(previousOutput, file));
    } catch (error) { if (error.code !== "ENOENT") throw error; }
  }
  Object.assign(report, { runId: randomUUID(), startedAt: new Date().toISOString(), status: "running" });
  const saveReport = async () => {
    const temporary = join(output, `.${report.runId}-results.tmp`);
    try {
      await writeFile(temporary, JSON.stringify(report, null, 2));
      await rename(temporary, join(output, "results.json"));
    } finally { await rm(temporary, { force: true }).catch(() => {}); }
  };
  await saveReport();
  return saveReport;
}

export async function captureBrowserFailure(driver, output) {
  if (!driver) return;
  await Promise.allSettled([
    (async () => writeFile(join(output, "failure.png"), await driver.takeScreenshot(), "base64"))(),
    (async () => writeFile(join(output, "failure.html"), await driver.getPageSource()))()
  ]);
}

export async function finishBrowserRun({ error, report, saveReport, driver, server, profile }) {
  const failures = [];
  for (const [operation, cleanup] of [
    ["driver.quit", () => driver?.quit()],
    ["server.close", () => server?.listening && new Promise((resolve, reject) => server.close((error) => error ? reject(error) : resolve()))],
    ["profile.remove", () => profile && rm(profile, { recursive: true, force: true })]
  ]) {
    try { await cleanup(); }
    catch (failure) { failures.push({ operation, error: String(failure.stack ?? failure) }); error ??= failure; }
  }
  if (failures.length) report.cleanupErrors = failures;
  if (error) { report.status = "failed"; report.error ??= String(error.stack ?? error); }
  report.finishedAt = new Date().toISOString();
  try { await saveReport(); }
  catch (failure) { error ??= failure; }
  if (error) throw error;
}
