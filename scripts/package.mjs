import { mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { collectFiles } from "./build-identity.mjs";
import { createArchive } from "./package-archive.mjs";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const releases = join(root, "dist", "releases");
const { version } = JSON.parse(await readFile(join(root, "package.json"), "utf8"));

await mkdir(releases, { recursive: true });

for (const target of ["chrome", "firefox"]) {
  const archive = join(releases, `lexend-the-web-${target}-v${version}.zip`);
  await rm(archive, { force: true });
  const files = await collectFiles(join(root, "dist", target));
  await writeFile(archive, createArchive(files));
}

console.log("Created browser packages in dist/releases/.");
