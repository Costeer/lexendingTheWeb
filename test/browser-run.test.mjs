import assert from "node:assert/strict";
import { createServer } from "node:http";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { captureBrowserFailure, finishBrowserRun, startBrowserReport } from "../scripts/browser-run.mjs";

const temporary = async (t) => {
  const directory = await mkdtemp(join(tmpdir(), "lexend-run-control-"));
  t.after(() => rm(directory, { recursive: true, force: true }));
  return directory;
};

test("reused output replaces prior success/failure with a fresh canonical run", async (t) => {
  const output = await temporary(t);
  const read = async () => JSON.parse(await readFile(join(output, "results.json"), "utf8"));
  const identities = new Set();
  for (const error of [undefined, new Error("delayed-root control"), undefined]) {
    await writeFile(join(output, "failure.json"), "stale failure");
    await writeFile(join(output, "failure.png"), "stale screenshot");
    const report = { checkScope: "shadow-only", negativeControl: error ? { releaseProof: false } : null };
    const saveReport = await startBrowserReport(output, report);
    assert.equal((await read()).status, "running");
    assert(!identities.has(report.runId));
    identities.add(report.runId);
    if (identities.size > 1) {
      const priorId = [...identities].at(-2);
      const prior = JSON.parse(await readFile(join(output, "previous-runs", priorId, "results.json"), "utf8"));
      assert.equal(prior.runId, priorId);
      assert.equal(await readFile(prior.artifact.retainedPath, "utf8"), priorId);
      assert.equal(await readFile(join(output, "previous-runs", priorId, "failure.json"), "utf8"), "stale failure");
      assert.equal(await readFile(join(output, "previous-runs", priorId, "failure.png"), "utf8"), "stale screenshot");
    }
    await assert.rejects(readFile(join(output, "failure.json")), { code: "ENOENT" });
    await assert.rejects(readFile(join(output, "failure.png")), { code: "ENOENT" });
    report.artifact = { retainedPath: join(output, `${report.runId}-release.zip`) };
    await writeFile(report.artifact.retainedPath, report.runId);
    report.status = "passed";
    const finish = finishBrowserRun({ error, report, saveReport });
    if (error) await assert.rejects(finish, (actual) => actual === error);
    else await finish;
    assert.equal((await read()).status, error ? "failed" : "passed");
    assert.equal((await read()).checkScope, "shadow-only");
    assert((await read()).finishedAt);
  }
});

test("primary assertion survives failed diagnostics, shutdown and report writing; real resources close", async (t) => {
  const profile = await temporary(t);
  const marker = join(profile, "owned-profile");
  await writeFile(marker, "owned");
  const server = createServer((_request, response) => response.end("control"));
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  t.after(() => server.close());
  const primary = new Error("original assertion");
  const driver = {
    quit: async () => { throw new Error("quit failed"); },
    takeScreenshot: async () => { throw new Error("screenshot failed"); },
    getPageSource: async () => { throw new Error("source failed"); }
  };
  await captureBrowserFailure(driver, profile);
  const report = { status: "running" };
  let writes = 0;
  await assert.rejects(finishBrowserRun({ error: primary, report, driver, server, profile,
    saveReport: async () => { writes++; throw new Error("report failed"); }
  }), (error) => error === primary);
  assert.equal(writes, 1);
  assert.equal(server.listening, false);
  await assert.rejects(readFile(marker), { code: "ENOENT" });
  assert.equal(report.status, "failed");
  assert.match(report.error, /original assertion/);
  assert.equal(report.cleanupErrors[0].operation, "driver.quit");
});

test("server-close rejection cannot skip profile removal or replace an earlier shutdown error", async (t) => {
  const profile = await temporary(t);
  const marker = join(profile, "owned-profile");
  await writeFile(marker, "owned");
  const primary = new Error("shutdown failed");
  const report = { status: "passed" };
  let saved;
  await assert.rejects(finishBrowserRun({ report, profile,
    driver: { quit: async () => { throw primary; } },
    server: { listening: true, close: (done) => done(new Error("close failed")) },
    saveReport: async () => { saved = structuredClone(report); }
  }), (error) => error === primary);
  await assert.rejects(readFile(marker), { code: "ENOENT" });
  assert.equal(saved.status, "failed");
  assert.deepEqual(saved.cleanupErrors.map((failure) => failure.operation), ["driver.quit", "server.close"]);
});

test("report-write failure is fatal after successful cleanup", async (t) => {
  const profile = await temporary(t);
  const primary = new Error("disk full");
  let quit = false;
  await assert.rejects(finishBrowserRun({ report: { status: "passed" }, profile,
    driver: { quit: async () => { quit = true; } }, saveReport: async () => { throw primary; }
  }), (error) => error === primary);
  assert.equal(quit, true);
  await assert.rejects(readFile(profile), { code: "ENOENT" });
});
