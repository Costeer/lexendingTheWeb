(() => {
  "use strict";

  // An experiment, not permission to redesign a page. Uncertain geometry keeps
  // the author's CSS. Every attempted change must pass a measured fit check.
  const EPSILON = 2;
  const MAX_CANDIDATES = 1500, MAX_ATTEMPTS = 40;
  const PROTECTED = "pre,code,kbd,samp,math,svg,canvas,iframe,input,select,textarea,[contenteditable]:not([contenteditable='false']),[role='textbox'],[data-lexend-ignore],[data-lexend-protected],[inert]";
  const parentOf = (element) => element.assignedSlot ?? element.parentElement ?? element.getRootNode()?.host;
  const plain = (element) => [...element.childNodes].some((node) => node.nodeType === Node.TEXT_NODE && node.textContent.trim())
    && [...element.children].every((child) => child.tagName === "BR");
  const clips = (value) => /^(hidden|clip)$/.test(value);
  const scrolls = (value) => /^(auto|scroll)$/.test(value);
  const number = (value) => parseFloat(value) || 0;
  const fields = ["display", "position", "visibility", "opacity", "overflowX", "overflowY", "clip", "clipPath",
    "textIndent", "textOverflow", "webkitLineClamp", "writingMode", "transform", "translate", "rotate", "scale",
    "contain", "contentVisibility", "float", "transitionDuration", "transitionDelay", "animationName",
    "fontFamily", "fontSize", "fontStretch", "fontVariationSettings", "fontFeatureSettings", "fontKerning",
    "lineHeight", "letterSpacing", "wordSpacing", "boxSizing", "paddingTop", "paddingBottom",
    "borderTopWidth", "borderBottomWidth", "borderLeftWidth", "borderRightWidth"];
  const read = (element) => {
    const css = getComputedStyle(element);
    return { box: element.getBoundingClientRect(), css: Object.fromEntries(fields.map((key) => [key, css[key]])),
      scrollX: Math.max(0, element.scrollWidth - element.clientWidth),
      scrollY: Math.max(0, element.scrollHeight - element.clientHeight) };
  };
  const ink = (element) => {
    const range = document.createRange(); range.selectNodeContents(element);
    const rects = [...range.getClientRects()].filter((value) => value.width > 0 && value.height > 0);
    if (!rects.length) return null;
    return { left: Math.min(...rects.map((r) => r.left)), right: Math.max(...rects.map((r) => r.right)),
      top: Math.min(...rects.map((r) => r.top)), bottom: Math.max(...rects.map((r) => r.bottom)) };
  };
  const overflow = (text, state) => ({
    x: Math.max(0, state.box.left + number(state.css.borderLeftWidth) - text.left,
      text.right - state.box.right + number(state.css.borderRightWidth)),
    y: Math.max(0, state.box.top + number(state.css.borderTopWidth) - text.top,
      text.bottom - state.box.bottom + number(state.css.borderBottomWidth))
  });
  const defaultTextElements = (root) => {
    const elements = new Set(), walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT);
    while (walker.nextNode()) if (walker.currentNode.textContent.trim() && walker.currentNode.parentElement) elements.add(walker.currentNode.parentElement);
    return elements;
  };
  const intersection = (a, b) => Math.max(0, Math.min(a.right, b.right) - Math.max(a.left, b.left))
    * Math.max(0, Math.min(a.bottom, b.bottom) - Math.max(a.top, b.top));

  const create = ({ withStylesDisabled = (callback) => callback(), getTextElements = defaultTextElements,
    getMode = () => "off" } = {}) => {
    let candidates = [], capturedMode = "off", diagnostics = {}, capturedRoots = [document.documentElement];
    const edits = new Map();
    const RECORD = "data-lexend-original-layout";
    const ownedProperties = new Set(["height", "max-height", "font-family", "font-size", "line-height", "letter-spacing", "word-spacing",
      "font-stretch", "font-variation-settings", "font-feature-settings", "font-kerning", "--lexend-size", "--lexend-line", "--lexend-spacing", "--lexend-family"]);
    const recoverClones = () => {
      for (const root of capturedRoots) for (const element of root?.querySelectorAll(`[${RECORD}]`) ?? []) {
        if (edits.has(element)) continue;
        try {
          const record = JSON.parse(element.getAttribute(RECORD));
          if (!Array.isArray(record.properties) || record.properties.length > ownedProperties.size) continue;
          for (const [name, value, priority, applied] of record.properties) {
            if (!ownedProperties.has(name) || typeof value !== "string" || !["", "important"].includes(priority)
                || element.style.getPropertyValue(name) !== applied || element.style.getPropertyPriority(name) !== "important") continue;
            if (value) element.style.setProperty(name, value, priority); else element.style.removeProperty(name);
          }
          element.removeAttribute(RECORD);
          element.removeAttribute("data-lexend-layout-repair");
          if (!record.hadStyle && !element.getAttribute("style")) element.removeAttribute("style");
        } catch { /* Ignore unrelated malformed page data. */ }
      }
    };
    const restoreElement = (element) => {
      const edit = edits.get(element);
      if (!edit) return;
      for (const [name, original] of edit.properties) {
        if (element.style.getPropertyValue(name) !== original.applied
            || element.style.getPropertyPriority(name) !== "important") continue;
        if (original.value) element.style.setProperty(name, original.value, original.priority);
        else element.style.removeProperty(name);
      }
      if (element.getAttribute("data-lexend-layout-repair") === edit.mode) {
        if (edit.marker === null) element.removeAttribute("data-lexend-layout-repair");
        else element.setAttribute("data-lexend-layout-repair", edit.marker);
      }
      if (!edit.hadStyle && !element.getAttribute("style")) element.removeAttribute("style");
      if (element.getAttribute(RECORD) === edit.record) element.removeAttribute(RECORD);
      edits.delete(element);
    };
    const restore = () => { recoverClones(); for (const element of edits.keys()) restoreElement(element); candidates = []; };
    const commit = (element) => {
      const edit = edits.get(element);
      edit.record = JSON.stringify({ hadStyle: edit.hadStyle,
        properties: [...edit.properties].map(([name, p]) => [name, p.value, p.priority, p.applied]) });
      element.setAttribute(RECORD, edit.record);
      element.setAttribute("data-lexend-layout-repair", capturedMode);
    };
    const write = (element, name, value) => {
      let edit = edits.get(element);
      if (!edit) edits.set(element, edit = { hadStyle: element.hasAttribute("style"),
        marker: element.getAttribute("data-lexend-layout-repair"), mode: capturedMode, properties: new Map() });
      if (!edit.properties.has(name)) edit.properties.set(name, {
        value: element.style.getPropertyValue(name), priority: element.style.getPropertyPriority(name)
      });
      element.style.setProperty(name, value, "important");
      edit.properties.get(name).applied = element.style.getPropertyValue(name);
      const variable = { "font-size": "--lexend-size", "line-height": "--lexend-line",
        "letter-spacing": "--lexend-spacing", "font-family": "--lexend-family" }[name];
      if (variable && element.assignedSlot && element.hasAttribute("data-lexend-text")) write(element, variable, value);
    };

    const capture = (roots = [document.documentElement]) => {
      restore(); capturedMode = getMode();
      capturedRoots = [...(roots instanceof Set || Array.isArray(roots) ? roots : [roots])];
      recoverClones();
      diagnostics = { mode: capturedMode, candidates: 0, changed: 0, reverted: 0, skipped: 0, limited: false };
      if (!["gentle", "fit"].includes(capturedMode)) return;
      withStylesDisabled(() => {
        const states = new Map(), seen = new Set();
        const stateFor = (element) => {
          if (!states.has(element)) states.set(element, read(element));
          return states.get(element);
        };
        for (const root of capturedRoots) {
          if (!root) continue;
          for (const element of getTextElements(root)) {
            if (seen.has(element)) continue;
            seen.add(element);
            if (seen.size > MAX_CANDIDATES) { diagnostics.limited = true; break; }
            if (!(element instanceof HTMLElement) || !plain(element) || element.textContent.length > 2000) continue;
            if (element.checkVisibility && !element.checkVisibility({ contentVisibilityAuto: true, visibilityProperty: true, opacityProperty: true })) continue;
            const ancestry = [];
            let safe = true;
            for (let current = element, depth = 0; current; current = parentOf(current), depth++) {
              if (depth > 40 || current.matches(PROTECTED) || current.hidden) { safe = false; break; }
              const state = stateFor(current), css = state.css;
              // Intentional truncation, transformed tracks, and hidden text
              // must never be unfolded, including through shadow boundaries.
              if (css.display === "none" || css.visibility !== "visible" || Number(css.opacity) === 0
                  || css.contentVisibility === "hidden" || (css.clip && css.clip !== "auto")
                  || (css.clipPath && css.clipPath !== "none") || number(css.textIndent) < -100
                  || css.textOverflow === "ellipsis" || number(css.webkitLineClamp) > 0
                  || css.writingMode !== "horizontal-tb" || css.transform !== "none"
                  || [css.translate, css.rotate, css.scale].some((v) => v && v !== "none")
                  || css.animationName !== "none") { safe = false; break; }
              ancestry.push({ element: current, state });
              if (current === document.documentElement) break;
            }
            if (!safe || !ancestry.length) continue;
            const text = ink(element);
            if (!text || !ancestry[0].state.box.width || !ancestry[0].state.box.height) continue;
            const boundaries = [];
            let foundBlock = false;
            for (const entry of ancestry) {
              const css = entry.state.css;
              const block = css.display !== "inline" && css.display !== "contents";
              const local = block && !foundBlock; foundBlock ||= block;
              if (entry.element === document.body || entry.element === document.documentElement) continue;
              if (local || clips(css.overflowX) || clips(css.overflowY)) {
                const oldOverflow = overflow(text, entry.state);
                if ((clips(css.overflowX) && oldOverflow.x > EPSILON)
                    || (clips(css.overflowY) && oldOverflow.y > EPSILON)) { safe = false; break; }
                boundaries.push({ ...entry, x: local || clips(css.overflowX), y: local || clips(css.overflowY), oldOverflow });
              }
            }
            if (safe && boundaries.length) candidates.push({ element, text: element.textContent, ancestry, boundaries });
          }
          if (diagnostics.limited) break;
        }
      });
      diagnostics.candidates = candidates.length;
    };
    const failures = (candidate) => {
      const text = ink(candidate.element);
      if (!text) return [];
      return candidate.boundaries.flatMap((boundary) => {
        const now = read(boundary.element), excess = overflow(text, now);
        const x = boundary.x ? Math.max(0, excess.x - boundary.oldOverflow.x - EPSILON) : 0;
        const y = boundary.y ? Math.max(0, excess.y - boundary.oldOverflow.y - EPSILON) : 0;
        return x > 0 || y > 0 ? [{ boundary, now, x, y }] : [];
      });
    };
    const guard = (candidate, target, grow) => {
      const watched = new Set();
      for (const { element } of candidate.ancestry.slice(0, 8)) {
        watched.add(element);
        const parent = parentOf(element);
        if (!parent || parent.children.length > 24) continue;
        for (const sibling of parent.children) if (sibling !== element && sibling instanceof HTMLElement) watched.add(sibling);
      }
      const before = new Map([...watched].map((element) => [element, read(element)]));
      const rootWidth = document.documentElement.scrollWidth, targetBox = target.getBoundingClientRect();
      return () => {
        if (document.documentElement.scrollWidth > rootWidth + EPSILON) return false;
        const targetNow = target.getBoundingClientRect(), growth = targetNow.height - targetBox.height;
        if (grow && (growth < -EPSILON || growth > Math.min(96, targetBox.height) + EPSILON
            || Math.abs(targetNow.width - targetBox.width) > EPSILON)) return false;
        for (const [element, old] of before) {
          const now = read(element);
          if (now.scrollX > old.scrollX + EPSILON
              || (clips(old.css.overflowY) && now.scrollY > old.scrollY + EPSILON)) return false;
          if (element === target || target.contains(element) || candidate.ancestry.some((entry) => entry.element === element)) continue;
          if (Math.abs(now.box.width - old.box.width) > EPSILON || Math.abs(now.box.height - old.box.height) > EPSILON
              || Math.abs(now.box.left - old.box.left) > EPSILON) return false;
          if (intersection(targetNow, now.box) > intersection(targetBox, old.box) + EPSILON) return false;
        }
        return true;
      };
    };
    const gentle = (candidate, problems) => {
      if (problems.some((p) => p.x > 0)) return false;
      const target = problems[0].boundary.element;
      if (target === document.body || target === document.documentElement) return false;
      let branch = candidate.element;
      while (branch !== target) {
        const parent = parentOf(branch);
        if (!parent || parent.children.length !== 1) return false;
        branch = parent;
      }
      // No flex/grid tracks, positioned UI, viewport shells, or scrolling
      // regions. Only an ordinary flow box with one text branch may grow.
      for (const { state } of candidate.ancestry) {
        const css = state.css;
        if (!/^(static|relative)$/.test(css.position) || /flex|grid|table/.test(css.display)
            || css.float !== "none" || (css.contain && css.contain !== "none")
            || scrolls(css.overflowX) || scrolls(css.overflowY)
            || css.transitionDuration.split(",").some((v) => number(v) > 0)
            || css.transitionDelay.split(",").some((v) => number(v) > 0)) return false;
      }
      const now = read(target), text = ink(candidate.element);
      if (!clips(now.css.overflowY)) return false;
      const extra = Math.max(now.scrollY, text.bottom - now.box.bottom + number(now.css.paddingBottom) + number(now.css.borderBottomWidth));
      if (extra <= EPSILON || extra > Math.min(96, now.box.height)) return false;
      const check = guard(candidate, target, true);
      const decoration = number(now.css.paddingTop) + number(now.css.paddingBottom)
        + number(now.css.borderTopWidth) + number(now.css.borderBottomWidth);
      const height = now.box.height + extra - (now.css.boxSizing === "border-box" ? 0 : decoration);
      write(target, "height", `${Math.ceil(height)}px`); write(target, "max-height", "none");
      if (failures(candidate).length || !check()) { restoreElement(target); diagnostics.reverted++; return false; }
      commit(target);
      return true;
    };
    const fit = (candidate) => {
      const element = candidate.element, native = candidate.ancestry[0].state.css, requested = read(element).css;
      const check = guard(candidate, element, false);
      const attempt = (size) => {
        write(element, "font-size", `${size.toFixed(3)}px`);
        return !failures(candidate).length && check();
      };
      const ceiling = number(requested.fontSize), floor = Math.min(ceiling, number(native.fontSize));
      let success = false;
      // Largest fitting size, never below the native/requested minimum.
      if (floor < ceiling && attempt(floor)) {
        let low = floor, high = ceiling;
        for (let i = 0; i < 6 && high - low > 0.1; i++) {
          const mid = (low + high) / 2;
          if (attempt(mid)) low = mid; else high = mid;
        }
        success = attempt(low);
      }
      if (!success) {
        restoreElement(element);
        // A local font exception beats tiny glyphs or moved controls.
        for (const [property, key] of [["font-family", "fontFamily"], ["font-size", "fontSize"],
          ["line-height", "lineHeight"], ["letter-spacing", "letterSpacing"], ["word-spacing", "wordSpacing"],
          ["font-stretch", "fontStretch"], ["font-variation-settings", "fontVariationSettings"],
          ["font-feature-settings", "fontFeatureSettings"], ["font-kerning", "fontKerning"]]) write(element, property, native[key]);
        success = !failures(candidate).length && check();
      }
      if (!success) { restoreElement(element); diagnostics.reverted++; return false; }
      commit(element);
      return true;
    };
    const repair = () => {
      if (capturedMode !== getMode()) { restore(); return; }
      if (!["gentle", "fit"].includes(capturedMode)) return;
      let attempts = 0;
      for (const candidate of candidates) {
        if (!candidate.element.isConnected || candidate.element.textContent !== candidate.text) continue;
        const problems = failures(candidate);
        if (!problems.length) continue;
        if (++attempts > MAX_ATTEMPTS) { diagnostics.limited = true; break; }
        try {
          if (capturedMode === "gentle" ? gentle(candidate, problems) : fit(candidate)) diagnostics.changed++;
          else diagnostics.skipped++;
        } catch (error) { restore(); throw error; }
      }
      candidates = [];
    };
    return Object.freeze({ capture, repair, restore,
      ownsProperty: (element, name) => {
        const property = edits.get(element)?.properties.get(name);
        return Boolean(property && element.style.getPropertyValue(name) === property.applied
          && element.style.getPropertyPriority(name) === "important");
      },
      getDiagnostics: () => getMode() === "off" ? { mode: "off", candidates: 0, changed: 0, reverted: 0, skipped: 0, limited: false }
        : ({ ...diagnostics }), refresh: (roots) => { capture(roots); repair(); } });
  };
  globalThis.LexendLayout = Object.freeze({ create });
})();
