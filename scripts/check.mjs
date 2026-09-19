import { access, readFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const targets = ["chrome", "firefox"];
const requiredIcons = [16, 32, 48, 128];
const requiredFonts = [
  "lexend-latin-wght-normal.woff2",
  "lexend-latin-ext-wght-normal.woff2",
  "lexend-vietnamese-wght-normal.woff2"
];
const packageJson = JSON.parse(await readFile(join(root, "package.json"), "utf8"));

for (const target of targets) {
  const manifestPath = join(root, "manifests", `manifest.${target}.json`);
  const manifest = JSON.parse(await readFile(manifestPath, "utf8"));

  if (manifest.manifest_version !== 3) {
    throw new Error(`${target}: expected Manifest V3`);
  }

  if (!manifest.permissions.includes("storage")) {
    throw new Error(`${target}: storage permission is missing`);
  }

  if (manifest.version !== packageJson.version) {
    throw new Error(`${target}: manifest and package versions differ`);
  }

  if (!manifest.permissions.includes("activeTab")) {
    throw new Error(`${target}: activeTab permission is missing`);
  }

  if (!manifest.content_scripts[0].match_origin_as_fallback) {
    throw new Error(`${target}: related-frame support is missing`);
  }

  for (const size of requiredIcons) {
    await access(join(root, manifest.icons[String(size)]));
    await access(join(root, `assets/icons/icon-off-${size}.png`));
  }

  for (const font of requiredFonts) {
    await access(join(root, "assets/fonts", font));
  }
}

const popupCss = await readFile(join(root, "popup.css"), "utf8");
if (!popupCss.includes("color-scheme: only light")) {
  throw new Error("The popup must explicitly stay in light mode.");
}

if (/border-radius\s*:/.test(popupCss)) {
  throw new Error("The visual system requires square corners.");
}

console.log("Static checks passed.");
