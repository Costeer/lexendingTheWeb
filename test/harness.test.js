import assert from "node:assert/strict";
import test from "node:test";
import { collectSnapshot, compareSnapshots } from "../harness/audit.js";
import { runInNewContext } from "node:vm";
import { validateReview, reviewTemplate } from "../harness/report.mjs";
import { validateConfig, reconcileReappeared, visibleInScreenshot, waitForTypographyState } from "../harness/run.mjs";
import { uncoveredRanges, missingFrames } from "../harness/coverage.mjs";

test("capture flags frames removed or navigated after the baseline", () => {
  const before = [{ index: 0, url: "https://example.org" }, { index: 1, url: "about:blank" }];
  assert.deepEqual(missingFrames(before, before), []);
  assert.deepEqual(missingFrames(before, before.slice(0, 1)), [before[1]]);
  assert.deepEqual(missingFrames(before, [before[0], { index: 1, url: "https://other.example" }]), [before[1]]);
});

test("a transient loss is reviewed only when identical text returns to its DOM location", () => {
  const missing = { code: "missing-element", severity: "error", frameIndex: 0, path: "main > p", text: "Readable notice" };
  const final = [{ index: 0, elements: [{ path: "main > p", text: "Readable notice" }] }];
  const [reappeared] = reconcileReappeared([missing], final);
  assert.equal(reappeared.code, "reappeared-element");
  assert.equal(reappeared.severity, "review");
  assert.equal(reconcileReappeared([missing], [{ index: 0, elements: [{ path: "aside > p", text: missing.text }] }])[0], missing);
  assert.equal(reconcileReappeared([missing], [{ index: 0, elements: [{ path: missing.path, text: "Other notice" }] }])[0], missing);
});

test("clipping needs text inside the screenshot rather than an offscreen carousel slide", () => {
  const tile = { width: 390, viewportHeight: 844, scrollX: 0, scrollY: 4220 };
  assert.equal(visibleInScreenshot(tile, { rect: { x: 20, y: 4400, width: 200, height: 80 } }), true);
  assert.equal(visibleInScreenshot(tile, { rect: { x: 20, y: 2731, width: 200, height: 80 } }), false);
  assert.equal(visibleInScreenshot(tile, { rect: { x: 20, y: 5063, width: 200, height: 5 } }), false);
  assert.equal(visibleInScreenshot(tile, { rect: { x: 410, y: 4400, width: 200, height: 80 } }), false);
});

test("screenshot coverage detects deferred growth and stalled scrolling", () => {
  const tiles = [0, 900, 1800].map((afterScrollY) => ({ afterScrollY }));
  assert.deepEqual(uncoveredRanges(tiles, "after", 900, 2600), []);
  assert.deepEqual(uncoveredRanges(tiles, "after", 900, 3100), [[2700, 3100]]);
  assert.deepEqual(uncoveredRanges([{ afterScrollY: 0 }, { afterScrollY: 0 }], "after", 900, 3100), [[900, 3100]]);
  assert.deepEqual(uncoveredRanges([{ afterScrollY: 0 }, { afterScrollY: 1800 }], "after", 900, 2700), [[900, 1800]]);
});

const settings = { textScale: 110, lineHeight: 1.6, letterSpacing: 0.02 };
const element = { id: 1, path: "p", text: "Readable text", excluded: null, pseudo: [], fontFamily: "Arial", fontSize: 16, lineHeight: 24, letterSpacing: 0, clipping: 0, controlOverflow: 0, lexendLoaded: true };
const converted = { ...element, fontFamily: '"Lexend for the Web", sans-serif', fontSize: 17.6, lineHeight: 28.16, letterSpacing: 0.352 };
const snapshot = (elements) => ({ elements, horizontalOverflow: 0 });

