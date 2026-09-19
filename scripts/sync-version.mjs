import { readFile, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const packagePath = join(root, "package.json");
const packageJson = JSON.parse(await readFile(packagePath, "utf8"));
const version = packageJson.version;

if (!/^\d+\.\d+\.\d+(?:\.\d+)?$/.test(version)) {
  throw new Error(`Unsupported browser extension version: ${version}`);
}

for (const target of ["chrome", "firefox"]) {
  const manifestPath = join(root, "manifests", `manifest.${target}.json`);
  const manifest = JSON.parse(await readFile(manifestPath, "utf8"));
  manifest.version = version;
  await writeFile(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`);
}

console.log(`Synchronized browser manifests to v${version}.`);
