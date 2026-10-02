// Runs in each page/frame. Keep the eligibility policy independent of content.js:
// the harness must detect holes in the extension's selectors, not inherit them.
export function collectSnapshot({ scope = "all" } = {}) {
  const state = window.__lexendAudit ??= { ids: new WeakMap(), nextId: 1 };
  const elements = [];
  const limitations = [];
  const domIds = [];
  // FontFaceSet.check can succeed when none of the family's unicode ranges
  // cover the requested text: the browser simply paints a fallback face.
  // Read the registered face ranges independently of extension DOM markers.
  const fontFaces = document.fonts?.[Symbol.iterator] ? [...document.fonts]
    .filter((face) => face.family.replace(/["']/g, "").trim() === "Lexend for the Web") : null;
  const fontRanges = fontFaces?.flatMap((face) => face.unicodeRange.split(",").flatMap((entry) => {
    const match = /^\s*U\+([\dA-F?]+)(?:-([\dA-F]+))?\s*$/i.exec(entry);
    if (!match) return [];
    const start = parseInt(match[1].replace(/\?/g, "0"), 16);
    const end = parseInt(match[2] ?? match[1].replace(/\?/g, "F"), 16);
    return [[start, end]];
  }));
  const glyphCoverage = new Map();
  const fontCoverage = (text, family) => {
    if (!/^['"]?Lexend for the Web['"]?(?:,|$)/i.test(family)) return null;
    if (!fontRanges) return { known: false };
    const unsupported = new Set();
    for (const glyph of text) {
      // Whitespace and shaping controls need not own a painted glyph.
      if (/\s|[\u200c\u200d\ufe0e\ufe0f]/u.test(glyph)) continue;
      if (!glyphCoverage.has(glyph)) {
        const point = glyph.codePointAt(0);
        glyphCoverage.set(glyph, fontRanges.some(([start, end]) => point >= start && point <= end));
      }
      if (!glyphCoverage.get(glyph)) unsupported.add(glyph);
    }
    return { known: true, available: fontFaces.length > 0, covered: unsupported.size === 0,
      unsupported: [...unsupported].slice(0, 24).join("") };
  };
  const bodyStyle = document.body && getComputedStyle(document.body);
  const rootStyle = getComputedStyle(document.documentElement);
  const bodyScrolls = document.body && /auto|scroll/.test(bodyStyle.overflowY)
    && document.body.clientHeight >= innerHeight * .85 && document.body.clientHeight <= innerHeight + 2
    && document.body.scrollHeight > document.body.clientHeight + 2
    && document.documentElement.scrollHeight <= innerHeight + 2;
  const pageScrollY = bodyScrolls ? document.body.scrollTop : scrollY;
  // https://www.w3.org/TR/css-overflow/#overflow-propagation
  // A body's hidden overflow can apply to
  // the viewport, rather than its narrower margin box. Containment disables it.
  const bodyOverflowPropagates = !bodyScrolls && bodyStyle?.display !== "none"
    && rootStyle.overflowX === "visible" && rootStyle.overflowY === "visible"
    && rootStyle.contain === "none" && bodyStyle?.contain === "none";
  const primaryVerticalScroller = (element, style) => (element === document.scrollingElement
    || (bodyOverflowPropagates && element === document.body))
    && /visible|auto|scroll/.test(style.overflowY) && document.scrollingElement.scrollHeight > innerHeight + 2;
  const clipBounds = (element) => {
    const box = element.getBoundingClientRect();
    return bodyOverflowPropagates && element === document.body
      ? { left: 0, right: innerWidth, top: box.top, bottom: box.bottom } : box;
  };
  const scrollableHeight = Math.max(innerHeight, (bodyScrolls ? document.body.scrollHeight : document.scrollingElement?.scrollHeight)
    ?? Math.max(document.documentElement.scrollHeight, document.body?.scrollHeight ?? 0));
  const symbolFont = (family) => {
    const primary = family.split(",")[0].replace(/["']/g, "").trim();
    return /icon|symbol|awesome|dingbat|wingding|musescore|mscore|creative.?commons|ccicons|fontello|icomoon|entypo|octicon|ionicon/i.test(primary) || /^CC$/i.test(primary);
  };
  const monospaceFont = (family) => /monospace|mono\b|Consolas|Menlo|Monaco|Courier|Lucida Console|Iosevka|Fira Code|Source Code/i.test(family);
  const privateGlyph = (text) => /^["']?[\ue000-\uf8ff\u{f0000}-\u{ffffd}\u{100000}-\u{10fffd}]{1,12}["']?$/u.test(text.trim());
  const privatePseudoGlyph = (content) => privateGlyph(content.match(/^(["'])([\s\S]*?)\1(?:\s*\/[\s\S]*)?$/)?.[2] ?? content);
  const imageReplacementText = (element, style) => {
    const alpha = style.color.match(/rgba\([^)]*,\s*([\d.]+)\s*\)/)?.[1];
    if (Number(alpha ?? 1) !== 0 || style.backgroundClip.includes("text") || style.webkitBackgroundClip?.includes("text")) return false;
    let imagery = false;
    for (let current = element, depth = 0; current && depth < 3; current = ancestor(current), depth++) {
      const css = current === element ? style : getComputedStyle(current);
      if (css.backgroundClip.includes("text") || css.webkitBackgroundClip?.includes("text")) return false;
      if (css.backgroundImage !== "none" || current.querySelector("img,picture,svg")) imagery = true;
    }
    return imagery || [element.previousElementSibling, element.nextElementSibling].some((sibling) => sibling?.matches("img,picture,svg"));
  };
  const closedImageLabel = (element, style, nodes) => {
    if (!style.backgroundImage.includes("url(") || style.backgroundClip.includes("text") || style.webkitBackgroundClip?.includes("text")) return false;
    const rects = nodes.flatMap((node) => {
      const range = document.createRange();
      range.selectNodeContents(node);
      return [...range.getClientRects()].filter((box) => box.width > 0 && box.height > 0);
    });
    if (!rects.length || !(rects.every((box) => box.right <= 0) || rects.every((box) => box.left >= innerWidth))) return false;
    for (let current = element; current; current = ancestor(current)) {
      if (getComputedStyle(current).position === "fixed") return true;
    }
    return false;
  };
  const ancestor = (element) => element.parentElement
    ?? (element.getRootNode() instanceof ShadowRoot ? element.getRootNode().host : null);
  // A viewport-fixed descendant can paint through a zero-sized flow portal.
  // Transformed/contained ancestors establish its containing block and keep
  // their clipping relationship, including clipping above that block.
  const clippingAncestors = (element) => {
    const result = [];
    for (let current = element; current; current = ancestor(current)) {
      result.push(current);
      if (getComputedStyle(current).position !== "fixed") continue;
      let contained = false;
      for (let parent = ancestor(current); parent; parent = ancestor(parent)) {
        const css = getComputedStyle(parent);
        if (css.transform !== "none" || css.perspective !== "none" || css.filter !== "none"
            || (css.backdropFilter && css.backdropFilter !== "none")
            || /(?:layout|paint|strict|content)/.test(css.contain)
            || /(?:transform|perspective|filter)/.test(css.willChange)) { contained = true; break; }
      }
      if (!contained) break;
    }
    return result;
  };
  const exclusion = (element) => {
    for (let current = element; current; current = ancestor(current)) {
      if (current.matches("pre,code,kbd,samp,math,svg,[data-lexend-ignore],[role='img']")) {
        return current.tagName.toLowerCase() + " / protected content";
      }
      // An "icon" substring often names a prose wrapper (e.g. with-icon).
      // Only known icon-font classes/fonts imply protected glyph content.
      const style = getComputedStyle(current);
      if (current === element && symbolFont(style.fontFamily)) {
        return "icon / symbol class";
      }
      if (current === element && privateGlyph([...current.childNodes].filter((node) => node.nodeType === Node.TEXT_NODE).map((node) => node.textContent).join(""))) return "private-use icon glyph / protected content";
      if (current === element && current.matches("[data-icon],[class~='fa'],[class~='material-icons'],[class~='material-symbols-outlined'],[class~='material-symbols-rounded'],[class~='material-symbols-sharp']")) {
        const ownText = [...current.childNodes].filter((node) => node.nodeType === Node.TEXT_NODE).map((node) => node.textContent).join("").trim();
        if (/^[\ue000-\uf8ff]{1,4}$/u.test(ownText)
            || (current.matches("[class~='material-icons'],[class~='material-symbols-outlined'],[class~='material-symbols-rounded'],[class~='material-symbols-sharp']") && /^[a-z_]{1,40}$/.test(ownText))) return "icon glyph / protected content";
      }
      // Computed monospace is independent evidence for code samples and editors
      // rendered as spans/divs rather than semantic <code> elements.
      if (current === element && monospaceFont(style.fontFamily)) return "monospace / protected content";
      if (scope === "body" && current.matches("h1,h2,h3,h4,h5,h6")) return "heading in body scope";
    }
    return null;
  };
  const path = (element) => {
    const parts = [];
    for (let current = element; current; current = ancestor(current)) {
      let label = current.tagName.toLowerCase();
      if (current.id) label += `#${current.id}`;
      else if (current.parentElement) label += `:nth-child(${[...current.parentElement.children].indexOf(current) + 1})`;
      parts.unshift(label);
      if (current.getRootNode() instanceof ShadowRoot && !current.parentElement) parts.unshift("::shadow");
    }
    return parts.join(" > ");
  };
  const rectData = (rect) => ({ x: rect.x + scrollX, y: rect.y + pageScrollY, width: rect.width, height: rect.height });
  const visit = (root) => {
    for (const element of root.querySelectorAll("*")) {
      let id = state.ids.get(element);
      if (!id) { id = state.nextId++; state.ids.set(element, id); }
      domIds.push(id);
      if (element.shadowRoot) visit(element.shadowRoot);
      const css = getComputedStyle(element);
      if (css.display === "none" || css.visibility !== "visible" || Number(css.opacity) === 0 || !element.getClientRects().length) continue;
      if (element.checkVisibility && !element.checkVisibility({ opacityProperty: true, visibilityProperty: true })) continue;
      if (element.checkVisibility && !element.checkVisibility({ contentVisibilityAuto: true })) {
        limitations.push({ path: path(element), reason: "Automatic rendering skips this subtree in the current viewport. Scroll it into view before comparing its painted geometry and readability." });
        continue;
      }
      let visuallyHidden = false;
      for (const current of clippingAncestors(element)) {
        const style = getComputedStyle(current);
        const bounds = current.getBoundingClientRect();
        const clipped = /^rect\(\s*(-?[\d.]+)px[,\s]+(-?[\d.]+)px[,\s]+(-?[\d.]+)px[,\s]+(-?[\d.]+)px\s*\)$/.exec(style.clip)?.slice(1).map(Number);
        if ((bounds.width <= 1 && bounds.height <= 1 && /hidden|clip/.test(style.overflow))
            || (clipped && (clipped[1] <= clipped[3] || clipped[2] <= clipped[0]))) {
          visuallyHidden = true;
          break;
        }
      }
      if (visuallyHidden) continue;
      const rect = element.getBoundingClientRect();
      if (rect.width === 0 || rect.height === 0) continue;
      if (["fixed", "sticky"].includes(css.position)) {
        limitations.push({ path: path(element), reason: "Fixed or sticky content may obscure text at screenshot seams; verify underlying text in an unobscured capture before passing." });
      }
      if (element.tagName === "CANVAS" || (element.localName.includes("-") && !element.shadowRoot)) {
        limitations.push({ path: path(element), reason: element.tagName === "CANVAS" ? "Canvas text requires visual inspection" : "Custom element may contain an inaccessible closed shadow root" });
      }
      let nodes = [...element.childNodes].filter((node) => node.nodeType === Node.TEXT_NODE && node.textContent.trim());
      const closedLabel = nodes.length > 0 && closedImageLabel(element, css, nodes);
      const replacementLabel = nodes.length > 0 && (imageReplacementText(element, css) || closedLabel);
      if (replacementLabel) {
        limitations.push({ path: path(element), reason: closedLabel
          ? "Closed fixed navigation paints an image while its label is outside the viewport. Reveal that navigation and verify its text and controls in a separate state."
          : "Transparent accessible label is represented by an image or sprite rather than painted text; verify the replacement artwork and accessible name visually and through interaction." });
        nodes = [];
      }
      let control = element.matches("textarea,select") || (element.tagName === "INPUT"
        && !["hidden", "checkbox", "radio", "range", "color", "image", "file"].includes(element.type));
      if (control && (element.tagName === "SELECT" || (element.tagName === "INPUT" && ["button", "submit", "reset"].includes(element.type))) && imageReplacementText(element, css)) {
        limitations.push({ path: path(element), reason: "Transparent control text in the closed state is represented by replacement artwork. Verify the artwork, accessible name, and revealed native choices through interaction." });
        control = false;
      }
      const pseudo = ["::before", "::after"].flatMap((which) => {
        const style = getComputedStyle(element, which);
        return style.content && !["none", "normal", '""'].includes(style.content)
          && style.content.replace(/^(['"])([\s\S]*)\1$/, "$2").trim()
          ? [{ which, content: style.content, fontFamily: style.fontFamily, protectedFont: symbolFont(style.fontFamily) || monospaceFont(style.fontFamily) || privatePseudoGlyph(style.content), fontSize: parseFloat(style.fontSize), lineHeight: parseFloat(style.lineHeight) || null, letterSpacing: parseFloat(style.letterSpacing) || 0,
              lexendCoverage: fontCoverage(style.content, style.fontFamily),
              lexendLoaded: document.fonts.check(`${style.fontStyle} ${style.fontWeight} ${style.fontSize} "Lexend for the Web"`, style.content) }] : [];
      });
      if (!nodes.length && !control && !pseudo.length) continue;
      const text = nodes.map((node) => node.textContent.trim()).join(" ")
        || element.value || element.getAttribute("placeholder") || "";
      const textRects = nodes.flatMap((node) => {
        const range = document.createRange();
        range.selectNodeContents(node);
        return [...range.getClientRects()];
      });
      const headingWordLines = {};
      const actionWordLines = {};
      let headingText = false;
      for (let current = element; current && !headingText; current = ancestor(current)) headingText = current.matches("h1,h2,h3,h4,h5,h6,[role=heading]");
      const ownWords = nodes.flatMap((node) => node.textContent.trim().split(/\s+/)).filter(Boolean);
      headingText ||= parseFloat(css.fontSize) >= 32 && ownWords.length > 0 && ownWords.length <= 18;
      let actionText = false;
      if (ownWords.length > 0 && ownWords.length <= 8) {
        for (let current = element; current && !actionText; current = ancestor(current)) {
          actionText = current.matches("button,a[href],[role=button],[role=tab]");
        }
      }
      if (headingText || actionText) {
        for (const node of nodes) {
          for (const match of node.textContent.matchAll(actionText ? /\p{Script=Latin}{2,}/gu : /\p{Script=Latin}{5,}/gu)) {
            const range = document.createRange();
            range.setStart(node, match.index);
            range.setEnd(node, match.index + match[0].length);
            const lines = [];
            for (const box of range.getClientRects()) {
              if (box.width > 0 && box.height > 0 && !lines.some((top) => Math.abs(top - box.top) < 1)) lines.push(box.top);
            }
            if (headingText && match[0].length >= 5) headingWordLines[match[0]] = Math.max(headingWordLines[match[0]] ?? 0, lines.length);
            if (actionText && !headingText) actionWordLines[match[0]] = Math.max(actionWordLines[match[0]] ?? 0, lines.length);
          }
        }
      }
      // Inactive carousel slides and closed navigation can retain layout boxes
      // while every text pixel is outside an ancestor's clipping rectangle.
      // Their typography needs a reveal-state capture, not a false clipping
      // regression against the currently visible page.
      const visibleRects = (textRects.length ? textRects : [rect]).map((box) => ({ left: box.left, right: box.right, top: box.top, bottom: box.bottom }));
      for (const current of clippingAncestors(element)) {
        if (bodyScrolls && (current === document.body || current === document.documentElement)) continue;
        const style = getComputedStyle(current);
        const box = clipBounds(current);
        for (const bounds of visibleRects) {
          if (/hidden|clip|auto|scroll/.test(style.overflowX)) {
            bounds.left = Math.max(bounds.left, box.left);
            bounds.right = Math.min(bounds.right, box.right);
          }
          if (/hidden|clip|auto|scroll/.test(style.overflowY) && !primaryVerticalScroller(current, style)) {
            bounds.top = Math.max(bounds.top, box.top);
            bounds.bottom = Math.min(bounds.bottom, box.bottom);
          }
        }
      }
      if (visibleRects.every((box) => box.right <= box.left || box.bottom <= box.top)) {
        limitations.push({ path: path(element), reason: "Text is wholly clipped in this state; reveal its carousel, navigation, or scrolling panel before establishing compatibility." });
        continue;
      }
      let clipping = 0;
      let clippingX = 0, clippingY = 0, scrollableX = false;
      let fixedAncestor = null;
      let reachableScroll = false;
      let nestedScroll = false;
      let isInteractive = false;
      let boxedAction = null;
      for (const current of clippingAncestors(element)) {
        const style = getComputedStyle(current);
        const box = clipBounds(current);
        if (current.matches("button,input:not([type=hidden]),textarea,select,a[href],[role=button]")) isInteractive = true;
        if (!boxedAction && current.matches("button,input:not([type=hidden]),textarea,select,[role=button]")) boxedAction = box;
        if (current !== document.body && current !== document.documentElement
            && /auto|scroll/.test(style.overflowY) && current.scrollHeight > current.clientHeight + 1) nestedScroll = true;
        if (current !== document.body && current !== document.documentElement
            && /auto|scroll/.test(style.overflowX) && current.scrollWidth > current.clientWidth + 1) scrollableX = true;
        if (!fixedAncestor && /auto|scroll/.test(style.overflowY) && current.scrollHeight > current.clientHeight + 1
            && box.bottom > 0 && box.top < innerHeight) reachableScroll = true;
        if (style.position === "fixed" && !fixedAncestor) fixedAncestor = current;
        if (bodyScrolls && (current === document.body || current === document.documentElement)) continue;
        const clipX = /hidden|clip|auto|scroll/.test(style.overflowX);
        const clipY = /hidden|clip|auto|scroll/.test(style.overflowY) && !primaryVerticalScroller(current, style);
        for (const textRect of textRects) {
          if (clipX) clippingX = Math.max(clippingX, box.left - textRect.left, textRect.right - box.right);
          if (clipY) clippingY = Math.max(clippingY, box.top - textRect.top, textRect.bottom - box.bottom);
        }
      }
      clipping = Math.max(clippingX, clippingY);
      // Inline link line boxes include unpainted font leading. Measure their
      // glyph ranges; native/boxed actions retain their complete hit-area box,
      // including when their audited text belongs to a descendant span.
      const actionRects = boxedAction ? [boxedAction] : textRects.length ? textRects : [rect];
      const fixedControlOverflow = fixedAncestor && isInteractive && !reachableScroll
        ? actionRects.reduce((maximum, box) => Math.max(maximum, -box.top, box.bottom - innerHeight), 0) : 0;
      const fixedControlVisible = Boolean(fixedAncestor && isInteractive && visibleRects.some((box) =>
        box.right > 0 && box.left < innerWidth && box.bottom > 0 && box.top < innerHeight));
      const viewportTextOverflow = textRects.reduce((maximum, box) => Math.max(maximum, -box.left, box.right - innerWidth), 0);
      const documentTextOverflow = !fixedAncestor && !nestedScroll
        ? textRects.reduce((maximum, box) => Math.max(maximum, box.bottom + pageScrollY - scrollableHeight), 0) : 0;
      elements.push({
        id, path: path(element), tag: element.tagName.toLowerCase(), text: text.slice(0, 500),
        hasOwnText: nodes.length > 0 || control,
        nativeSingleSelect: element.tagName === "SELECT" && !element.multiple && element.size <= 1 && css.appearance !== "none" && css.lineHeight === "normal",
        nativeButtonInput: element.tagName === "INPUT" && ["button", "submit", "reset"].includes(element.type) && css.appearance !== "none" && css.lineHeight === "normal",
        excluded: exclusion(element) || (!nodes.length && !control && pseudo.length && pseudo.every((entry) => entry.protectedFont) ? "generated typography / protected content" : null), rect: rectData(rect), pseudo,
        fontFamily: css.fontFamily, fontSize: parseFloat(css.fontSize),
        lineHeight: parseFloat(css.lineHeight) || null,
        letterSpacing: parseFloat(css.letterSpacing) || 0,
        color: css.color, backgroundColor: css.backgroundColor,
        clipping: Math.max(0, clipping),
        clippingX, clippingY, scrollableX, scrollableY: nestedScroll,
        viewportTextOverflow, documentTextOverflow, fixedControlOverflow, fixedControlVisible, headingWordLines, actionWordLines,
        layoutRepairs: (element.getAttribute("data-lexend-layout-repair") ?? "").split(/[ ,]+/).filter(Boolean),
        layoutBaselineFontSize: Number(element.getAttribute("data-lexend-layout-baseline-font-size")) || null,
        controlOverflow: control && !element.matches("textarea,select") ? Math.max(0, element.scrollWidth - element.clientWidth) : 0,
        lexendCoverage: fontCoverage(text || "Read", css.fontFamily),
        lexendLoaded: document.fonts.check(`${css.fontStyle} ${css.fontWeight} ${css.fontSize} "Lexend for the Web"`, text || "Read")
      });
    }
  };
  visit(document);
  if (document.fonts?.status === "loading") limitations.push({ reason: "Author or extension fonts are still loading; verify a stable loaded state before assigning a pass." });
  return {
    url: location.href, title: document.title, elements, limitations, domIds,
    fontsPending: document.fonts?.status === "loading",
    loadingFontFaces: document.fonts?.[Symbol.iterator] ? [...document.fonts].filter((face) => face.status === "loading")
      .slice(0, 16).map((face) => ({ family: face.family, weight: face.weight, unicodeRange: face.unicodeRange })) : [],
    width: innerWidth, viewportHeight: innerHeight, scrollX, scrollY: pageScrollY,
    nativeScrollY: scrollY, scrollContainer: bodyScrolls ? "body" : "document",
    height: Math.max(document.documentElement.scrollHeight, document.body?.scrollHeight ?? 0),
    horizontalOverflow: Math.max(0, document.documentElement.scrollWidth - innerWidth)
  };
}

export function compareSnapshots(before, after, settings) {
  const findings = [];
  if (before.fontsPending || after.fontsPending) findings.push({ code: "font-state-pending", severity: "review", path: "document", text: "",
    message: "Fonts were still loading in a compared state. Capture stable loaded typography before assigning a pass." });
  let eligible = 0;
  let converted = 0;
  let excluded = 0;
  const privateGlyph = (text) => /^["']?[\ue000-\uf8ff\u{f0000}-\u{ffffd}\u{100000}-\u{10fffd}]{1,12}["']?$/u.test(text.trim());
  const privatePseudoGlyph = (content) => privateGlyph(content.match(/^(["'])([\s\S]*?)\1(?:\s*\/[\s\S]*)?$/)?.[2] ?? content);
  const old = new Map(before.elements.map((element) => [element.id, element]));
  const currentIds = new Set(after.elements.map((element) => element.id));
  const add = (element, code, message, severity = "error") => findings.push({
    elementId: element?.id ?? null, path: element?.path ?? "document", text: element?.text ?? "",
    code, message, severity, before: element ? old.get(element.id) ?? null : null, after: element ?? null
  });
  for (const element of after.elements) {
    const baseline = old.get(element.id);
    if (!baseline) add(element, "unpaired-element", "New text has no before comparison; capture this state again.", "review");
    if (baseline && element.text !== baseline.text) add(element, "changed-content", "Text changed between captures; compare an equivalent state.", "review");
    const protection = baseline?.excluded || element.excluded;
    if (protection) {
      excluded++;
      if (baseline && element.hasOwnText !== false && ["fontFamily", "fontSize", "lineHeight", "letterSpacing"].some((key) => element[key] !== baseline[key])) {
        add(element, "protected-content-changed", `Typography changed in ${protection}.`);
      }
      if (baseline && baseline.pseudo.some((entry) => {
        const current = element.pseudo.find((candidate) => candidate.which === entry.which);
        return current && ["fontFamily", "fontSize", "lineHeight", "letterSpacing"].some((key) => current[key] !== entry[key]);
      })) add(element, "protected-pseudo-changed", "Generated content typography changed inside protected content.");
      continue;
    }
    const ownText = element.hasOwnText !== false;
    if (ownText) {
      eligible++;
      if (!/^['"]?Lexend for the Web['"]?(?:,|$)/i.test(element.fontFamily)) add(element, "unconverted", "Eligible text does not use Lexend as its first font.");
      else if (!element.lexendLoaded) add(element, "font-not-loaded", "Lexend is declared but its font did not load.");
      else if (element.lexendCoverage?.available === false) add(element, "font-not-loaded", "No registered Lexend font face is available; the declaration alone uses fallback text.");
      else if (element.lexendCoverage?.known === false) add(element, "font-coverage-unknown", "Registered font ranges could not be inspected; complete typeface conversion is unverified.", "review");
      else if (element.lexendCoverage?.covered === false) add(element, "font-fallback-coverage", `Bundled font ranges do not cover ${JSON.stringify(element.lexendCoverage.unsupported)}. Readability styles may apply, but complete typeface conversion is not established. Inspect the fallback glyphs.`, "review");
      else converted++;
    }
    for (const pseudo of element.pseudo) {
      const oldPseudo = baseline?.pseudo.find((candidate) => candidate.which === pseudo.which);
      if (oldPseudo?.protectedFont || pseudo.protectedFont || privatePseudoGlyph(oldPseudo?.content ?? "") || privatePseudoGlyph(pseudo.content)) {
        if (oldPseudo && ["fontFamily", "fontSize", "lineHeight", "letterSpacing"].some((key) => pseudo[key] !== oldPseudo[key])) add(element, "protected-pseudo-changed", `${pseudo.which} icon typography changed.`);
        continue;
      }
      if (/^url\(/i.test(pseudo.content)) continue;
      eligible++;
      if (!/^['"]?Lexend for the Web['"]?(?:,|$)/i.test(pseudo.fontFamily)) add(element, "pseudo-unconverted", `${pseudo.which} generated content does not use Lexend.`);
      else if (pseudo.lexendLoaded === false) add(element, "font-not-loaded", `${pseudo.which} declares Lexend but its font did not load.`);
      else if (pseudo.lexendCoverage?.available === false) add(element, "font-not-loaded", `${pseudo.which} has no registered Lexend face.`);
      else if (pseudo.lexendCoverage?.known === false) add(element, "font-coverage-unknown", `${pseudo.which} font ranges could not be inspected.`, "review");
      else if (pseudo.lexendCoverage?.covered === false) add(element, "font-fallback-coverage", `${pseudo.which} contains glyphs outside bundled font ranges; inspect fallback rendering and do not count complete typeface conversion.`, "review");
      else converted++;
      if (oldPseudo && Math.abs(pseudo.fontSize - oldPseudo.fontSize * settings.textScale / 100) > 0.6) add(element, "pseudo-scale-review", `${pseudo.which} generated text did not scale as requested; check whether it is a decorative glyph.`, "review");
    }
    if (/[^\u0000-\u024f\u0300-\u036f\u1e00-\u1eff\u2000-\u206f]/u.test(element.text)) {
      add(element, "glyph-review", "Check unsupported scripts, symbols, and fallback glyphs in the screenshot.", "review");
    }
    if (baseline) {
      for (const [word, lines] of Object.entries(element.actionWordLines ?? {})) {
        if (baseline.actionWordLines?.[word] === 1 && lines > 1) {
          const technicalPath = element.text.length > 40 && /[`/\\]/.test(element.text);
          add(element, technicalPath ? "technical-action-word-break" : "new-action-word-break",
            `Action label word ${JSON.stringify(word)} now breaks across ${lines} lines; it previously fit on one line.`,
            technicalPath ? "review" : "error");
        }
      }
      for (const [word, lines] of Object.entries(element.headingWordLines ?? {})) {
        if (Object.hasOwn(baseline.headingWordLines ?? {}, word) && baseline.headingWordLines[word] === 1 && lines > 1) {
          add(element, "new-heading-word-break", `Heading word ${JSON.stringify(word)} now breaks across ${lines} lines; it previously fit on one line.`);
        }
      }
      const expectedSize = baseline.fontSize * settings.textScale / 100;
      if (element.hasOwnText !== false && Math.abs(element.fontSize - expectedSize) > 0.6) {
        const fitted = element.layoutRepairs?.includes("fit-heading") && (element.fontSize >= baseline.fontSize - 0.6 || element.layoutRepairs.includes("fit-heading-below-baseline"))
          && element.fontSize >= Math.min(24, baseline.fontSize) - 0.6
          && element.fontSize <= expectedSize + 0.6 && Math.abs((element.layoutBaselineFontSize ?? 0) - baseline.fontSize) < 0.6;
        const tightLabel = element.layoutRepairs?.includes("fit-tight-label")
          && element.fontSize >= baseline.fontSize - 0.1 && element.fontSize <= expectedSize + 0.6
          && Math.abs((element.layoutBaselineFontSize ?? 0) - baseline.fontSize) < 0.6;
        add(element, fitted ? "adapted-heading-size" : tightLabel ? "adapted-label-size" : "scale-mismatch",
          fitted ? `Heading size was bounded to ${element.fontSize}px to retain complete words; visually verify readability.`
            : tightLabel ? `A narrow label uses ${element.fontSize}px to expose its complete text; visually verify readability.`
              : `Expected ${expectedSize.toFixed(1)}px; got ${element.fontSize}px.`, fitted || tightLabel ? "review" : "error");
      }
      if (ownText && element.fontSize < baseline.fontSize - 0.6) {
        const fitted = element.layoutRepairs?.includes("fit-heading") && element.layoutRepairs.includes("fit-heading-below-baseline")
          && element.fontSize >= Math.min(24, baseline.fontSize) - 0.6
          && Math.abs((element.layoutBaselineFontSize ?? 0) - baseline.fontSize) < 0.6;
        add(element, fitted ? "adapted-heading-smaller" : "smaller-text", fitted
          ? "Heading was reduced below its original size to preserve complete words. Visually verify that the resulting text is easier to read."
          : "Text is smaller after conversion.", fitted ? "review" : "error");
      }
      if (element.clipping > baseline.clipping + 1) {
        const measuredAxes = Number.isFinite(element.clippingX) && Number.isFinite(element.clippingY)
          && Number.isFinite(baseline.clippingX) && Number.isFinite(baseline.clippingY);
        const reachable = measuredAxes
          && (element.clippingX <= baseline.clippingX + 1 || element.scrollableX)
          && (element.clippingY <= baseline.clippingY + 1 || element.scrollableY);
        add(element, reachable ? "scrollable-text-clipping" : "new-clipping", reachable
          ? "Text extends farther within a scrolling container. Interact with that container to verify every word is reachable and readable."
          : `Text clipping increased by ${(element.clipping - baseline.clipping).toFixed(1)}px.`, reachable ? "review" : "error");
      }
      if (element.controlOverflow > baseline.controlOverflow + 1) add(element, "control-overflow", "Form text now overflows its control.");
      if ((element.documentTextOverflow ?? 0) > (baseline.documentTextOverflow ?? 0) + 1) add(element, "document-text-unreachable", "Text grew beyond the document's reachable scroll range without a nested scrolling container.");
      if ((element.viewportTextOverflow ?? 0) > (baseline.viewportTextOverflow ?? 0) + 1) add(element, "viewport-text-overflow", "Text extends farther beyond the viewport; verify whether an intentional horizontally scrollable area makes it reachable.", "review");
      if (baseline.fixedControlVisible === true && (element.fixedControlOverflow ?? 0) > (baseline.fixedControlOverflow ?? 0) + 1) {
        const changedScroll = Number.isFinite(before.scrollY) && Number.isFinite(after.scrollY) && Math.abs(before.scrollY - after.scrollY) > 1;
        add(element, changedScroll ? "fixed-control-state-review" : "fixed-control-inaccessible", changedScroll
          ? "A fixed-panel action is outside the viewport, but the comparison scroll positions differ; recapture equivalent positions before attributing inaccessibility."
          : "An action inside a fixed panel moved beyond the viewport without a visible scrolling ancestor.", changedScroll ? "review" : "error");
      }
      if (ownText && element.lineHeight && baseline.lineHeight && element.lineHeight / element.fontSize < baseline.lineHeight / baseline.fontSize - 0.02) {
        add(element, "tighter-lines", "Line spacing relative to text size decreased.", "review");
      }
    }
    if (ownText && settings.lineHeight > 0 && Math.abs((element.lineHeight ?? 0) / element.fontSize - settings.lineHeight) > 0.03) {
      const nativeControl = element.lineHeight === null && ((element.tag === "select" && element.nativeSingleSelect === true)
        || (element.tag === "input" && element.nativeButtonInput === true));
      add(element, nativeControl ? "native-control-line-height" : "line-height-mismatch", nativeControl
        ? "The browser's native control renderer reports normal line height. Visually verify that its complete label and hit area remain readable and contained."
        : "Requested line height was not applied.", nativeControl ? "review" : "error");
    }
    // Added tracking separates joined Arabic glyphs and can crop narrow labels.
    // Zero tracking is the intentional readability value for that script.
    const expectedTracking = /\p{Script=Arabic}/u.test(element.text) ? 0 : settings.letterSpacing;
    if (ownText && settings.letterSpacing > 0 && Math.abs(element.letterSpacing / element.fontSize - expectedTracking) > 0.003) add(element, "letter-spacing-mismatch", "Requested script-appropriate letter spacing was not applied.");
  }
  for (const element of before.elements) {
    if (!currentIds.has(element.id)) {
      const remainsInDom = after.domIds?.includes(element.id);
      const replacement = !remainsInDom && after.elements.find((candidate) => candidate.path === element.path && candidate.text === element.text);
      if (replacement) {
        add(replacement, "replaced-element", "The page replaced this DOM node with the same text at the same location. Its author baseline changed; review an equivalent stable state before establishing compatibility.", "review");
        continue;
      }
      add(element, remainsInDom ? "hidden-state-change" : "missing-element", remainsInDom
        ? "Previously visible text remains in the DOM but is hidden or wholly clipped in this capture; compare an equivalent revealed state before establishing compatibility."
        : "Previously visible text disappeared.", remainsInDom ? "review" : "error");
    }
  }
  if (after.horizontalOverflow > before.horizontalOverflow + 1) {
    const unpainted = before.embedding?.painted === false && after.embedding?.painted === false;
    add(null, unpainted ? "hidden-frame-overflow" : "page-overflow", unpainted
      ? "Horizontal overflow increased inside an embedded frame that its parent does not paint in either captured state. Reveal the frame and verify its contents separately."
      : "Conversion introduced horizontal page overflow.", unpainted ? "review" : "error");
  }
  if (eligible === 0 && (before.elements.length || after.elements.length)) add(null, "no-eligible-frame-text", "This frame has no eligible rendered text in the captured state; assess compatibility using the complete case and reveal relevant hidden states.", "review");
  return { eligible, converted, excluded, coverage: eligible ? converted / eligible : 0, findings };
}