test("snapshot distinguishes transparent image labels from visible gradient text", () => {
  const capture = ({ image = true, textClip = false, parentTextClip = false, heading = false, brokenWord = false, ariaHidden = false, displayFont = 16, clip = "auto", text = "Download app", fontFamily = "Arial", fontFaces = [] } = {}) => {
    const box = { x: 0, y: 0, left: 0, top: 0, right: 120, bottom: 30, width: 120, height: 30 };
    const css = { display: "inline", visibility: "visible", opacity: "1", position: "static", overflow: "visible", overflowX: "visible", overflowY: "visible", clip: "auto",
      color: "rgba(0, 0, 0, 0)", backgroundColor: "rgba(0, 0, 0, 0)", backgroundClip: textClip ? "text" : "border-box", webkitBackgroundClip: textClip ? "text" : "border-box", backgroundImage: image ? 'url("badge.png")' : "none",
      fontFamily, fontSize: `${displayFont}px`, lineHeight: "24px", letterSpacing: "0px", fontStyle: "normal", fontWeight: "400", content: "none" };
    let document;
    const node = (tagName, id, childNodes = []) => ({ tagName, id, localName: tagName.toLowerCase(), childNodes, children: [], parentElement: null,
      matches: (selector) => ariaHidden && selector.includes("[aria-hidden='true']"), querySelector: () => null, getRootNode: () => document, getAttribute: () => null,
      getClientRects: () => [box], getBoundingClientRect: () => box });
    const body = node("BODY", "fixture-root");
    body.css = { ...css, color: "rgb(0, 0, 0)", backgroundImage: "none", backgroundClip: parentTextClip ? "text" : "border-box", webkitBackgroundClip: parentTextClip ? "text" : "border-box" };
    const label = node(heading ? "H1" : "SPAN", "label", [{ nodeType: 3, textContent: text }]);
    if (heading) label.matches = (selector) => selector.includes("h1,h2,h3,h4,h5,h6");
    label.css = { ...css, clip };
    label.parentElement = body;
    body.children.push(label);
    const html = node("HTML", "fixture-document");
    html.css = { ...css, contain: "none" };
    html.scrollHeight = 30;
    html.scrollWidth = 390;
    body.css.contain = "none";
    document = { querySelectorAll: () => [body, label], documentElement: html, scrollingElement: html, body,
      createRange: () => ({ word: false, selectNodeContents() {}, setStart() { this.word = true; }, setEnd() {},
        getClientRects() { return this.word && brokenWord ? [box, { ...box, top: 32, bottom: 62 }] : [box]; } }), fonts: { check: () => true, *[Symbol.iterator]() { yield* fontFaces; } } };
    return runInNewContext(`(${collectSnapshot.toString()})({ scope: "all" })`, {
      document, window: {}, location: { href: "https://example.org/" }, Node: { TEXT_NODE: 3 }, ShadowRoot: class {},
      getComputedStyle: (element) => element.css, innerWidth: 390, innerHeight: 844, scrollX: 0, scrollY: 0
    });
  };
  const sprite = capture();
  assert.equal(sprite.elements.length, 0);
  assert.ok(sprite.limitations.some((item) => item.reason.includes("Transparent accessible label")));
  assert.equal(capture({ image: false, clip: "rect(1px, 1px, 1px, 1px)" }).elements.length, 0);
  assert.equal(capture({ image: false, clip: "rect(1px 80px 24px 1px)" }).elements.length, 1);
  for (const visible of [capture({ textClip: true }), capture({ parentTextClip: true }), capture({ image: false })]) {
    assert.equal(visible.elements.length, 1);
    assert.equal(visible.elements[0].hasOwnText, true);
  }
  const wholeHeading = capture({ image: false, heading: true, text: "Framework" });
  const splitHeading = capture({ image: false, heading: true, brokenWord: true, text: "Framework" });
  assert.equal(wholeHeading.elements[0].headingWordLines.Framework, 1);
  assert.equal(splitHeading.elements[0].headingWordLines.Framework, 2);
  const cjk = capture({ image: false, heading: true, brokenWord: true, text: "日本語文章" });
  assert.equal(Object.keys(cjk.elements[0].headingWordLines).length, 0);
  const visibleAriaHiddenProse = capture({ image: false, ariaHidden: true, text: "Visible prose" });
  assert.equal(visibleAriaHiddenProse.elements[0].excluded, null);
  const displayParagraph = capture({ image: false, displayFont: 50, brokenWord: true, text: "The Ecosystem" });
  assert.equal(displayParagraph.elements[0].headingWordLines.Ecosystem, 2);
  const face = { family: '"Lexend for the Web"', unicodeRange: "U+20-FF,U+0100-017F" };
  const latin = capture({ image: false, text: "Română", fontFamily: face.family, fontFaces: [face] });
  assert.equal(latin.elements[0].lexendCoverage.covered, true);
  const fallback = capture({ image: false, text: "Read 日本", fontFamily: face.family, fontFaces: [face] });
  assert.equal(fallback.elements[0].lexendLoaded, true);
  assert.equal(fallback.elements[0].lexendCoverage.covered, false);
  assert.equal(fallback.elements[0].lexendCoverage.unsupported, "日本");
  const missing = capture({ image: false, fontFamily: face.family });
  assert.equal(missing.elements[0].lexendCoverage.available, false);
});

