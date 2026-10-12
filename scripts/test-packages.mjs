import assert from "node:assert/strict";
import { readFile, readdir } from "node:fs/promises";
import { dirname, join, posix, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { unzipSync } from "fflate";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const { version } = JSON.parse(await readFile(join(root, "package.json"), "utf8"));
const collect = async (directory, prefix = "") => {
  const files = {};
  for (const entry of await readdir(directory, { withFileTypes: true })) {
    const name = posix.join(prefix, entry.name);
    if (entry.isDirectory()) Object.assign(files, await collect(join(directory, entry.name), name));
    else files[name] = await readFile(join(directory, entry.name));
  }
  return files;
};

for (const target of ["chrome", "firefox"]) {
  const archive = join(root, "dist/releases", `lexend-the-web-${target}-v${version}.zip`);
  const files = unzipSync(await readFile(archive));
  const built = await collect(join(root, "dist", target));
  assert.deepEqual(Object.keys(files).sort(), Object.keys(built).sort(), `${target}: ZIP must contain the complete build`);
  const requireFile = (path, source) => assert(files[path]?.length, `${target}: ${source} references missing/empty ${path}`);
  for (const [path, bytes] of Object.entries(files)) {
    assert(!path.startsWith("/") && !path.split("/").includes("..") && !path.includes("\\"), `Unsafe ZIP path: ${path}`);
    assert(!/(^|\/)(?:node_modules|test|\.git|\.env)(\/|$)/.test(path), `Unexpected development file: ${path}`);
    assert.deepEqual(Buffer.from(bytes), built[path], `${target}: ZIP changed the bytes of ${path}`);
    if (!/\.(?:html|css)$/.test(path)) continue;
    const source = Buffer.from(bytes).toString("utf8");
    const references = path.endsWith(".html")
      ? [...source.matchAll(/\b(?:src|href)=["']([^"']+)["']/g)].map((match) => match[1])
      : [...source.matchAll(/url\(\s*["']?([^\s"')]+)["']?\s*\)/g)].map((match) => match[1]);
    for (const reference of references) {
      if (/^(?:[a-z][a-z\d+.-]*:|\/\/|#)/i.test(reference)) continue;
      requireFile(posix.normalize(posix.join(posix.dirname(path), reference.split(/[?#]/)[0])), path);
    }
  }
  const manifest = JSON.parse(Buffer.from(files["manifest.json"]).toString("utf8"));
  assert.equal(manifest.version, version);
  const runtimeFiles = [manifest.action.default_popup, manifest.options_ui.page,
    ...Object.values(manifest.icons), ...Object.values(manifest.action.default_icon),
    ...(manifest.background.scripts ?? [manifest.background.service_worker]),
    ...manifest.content_scripts.flatMap(({ js = [], css = [] }) => [...js, ...css]),
    ...manifest.web_accessible_resources.flatMap(({ resources }) => resources)];
  for (const path of runtimeFiles) requireFile(path, "manifest.json");
  for (const path of ["assets/fonts/LICENSE", "assets/fonts/LICENSE-NERD-FONTS", "assets/fonts/README-NERD-FONTS.md"]) requireFile(path, "font license");
  console.log(`PASS ${target}: ${Object.keys(files).length} archived files, runtime references, local assets and font licenses`);
}
