import { readFile, writeFile } from "node:fs/promises";
import { resolve } from "node:path";
const root = new URL("../", import.meta.url);
let script = await readFile(new URL("benchmarks/site-audit.template.js", root), "utf8");
const fontDefinitions = [
  ["lexend-vietnamese-wght-normal.woff2", "U+0102-0103,U+0110-0111,U+0128-0129,U+0168-0169,U+01A0-01A1,U+01AF-01B0,U+0300-0301,U+0303-0304,U+0308-0309,U+0323,U+0329,U+1EA0-1EF9,U+20AB"],
  ["lexend-latin-ext-wght-normal.woff2", "U+0100-02BA,U+02BD-02C5,U+02C7-02CC,U+02CE-02D7,U+02DD-02FF,U+0304,U+0308,U+0329,U+1D00-1DBF,U+1E00-1E9F,U+1EF2-1EFF,U+2020,U+20A0-20AB,U+20AD-20C0,U+2113,U+2C60-2C7F,U+A720-A7FF"],
  ["lexend-latin-wght-normal.woff2", "U+0000-00FF,U+0131,U+0152-0153,U+02BB-02BC,U+02C6,U+02DA,U+02DC,U+0304,U+0308,U+0329,U+2000-206F,U+20AC,U+2122,U+2191,U+2193,U+2212,U+2215,U+FEFF,U+FFFD"]
];
const fonts = await Promise.all(fontDefinitions.map(async ([file, range]) => ({
  file, range, data: (await readFile(new URL(`assets/fonts/${file}`, root))).toString("base64")
})));
script = script.replace("__FONT_DATA__", "window.__lexendAuditFontData");
for (const [placeholder, file] of Object.entries({
  __SETTINGS_SOURCE__: "src/settings.js",
  __CONTENT_SOURCE__: "src/content.js",
  __BASELINE_SOURCE__: "benchmarks/baselines/content-observer.js",
  __DETECTOR_SOURCE__: "src/shadow-detector.js"
})) {
  const source = await readFile(new URL(file, root), "utf8");
  script = script.replace(placeholder, () => source);
}
const output = resolve(process.argv[2] ?? "/tmp/lexend-site-audit.js");
await writeFile(output, script);
for (const [index, font] of fonts.entries()) {
  await writeFile(`${output}.font-${index}.js`, `(window.__lexendAuditFontData ??= []).push(${JSON.stringify(font)})`);
}
console.log(`Wrote ${output} (${Buffer.byteLength(script)} bytes).`);