test("audit requires actual conversion and requested readability settings", () => {
  const good = compareSnapshots(snapshot([element]), snapshot([converted]), settings);
  assert.equal(good.coverage, 1);
  assert.deepEqual(good.findings, []);
  const bad = compareSnapshots(snapshot([element]), snapshot([element]), settings);
  assert.equal(bad.coverage, 0);
  assert.deepEqual(bad.findings.map((finding) => finding.code), ["unconverted", "scale-mismatch", "line-height-mismatch", "letter-spacing-mismatch"]);
});

test("loaded declarations do not certify fallback glyphs or absent font faces", () => {
  const fallback = { ...converted, text: "Read 日本語", lexendCoverage: { known: true, available: true, covered: false, unsupported: "日本語" } };
  const baseline = { ...element, text: fallback.text };
  const result = compareSnapshots(snapshot([baseline]), snapshot([fallback]), settings);
  assert.equal(result.eligible, 1);
  assert.equal(result.converted, 0);
  assert.ok(result.findings.some((finding) => finding.code === "font-fallback-coverage" && finding.severity === "review"));
  const absent = compareSnapshots(snapshot([element]), snapshot([{ ...converted, lexendCoverage: { known: true, available: false, covered: false } }]), settings);
  assert.equal(absent.converted, 0);
  assert.ok(absent.findings.some((finding) => finding.code === "font-not-loaded"));
  const covered = compareSnapshots(snapshot([element]), snapshot([{ ...converted, lexendCoverage: { known: true, available: true, covered: true } }]), settings);
  assert.equal(covered.converted, 1);
  assert.deepEqual(covered.findings, []);
});

test("technical paths with a wrapped segment require visual review", () => {
  const path = "chore: translation of `Web/HTTP/Reference/Headers/Sec-Fetch-User`";
  const before = { ...element, text: path, actionWordLines: { Sec: 1 } };
  const after = { ...converted, text: path, actionWordLines: { Sec: 2 } };
  const result = compareSnapshots(snapshot([before]), snapshot([after]), settings);
  assert.ok(result.findings.some((finding) => finding.code === "technical-action-word-break" && finding.severity === "review"));
});

test("joined Arabic labels keep zero tracking while still scaling and converting", () => {
  const before = { ...element, text: "سارة أحمد" };
  const after = { ...converted, text: before.text, letterSpacing: 0 };
  const result = compareSnapshots(snapshot([before]), snapshot([after]), settings);
  assert.equal(result.coverage, 1);
  assert.ok(!result.findings.some((finding) => finding.code === "letter-spacing-mismatch"));
  const tracked = compareSnapshots(snapshot([before]), snapshot([{ ...after, letterSpacing: 0.3 }]), settings);
  assert.ok(tracked.findings.some((finding) => finding.code === "letter-spacing-mismatch"));
});

test("audit flags unloaded fonts, new clipping, lost text, and protected content changes", () => {
  const after = { ...converted, lexendLoaded: false, clipping: 12 };
  assert.deepEqual(compareSnapshots(snapshot([element]), snapshot([after]), settings).findings.map((finding) => finding.code), ["font-not-loaded", "new-clipping"]);
  assert.ok(compareSnapshots(snapshot([element]), snapshot([]), settings).findings.some((finding) => finding.code === "missing-element"));
  const protectedElement = { ...element, excluded: "code / protected content" };
  assert.equal(compareSnapshots(snapshot([protectedElement]), snapshot([{ ...converted, excluded: protectedElement.excluded }]), settings).findings[0].code, "protected-content-changed");
});

