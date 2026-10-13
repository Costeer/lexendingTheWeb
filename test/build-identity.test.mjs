import assert from "node:assert/strict";
import { mkdir, mkdtemp, readFile, rm, utimes, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import test from "node:test";
import { buildToolInputs, collectFiles, createBuildIdentity, fingerprintFiles } from "../scripts/build-identity.mjs";

async function fixture(t, entries) {
  const root = await mkdtemp(join(tmpdir(), "lexend-build-identity-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  for (const [name, bytes] of entries) {
    await mkdir(dirname(join(root, name)), { recursive: true });
    await writeFile(join(root, name), bytes);
  }
  return root;
}

test("build identity depends on source bytes, not checkout path, input order, or filesystem dates", async (t) => {
  const entries = [
    ...buildToolInputs.map((name) => [name, `input ${name}`]),
    ["out/manifest.json", JSON.stringify({ version: "0.5.0" })],
    ["out/src/content.js", "runtime bytes"], ["out/assets/font.woff2", Buffer.from([0, 255, 12])]
  ];
  const first = await fixture(t, entries);
  const second = await fixture(t, [...entries].reverse());
  for (const [name] of entries) await utimes(join(second, name), new Date(0), new Date(0));
  const identity = (root) => createBuildIdentity({ root, output: join(root, "out"), target: "chrome" });
  const actual = await identity(first);
  assert.deepEqual(await identity(second), actual);
  assert.deepEqual(Object.keys(actual), ["schemaVersion", "version", "target", "sourceHash"]);
  assert.equal(actual.version, "0.5.0");
  assert.match(actual.sourceHash, /^[a-f0-9]{64}$/);
  await writeFile(join(first, "out/build-identity.json"), JSON.stringify(actual));
  assert.deepEqual(await identity(first), actual, "generated identity must not hash itself");

  for (const [name] of entries) {
    const path = join(first, name);
    const original = await readFile(path);
    await writeFile(path, name.endsWith("manifest.json") ? JSON.stringify({ version: "0.5.1" }) : Buffer.concat([original, Buffer.from("changed")]));
    assert.notEqual((await identity(first)).sourceHash, actual.sourceHash, `${name} must affect the fingerprint`);
    await writeFile(path, original);
  }
  await writeFile(join(first, "out/src/new-runtime.js"), "new bytes");
  assert.notEqual((await identity(first)).sourceHash, actual.sourceHash, "new copied resources must affect the fingerprint");
});

test("fingerprinting includes names, empty files and unambiguous byte boundaries", () => {
  const hash = (files) => fingerprintFiles(Object.fromEntries(Object.entries(files).map(([key, value]) => [key, Buffer.from(value)])));
  assert.equal(hash({ a: "1", b: "2" }), hash({ b: "2", a: "1" }));
  assert.notEqual(hash({ a: "1" }), hash({ b: "1" }));
  assert.notEqual(hash({ a: "1" }), hash({ a: "1", b: "" }));
  assert.notEqual(hash({ a: "1b2" }), hash({ a: "1", b: "2" }));
});

test("file collection preserves arbitrary binary content and stable relative names", async (t) => {
  const root = await fixture(t, [["z.bin", Buffer.from([0, 1, 255])], ["nested/a.txt", "hello"]]);
  const files = await collectFiles(root);
  assert.deepEqual(Object.keys(files), ["nested/a.txt", "z.bin"]);
  assert.deepEqual(files["z.bin"], Buffer.from([0, 1, 255]));
});
