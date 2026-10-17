import { createHash } from "node:crypto";
import { readFile, readdir } from "node:fs/promises";
import { join } from "node:path";

// These files define the build/package operation and its locked dependencies.
// Artifact bytes below cover every copied resource, including the target manifest.
export const buildToolInputs = Object.freeze([
  "package.json", "package-lock.json", "scripts/build.mjs",
  "scripts/build-identity.mjs", "scripts/package.mjs", "scripts/package-archive.mjs"
]);

export async function collectFiles(directory, prefix = "") {
  const files = Object.create(null);
  const entries = await readdir(directory, { withFileTypes: true });
  entries.sort((left, right) => left.name < right.name ? -1 : left.name > right.name ? 1 : 0);
  for (const entry of entries) {
    const name = prefix ? `${prefix}/${entry.name}` : entry.name;
    const path = join(directory, entry.name);
    if (entry.isDirectory()) Object.assign(files, await collectFiles(path, name));
    else if (entry.isFile()) files[name] = await readFile(path);
    else throw new Error(`Build input must be a regular file or directory: ${name}`);
  }
  return files;
}

export function fingerprintFiles(files) {
  const hash = createHash("sha256");
  hash.update("lexend-build-inputs-v1\n");
  for (const name of Object.keys(files).sort()) {
    const bytes = files[name];
    // Length prefixes distinguish names and bytes even if either contains newlines.
    hash.update(`${Buffer.byteLength(name)}:${name}${bytes.length}:`);
    hash.update(bytes);
  }
  return hash.digest("hex");
}

export async function createBuildIdentity({ root, output, target }) {
  if (!["chrome", "firefox"].includes(target)) throw new Error("Unknown build target");
  const artifacts = await collectFiles(output);
  delete artifacts["build-identity.json"];
  const manifest = JSON.parse(artifacts["manifest.json"].toString("utf8"));
  const files = Object.fromEntries(Object.entries(artifacts).map(([name, bytes]) => [`artifact/${name}`, bytes]));
  for (const name of buildToolInputs) files[`build/${name}`] = await readFile(join(root, name));
  return { schemaVersion: 1, version: manifest.version, target, sourceHash: fingerprintFiles(files) };
}