test("audit catches text beyond the reachable document independently of font conversion", () => {
  const result = compareSnapshots(snapshot([{ ...element, documentTextOverflow: 0 }]),
    snapshot([{ ...converted, documentTextOverflow: 120 }]), settings);
  assert.deepEqual(result.findings.map((finding) => finding.code), ["document-text-unreachable"]);
  assert.deepEqual(compareSnapshots(snapshot([{ ...element, documentTextOverflow: 120 }]),
    snapshot([{ ...converted, documentTextOverflow: 120 }]), settings).findings, []);
});

test("scrolling can excuse only the clipping axis it makes reachable", () => {
  const before = { ...element, clipping: 10, clippingX: 10, clippingY: 0 };
  const after = { ...converted, clipping: 30, clippingX: 30, clippingY: 0, scrollableX: true, scrollableY: false };
  const review = compareSnapshots(snapshot([before]), snapshot([after]), settings);
  assert.equal(review.findings[0].code, "scrollable-text-clipping");
  assert.equal(review.findings[0].severity, "review");
  assert.equal(compareSnapshots(snapshot([before]), snapshot([{ ...after, clippingY: 20 }]), settings).findings[0].code, "new-clipping");
  assert.equal(compareSnapshots(snapshot([before]), snapshot([{ ...after, scrollableX: false }]), settings).findings[0].code, "new-clipping");
});

test("hidden DOM state needs equivalent-state review while removal remains an error", () => {
  const hidden = compareSnapshots(snapshot([element]), { ...snapshot([]), domIds: [element.id] }, settings);
  assert.equal(hidden.findings.find((finding) => finding.code === "hidden-state-change").severity, "review");
  assert.ok(!hidden.findings.some((finding) => finding.code === "missing-element"));
  const removed = compareSnapshots(snapshot([element]), { ...snapshot([]), domIds: [] }, settings);
  assert.equal(removed.findings.find((finding) => finding.code === "missing-element").severity, "error");
});

test("same-text DOM replacements require review while changed or displaced text remains a loss", () => {
  const replaced = compareSnapshots(snapshot([element]), snapshot([{ ...converted, id: 2 }]), settings);
  assert.equal(replaced.findings.find((finding) => finding.code === "replaced-element").severity, "review");
  assert.ok(!replaced.findings.some((finding) => finding.code === "missing-element"));
  for (const replacement of [{ ...converted, id: 2, text: "Different content" }, { ...converted, id: 2, path: "footer > p" }]) {
    assert.ok(compareSnapshots(snapshot([element]), snapshot([replacement]), settings).findings.some((finding) => finding.code === "missing-element"));
  }
});

test("unpainted embedded frame overflow needs reveal evidence while visible frames remain errors", () => {
  const before = { ...snapshot([element]), embedding: { painted: false } };
  const after = { ...snapshot([converted]), horizontalOverflow: 20, embedding: { painted: false } };
  assert.equal(compareSnapshots(before, after, settings).findings.find((finding) => finding.code === "hidden-frame-overflow").severity, "review");
  assert.ok(compareSnapshots(before, { ...after, embedding: { painted: true } }, settings).findings.some((finding) => finding.code === "page-overflow" && finding.severity === "error"));
  assert.ok(compareSnapshots(before, { ...after, elements: [element] }, settings).findings.some((finding) => finding.code === "unconverted" && finding.severity === "error"));
});

test("a private pseudo glyph with alternate text is protected while a painted slash caption converts", () => {
  const pseudo = { which: "::after", content: '"\uf111" / "status"', fontFamily: "UnknownGlyphFace", fontSize: 16, lineHeight: 24, letterSpacing: 0 };
  const before = { ...element, pseudo: [pseudo] };
  const after = { ...converted, pseudo: [pseudo] };
  assert.ok(!compareSnapshots(snapshot([before]), snapshot([after]), settings).findings.some((finding) => finding.code === "pseudo-unconverted"));
  const changed = { ...after, pseudo: [{ ...pseudo, fontFamily: "Lexend for the Web" }] };
  assert.ok(compareSnapshots(snapshot([before]), snapshot([changed]), settings).findings.some((finding) => finding.code === "protected-pseudo-changed"));
  const painted = { ...pseudo, content: '"\uf111 / Caption"' };
  assert.ok(compareSnapshots(snapshot([{ ...before, pseudo: [painted] }]), snapshot([{ ...after, pseudo: [painted] }]), settings).findings.some((finding) => finding.code === "pseudo-unconverted"));
});

