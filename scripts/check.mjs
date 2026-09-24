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

const pngDimensions = async (path) => {
  const data = await readFile(path);
  const signature = data.subarray(0, 8).toString("hex");
  if (signature !== "89504e470d0a1a0a" || data.subarray(12, 16).toString() !== "IHDR") {
    throw new Error(`${path} is not a valid PNG file.`);
  }
  return [data.readUInt32BE(16), data.readUInt32BE(20)];
};

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

  if (manifest.permissions.some((permission) => permission !== "storage")) {
    throw new Error(`${target}: unexpected extension permission`);
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

for (const page of ["popup", "options"]) {
  const html = await readFile(join(root, `${page}.html`), "utf8");
  if (!html.includes('href="shared.css"')) {
    throw new Error(`${page}.html must load the shared design tokens.`);
  }
}

const listing = await readFile(join(root, "store", "listing.md"), "utf8");
const summary = listing.match(/## Summary\s+([\s\S]*?)\s+## Detailed description/)?.[1]
  .replace(/\s+/g, " ")
  .trim();
if (!summary || summary.length > 132) {
  throw new Error("The Chrome Web Store summary must be present and at most 132 characters.");
}

const requiredStoreImages = new Map([
  ["screenshot-01-controls.png", [1280, 800]],
  ["screenshot-02-per-site-pause.png", [1280, 800]]
]);
for (const [file, expected] of requiredStoreImages) {
  const path = join(root, "store", "assets", file);
  const actual = await pngDimensions(path);
  if (actual[0] !== expected[0] || actual[1] !== expected[1]) {
    throw new Error(`${file} must be ${expected.join("x")}; found ${actual.join("x")}.`);
  }
}

for (const file of ["PRIVACY.md", join("docs", "privacy.html")]) {
  const policy = (await readFile(join(root, file), "utf8")).replace(/\s+/g, " ");
  if (!policy.includes("Chrome Web Store User Data Policy")
      || !policy.includes("Limited Use requirements")) {
    throw new Error(`${file} is missing the Chrome Web Store Limited Use disclosure.`);
  }
}

console.log("Static checks passed.");
