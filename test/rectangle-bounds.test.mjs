import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import { runInNewContext } from "node:vm";
import { replaceExactlyOnce } from "./helpers/conversation.mjs";

const source = await readFile(new URL("../src/adaptive-layout.js", import.meta.url), "utf8");
const context = {};
// Expose the real helper only in this test; the production API stays unchanged.
runInNewContext(replaceExactlyOnce(source,
  "globalThis.LexendLayout = Object.freeze({ create });",
  "globalThis.LexendLayout = Object.freeze({ create, bounds });", "rectangle bounds test access"), context);
const bounds = context.LexendLayout.bounds;
const reference = (rects) => rects.length ? {
  left: Math.min(...rects.map((box) => box.left)), right: Math.max(...rects.map((box) => box.right)),
  top: Math.min(...rects.map((box) => box.top)), bottom: Math.max(...rects.map((box) => box.bottom))
} : null;
const uniform = (value) => ({ left: value, right: value, top: value, bottom: value });
const assertSameBounds = (rects, description) => {
  const actual = bounds(rects), expected = reference(rects);
  if (expected === null) return assert.equal(actual, null, description);
  assert.deepEqual(Object.keys(actual), ["left", "right", "top", "bottom"]);
  for (const key of Object.keys(expected)) {
    assert.equal(actual[key], expected[key], `${description}: ${key}`);
  }
};

test("rectangle bounds preserve empty, fractional and exceptional numeric geometry", () => {
  const cases = [
    ["empty", []],
    ["single rectangle", [{ left: -12.25, right: 0.5, top: -90.75, bottom: -3.125 }]],
    ["mixed negative and fractional edges", [
      { left: -12.25, right: 0.5, top: -90.75, bottom: -3.125 },
      { left: -34.5, right: 8.75, top: -20.125, bottom: 16.625 },
      { left: 0.25, right: 20.5, top: -100.25, bottom: 48.5 }
    ]],
    ["single negative zero", [uniform(-0)]],
    ["single positive zero", [uniform(0)]],
    ["negative zero then positive zero", [uniform(-0), uniform(0)]],
    ["positive zero then negative zero", [uniform(0), uniform(-0)]],
    ["infinite edges", [uniform(-Infinity), uniform(Infinity)]],
    ["independent NaN edges", [
      { left: NaN, right: Infinity, top: -Infinity, bottom: 8 },
      { left: -4, right: 4, top: 2, bottom: NaN }
    ]]
  ];
  for (const [description, rects] of cases) assertSameBounds(rects, description);
});

test("rectangle bounds match dense deterministic geometry across small and large groups", () => {
  let seed = 0x51c0ffee;
  const next = () => {
    seed = (Math.imul(seed, 1664525) + 1013904223) >>> 0;
    return seed / 0x100000000;
  };
  for (const length of [1, 2, 5, 20, 120, 400, 2048]) {
    const rects = Array.from({ length }, () => {
      const left = next() * 2000 - 1000, top = next() * 2000 - 1000;
      return { left, right: left + next() * 500, top, bottom: top + next() * 80 };
    });
    assertSameBounds(rects, `${length} rectangles`);
  }
});