test("pseudo-only protected icons audit their actual glyph rather than empty host metrics", () => {
  const glyph = { which: "::after", content: '"\\ue001"', fontFamily: "FontAwesome", fontSize: 16, lineHeight: 16, letterSpacing: 0, protectedFont: true };
  const before = { ...element, hasOwnText: false, text: "", pseudo: [glyph], excluded: "generated typography / protected content" };
  const after = { ...before, fontFamily: converted.fontFamily, fontSize: 17.6, lineHeight: 28.16, letterSpacing: 0.352 };
  const unchangedGlyph = compareSnapshots(snapshot([before]), snapshot([after]), settings);
  assert.ok(!unchangedGlyph.findings.some((finding) => finding.code === "protected-content-changed"));
  const changedGlyph = compareSnapshots(snapshot([before]), snapshot([{ ...after, pseudo: [{ ...glyph, fontSize: 20 }] }]), settings);
  assert.ok(changedGlyph.findings.some((finding) => finding.code === "protected-pseudo-changed"));
});

test("audit retains baseline icon protection after its font was incorrectly converted", () => {
  const icon = { ...element, text: "cba", fontFamily: "CC", excluded: "icon / symbol class" };
  const result = compareSnapshots(snapshot([icon]), snapshot([{ ...converted, text: "cba" }]), settings);
  assert.equal(result.eligible, 0);
  assert.equal(result.excluded, 1);
  assert.ok(result.findings.some((finding) => finding.code === "protected-content-changed"));
});

test("heading adaptations need independent baseline evidence and cannot excuse lost text", () => {
  const fitted = { ...converted, fontSize: 16.5, lineHeight: 26.4, letterSpacing: 0.33,
    layoutRepairs: ["fit-heading"], layoutBaselineFontSize: 16 };
  const result = compareSnapshots(snapshot([element]), snapshot([fitted]), settings);
  assert.deepEqual(result.findings.map((finding) => finding.code), ["adapted-heading-size"]);
  assert.equal(result.findings[0].severity, "review");
  const lostText = compareSnapshots(snapshot([element]), snapshot([{ ...fitted, clipping: 10 }]), settings);
  assert.ok(lostText.findings.some((finding) => finding.code === "new-clipping" && finding.severity === "error"));
  const smaller = compareSnapshots(snapshot([element]), snapshot([{ ...fitted, fontSize: 12 }]), settings);
  assert.ok(smaller.findings.some((finding) => finding.code === "smaller-text"));
  const falseBaseline = compareSnapshots(snapshot([element]), snapshot([{ ...fitted, layoutBaselineFontSize: 12 }]), settings);
  assert.ok(falseBaseline.findings.some((finding) => finding.code === "scale-mismatch"));
  const heading = { ...element, fontSize: 48, lineHeight: 72 };
  const fitHeading = { ...converted, fontSize: 32, lineHeight: 51.2, letterSpacing: 0.64,
    layoutRepairs: ["fit-heading", "fit-heading-below-baseline"], layoutBaselineFontSize: 48 };
  const bounded = compareSnapshots(snapshot([heading]), snapshot([fitHeading]), settings);
  assert.deepEqual(bounded.findings.map((finding) => finding.code), ["adapted-heading-size", "adapted-heading-smaller"]);
  assert.ok(bounded.findings.every((finding) => finding.severity === "review"));
  const tooSmall = compareSnapshots(snapshot([heading]), snapshot([{ ...fitHeading, fontSize: 20 }]), settings);
  assert.ok(tooSmall.findings.some((finding) => finding.code === "smaller-text" && finding.severity === "error"));
  const noEvidence = compareSnapshots(snapshot([heading]), snapshot([{ ...fitHeading, layoutBaselineFontSize: null }]), settings);
  assert.ok(noEvidence.findings.some((finding) => finding.code === "smaller-text"));
  const missingToken = compareSnapshots(snapshot([heading]), snapshot([{ ...fitHeading, layoutRepairs: ["fit-heading"] }]), settings);
  assert.ok(missingToken.findings.some((finding) => finding.code === "smaller-text"));
});

