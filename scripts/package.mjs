import { mkdir, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { zipSync } from "fflate";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const releases = join(root, "dist", "releases");

const collectFiles = async (directory, prefix = "") => {
  const files = {};

  for (const entry of await readdir(directory, { withFileTypes: true })) {
    const relativePath = prefix ? `${prefix}/${entry.name}` : entry.name;
    const absolutePath = join(directory, entry.name);

    if (entry.isDirectory()) {
      Object.assign(files, await collectFiles(absolutePath, relativePath));
    } else {
      files[relativePath] = await readFile(absolutePath);
    }
  }

  return files;
};

await mkdir(releases, { recursive: true });

for (const target of ["chrome", "firefox"]) {
  const archive = join(releases, `lexend-the-web-${target}.zip`);
  await rm(archive, { force: true });
  const files = await collectFiles(join(root, "dist", target));
  await writeFile(archive, zipSync(files, { level: 9 }));
}

console.log("Created browser packages in dist/releases/.");
