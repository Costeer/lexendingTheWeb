import assert from "node:assert/strict";
import { runInNewContext } from "node:vm";
import test from "node:test";
import { createBrowserCalls } from "../scripts/browser-session.mjs";

test("shared calls use the current driver after browser restart", async () => {
  let driver = { executeScript: async () => "first" };
  const calls = createBrowserCalls(() => driver, "chrome");
  assert.equal(await calls.script("location.href"), "first");
  driver = { executeScript: async () => "restarted", wait: async (condition) => condition() };
  assert.equal(await calls.script(() => location.href), "restarted");
  assert.equal(await calls.wait("document.readyState", "ready"), "restarted");
});

test("extension calls preserve async values/errors and the real mutation envelope", async () => {
  let operation;
  const context = { chrome: { runtime: { sendMessage: async (message) => {
    assert.equal(message.type, "LEXEND_SETTINGS_MUTATE");
    operation = message.operation;
    return { ok: true, settings: { enabled: false } };
  } } } };
  const driver = { executeAsyncScript: (source, ...args) => new Promise((resolve) => {
    runInNewContext(`(function () {${source}\n})`, context)(...args, resolve);
  }) };
  const { extensionCall, mutate } = createBrowserCalls(() => driver, "chrome");
  assert.equal(await extensionCall(async (value) => value + 1, 4), 5);
  await assert.rejects(extensionCall(async () => { throw new Error("browser failure"); }), /browser failure/);
  const mutation = { type: "patch", changes: { enabled: false } };
  assert.deepEqual(JSON.parse(JSON.stringify(await mutate(mutation))), { enabled: false });
  assert.deepEqual(operation, mutation);
});

test("Firefox navigation restores content context when privileged navigation fails", async () => {
  const contexts = [];
  const primary = new Error("navigation failed");
  const driver = {
    setContext: async (context) => contexts.push(context),
    executeScript: async () => { throw primary; }
  };
  const { navigateExtension } = createBrowserCalls(() => driver, "firefox");
  await assert.rejects(navigateExtension("moz-extension://control/options.html"), (error) => error === primary);
  assert.deepEqual(contexts, ["chrome", "content"]);
});