test("heading word audit catches newly broken words without flagging existing breaks or new content", () => {
  const heading = { ...element, text: "JavaScript Framework", headingWordLines: { JavaScript: 1, Framework: 1 } };
  const broken = { ...converted, text: heading.text, headingWordLines: { JavaScript: 1, Framework: 2 } };
  const regression = compareSnapshots(snapshot([heading]), snapshot([broken]), settings);
  assert.equal(regression.findings.find((finding) => finding.code === "new-heading-word-break").severity, "error");
  const existing = compareSnapshots(snapshot([{ ...heading, headingWordLines: { JavaScript: 1, Framework: 2 } }]), snapshot([broken]), settings);
  assert.ok(!existing.findings.some((finding) => finding.code === "new-heading-word-break"));
  const newWord = compareSnapshots(snapshot([{ ...heading, headingWordLines: { JavaScript: 1 } }]), snapshot([broken]), settings);
  assert.ok(!newWord.findings.some((finding) => finding.code === "new-heading-word-break"));
  assert.deepEqual(compareSnapshots(snapshot([heading]), snapshot([{ ...converted, text: heading.text, headingWordLines: heading.headingWordLines }]), settings).findings, []);
});

test("empty decorative frames do not fail a case with eligible text elsewhere", () => {
  const empty = compareSnapshots(snapshot([]), snapshot([]), settings);
  assert.equal(empty.eligible, 0);
  assert.deepEqual(empty.findings, []);
  const protectedOnly = { ...element, excluded: "icon / symbol class" };
  const icons = compareSnapshots(snapshot([protectedOnly]), snapshot([protectedOnly]), settings);
  assert.equal(icons.findings.find((finding) => finding.code === "no-eligible-frame-text").severity, "review");
  const lost = compareSnapshots(snapshot([element]), snapshot([]), settings);
  assert.ok(lost.findings.some((finding) => finding.code === "missing-element" && finding.severity === "error"));
});

test("audit distinguishes intentional scrolling review from inaccessible fixed actions", () => {
  const before = { ...element, viewportTextOverflow: 20, fixedControlOverflow: 0, fixedControlVisible: true };
  const after = { ...converted, viewportTextOverflow: 45, fixedControlOverflow: 35 };
  const result = compareSnapshots(snapshot([before]), snapshot([after]), settings);
  assert.equal(result.findings.find((finding) => finding.code === "viewport-text-overflow").severity, "review");
  assert.equal(result.findings.find((finding) => finding.code === "fixed-control-inaccessible").severity, "error");
  assert.deepEqual(compareSnapshots(snapshot([before]), snapshot([{ ...converted, viewportTextOverflow: 20, fixedControlOverflow: 0 }]), settings).findings, []);
  const hiddenBefore = compareSnapshots(snapshot([{ ...before, fixedControlVisible: false }]), snapshot([after]), settings);
  assert.ok(!hiddenBefore.findings.some((finding) => finding.code === "fixed-control-inaccessible"));
  const changedScroll = compareSnapshots({ ...snapshot([before]), scrollY: 0 }, { ...snapshot([after]), scrollY: 500 }, settings);
  assert.equal(changedScroll.findings.find((finding) => finding.code === "fixed-control-state-review").severity, "review");
});

