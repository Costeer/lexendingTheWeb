(() => {
  "use strict";
  const EPSILON = 2;
  const interactive = (element) => element.matches("button,a[href],[role='button']");
  const excluded = (element) => element.closest("pre,code,kbd,samp,math,svg,[data-lexend-ignore],[contenteditable='true']");
  const grew = (before, now) => now.fontSize > before.fontSize * 1.04 || now.text && before.text && now.text.bottom - now.text.top > before.text.bottom - before.text.top + EPSILON;
  const sameRow = (left, right) => Math.abs(left.top - right.top) <= EPSILON;
  const footerPadding = new WeakMap();
  let canvas;

  const parentOf = (element) => element.parentElement ?? element.getRootNode()?.host ?? null;
  const wordWidths = (element) => {
    const words = [];
    for (const node of element.childNodes) {
      if (node.nodeType !== Node.TEXT_NODE) continue;
      for (const match of node.textContent.matchAll(/\p{Script=Latin}{2,}/gu)) {
        const range = document.createRange();
        range.setStart(node, match.index); range.setEnd(node, match.index + match[0].length);
        const boxes = [...range.getClientRects()].filter((box) => box.width && box.height);
        words.push({ width: boxes.reduce((sum, box) => sum + box.width, 0), lines: new Set(boxes.map((box) => Math.round(box.top / 2))).size });
      }
    }
    return words;
  };

  // Small authored widgets can use plain divs for their branding or actions.
  // Keep previously whole words intact only in a compact positioned utility
  // or an embedded widget, and only when the word fits its painted viewport.
  const repairCompactWords = ({ baseline, textElements = baseline.keys(), snapshot, write }) => {
    for (const label of textElements) {
      const before = baseline.get(label), now = snapshot(label);
      if (!before?.texts?.length || !now || excluded(label) || !grew(before, now) ||
          label.textContent.trim().split(/\s+/u).length > 4 || before.box.width > 180 ||
          new Set(before.texts.map((box) => Math.round(box.top / 2))).size > 1) continue;
      const words = wordWidths(label);
      if (!words.some((word) => word.lines > 1)) continue;
      let utility = null;
      for (let parent = label, depth = 0; parent && depth < 8; parent = parentOf(parent), depth++) {
        const original = baseline.get(parent), css = getComputedStyle(parent);
        if (original?.position === "fixed" && original.box.width <= 180 && original.box.height < innerHeight * .45 &&
            original.box.left > innerWidth / 2 && original.box.right <= innerWidth + EPSILON && css.right !== "auto" &&
            !parent.matches("dialog,[role='dialog'],[aria-modal='true']")) { utility = parent; break; }
      }
      if (!utility && !(window !== window.top && innerWidth <= 400 && innerHeight <= 120)) continue;
      const scale = label.offsetWidth ? now.box.width / label.offsetWidth : 1;
      if (!(scale > 0)) continue;
      const required = Math.max(...words.map((word) => word.width)) + 3;
      const limit = utility ? Math.min(innerWidth - 16, 180) : innerWidth - Math.max(0, now.box.left) - 3;
      if (required > limit || required <= now.box.width + EPSILON) continue;
      write(label, "min-width", `${Math.ceil(required / scale)}px`, "compact-word");
      write(label, "white-space", "normal", "compact-word");
      write(label, "word-break", "normal", "compact-word");
      write(label, "overflow-wrap", "normal", "compact-word");
      if (utility) {
        const state = snapshot(utility), utilityScale = utility.offsetWidth ? state.box.width / utility.offsetWidth : 1;
        const width = state.box.width + Math.max(0, required - now.box.width);
        if (utilityScale > 0 && width <= limit) {
          write(utility, "box-sizing", "border-box", "compact-word");
          write(utility, "min-width", `${Math.ceil(width / utilityScale)}px`, "compact-word");
        }
      }
    }
  };

  // A compact selector can contain a brand, an ellipsized model name and an
  // arrow. Let its previously single-line label borrow measured free space
  // before converting that short label into a tall stack of lines.
  const repairCompactSelectors = ({ baseline, textElements = baseline.keys(), snapshot, write }) => {
    for (const label of textElements) {
      const before = baseline.get(label), now = snapshot(label), action = label.closest?.("button,[role='button']");
      if (!action || action === label || !before?.texts?.length || !now || !grew(before, now) || excluded(label) ||
          before.whiteSpace !== "nowrap" || before.textOverflow !== "ellipsis" ||
          label.textContent.trim().split(/\s+/u).length > 4 || before.box.width > 180 ||
          new Set(before.texts.map((box) => Math.round(box.top / 2))).size > 1 ||
          new Set(now.texts.map((box) => Math.round(box.top / 2))).size <= 1) continue;
      const oldAction = baseline.get(action), state = snapshot(action);
      if (!oldAction || !state || oldAction.box.width > 280 || oldAction.box.left < 0 || oldAction.box.right > innerWidth + EPSILON ||
          action.querySelector("picture,video,iframe,canvas")) continue;
      canvas ??= document.createElement("canvas");
      const context = canvas.getContext("2d"), css = getComputedStyle(label);
      if (!context) continue;
      context.font = css.font || `${css.fontWeight} ${css.fontSize} ${css.fontFamily}`;
      const scale = label.offsetWidth ? now.box.width / label.offsetWidth : 1;
      if (!(scale > 0)) continue;
      const measure = (text) => context.measureText(text).width + Math.max(0, [...text].length - 1) * now.letterSpacing + 4;
      const required = measure(label.textContent.trim());
      const actionScale = action.offsetWidth ? state.box.width / action.offsetWidth : 1;
      if (!(actionScale > 0)) continue;
      let right = innerWidth - 8;
      for (let branch = action, depth = 0; branch && depth < 8; branch = parentOf(branch), depth++) {
        const parent = parentOf(branch);
        if (!parent || parent.matches("body,html")) break;
        const outer = parent.getBoundingClientRect(), parentCss = getComputedStyle(parent);
        if (["hidden", "clip"].includes(parentCss.overflowX)) right = Math.min(right, outer.right - 2);
        for (const sibling of parent.children) {
          if (sibling === branch) continue;
          const box = sibling.getBoundingClientRect();
          if (box.width && box.height && box.left >= state.box.right - 2 && box.top < state.box.bottom - 2 && box.bottom > state.box.top + 2) right = Math.min(right, box.left - 8);
        }
      }
      // Transformed labels still reserve their unscaled CSS width in flex
      // flow. If the whole label cannot fit, reserve enough available space
      // for its longest complete token and use native word wrapping.
      const currentWidth = now.box.width / scale;
      const width = Math.min(required, currentWidth + Math.max(0, right - state.box.right) / actionScale);
      const growth = width - currentWidth;
      const wholeToken = Math.max(...label.textContent.trim().split(/\s+/u).map(measure));
      if (required * scale > innerWidth * .6 || width < wholeToken || growth <= EPSILON) continue;
      write(label, "min-width", `${Math.floor(width)}px`, "compact-selector");
      write(label, "width", `${Math.floor(width)}px`, "compact-selector");
      write(label, "max-width", "none", "compact-selector");
      write(label, "white-space", width >= required ? "nowrap" : "normal", "compact-selector");
      write(label, "word-break", "normal", "compact-selector");
      write(label, "overflow-wrap", "normal", "compact-selector");
      write(label, "flex-shrink", "0", "compact-selector");
      write(label, "height", "auto", "compact-selector");
      for (let branch = parentOf(label); branch && branch !== action; branch = parentOf(branch)) {
        const original = baseline.get(branch), current = snapshot(branch);
        if (!original || !current || current.position === "fixed" || current.position === "absolute") break;
        if (current.box.width < state.box.width) write(branch, "min-width", `${Math.ceil(current.box.width + growth)}px`, "compact-selector");
        if (current.box.height > original.box.height + EPSILON) write(branch, "height", "auto", "compact-selector");
      }
      write(action, "box-sizing", "border-box", "compact-selector");
      write(action, "min-width", `${Math.floor(state.box.width / actionScale + growth)}px`, "compact-selector");
      write(action, "height", "auto", "compact-selector");
    }
  };

  // Some authored tab handlers prevent arrow-key scrolling. Keep the focused
  // action visible without replacing their selection logic or rebuilding DOM.
  const revealFocused = (target) => {
    const action = target?.closest?.("button,a[href],input,select,textarea,[role='button'],[role='tab']");
    const navigation = action?.closest("nav,[role='navigation'],[role='tablist'],[role='menubar']");
    if (!action?.isConnected || excluded(action)) return;
    let pane = action.parentElement;
    for (let depth = 0; pane && depth < 8; depth++, pane = pane.parentElement) {
      const css = getComputedStyle(pane), viewport = pane.getBoundingClientRect();
      if (navigation && pane.scrollWidth > pane.clientWidth + EPSILON && ["auto", "scroll"].includes(css.overflowX) && viewport.width > 0 && viewport.height > 0) {
        const box = action.getBoundingClientRect();
        const left = viewport.left + pane.clientLeft, right = left + pane.clientWidth;
        const delta = box.right > right + EPSILON ? box.right - right : box.left < left - EPSILON ? box.left - left : 0;
        if (delta) pane.scrollTo({ left: pane.scrollLeft + delta, behavior: "instant" });
      }
      if (pane.closest("[data-lexend-layout-repair~='bounded-panel'],[data-lexend-layout-repair~='reachable-scroll']") &&
          pane.scrollHeight > pane.clientHeight + EPSILON && ["auto", "scroll"].includes(css.overflowY) && viewport.width > 0 && viewport.height > 0) {
        const box = action.getBoundingClientRect(), top = Math.max(0, viewport.top + pane.clientTop);
        const bottom = Math.min(innerHeight, viewport.top + pane.clientTop + pane.clientHeight);
        const delta = box.bottom > bottom + EPSILON ? box.bottom - bottom : box.top < top - EPSILON ? box.top - top : 0;
        if (delta) pane.scrollTo({ top: pane.scrollTop + delta, behavior: "instant" });
      }
      if (pane === navigation) break;
    }
  };

  const repair = ({ baseline, textElements, descendants = new Map(), snapshot, write, mark, ancestor, directTextRects }) => {
    const states = [...baseline.keys()].filter((element) => element.isConnected && !excluded(element));
    const contentGrew = (element, before, now) => grew(before, now) || (descendants.get(element) ?? []).some((child) => {
      const original = baseline.get(child), current = snapshot(child);
      return original && current && grew(original, current);
    });
    const usable = (element) => {
      const parent = ancestor(element), parentState = parent ? snapshot(parent) : null;
      const now = snapshot(element);
      if (!now) return null;
      const right = Math.min(innerWidth - 8, parentState ? parentState.box.right - parentState.paddingRight - parentState.borderRight : innerWidth - 8);
      return { now, width: Math.max(0, right - Math.max(0, now.box.left)) };
    };

    repairCompactWords({ baseline, textElements, snapshot, write });
    repairCompactSelectors({ baseline, textElements, snapshot, write });

    // A short header action can lose its authored minimum width when its
    // surrounding flex row adapts. Reserve the measured whole word and the
    // original artwork footprint only when a previously intact label breaks.
    for (const element of states.filter(interactive)) {
      const before = baseline.get(element), now = snapshot(element);
      if (!now || !contentGrew(element, before, now) || before.box.width > 180 ||
          before.box.left < 0 || before.box.right > innerWidth + EPSILON) continue;
      const labels = [element, ...(descendants.get(element) ?? [])].filter((label) =>
        [...label.childNodes].some((node) => node.nodeType === Node.TEXT_NODE && node.textContent.trim()));
      if (element.textContent.trim().split(/\s+/).length > 4) continue;
      let required = 0, broken = false;
      for (const label of labels) {
        const original = baseline.get(label);
        if (!original?.texts?.length || new Set(original.texts.map((box) => Math.round(box.top / 2))).size > 1) continue;
        for (const node of label.childNodes) {
          if (node.nodeType !== Node.TEXT_NODE) continue;
          for (const word of node.textContent.matchAll(/\p{Script=Latin}{2,}/gu)) {
            const range = document.createRange();
            range.setStart(node, word.index); range.setEnd(node, word.index + word[0].length);
            const boxes = [...range.getClientRects()].filter((box) => box.width && box.height);
            if (new Set(boxes.map((box) => Math.round(box.top / 2))).size <= 1) continue;
            broken = true;
            required = Math.max(required, boxes.reduce((sum, box) => sum + box.width, 0));
          }
        }
      }
      if (!broken) continue;
      const artwork = [...element.querySelectorAll("svg,[role='img'],img")].map((glyph) => glyph.getBoundingClientRect().width);
      required = Math.max(before.box.width, required + now.paddingLeft + now.paddingRight + now.borderLeft + now.borderRight + 4,
        ...artwork.map((width) => width + now.paddingLeft + now.paddingRight));
      const parent = ancestor(element), parentState = parent && snapshot(parent);
      if (!parentState || required > Math.min(innerWidth - 16, parentState.box.width) || required <= now.box.width + EPSILON) continue;
      write(element, "box-sizing", "border-box", "action-word");
      write(element, "min-width", `${required}px`, "action-word");
      write(element, "flex-shrink", "0", "action-word");
      write(element, "overflow-wrap", "normal", "action-word");
      write(element, "word-break", "normal", "action-word");
    }

    // Typography can displace the final action even without splitting a word.
    // Wrap the smallest authored horizontal action row that newly overflows;
    // retain its native children, focus order and click handlers.
    const responsiveRows = new Set();
    for (const action of states.filter(interactive)) {
      const before = baseline.get(action), now = snapshot(action);
      const panel = action.closest("dialog,[role='dialog'],[aria-modal='true']");
      const oldLoss = Math.max(0, -before.box.left, before.box.right - innerWidth);
      const newLoss = now ? Math.max(0, -now.box.left, now.box.right - innerWidth) : 0;
      if (!now || oldLoss > before.box.width * .5 || newLoss <= oldLoss + EPSILON ||
          now.box.left >= -EPSILON && now.box.right <= innerWidth + EPSILON ||
          !contentGrew(action, before, now) || !panel && !action.closest("header,nav,[role='navigation'],[role='menubar']")) continue;
      let authoredRail = false;
      for (let parent = ancestor(action), depth = 0; parent && depth < 8; parent = ancestor(parent), depth++) {
        if (!panel && ["auto", "scroll"].includes(getComputedStyle(parent).overflowX) && parent.scrollWidth > parent.clientWidth + EPSILON) { authoredRail = true; break; }
        if (parent.matches("header,nav,[role='navigation'],[role='menubar']")) break;
      }
      if (authoredRail) continue;
      for (let row = ancestor(action), depth = 0; row && depth < 7; row = ancestor(row), depth++) {
        const old = baseline.get(row), state = snapshot(row), css = getComputedStyle(row);
        if (!old || !state || responsiveRows.has(row) || !/^(?:inline-)?flex$/.test(css.display) ||
            css.flexDirection !== "row" || css.flexWrap !== "nowrap" || state.box.height > 160 ||
            old.box.left < -EPSILON || state.box.left < -EPSILON ||
            !row.querySelector("button,a[href],[role='button']")) continue;
        // A consent/dialog terminal group may itself overflow an authored
        // horizontal pane. Restrict wrapping to its small local action group.
        if (panel) {
          const actions = row.querySelectorAll("button,a[href],[role='button']");
          if (actions.length < 2 || actions.length > 4 || row.querySelector("input,select,textarea,picture,video,iframe,canvas")) continue;
        }
        // A horizontal scrolling rail already provides native reachability.
        // Never turn that authored composition into a stacked header.
        if (["auto", "scroll"].includes(css.overflowX) && row.scrollWidth > row.clientWidth + EPSILON) break;
        const available = innerWidth - Math.max(0, state.box.left) - state.borderRight - 4;
        if (available < 80 || state.box.width < available * .7) continue;
        write(row, "box-sizing", "border-box", "action-row-wrap");
        write(row, "max-width", `${Math.floor(available)}px`, "action-row-wrap");
        write(row, "min-width", "0", "action-row-wrap");
        write(row, "flex-wrap", "wrap", "action-row-wrap");
        write(row, "height", "auto", "action-row-wrap");
        responsiveRows.add(row);
        break;
      }
    }

    // Native option rendering cannot wrap or honor every line-height setting.
    // Keep its hit area and arrow within the original containing column.
    for (const element of states) {
      if (!element.matches("select") || element.multiple || element.size > 1) continue;
      const before = baseline.get(element), fit = usable(element);
      if (!fit || fit.width < 48 || before.box.right > innerWidth + EPSILON || fit.now.box.width <= fit.width + EPSILON) continue;
      write(element, "box-sizing", "border-box", "control-fit");
      write(element, "min-width", "0", "control-fit");
      write(element, "max-width", `${fit.width}px`, "control-fit");
      write(element, "width", `${fit.width}px`, "control-fit");
    }

    // Native placeholders have no DOM Range and scrollWidth omits their lost
    // pixels. Legacy sites use an unchanged author default value as a prompt;
    // measure that fallback too, never edited/password content.
    for (const element of states) {
      if (!element.matches("input") || !["text", "search", "email", "url", "tel"].includes(element.type)) continue;
      const prompt = element.placeholder || (element.value === element.defaultValue ? element.defaultValue : "");
      if (!prompt) continue;
      const before = baseline.get(element), fit = usable(element);
      if (!fit || fit.width < 48 || !grew(before, fit.now)) continue;
      canvas ??= document.createElement("canvas");
      const context = canvas.getContext("2d");
      if (!context) continue;
      const measure = (state) => { context.font = state.font; return context.measureText(prompt).width + Math.max(0, [...prompt].length - 1) * state.letterSpacing + state.paddingLeft + state.paddingRight + state.borderLeft + state.borderRight + 4; };
      const required = measure(fit.now), original = measure(before);
      if (original > before.box.width + EPSILON || required <= fit.now.box.width + EPSILON || required > fit.width + EPSILON) continue;
      write(element, "box-sizing", "border-box", "native-field");
      write(element, "width", `${required}px`, "native-field");
      write(element, "min-width", `${required}px`, "native-field");
      write(element, "max-width", `${fit.width}px`, "native-field");
      const parent = ancestor(element), css = parent ? getComputedStyle(parent) : null;
      if (css && /^(?:inline-)?flex$/.test(css.display)) write(parent, "flex-wrap", "wrap", "native-field");
      else if (css?.whiteSpace === "nowrap") write(parent, "white-space", "normal", "native-field");
    }

    // Keep real icon artwork next to its label when a previously adjacent
    // arrow drops onto another row. Ordinary prose spans are never icons.
    const icon = (element) => {
      const css = getComputedStyle(element), text = element.textContent.trim();
      return element.matches("svg,img,[role='img']") || !text && (css.backgroundImage !== "none" || ["::before", "::after"].some((pseudo) => !["none", "normal", '""', "''"].includes(getComputedStyle(element, pseudo).content)));
    };
    for (const element of states.filter(interactive)) {
      const before = baseline.get(element), now = snapshot(element);
      if (!now || !contentGrew(element, before, now)) continue;
      const children = [...element.children].filter((child) => baseline.has(child) && snapshot(child));
      if (children.length < 2 || children.length > 4) continue;
      const icons = children.filter(icon), labels = children.filter((child) => !icon(child) && child.textContent.trim());
      if (!icons.length || labels.length !== 1) continue;
      const label = labels[0], oldLabel = baseline.get(label).box, newLabel = snapshot(label).box;
      const associated = icons.every((glyph) => {
        const box = baseline.get(glyph).box;
        return box.width > 0 && box.width <= 48 && Math.abs((box.top + box.bottom - oldLabel.top - oldLabel.bottom) / 2) <= Math.max(5, before.fontSize * .7);
      });
      const separated = icons.some((glyph) => { const box = snapshot(glyph).box; return box.top >= newLabel.bottom - 1 || box.bottom <= newLabel.top + 1; });
      if (!associated || !separated) continue;
      write(element, "display", "inline-flex", "icon-label");
      write(element, "align-items", "center", "icon-label");
      write(element, "gap", ".35em", "icon-label");
      for (const glyph of icons) write(glyph, "flex-shrink", "0", "icon-label");
      write(label, "min-width", "0", "icon-label");
      write(label, "white-space", "normal", "icon-label");
      write(label, "flex", "1 1 auto", "icon-label");
      if (/^\S+$/u.test(label.textContent.trim()) && newLabel.width < innerWidth * 0.5) {
        // A single-word brand remains whole when the icon/label flex repair
        // grows its text. Multiword actions can still wrap between words.
        write(label, "min-width", "max-content", "icon-label");
        write(label, "white-space", "nowrap", "icon-label");
        write(label, "flex", "0 0 auto", "icon-label");
      }
    }

    // A radio and its explicit HTML label must stay visually associated. For
    // a direct alternating option list, use two columns only after a new line
    // break separates an originally adjacent pair. No DOM wrapping is needed.
    for (const parent of new Set(states.filter((element) => element.matches("input[type='radio'],input[type='checkbox']")).map(ancestor).filter(Boolean))) {
      const children = [...parent.children];
      if (children.length < 4 || children.length > 16 || children.length % 2) continue;
      let valid = true, separated = false;
      for (let index = 0; index < children.length; index += 2) {
        const input = children[index], label = children[index + 1];
        if (!input.matches("input[type='radio'],input[type='checkbox']") || !input.id || !label.matches("label") || label.htmlFor !== input.id || !baseline.has(input) || !baseline.has(label)) { valid = false; break; }
        const oldInput = baseline.get(input).box, oldLabel = baseline.get(label).box, nowInput = snapshot(input), nowLabel = snapshot(label);
        if (!nowInput || !nowLabel || Math.abs((oldInput.top + oldInput.bottom - oldLabel.top - oldLabel.bottom) / 2) > 10) { valid = false; break; }
        if (Math.abs((nowInput.box.top + nowInput.box.bottom - nowLabel.box.top - nowLabel.box.bottom) / 2) > nowLabel.fontSize && grew(baseline.get(label), nowLabel)) separated = true;
      }
      if (!valid || !separated) continue;
      write(parent, "display", "inline-grid", "choice-label");
      write(parent, "grid-template-columns", "max-content minmax(0, 1fr)", "choice-label");
      write(parent, "column-gap", ".35em", "choice-label");
      write(parent, "row-gap", ".25em", "choice-label");
      write(parent, "align-items", "center", "choice-label");
      for (const child of children) write(child, "margin", "0", "choice-label");
    }

    // A small overlay action can share a navigation grid cell with the label
    // row even when its CSS position is relative. If enlarged text newly
    // enters its hit area, give the sibling row a bounded keyboard scroller.
    // Leave the action itself in place and never resize an entire header.
    const rowRepairs = new Set();
    const overlap = (a, b) => Math.max(0, Math.min(a.right, b.right) - Math.max(a.left, b.left)) * Math.max(0, Math.min(a.bottom, b.bottom) - Math.max(a.top, b.top));
    for (const widget of states.filter(interactive)) {
      const oldWidget = baseline.get(widget), nowWidget = snapshot(widget), navigation = widget.closest("nav,[role='navigation']");
      if (!navigation || !nowWidget || !widget.querySelector("svg,[role='img']") && !icon(widget) ||
          nowWidget.box.width < 20 || nowWidget.box.width > 80 || nowWidget.box.height < 20 || nowWidget.box.height > 80 ||
          nowWidget.box.right < innerWidth - 80 || oldWidget.box.left < 0 || oldWidget.box.right > innerWidth + EPSILON) continue;
      for (const label of states.filter((element) => element.matches("a[href]") && element.closest("nav,[role='navigation']") === navigation)) {
        const oldLabel = baseline.get(label), nowLabel = snapshot(label);
        if (!nowLabel?.text || !oldLabel.text || !contentGrew(label, oldLabel, nowLabel) || overlap(nowLabel.text, nowWidget.box) <= overlap(oldLabel.text, oldWidget.box) + 4) continue;
        for (let row = ancestor(label), depth = 0; row && row !== navigation && depth < 6; row = ancestor(row), depth++) {
          const state = snapshot(row), css = getComputedStyle(row);
          if (!state || row.contains(widget) || rowRepairs.has(row) || state.box.width < 160 || row.children.length < 2 || state.box.height > 120) continue;
          if (!/^(?:inline-)?flex$/.test(css.display) && !/auto|scroll|hidden|clip/.test(css.overflowX)) continue;
          const available = nowWidget.box.left - state.box.left - 8;
          if (available < 120 || available >= state.box.width - EPSILON) continue;
          write(row, "box-sizing", "border-box", "navigation-action-space");
          write(row, "width", `${available}px`, "navigation-action-space");
          write(row, "max-width", `${available}px`, "navigation-action-space");
          write(row, "overflow-x", "auto", "navigation-action-space");
          write(row, "white-space", "nowrap", "navigation-action-space");
          if (/flex/.test(css.display)) {
            write(row, "flex-wrap", "nowrap", "navigation-action-space");
            for (const child of row.children) write(child, "flex-shrink", "0", "navigation-action-space");
          }
          if (!row.hasAttribute("tabindex")) mark(row, "tabindex", "0");
          rowRepairs.add(row);
          break;
        }
      }
    }

    // An authored navigation carousel can intentionally retain its transform
    // while enlarged labels exceed the current viewport. Expose its existing
    // clipping pane as a keyboard scroller rather than flattening the track.
    for (const label of textElements) {
      const navigation = label.closest("nav,[role='tablist'],[role='menubar']");
      const action = label.closest("button,a[href],[role='button'],[role='tab']");
      const before = baseline.get(label), now = snapshot(label);
      if (!navigation || !action || !before?.text || !now?.text || !grew(before, now)) continue;
      for (let pane = ancestor(label), depth = 0; pane && pane !== navigation && depth < 7; pane = ancestor(pane), depth++) {
        const original = baseline.get(pane), state = snapshot(pane), css = getComputedStyle(pane);
        if (!original || !state || rowRepairs.has(pane) || state.box.width < 80 || state.box.height > 120 || !/hidden|clip|auto|scroll/.test(css.overflowX)) continue;
        const oldLoss = Math.max(0, original.box.left - before.text.left, before.text.right - original.box.right);
        const newLoss = Math.max(0, state.box.left - now.text.left, now.text.right - state.box.right);
        if (oldLoss > EPSILON || newLoss <= oldLoss + EPSILON || pane.querySelectorAll("button,a[href],[role='button'],[role='tab']").length < 2) continue;
        write(pane, "overflow-x", "auto", "navigation-scroll");
        write(pane, "height", "auto", "navigation-scroll");
        write(pane, "min-height", `${state.box.height + 16}px`, "navigation-scroll");
        if (!pane.hasAttribute("tabindex")) mark(pane, "tabindex", "0");
        rowRepairs.add(pane);
        break;
      }
    }

    // A touching split control is a single visual hit area. Repair only pairs
    // that had equal heights before typography and now acquire a visible step.
    const splitParents = new Set(states.filter(interactive).map(ancestor).filter(Boolean));
    for (const parent of splitParents) {
      const controls = [...parent.children].filter((element) => interactive(element) && baseline.has(element) && snapshot(element));
      if (controls.length < 2 || controls.length > 6) continue;
      for (let index = 1; index < controls.length; index++) {
        const left = controls[index - 1], right = controls[index];
        const a = baseline.get(left), b = baseline.get(right), nowA = snapshot(left), nowB = snapshot(right);
        if (!sameRow(a.box, b.box) || Math.abs(a.box.height - b.box.height) > EPSILON || Math.abs(a.box.right - b.box.left) > 4 ||
            !sameRow(nowA.box, nowB.box) || Math.abs(nowA.box.height - nowB.box.height) <= EPSILON ||
            (!contentGrew(left, a, nowA) && !contentGrew(right, b, nowB))) continue;
        const height = Math.max(nowA.box.height, nowB.box.height);
        for (const element of [left, right]) {
          write(element, "box-sizing", "border-box", "split-control");
          write(element, "min-height", `${height}px`, "split-control");
          write(element, "display", "inline-flex", "split-control");
          write(element, "align-items", "center", "split-control");
          write(element, "justify-content", "center", "split-control");
        }
      }
    }

    // Preserve a short action's complete label when growth exceeds its pill.
    // Closed/offscreen panels never enter the baseline and stay untouched.
    for (const element of states.filter(interactive)) {
      const before = baseline.get(element), now = snapshot(element);
      if (!now || before.position === "absolute" || before.position === "fixed") continue;
      const words = element.textContent.trim().split(/\s+/).filter(Boolean);
      if (!words.length || words.length > 10 || element.querySelector("picture,video,iframe,canvas") ||
          [...element.querySelectorAll("img,svg")].some((glyph) => {
            const box = glyph.getBoundingClientRect();
            return box.width > 48 || box.height > 48;
          })) continue;
      const texts = [element, ...(descendants.get(element) ?? [])].flatMap(directTextRects);
      if (!texts.length) continue;
      // Centered actions can have padding slightly outside the viewport while
      // every authored glyph still fits. Compare the actual baseline labels,
      // rather than treating that harmless padding as pre-existing text loss.
      const originalTexts = [element, ...(descendants.get(element) ?? [])].flatMap((label) => baseline.get(label)?.texts ?? []);
      const originallyInViewport = originalTexts.length && originalTexts.every((box) => box.left >= -EPSILON && box.right <= innerWidth + EPSILON);
      const lost = texts.some((box) => originallyInViewport && (box.left < -EPSILON || box.right > innerWidth + EPSILON) || box.right > now.box.right + EPSILON || box.bottom > now.box.bottom + EPSILON);
      const originallyContained = !before.text || before.text.right <= before.box.right + EPSILON && before.text.bottom <= before.box.bottom + EPSILON;
      if (!lost || !originallyContained || !contentGrew(element, before, now)) continue;
      write(element, "white-space", "normal", "pill-label");
      write(element, "overflow-wrap", "normal", "pill-label");
      for (const label of descendants.get(element) ?? []) {
        if (baseline.has(label) && getComputedStyle(label).whiteSpace === "nowrap" && !excluded(label)) write(label, "white-space", "normal", "pill-label");
      }
      write(element, "height", "auto", "pill-label");
      write(element, "min-height", `${before.box.height}px`, "pill-label");
      write(element, "max-height", "none", "pill-label");
      const fit = usable(element);
      if (fit?.width >= 48) {
        write(element, "box-sizing", "border-box", "pill-label");
        write(element, "max-width", `${fit.width}px`, "pill-label");
      }
    }

    // Short media captions in an authored horizontal rail need enough width
    // for words that fitted before conversion. Expand only their local card;
    // retain the rail, font size and media aspect ratio.
    for (const element of textElements) {
      const before = baseline.get(element), now = snapshot(element);
      if (!before || !now || excluded(element) || !grew(before, now)) continue;
      const words = element.textContent.trim().split(/\s+/).filter(Boolean);
      if (words.length < 3 || words.length > 18 || now.box.width > 220) continue;
      const card = element.closest("a[href],button,[role='button']"), rail = card && ancestor(card);
      const cardState = card && snapshot(card), railState = rail && snapshot(rail);
      if (!cardState || !railState || !card.querySelector("img,picture,video") ||
          cardState.box.width < 60 || cardState.box.width > 220 ||
          !["auto", "scroll"].includes(railState.overflowX) ||
          !railState.display.includes("flex") || cardState.position === "absolute" || cardState.position === "fixed") continue;
      canvas ??= document.createElement("canvas");
      const context = canvas.getContext("2d");
      if (!context) continue;
      context.font = before.font;
      let required = now.box.width;
      for (const node of element.childNodes) {
        if (node.nodeType !== Node.TEXT_NODE) continue;
        for (const match of node.textContent.matchAll(/\p{Script=Latin}{5,}/gu)) {
          const originalWidth = context.measureText(match[0]).width + Math.max(0, match[0].length - 1) * before.letterSpacing;
          if (originalWidth > before.box.width - before.paddingLeft - before.paddingRight + EPSILON) continue;
          const range = document.createRange(); range.setStart(node, match.index); range.setEnd(node, match.index + match[0].length);
          const boxes = [...range.getClientRects()].filter((box) => box.width && box.height);
          const lines = new Set(boxes.map((box) => Math.round(box.top / 2)));
          if (lines.size > 1) required = Math.max(required, boxes.reduce((sum, box) => sum + box.width, 0) + now.paddingLeft + now.paddingRight + 4);
        }
      }
      if (required <= now.box.width + EPSILON || required > railState.box.width * .75) continue;
      const width = cardState.box.width + required - now.box.width;
      write(card, "box-sizing", "border-box", "media-caption");
      write(card, "min-width", `${width}px`, "media-caption");
      write(card, "flex-shrink", "0", "media-caption");
    }

    // Large decorative gutters can leave a paragraph narrower than its words.
    // Relieve only padded local columns whose newly enlarged prose is narrow;
    // leave document gutters, code, media and naturally small labels alone.
    const relieved = new Set();
    for (const element of textElements) {
      const before = baseline.get(element), now = snapshot(element);
      if (!before || !now || excluded(element) || !grew(before, now)) continue;
      const words = [...element.childNodes].filter((node) => node.nodeType === Node.TEXT_NODE).flatMap((node) => node.textContent.trim().split(/\s+/)).filter(Boolean);
      const columnWidth = now.box.width - now.paddingLeft - now.paddingRight - now.borderLeft - now.borderRight;
      if (words.length < 16 || columnWidth >= Math.min(260, innerWidth * .68)) continue;
      const ownCss = getComputedStyle(element), parentState = snapshot(ancestor(element));
      const marginLeft = parseFloat(ownCss.marginLeft) || 0, marginRight = parseFloat(ownCss.marginRight) || 0;
      // Authored margins can create the same narrow paragraph as padding.
      // Only relieve two substantial margins within a viewport-sized parent.
      if (parentState && parentState.box.width >= 260 && parentState.box.width <= innerWidth + EPSILON &&
          marginLeft >= 24 && marginRight >= 24 && marginLeft + marginRight >= parentState.box.width * .25 &&
          now.position !== "absolute" && now.position !== "fixed") {
        const gutter = Math.min(24, Math.max(12, parentState.box.width * .06));
        write(element, "margin-left", `${Math.min(marginLeft, gutter)}px`, "prose-gutter");
        write(element, "margin-right", `${Math.min(marginRight, gutter)}px`, "prose-gutter");
      }
      let current = element;
      for (let depth = 0; current && depth < 4; depth++, current = ancestor(current)) {
        if (current === document.body || current === document.documentElement || relieved.has(current)) continue;
        const state = snapshot(current), original = baseline.get(current);
        if (!state || !original || state.box.width > innerWidth + EPSILON || state.position === "absolute" || state.position === "fixed") continue;
        const padding = state.paddingLeft + state.paddingRight;
        if (padding < 64 || padding < state.box.width * .25 || columnWidth >= state.box.width * .7) continue;
        const gutter = Math.min(24, Math.max(12, state.box.width * .06));
        write(current, "padding-left", `${Math.min(state.paddingLeft, gutter)}px`, "prose-gutter");
        write(current, "padding-right", `${Math.min(state.paddingRight, gutter)}px`, "prose-gutter");
        relieved.add(current);
        break;
      }
    }

    // Unequal-height floats can occupy the next row's left/right slots. Clear
    // only original row starts in consecutive complete float runs. This also
    // works when cards are body siblings beside unrelated headers and footers;
    // their containing layout and media dimensions remain the author's own.
    const floatParents = new Set(states.map(ancestor).filter(Boolean));
    for (const parent of floatParents) {
      const css = getComputedStyle(parent);
      if (css.display.includes("grid") || css.display.includes("flex")) continue;
      const runs = [], children = [...parent.children].filter((child) => snapshot(child));
      let run = [];
      for (const child of children) {
        if (baseline.has(child) && ["left", "right"].includes(getComputedStyle(child).cssFloat)) run.push(child);
        else { if (run.length) runs.push(run); run = []; }
      }
      if (run.length) runs.push(run);
      for (const group of runs) {
        if (group.length < 4 || group.length > 16) continue;
        const old = group.map((child) => baseline.get(child).box);
        const firstRow = old.filter((box) => sameRow(box, old[0]));
        const columns = firstRow.length;
        if (columns < 2 || columns > 4 || group.length % columns) continue;
        let aligned = true, staggered = false;
        for (let row = 0; row < group.length; row += columns) {
          if (old.slice(row, row + columns).some((box, column) => !sameRow(box, old[row]) || Math.abs(box.left - old[column].left) > EPSILON || Math.abs(box.width - old[column].width) > EPSILON)) aligned = false;
          const changed = group.slice(row, row + columns).map((child) => snapshot(child).box);
          if (changed.some((box) => Math.abs(box.top - changed[0].top) > 4)) staggered = true;
        }
        if (!aligned || !staggered) continue;
        for (let row = columns; row < group.length; row += columns) write(group[row], "clear", "both", "float-rows");
      }
    }

    // A growing floating utility needs enough document space for the footer's
    // last line to scroll above it. Keep headers, dialogs and full-width bars
    // out; ordinary paragraphs remain readable at other scroll positions.
    let reserved = 0;
    for (const element of states) {
      const before = baseline.get(element), now = snapshot(element);
      if (!now || before.position !== "fixed" || !element.matches("button,a[href],[role='button']") && !element.querySelector("button,a[href],[role='button']")) continue;
      if (before.box.bottom < innerHeight - 80 || before.box.top >= innerHeight || before.box.left >= innerWidth || before.box.right <= 0 ||
          now.box.height > innerHeight * .2 || now.box.width > innerWidth * .6 ||
          now.box.height <= before.box.height + EPSILON && now.box.width <= before.box.width + EPSILON) continue;
      reserved = Math.max(reserved, now.box.height + 8);
    }
    if (reserved && document.body) {
      if (!footerPadding.has(baseline)) footerPadding.set(baseline, parseFloat(getComputedStyle(document.body).paddingBottom) || 0);
      write(document.body, "padding-bottom", `${footerPadding.get(baseline) + reserved}px`, "floating-control-space");
    }
  };
  // Container repair can shrink a layered flex action after its label was
  // converted. Reserve complete short words after that last pass, including
  // the unchanged icon footprint, and wrap only its local header action row.
  const finalizeActionWords = ({ baseline, snapshot, write }) => {
    for (const label of baseline.keys()) {
      const original = baseline.get(label), current = snapshot(label);
      const action = label.closest?.("button,a[href],[role='button']");
      if (!action || !original?.texts?.length || !current || excluded(label) || !grew(original, current) ||
          label.textContent.trim().split(/\s+/u).length > 4 ||
          new Set(original.texts.map(box => Math.round(box.top / 2))).size > 1 ||
          !action.closest("header,nav,[role='navigation'],dialog,[role='dialog'],[aria-modal='true']")) continue;
      const words = wordWidths(label);
      const before = baseline.get(action), now = snapshot(action);
      if (!words.some(word => word.lines > 1) && !(current.text && now && current.text.right > now.box.right + EPSILON && original.text && before && original.text.right <= before.box.right + EPSILON)) continue;
      if (!before || !now || before.box.width > 180 || before.box.left < 0 || before.box.right > innerWidth + EPSILON ||
          action.textContent.trim().split(/\s+/u).length > 4 || action.querySelector("picture,video,iframe,canvas,input,select,textarea")) continue;
      const glyphs = [...action.querySelectorAll("svg,img,[role='img']")].filter(glyph => !glyph.parentElement.closest("svg,[role='img']"));
      if (glyphs.some(glyph => glyph.getBoundingClientRect().width > 48 || glyph.getBoundingClientRect().height > 48)) continue;
      const token = Math.ceil(Math.max(...words.map(word => word.width)) + 3);
      const artwork = glyphs.reduce((sum, glyph) => sum + glyph.getBoundingClientRect().width, 0);
      const required = Math.ceil(Math.max(before.box.width, token + artwork + now.paddingLeft + now.paddingRight + now.borderLeft + now.borderRight + 8));
      let row = null;
      const wrappers = [];
      for (let parent = parentOf(action), depth = 0; parent && depth < 6; parent = parentOf(parent), depth++) {
        const css = getComputedStyle(parent), state = snapshot(parent);
        if (!state || parent.matches("body,html") || ["fixed", "absolute"].includes(css.position) ||
            ["auto", "scroll"].includes(css.overflowX) && parent.scrollWidth > parent.clientWidth + EPSILON) break;
        const actions = parent.querySelectorAll("button,a[href],[role='button']");
        if (/^(?:inline-)?flex$/.test(css.display) && css.flexDirection === "row" && actions.length >= 2 && actions.length <= 4) { row = parent; break; }
        if (actions.length !== 1) break;
        wrappers.push(parent);
      }
      if (!row) continue;
      const outer = row.getBoundingClientRect(), available = innerWidth - Math.max(0, outer.left) - 8;
      if (required > available || available < 80) continue;
      write(label, "min-width", `${token}px`, "action-word");
      write(label, "overflow-wrap", "normal", "action-word");
      write(label, "word-break", "normal", "action-word");
      for (let parent = parentOf(label); parent && parent !== action; parent = parentOf(parent)) {
        if (!baseline.has(parent) || ["absolute", "fixed"].includes(getComputedStyle(parent).position)) break;
        write(parent, "min-width", `${token}px`, "action-word");
      }
      for (const element of [action, ...wrappers]) {
        write(element, "box-sizing", "border-box", "action-word");
        write(element, "min-width", `${required}px`, "action-word");
        write(element, "max-width", `${available}px`, "action-word");
        write(element, "height", "auto", "action-word");
        write(element, "min-height", `${baseline.get(element)?.box.height ?? before.box.height}px`, "action-word");
        write(element, "flex-shrink", "0", "action-word");
      }
      write(row, "min-width", "0", "action-row-wrap");
      write(row, "max-width", `${Math.floor(available)}px`, "action-row-wrap");
      write(row, "flex-wrap", "wrap", "action-row-wrap");
      write(row, "height", "auto", "action-row-wrap");
    }
  };
  const finalizeIconLabels = ({ baseline, snapshot, write }) => {
    finalizeActionWords({ baseline, snapshot, write });
    repairCompactWords({ baseline, snapshot, write });
    repairCompactSelectors({ baseline, snapshot, write });
    for (const element of baseline.keys()) {
      if (!element.isConnected || !element.getAttribute("data-lexend-layout-repair")?.split(" ").includes("icon-label")) continue;
      const label = [...element.children].find((child) => /^\S+$/u.test(child.textContent.trim()) && snapshot(child)?.box.width < innerWidth * 0.5);
      if (!label) continue;
      write(label, "white-space", "nowrap", "icon-label");
      write(label, "overflow-wrap", "normal", "icon-label");
      write(label, "min-width", "max-content", "icon-label");
      write(label, "flex", "0 0 auto", "icon-label");
      const next = element.nextElementSibling;
      const originalLabel = baseline.get(label), originalNext = next && baseline.get(next);
      if (!originalLabel || !originalNext || originalNext.box.left - originalLabel.box.right < 8) continue;
      const labelRight = label.getBoundingClientRect().right, nextBox = next.getBoundingClientRect();
      const gap = nextBox.left - labelRight;
      const shift = Math.ceil(8 - gap);
      if (shift > 0 && shift < 64 && nextBox.right + shift < innerWidth - 8
          && !["absolute", "fixed"].includes(getComputedStyle(next).position)) {
        const margin = parseFloat(getComputedStyle(next).marginLeft) || 0;
        write(next, "margin-left", `${margin + shift}px`, "icon-label-space");
      }
    }
  };
  globalThis.LexendControls = Object.freeze({ repair, finalizeIconLabels, revealFocused });
})();
