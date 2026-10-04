import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
import test from "node:test";
import { chromium } from "playwright";

// A tiny original triangle at U+F007 deliberately conflicts with Nerd Fonts'
// user icon. The font has no other mapped glyphs, so U+F013 needs a fallback.
const siteIcons = "d09GMgABAAAAAAF0AAoAAAAAAzAAAAErAAEAAAAAAAAAAAAAAAAAAAAAAAAAAAAABmAANAoYNQE2AiQDBgsGAAQgBYIaBy8bkQIALgrshmOHgGr7L6caQvhjEIhrWDxPjbX3d/cM9+nniUb1xhAJiRbEWqIznZDJHF5b1YMf8hdGlPhAcMXD2/8D9QD7QXNX37qbJxDQIYxSCuTb1yqNonNSEvhBUswSjWNNt4ljzDeSROoLiViNl0cdDb1GvCDz37MhcM7M2Q8C6swuqNjKcbM5Q0upUsC7LAAKaAgqOoAGSLVRMR9+BATh7tvfElfRAH9h/oWzOXksURUQjvDJPJubp4ABAInHXFBUAQUAAEs+BcQKAoqeFQF1TbYYOhZt77uWnKnSNIojwxiKFZeyQjaDjh0PrWvPU7MH20z4BI4+pqI7aJ2NpzlI5BWJ2acHrrROB3Cv9/rEeqPfpvbI9R6vObPPjE1rkIIWiGEupKh3OwAA";

