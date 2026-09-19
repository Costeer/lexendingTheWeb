import { cp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const dist = join(root, "dist");
const targets = ["chrome", "firefox"];
const sharedFiles = [
  "popup.html",
  "popup.css",
  "popup.js",
  "src",
  "assets"
];

await rm(dist, { recursive: true, force: true });

for (const target of targets) {
  const output = join(dist, target);
  await mkdir(output, { recursive: true });

  for (const file of sharedFiles) {
    await cp(join(root, file), join(output, file), { recursive: true });
  }

  const manifest = await readFile(
    join(root, "manifests", `manifest.${target}.json`),
    "utf8"
  );
  await writeFile(join(output, "manifest.json"), manifest);
}

console.log("Built Chrome and Firefox extensions in dist/.");

