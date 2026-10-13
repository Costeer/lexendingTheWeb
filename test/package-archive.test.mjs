import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import test from "node:test";
import { unzipSync } from "fflate";
import { createArchive } from "../scripts/package-archive.mjs";

const inputs = { "z.txt": Buffer.from("same bytes"), "assets/a.bin": Buffer.from([0, 1, 255]), "empty": Buffer.alloc(0) };

test("ZIP output is identical across input order and preserves every byte", () => {
  const archive = createArchive(inputs);
  assert.deepEqual(createArchive(Object.fromEntries(Object.entries(inputs).reverse())), archive);
  const files = unzipSync(archive);
  assert.deepEqual(Object.keys(files), Object.keys(inputs).sort());
  for (const name of Object.keys(inputs)) assert.deepEqual(Buffer.from(files[name]), inputs[name]);
  assert.notDeepEqual(createArchive({ ...inputs, "z.txt": Buffer.from("changed") }), archive);
});

test("real ZIP bytes remain equal with different wall clocks and time zones", () => {
  const script = `
    const RealDate = Date;
    globalThis.Date = class extends RealDate {
      constructor(...args) { super(...(args.length ? args : [process.env.TEST_CLOCK])); }
      static now() { return new RealDate(process.env.TEST_CLOCK).getTime(); }
    };
    const { createArchive } = await import(${JSON.stringify(new URL("../scripts/package-archive.mjs", import.meta.url).href)});
    process.stdout.write(Buffer.from(createArchive({"test.txt": Buffer.from("unchanged")})).toString("base64"));
  `;
  const run = (TEST_CLOCK, TZ) => execFileSync(process.execPath, ["--input-type=module", "--eval", script], {
    cwd: process.cwd(), env: { ...process.env, TEST_CLOCK, TZ }, encoding: "utf8"
  });
  assert.equal(run("2020-02-02T03:04:05Z", "Pacific/Honolulu"), run("2035-10-11T12:13:14Z", "Asia/Tokyo"));
});

test("archive creation rejects paths that escape the extension root", () => {
  for (const name of ["/absolute", "../outside", "a/../../outside", "a\\b", "a//b", "./a"]) {
    assert.throws(() => createArchive({ [name]: Buffer.from("unsafe") }), /Unsafe ZIP path/);
  }
});