test("native single-select line height requires visual review without excusing ordinary text", () => {
  const after = { ...converted, tag: "select", nativeSingleSelect: true, lineHeight: null };
  const native = compareSnapshots(snapshot([{ ...element, tag: "select" }]), snapshot([after]), settings);
  assert.deepEqual(native.findings.map((finding) => finding.code), ["native-control-line-height"]);
  assert.equal(native.findings[0].severity, "review");
  const nativeButton = compareSnapshots(snapshot([{ ...element, tag: "input" }]),
    snapshot([{ ...converted, tag: "input", nativeButtonInput: true, lineHeight: null }]), settings);
  assert.equal(nativeButton.findings[0].code, "native-control-line-height");
  assert.equal(nativeButton.findings[0].severity, "review");
  const plainInput = compareSnapshots(snapshot([{ ...element, tag: "input" }]),
    snapshot([{ ...converted, tag: "input", nativeButtonInput: false, lineHeight: null }]), settings);
  assert.equal(plainInput.findings[0].code, "line-height-mismatch");
  for (const tag of ["p", "button", "textarea"]) {
    const result = compareSnapshots(snapshot([{ ...element, tag }]), snapshot([{ ...after, tag }]), settings);
    assert.ok(result.findings.some((finding) => finding.code === "line-height-mismatch" && finding.severity === "error"));
  }
  const custom = compareSnapshots(snapshot([{ ...element, tag: "select" }]), snapshot([{ ...after, nativeSingleSelect: false }]), settings);
  assert.ok(custom.findings.some((finding) => finding.code === "line-height-mismatch"));
  const unconverted = compareSnapshots(snapshot([{ ...element, tag: "select" }]), snapshot([{ ...after, fontFamily: "Arial", fontSize: 16, letterSpacing: 0 }]), settings);
  assert.ok(unconverted.findings.some((finding) => finding.code === "unconverted"));
  assert.ok(unconverted.findings.some((finding) => finding.code === "scale-mismatch"));
  assert.ok(unconverted.findings.some((finding) => finding.code === "letter-spacing-mismatch"));
});

test("generated symbols stay protected without hiding the surrounding prose conversion", () => {
  const icon = { which: "::before", content: '"\\ue001"', fontFamily: "FontAwesome", fontSize: 16, lineHeight: 16, letterSpacing: 0, protectedFont: true };
  const before = { ...element, pseudo: [icon] };
  const result = compareSnapshots(snapshot([before]), snapshot([{ ...converted, pseudo: [icon] }]), settings);
  assert.equal(result.eligible, 1);
  assert.deepEqual(result.findings, []);
  const changed = compareSnapshots(snapshot([before]), snapshot([{ ...converted, pseudo: [{ ...icon, fontFamily: converted.fontFamily, protectedFont: false }] }]), settings);
  assert.ok(changed.findings.some((finding) => finding.code === "protected-pseudo-changed"));
  const mono = { ...icon, content: '"Live"', fontFamily: '"DM Mono", monospace' };
  const monoBefore = { ...element, pseudo: [mono] };
  assert.deepEqual(compareSnapshots(snapshot([monoBefore]), snapshot([{ ...converted, pseudo: [mono] }]), settings).findings, []);
  const changedMono = compareSnapshots(snapshot([monoBefore]), snapshot([{ ...converted, pseudo: [{ ...mono, fontFamily: converted.fontFamily, protectedFont: false }] }]), settings);
  assert.ok(changedMono.findings.some((finding) => finding.code === "protected-pseudo-changed"));
  const arbitraryGlyph = { ...icon, content: '"\ue842"', fontFamily: "fontutti", protectedFont: false };
  const arbitraryBefore = { ...element, pseudo: [arbitraryGlyph] };
  assert.deepEqual(compareSnapshots(snapshot([arbitraryBefore]), snapshot([{ ...converted, pseudo: [arbitraryGlyph] }]), settings).findings, []);
  const replacedGlyph = compareSnapshots(snapshot([arbitraryBefore]), snapshot([{ ...converted, pseudo: [{ ...arbitraryGlyph, fontFamily: converted.fontFamily }] }]), settings);
  assert.ok(replacedGlyph.findings.some((finding) => finding.code === "protected-pseudo-changed" && finding.severity === "error"));
});

