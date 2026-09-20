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

const sharedCss = await readFile(join(root, "shared.css"), "utf8");
for (const token of ["#C40000", "#111111", "#FFFFFF", "#F4F4F4", "#FAF8F4", "#444444"]) {
  if (!sharedCss.includes(token)) {
    throw new Error(`shared.css is missing the ${token} design token.`);
  }
}
if (!sharedCss.includes("color-scheme: only light")) {
  throw new Error("The interface must explicitly stay in light mode.");
}

for (const page of ["popup", "options"]) {
  const html = await readFile(join(root, `${page}.html`), "utf8");
  const css = await readFile(join(root, `${page}.css`), "utf8");
  if (!html.includes('href="shared.css"')) {
    throw new Error(`${page}.html must load the shared design tokens.`);
  }
  const undersizedText = [...css.matchAll(/font-size:\s*([\d.]+)px/g)]
    .map((match) => Number(match[1]))
    .filter((size) => size < 12);
  if (undersizedText.length) {
    throw new Error(`${page}.css contains text smaller than 12px.`);
  }
}

const popupCss = await readFile(join(root, "popup.css"), "utf8");
const optionsCss = await readFile(join(root, "options.css"), "utf8");
if ((popupCss.match(/border-radius\s*:/g) ?? []).length !== 2
    || !popupCss.includes(".radio-mark")
    || /border-radius\s*:/.test(optionsCss)) {
  throw new Error("Only the popup's radio indicators may be round.");
}

console.log("Static checks passed.");
