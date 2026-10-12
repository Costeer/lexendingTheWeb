import assert from "node:assert/strict";
import test from "node:test";
import { resolve } from "node:path";
import { readFile } from "node:fs/promises";
import { chromium } from "playwright";
import { instrumentContent } from "./helpers/conversation.mjs";

const cycles = Number(process.env.LEXEND_STRESS_CYCLES ?? 12);
if (!Number.isInteger(cycles) || cycles < 1 || cycles > 1000) throw new Error("LEXEND_STRESS_CYCLES must be an integer from 1 to 1000");

test("repeated feed replacement and pause/resume settle within a bounded amount of work", async () => {
  const browser = await chromium.launch();
  try {
    const page = await browser.newPage();
    await page.route("http://stress.test/**", async (route) => {
      const path = new URL(route.request().url()).pathname;
      await route.fulfill({ body: await readFile(resolve(`.${path}`)), contentType: "font/woff2" });
    });
    await page.setContent('<!doctype html><style>body{font:16px/1.5 Arial}p{margin:0}pre{font:14px monospace}</style><main id="feed"></main><pre id="code">const preserved = true;</pre>');
    await page.evaluate(() => {
      const listeners = [], messages = [];
      let settings = { enabled: true, scope: "all", textScale: 120 };
      globalThis.chrome = {
        runtime: { getURL: (path) => `http://stress.test/${path}`, sendMessage: async () => {}, onMessage: { addListener: (fn) => messages.push(fn) } },
        storage: { sync: { get: async () => settings }, onChanged: { addListener: (fn) => listeners.push(fn) } }
      };
      globalThis.update = (patch) => {
        settings = { ...settings, ...patch };
        const changes = Object.fromEntries(Object.entries(patch).map(([key, newValue]) => [key, { newValue }]));
        listeners.forEach((fn) => fn(changes, "sync"));
      };
      globalThis.state = () => {
        let result;
        messages.forEach((fn) => fn({ type: "LEXEND_GET_STATE" }, null, (value) => { result = value; }));
        return result;
      };
      const native = getComputedStyle;
      globalThis.styleReads = 0;
      globalThis.getComputedStyle = (...args) => { styleReads++; return native(...args); };
      globalThis.replaceFeed = (iteration) => {
        const fragment = document.createDocumentFragment();
        for (let index = 0; index < 20; index++) {
          const article = document.createElement("article");
          article.innerHTML = `<p>Feed ${iteration}, entry ${index}</p><button>Read entry</button><div class="host"></div>`;
          article.querySelector(".host").attachShadow({ mode: "open" }).innerHTML = "<p>Shadow feed entry</p>";
          fragment.append(article);
        }
        document.querySelector("#feed").replaceChildren(fragment);
      };
      replaceFeed(0);
    });
    for (const name of ["settings", "adaptive-controls", "adaptive-layout", "content"]) {
      const path = resolve(`src/${name}.js`);
      if (name === "content") await page.addScriptTag({ content: instrumentContent(await readFile(path, "utf8")) });
      else await page.addScriptTag({ path });
    }
    await page.evaluate(() => document.fonts.ready);
    await page.waitForFunction(() => state()?.healthy && !state().pending);
    const client = await page.context().newCDPSession(page);
    let warmHeap, warmNodes;
    for (let iteration = 0; iteration < cycles; iteration++) {
      const scale = iteration % 2 ? 110 : 130;
      await page.evaluate(({ iteration, scale }) => {
        styleReads = 0;
        replaceFeed(iteration);
        update({ textScale: scale });
        dispatchEvent(new Event("resize"));
      }, { iteration, scale });
      await page.waitForFunction((size) => state()?.healthy && !state().pending
        && Math.abs(parseFloat(getComputedStyle(document.querySelector("#feed p")).fontSize) - size) < .03,
      16 * scale / 100);
      const active = await page.evaluate(() => ({
        reads: styleReads,
        shadowSizes: [...document.querySelectorAll(".host")].map((host) => parseFloat(getComputedStyle(host.shadowRoot.querySelector("p")).fontSize)),
        code: getComputedStyle(document.querySelector("#code")).fontSize,
        duplicateStyles: [...document.querySelectorAll(".host")].some((host) => host.shadowRoot.querySelectorAll("#lexend-the-web-styles").length > 1)
      }));
      assert(active.reads < 40000, `cycle ${iteration}: ${active.reads} style reads exceeds the work budget`);
      assert(active.shadowSizes.every((size) => Math.abs(size - 16 * scale / 100) < .03), `cycle ${iteration}: shadow typography must scale exactly once`);
      assert.equal(active.code, "14px");
      assert.equal(active.duplicateStyles, false);
      const retained = await page.evaluate(() => __collections());
      assert.equal(retained.detached, 0, `cycle ${iteration}: detached typography owners`);
      assert.equal(retained.eligibleDetached, 0, `cycle ${iteration}: detached text candidates`);
      assert.equal(retained.detachedRoots, 0, `cycle ${iteration}: detached shadow roots`);
      assert.equal(retained.detachedAuto, 0, `cycle ${iteration}: detached auto-content targets`);
      assert.equal(retained.styledRoots, 21, "only the document and current 20 shadow roots remain");
      if (iteration === 2 || iteration === cycles - 1) {
        await client.send("HeapProfiler.collectGarbage");
        const heap = (await client.send("Runtime.getHeapUsage")).usedSize;
        const nodes = (await client.send("Memory.getDOMCounters")).nodes;
        if (warmHeap !== undefined) {
          assert.ok(heap < warmHeap + 1_000_000, `post-GC heap grew from ${warmHeap} to ${heap} bytes`);
          assert.ok(nodes <= warmNodes + 20, `live DOM grew from ${warmNodes} to ${nodes} nodes`);
        }
        warmHeap = heap;
        warmNodes = nodes;
      }
      await page.evaluate(() => update({ enabled: false }));
      await page.waitForFunction(() => !state().pending);
      const paused = await page.evaluate((iteration) => {
        const revision = state().refreshRevision;
        styleReads = 0;
        replaceFeed(iteration);
        dispatchEvent(new Event("resize"));
        return revision;
      }, iteration);
      // Wait through the mutation debounce to catch work incorrectly scheduled while paused.
      await page.waitForTimeout(150);
      assert.deepEqual(await page.evaluate(() => ({ reads: styleReads, revision: state().refreshRevision })),
        { reads: 0, revision: paused });
      assert.equal(await page.locator("#feed p").first().evaluate((element) => getComputedStyle(element).fontSize), "16px");
      await page.evaluate(() => update({ enabled: true }));
      await page.waitForFunction(() => state()?.healthy && !state().pending);
    }
    await page.evaluate(() => update({ enabled: false }));
    assert.equal(await page.locator("#feed p").first().getAttribute("style"), null);
    assert.equal(await page.locator("#code").getAttribute("style"), null);
  } finally {
    await browser.close();
  }
});