test("bundled symbols render missing icons while site glyphs win and pause restores families", async () => {
  const browser = await chromium.launch({ headless: true });
  try {
    const page = await browser.newPage();
    const requests = [];
    page.on("request", (request) => requests.push(request.url()));
    await page.route("http://lexend.test/**", async (route) => {
      const pathname = new URL(route.request().url()).pathname;
      await route.fulfill({ body: await readFile(resolve(`.${pathname}`)), contentType: "font/woff2" });
    });
    await page.setContent(`<!doctype html><style>
      @font-face {font-family:SiteIcons;src:url(data:font/woff2;base64,${siteIcons})}
      body {font:20px/30px Arial}
      #site,#missing,#mixed,#generated::before {font-family:SiteIcons,Arial}
      #generated::before {content:"\\f007\\f013"}
    </style>
    <p id=prose>Ordinary prose</p>
    <span id=site>\uf007</span><span id=missing>\uf013</span>
    <span id=supplementary>\u{f0001}</span>
    <p id=mixed>Caption \uf007 \uf013</p><span id=generated>Generated icons</span>
    <code id=code>\uf013</code><span data-lexend-ignore id=ignored>\uf013</span>
    <span id=host></span>`);
    await page.evaluate(() => {
      const shadow = document.querySelector("#host").attachShadow({ mode: "open" });
      shadow.innerHTML = '<span id="shadow-icon">\uf013</span>';
      globalThis.__listeners = [];
      globalThis.__settings = { enabled: false, scope: "all" };
      globalThis.chrome = {
        runtime: { getURL: (path) => `http://lexend.test/${path}`, sendMessage: async () => {}, onMessage: { addListener() {} } },
        storage: { sync: { get: async () => __settings }, onChanged: { addListener: (fn) => __listeners.push(fn) } }
      };
      globalThis.__enable = (enabled) => {
        __settings.enabled = enabled;
        __listeners.forEach((fn) => fn({ enabled: { newValue: enabled } }, "sync"));
      };
    });
    await page.evaluate(() => document.fonts.load("20px SiteIcons", "\uf007"));
    const originals = await page.evaluate(() => ({
      styles: Object.fromEntries(["site", "missing", "mixed", "code", "ignored"].map((id) => [id, document.getElementById(id).getAttribute("style")])),
      pseudo: getComputedStyle(document.getElementById("generated"), "::before").fontFamily,
      shadow: getComputedStyle(document.getElementById("host").shadowRoot.getElementById("shadow-icon")).fontFamily
    }));
    for (const path of ["src/settings.js", "src/adaptive-controls.js", "src/adaptive-layout.js", "src/content.js"]) {
      await page.addScriptTag({ path: resolve(path) });
    }
    assert.equal(requests.some((url) => url.endsWith("nerd-fonts-symbols.woff2")), false, "paused extension does not fetch symbols");
    await page.evaluate(() => __enable(true));
    await page.waitForFunction(() => /Lexend Nerd Symbols/.test(getComputedStyle(document.getElementById("missing")).fontFamily));
    await page.evaluate(() => document.fonts.ready);

    const session = await page.context().newCDPSession(page);
    await session.send("DOM.enable");
    await session.send("CSS.enable");
    const { root } = await session.send("DOM.getDocument", { depth: -1, pierce: true });
    const fontsFor = async (selector) => {
      const { nodeId } = await session.send("DOM.querySelector", { nodeId: root.nodeId, selector });
      return (await session.send("CSS.getPlatformFontsForNode", { nodeId })).fonts.filter(({ glyphCount }) => glyphCount > 0);
    };
    assert.deepEqual((await fontsFor("#site")).map(({ familyName }) => familyName), ["Site Icon Test"], "original site icon wins the collision");
    assert.deepEqual((await fontsFor("#missing")).map(({ familyName }) => familyName), ["Symbols Nerd Font"], "missing icon uses the bundled font");
    assert.deepEqual((await fontsFor("#supplementary")).map(({ familyName }) => familyName), ["Symbols Nerd Font"], "supplementary private-use icons also render");
    const { nodeId: generatedId } = await session.send("DOM.querySelector", { nodeId: root.nodeId, selector: "#generated" });
    const { node: generated } = await session.send("DOM.describeNode", { nodeId: generatedId });
    const { nodeId: beforeId } = await session.send("DOM.pushNodesByBackendIdsToFrontend", { backendNodeIds: [generated.pseudoElements.find(({ pseudoType }) => pseudoType === "before").backendNodeId] }).then(({ nodeIds }) => ({ nodeId: nodeIds[0] }));
    const generatedFonts = (await session.send("CSS.getPlatformFontsForNode", { nodeId: beforeId })).fonts.map(({ familyName }) => familyName);
    for (const name of ["Site Icon Test", "Symbols Nerd Font"]) assert.ok(generatedFonts.includes(name), `${name} paints generated icons`);
    const { nodeId: hostId } = await session.send("DOM.querySelector", { nodeId: root.nodeId, selector: "#host" });
    const { node: host } = await session.send("DOM.describeNode", { nodeId: hostId, depth: 1, pierce: true });
    const { nodeId: shadowId } = await session.send("DOM.querySelector", { nodeId: host.shadowRoots[0].nodeId, selector: "#shadow-icon" });
    assert.deepEqual((await session.send("CSS.getPlatformFontsForNode", { nodeId: shadowId })).fonts.map(({ familyName }) => familyName), ["Symbols Nerd Font"], "shadow icon uses the bundled font");
    const mixedFonts = (await fontsFor("#mixed")).map(({ familyName }) => familyName);
    for (const name of ["Lexend", "Site Icon Test", "Symbols Nerd Font"]) assert.ok(mixedFonts.includes(name), `${name} paints mixed prose`);
    assert.equal((await fontsFor("#prose")).some(({ familyName }) => familyName === "Symbols Nerd Font"), false, "ordinary letters stay in Lexend");
    const families = await page.evaluate(() => ({
      missing: getComputedStyle(document.getElementById("missing")).fontFamily,
      pseudo: getComputedStyle(document.getElementById("generated"), "::before").fontFamily,
      shadow: getComputedStyle(document.getElementById("host").shadowRoot.getElementById("shadow-icon")).fontFamily,
      code: document.getElementById("code").style.fontFamily,
      ignored: document.getElementById("ignored").style.fontFamily
    }));
    assert.match(families.missing, /^SiteIcons, Arial, "Lexend Nerd Symbols"$/);
    assert.match(families.pseudo, /^SiteIcons, Arial, "Lexend Nerd Symbols"$/);
    assert.match(families.shadow, /Lexend Nerd Symbols/);
    assert.doesNotMatch(families.code, /Lexend Nerd Symbols/);
    assert.doesNotMatch(families.ignored, /Lexend Nerd Symbols/);
    assert.equal(requests.filter((url) => url.endsWith("nerd-fonts-symbols.woff2")).length, 1, "one local symbols asset serves document and shadow DOM");

    // Font loading and mutation refreshes must not repeatedly append families.
    await page.evaluate(() => { document.getElementById("mixed").append(" refreshed"); });
    await page.waitForFunction(() => document.getElementById("mixed").textContent.endsWith("refreshed") && /Lexend Nerd Symbols/.test(document.getElementById("mixed").style.fontFamily));
    await page.waitForTimeout(150);
    assert.equal(await page.locator("#mixed").evaluate((element) => element.style.fontFamily.split("Lexend Nerd Symbols").length - 1), 1);
    await page.evaluate(() => __enable(false));
    await page.waitForFunction(() => !document.getElementById("mixed").hasAttribute("data-lexend-text"));
    const restored = await page.evaluate(() => ({
      styles: Object.fromEntries(["site", "missing", "mixed", "code", "ignored"].map((id) => [id, document.getElementById(id).getAttribute("style")])),
      pseudo: getComputedStyle(document.getElementById("generated"), "::before").fontFamily,
      shadow: getComputedStyle(document.getElementById("host").shadowRoot.getElementById("shadow-icon")).fontFamily
    }));
    assert.deepEqual(restored, originals);
    await page.evaluate(() => __enable(true));
    await page.waitForFunction(() => /Lexend Nerd Symbols/.test(getComputedStyle(document.getElementById("missing")).fontFamily));
    assert.equal(requests.filter((url) => url.endsWith("nerd-fonts-symbols.woff2")).length, 1, "re-enabling reuses the local font");
  } finally {
    await browser.close();
  }
});
