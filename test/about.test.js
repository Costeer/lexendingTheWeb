import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { runInNewContext } from "node:vm";
import test from "node:test";
import "../src/settings.js";

const source = await readFile(new URL("../about.js", import.meta.url), "utf8");

async function openAbout(get) {
  const root = { dataset: {} };
  let onChanged;
  const errors = [];
  runInNewContext(source, {
    document: { documentElement: root },
    LexendSettings: globalThis.LexendSettings,
    browser: {
      storage: {
        sync: { get },
        onChanged: { addListener(listener) { onChanged = listener; } }
      }
    },
    console: { error(...args) { errors.push(args); } }
  });
  await new Promise((resolve) => setImmediate(resolve));
  return { root, onChanged, errors };
}

test("About loads the saved theme and follows only synced theme changes", async () => {
  const { root, onChanged } = await openAbout(async () => ({ theme: "dark" }));
  assert.equal(root.dataset.theme, "dark");
  onChanged({ theme: { newValue: "light" } }, "local");
  assert.equal(root.dataset.theme, "dark");
  onChanged({ enabled: { newValue: false } }, "sync");
  assert.equal(root.dataset.theme, "dark");
  onChanged({ theme: { newValue: "light" } }, "sync");
  assert.equal(root.dataset.theme, "light");
  onChanged({ theme: { newValue: "dark" } }, "sync");
  assert.equal(root.dataset.theme, "dark");
  onChanged({ theme: {} }, "sync");
  assert.equal(root.dataset.theme, "light");
});

test("About remains readable when stored preferences cannot be loaded", async () => {
  const { root, errors } = await openAbout(async () => { throw new Error("Storage unavailable"); });
  assert.equal(root.dataset.theme, "light");
  assert.equal(errors.length, 1);
});