test("pseudo-only text audits the generated font rather than the empty host", () => {
  const pseudo = { which: "::before", content: '"Label"', fontFamily: "Arial", fontSize: 16, lineHeight: 24, letterSpacing: 0, protectedFont: false, lexendLoaded: true };
  const before = { ...element, text: "", hasOwnText: false, pseudo: [pseudo] };
  const after = { ...before, pseudo: [{ ...pseudo, fontFamily: converted.fontFamily, fontSize: 17.6 }] };
  const good = compareSnapshots(snapshot([before]), snapshot([after]), settings);
  assert.equal(good.eligible, 1);
  assert.equal(good.converted, 1);
  assert.deepEqual(good.findings, []);
  const bad = compareSnapshots(snapshot([before]), snapshot([before]), settings);
  assert.equal(bad.converted, 0);
  assert.ok(bad.findings.some((finding) => finding.code === "pseudo-unconverted" && finding.severity === "error"));
  assert.ok(!bad.findings.some((finding) => finding.code === "unconverted"));
  const unloaded = compareSnapshots(snapshot([before]), snapshot([{ ...after, pseudo: [{ ...after.pseudo[0], lexendLoaded: false }] }]), settings);
  assert.equal(unloaded.converted, 0);
  assert.ok(unloaded.findings.some((finding) => finding.code === "font-not-loaded"));
  const both = compareSnapshots(snapshot([{ ...before, hasOwnText: true }]), snapshot([{ ...converted, pseudo: after.pseudo }]), settings);
  assert.equal(both.eligible, 2);
  assert.equal(both.converted, 2);
});

test("review cannot pass missing screenshots, unreadable text, or automated errors", () => {
  const report = { runId: "run", cases: [{ id: "desktop", tiles: [{ id: "tile-1" }], audit: { findings: [] }, limitations: [] }] };
  const review = reviewTemplate(report);
  assert.ok(validateReview(report, review).length);
  Object.assign(review, { reviewer: "visual agent", verdict: "pass", summary: "Text is easier to follow with no layout loss.", inspectedTiles: ["tile-1"] });
  Object.assign(review.cases[0], { moreReadable: true, allEligibleTextConverted: true, layoutIntact: true, controlsUsable: true, protectedContentIntact: true, notes: "Checked every line and the navigation link." });
  assert.deepEqual(validateReview(report, review), []);
  review.cases[0].moreReadable = false;
  assert.ok(validateReview(report, review).some((error) => error.includes("moreReadable")));
  review.cases[0].moreReadable = true;
  report.cases[0].audit.findings.push({ severity: "error" });
  assert.ok(validateReview(report, review).some((error) => error.includes("Automated errors")));
  report.cases[0].audit.findings = [{ severity: "review" }];
  assert.ok(validateReview(report, review).some((error) => error.includes("needs an explanation")));
  review.cases[0].flagNotes = ["Inspected the fallback glyph; it is legible."];
  assert.deepEqual(validateReview(report, review), []);
  report.cases[0].incomplete = true;
  assert.ok(validateReview(report, review).some((error) => error.includes("Incomplete")));
});

test("configuration rejects empty coverage and invalid settings", () => {
  assert.doesNotThrow(() => validateConfig({}));
  assert.throws(() => validateConfig({ profiles: [] }), /at least one/);
  assert.throws(() => validateConfig({ profiles: [{ name: "bad", settings: { textScale: 500 } }] }), /textScale/);
  assert.throws(() => validateConfig({ viewports: [{ name: "mobile", width: 0, height: 844 }] }), /Viewport/);
  assert.throws(() => validateConfig({ maxTiles: 0 }), /maxTiles/);
});


test("capture waits for pending repair and a stable completed revision", async () => {
  const states = [
    { pending: true, refreshRevision: 4, healthy: true },
    { pending: false, refreshRevision: 5, healthy: true },
    { pending: false, refreshRevision: 6, healthy: true },
    { pending: false, refreshRevision: 6, healthy: true }
  ];
  let reads = 0;
  const result = await waitForTypographyState(async () => states[reads++], { pollMs: 0 });
  assert.equal(result.settled, true);
  assert.equal(result.state.refreshRevision, 6);
  assert.equal(reads, 4);
  const busy = await waitForTypographyState(async () => states[0], { timeoutMs: 0 });
  assert.equal(busy.settled, false);
  const legacy = await waitForTypographyState(async () => ({ healthy: true }));
  assert.equal(legacy.settled, true);
});


test("per-capture reveal actions are repeatable rather than submitting forms or dismissing controls", () => {
  assert.doesNotThrow(() => validateConfig({ captureActions: [{ type: "focus", locator: "button" }, { type: "scroll", y: 100000 }] }));
  assert.throws(() => validateConfig({ captureActions: [{ type: "click", locator: "button" }] }), /repeatable/);
  assert.throws(() => validateConfig({ captureActions: "focus" }), /repeatable/);
});
