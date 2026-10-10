(() => {
  "use strict";

  // Adapt only constraints that become unsafe after typography changes. No site
  // identities or author class names are involved. Every write is reversible.
  const EPSILON = 2;
  const PROTECTED = "pre,code,kbd,samp,math,svg,[data-lexend-ignore],[role='textbox'][aria-multiline='true'],[contenteditable='true']";
  const heading = (element) => /^H[1-6]$/.test(element.tagName) || element.getAttribute("role") === "heading";
  const control = (element) => element.matches("button,input,select,textarea,a[href],[role='button']");
  const rect = (value) => ({ left: value.left, right: value.right, top: value.top, bottom: value.bottom, width: value.width, height: value.height });
  const visible = (element, style, allowViewportEscape = false, styleFor = getComputedStyle) => {
    if (style.display === "none" || style.visibility === "hidden" || Number(style.opacity) === 0 || !element.getClientRects().length) return false;
    if (element.checkVisibility && !element.checkVisibility({ contentVisibilityAuto: true })) return false;
    // Visually hidden labels, sprite replacement text and closed navigation
    // panels remain hidden. Expansion must never turn them into page content.
    if ((style.clip !== "auto" && style.clip !== "") || style.clipPath === "inset(50%)" || parseFloat(style.textIndent) < -500) return false;
    const box = element.getBoundingClientRect();
    let current = element;
    let escapedFixed = false;
    for (let depth = 0; current && depth < 10; depth++, current = current.parentElement ?? current.getRootNode()?.host) {
      const css = current === element ? style : styleFor(current);
      if (Number(css.opacity) === 0 || css.visibility === "hidden" || (css.clip !== "auto" && css.clip !== "")) return false;
      // A fixed descendant escapes scrolling ancestors' geometric clips until
      // an ancestor actually owns its containing block. Continue checking
      // visibility/opacity; hidden ancestry must never become visible text.
      if (escapedFixed && (css.transform !== "none" || css.perspective !== "none" || css.filter !== "none"
          || (css.backdropFilter && css.backdropFilter !== "none") || /(?:layout|paint|strict|content)/.test(css.contain)
          || /(?:transform|perspective|filter)/.test(css.willChange))) escapedFixed = false;
      if (escapedFixed) continue;
      const clippingX = ["hidden", "clip"].includes(css.overflowX), clippingY = ["hidden", "clip"].includes(css.overflowY);
      const boundary = current.getBoundingClientRect();
      // Focus-revealed accessibility links are often positioned far to the
      // left with a tiny box, rather than clipped. They have no painted page
      // footprint until the author brings them onscreen on keyboard focus.
      if (css.position === "absolute" && parseFloat(css.left) < -500 && boundary.right < 0) return false;
      if (!allowViewportEscape && css.position === "fixed" && boundary.width > 0 && boundary.height > 0
          && (boundary.top >= innerHeight || boundary.bottom <= 0 || boundary.left >= innerWidth || boundary.right <= 0)) return false;
      if (css.position === "fixed") escapedFixed = true;
      if (allowViewportEscape) continue;
      if (!clippingX && !clippingY) continue;
      if ((clippingX && (current.clientWidth < 2 || Math.min(box.right, boundary.right) <= Math.max(box.left, boundary.left))) ||
          (clippingY && (current.clientHeight < 2 || Math.min(box.bottom, boundary.bottom) <= Math.max(box.top, boundary.top)))) return false;
    }
    return true;
  };
  const ancestor = (element) => element.parentElement ?? element.getRootNode()?.host ?? null;
  const intersection = (a, b) => Math.max(0, Math.min(a.right, b.right) - Math.max(a.left, b.left)) * Math.max(0, Math.min(a.bottom, b.bottom) - Math.max(a.top, b.top));
  const bounds = (rects) => rects.length ? {
    left: Math.min(...rects.map((r) => r.left)), right: Math.max(...rects.map((r) => r.right)),
    top: Math.min(...rects.map((r) => r.top)), bottom: Math.max(...rects.map((r) => r.bottom))
  } : null;
  const measureTextRects = (element) => {
    const result = [];
    for (const node of element.childNodes) {
      if (node.nodeType !== Node.TEXT_NODE || !node.textContent.trim()) continue;
      const range = document.createRange();
      range.selectNodeContents(node);
      for (const box of range.getClientRects()) if (box.width && box.height) result.push(rect(box));
    }
    return result;
  };
  const hangulTokens = (element) => {
    const result = [];
    for (const node of element.childNodes) {
      if (node.nodeType !== Node.TEXT_NODE || node.textContent.length > 500 || !/\p{Script=Hangul}/u.test(node.textContent)) continue;
      for (const match of node.textContent.matchAll(/\S+/gu)) {
        const range = document.createRange();
        range.setStart(node, match.index); range.setEnd(node, match.index + match[0].length);
        const fragments = [...range.getClientRects()].filter((box) => box.width > 0 && box.height > 0);
        result.push({ word: match[0], lines: new Set(fragments.map((box) => Math.round(box.top * 2))).size,
          width: fragments.reduce((sum, box) => sum + box.width, 0) });
        if (result.length > 24) return [];
      }
    }
    return result;
  };
  const measureSnapshot = (element, allowViewportEscape, styleFor, textRects) => {
    const style = styleFor(element);
    if (!visible(element, style, allowViewportEscape, styleFor)) return null;
    const box = rect(element.getBoundingClientRect());
    const texts = textRects(element);
    return {
      box, texts, text: bounds(texts), scrollWidth: element.scrollWidth, scrollHeight: element.scrollHeight,
      clientWidth: element.clientWidth, clientHeight: element.clientHeight,
      fontSize: parseFloat(style.fontSize) || 16, font: style.font, letterSpacing: parseFloat(style.letterSpacing) || 0,
      display: style.display, position: style.position, whiteSpace: style.whiteSpace,
      overflowX: style.overflowX, overflowY: style.overflowY, lineClamp: style.webkitLineClamp,
      color: style.color, backgroundColor: style.backgroundColor, backgroundImage: style.backgroundImage,
      paddingTop: parseFloat(style.paddingTop) || 0, paddingBottom: parseFloat(style.paddingBottom) || 0,
      paddingLeft: parseFloat(style.paddingLeft) || 0, paddingRight: parseFloat(style.paddingRight) || 0,
      borderTop: parseFloat(style.borderTopWidth) || 0, borderBottom: parseFloat(style.borderBottomWidth) || 0,
      borderLeft: parseFloat(style.borderLeftWidth) || 0, borderRight: parseFloat(style.borderRightWidth) || 0,
      flexDirection: style.flexDirection, flexWrap: style.flexWrap, gridTemplateColumns: style.gridTemplateColumns,
      textOverflow: style.textOverflow, transform: style.transform,
      authoredTop: parseFloat(style.top), authoredHeight: parseFloat(style.height), hangulTokens: hangulTokens(element)
    };
  };
  const defaultTextElements = (root) => {
    const elements = new Set();
    const walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT);
    let node;
    while ((node = walker.nextNode())) {
      if (node.textContent.trim() && node.parentElement && !node.parentElement.closest(PROTECTED)) elements.add(node.parentElement);
    }
    root.querySelectorAll?.("input,select,textarea,button,[role='button']").forEach((element) => {
      if (!element.closest(PROTECTED)) elements.add(element);
    });
    return elements;
  };
  const lightText = (color) => {
    const values = color.match(/[\d.]+/g)?.map(Number);
    return values?.length >= 3 && (values[0] * 0.2126 + values[1] * 0.7152 + values[2] * 0.0722) > 180;
  };

  const create = ({ withStylesDisabled = (callback) => callback(), getTextElements = defaultTextElements } = {}) => {
    let baseline = new Map();
    let textElements = new Set();
    let descendants = new Map();
    let visualContainers = new WeakMap();
    let pseudoBaseline = new Map();
    let maskedTickers = new Map();
    let panelReservations = new Map();
    let frameQualification = null;
    let viewportScrollOwners = new Set();
    const edits = new Map();
    const attributes = new Map();
    const tableWrappers = new Map();
    const maskedScrollOffsets = new Map();
    const originalStylePresence = new Map();
    let canvas;
    // Repeated repair stages read the same boxes and ancestor styles. Reuse
    // them only within this synchronous pass, and discard every measurement
    // after any write: a child can change its siblings or a :has() ancestor.
    let measurements = null;
    const freshMeasurements = () => ({
      styles: new WeakMap(), snapshots: [new WeakMap(), new WeakMap()],
      textRects: new WeakMap(), containedRects: new WeakMap()
    });
    const invalidateMeasurements = () => { if (measurements) measurements = freshMeasurements(); };
    const withMeasurements = (callback) => {
      const previous = measurements;
      measurements = freshMeasurements();
      try { return callback(); }
      finally { measurements = previous; }
    };
    const styleFor = (element, pseudo = null) => {
      if (!measurements || pseudo) return getComputedStyle(element, pseudo);
      if (!measurements.styles.has(element)) measurements.styles.set(element, getComputedStyle(element));
      return measurements.styles.get(element);
    };
    const directTextRects = (element) => {
      if (!measurements) return measureTextRects(element);
      if (!measurements.textRects.has(element)) measurements.textRects.set(element, measureTextRects(element));
      return measurements.textRects.get(element);
    };
    const snapshot = (element, allowViewportEscape = false) => {
      if (!measurements) return measureSnapshot(element, allowViewportEscape, styleFor, directTextRects);
      const cache = measurements.snapshots[Number(allowViewportEscape)];
      if (!cache.has(element)) cache.set(element, measureSnapshot(element, allowViewportEscape, styleFor, directTextRects));
      return cache.get(element);
    };
    const write = (element, property, value, category) => {
      let properties = edits.get(element);
      if (!properties) {
        edits.set(element, properties = new Map());
        originalStylePresence.set(element, element.hasAttribute("style"));
      }
      if (!properties.has(property)) properties.set(property, {
        value: element.style.getPropertyValue(property), priority: element.style.getPropertyPriority(property)
      });
      const original = properties.get(property);
      if (element.style.getPropertyValue(property) !== value || element.style.getPropertyPriority(property) !== "important") {
        element.style.setProperty(property, value, "important");
        invalidateMeasurements();
      }
      original.applied = element.style.getPropertyValue(property);
      original.appliedPriority = "important";
      mark(element, "data-lexend-layout-repair", category);
      // Shadow ::slotted typography rules read these variables. A measured
      // label fit must update the same source while retaining reversible edits.
      if (element.assignedSlot && element.hasAttribute("data-lexend-text")) {
        const variable = { "font-size": "--lexend-size", "line-height": "--lexend-line", "letter-spacing": "--lexend-spacing", "font-family": "--lexend-family" }[property];
        if (variable) write(element, variable, value, category);
      }
    };
    const writePanelConstraint = (element, property, value) => {
      const css = styleFor(element);
      const properties = css.transitionProperty.split(",").map((item) => item.trim());
      const durations = css.transitionDuration.split(",").map((item) => item.trim());
      const delays = css.transitionDelay.split(",").map((item) => item.trim());
      const timings = css.transitionTimingFunction.match(/(?:cubic-bezier|steps|linear)\([^)]*\)|[^,]+/g)?.map((item) => item.trim()) ?? ["ease"];
      const matching = properties.map((name, index) => ({ name, index })).filter(({ name }) => name === "all" || name === property).at(-1);
      if (matching && (parseFloat(durations[matching.index % durations.length]) > 0 || parseFloat(delays[matching.index % delays.length]) > 0)) {
        // Only the vertical constraint owned by this repair settles immediately.
        // An explicit entry overrides `all` for this property while preserving
        // authored opacity, transform and other simultaneous transitions.
        write(element, "transition-property", [...properties, property].join(", "), "bounded-panel");
        write(element, "transition-duration", [...properties.map((_, index) => durations[index % durations.length]), "0s"].join(", "), "bounded-panel");
        write(element, "transition-delay", [...properties.map((_, index) => delays[index % delays.length]), "0s"].join(", "), "bounded-panel");
        write(element, "transition-timing-function", [...properties.map((_, index) => timings[index % timings.length]), "linear"].join(", "), "bounded-panel");
      }
      write(element, property, value, "bounded-panel");
    };
    const mark = (element, name, value) => {
      let values = attributes.get(element);
      if (!values) attributes.set(element, values = new Map());
      if (!values.has(name)) values.set(name, { value: element.getAttribute(name) });
      const previous = element.getAttribute(name);
      const next = name === "data-lexend-layout-repair" ? [...new Set([...(previous?.split(" ") ?? []), value])].join(" ") : value;
      if (previous !== next) {
        element.setAttribute(name, next);
        invalidateMeasurements();
      }
      values.get(name).applied = next;
    };
    const restore = () => {
      invalidateMeasurements();
      for (const [element, offset] of maskedScrollOffsets) {
        const owned = edits.get(element)?.get("overflow-x");
        if (owned && element.style.getPropertyValue("overflow-x") === owned.applied) element.scrollLeft = offset;
      }
      maskedScrollOffsets.clear();
      for (const [element, properties] of edits) {
        const restoreProperty = (property, original) => {
          // The site may have changed its inline style since our last pass.
          if (element.style.getPropertyValue(property) !== original.applied || element.style.getPropertyPriority(property) !== original.appliedPriority) return;
          if (original.value) element.style.setProperty(property, original.value, original.priority);
          else element.style.removeProperty(property);
        };
        const transitions = [...properties].filter(([property]) => property.startsWith("transition-"));
        for (const [property, original] of properties) if (!property.startsWith("transition-")) restoreProperty(property, original);
        // The owned zero-duration constraints remain active until restored
        // geometry has resolved. Releasing `all` first would animate our old
        // repair back toward the author height and contaminate a recapture.
        if (transitions.length) void styleFor(element).height;
        for (const [property, original] of transitions) restoreProperty(property, original);
        if (!element.getAttribute("style") && !originalStylePresence.get(element)) element.removeAttribute("style");
      }
      for (const [element, values] of attributes) {
        for (const [name, original] of values) {
          if (element.getAttribute(name) !== original.applied) continue;
          if (original.value === null) element.removeAttribute(name);
          else element.setAttribute(name, original.value);
        }
      }
      edits.clear(); attributes.clear(); originalStylePresence.clear();
      for (const [table, wrapper] of tableWrappers) {
        if (table.parentNode === wrapper && wrapper.parentNode) wrapper.parentNode.insertBefore(table, wrapper);
        if (!wrapper.childNodes.length) wrapper.remove();
      }
      tableWrappers.clear();
    };
    const captureBaseline = (roots = [document.documentElement]) => {
      restore();
      baseline = new Map(); textElements = new Set(); descendants = new Map(); visualContainers = new WeakMap(); pseudoBaseline = new Map(); maskedTickers = new Map();
      return withStylesDisabled(() => {
        panelReservations = new Map();
        viewportScrollOwners = new Set();
        const sources = roots instanceof Set || Array.isArray(roots) ? roots : [roots];
        for (const root of sources) {
          if (!root) continue;
          const candidates = new Set(getTextElements(root));
          // Geometry-only actions can contain an icon and a hidden accessible
          // label. They still reserve space even with no painted direct text.
          root.querySelectorAll?.("button,[role='button'],input,select,textarea,a[href]").forEach((element) => candidates.add(element));
          for (const element of candidates) {
            if (!(element instanceof HTMLElement) || element.closest(PROTECTED)) continue;
            const state = snapshot(element);
            if (!state) continue;
            textElements.add(element); baseline.set(element, state);
            if (element.matches("button,[role='button']") && element.children.length <= 4) {
              for (const child of element.children) {
                const childState = snapshot(child);
                if (childState && !baseline.has(child)) baseline.set(child, childState);
              }
            }
            if (!descendants.has(element)) descendants.set(element, []);
            descendants.get(element).push(element);
            let parent = ancestor(element);
            // Include containing panels and siblings, even when they have no
            // direct text. Stop before document-wide reflow constraints.
            for (let depth = 0; parent && depth < 8 && parent !== document.documentElement && parent !== document.body; depth++, parent = ancestor(parent)) {
              if (!descendants.has(parent)) descendants.set(parent, []);
              descendants.get(parent).push(element);
              if (!baseline.has(parent)) {
                const parentState = snapshot(parent);
                if (parentState) baseline.set(parent, parentState);
                if (parent.children.length <= 16) for (const sibling of parent.children) {
                  if (!(sibling instanceof HTMLElement || sibling instanceof SVGElement) || baseline.has(sibling)) continue;
                  const siblingState = snapshot(sibling);
                  if (siblingState) baseline.set(sibling, siblingState);
                }
                // A picture wrapper can have no box while its absolutely
                // positioned image paints next to the heading. Capture those
                // shallow image layers without scanning whole page subtrees.
                if (parent.children.length <= 16) for (const visual of parent.querySelectorAll(":scope > picture > img")) {
                  if (!baseline.has(visual)) {
                    const visualState = snapshot(visual);
                    if (visualState) baseline.set(visual, visualState);
                  }
                }
              }
            }
          }
          // Media-only branches may have no text ancestors near the flex
          // column that owns their width. Retain their measured geometry too.
          for (const media of root.querySelectorAll?.("img,video,canvas") ?? []) {
            const state = snapshot(media);
            if (!state || state.box.width < 40 || state.box.height < 40) continue;
            if (!baseline.has(media)) baseline.set(media, state);
            let parent = ancestor(media);
            for (let depth = 0; parent && depth < 10 && parent !== document.body && parent !== document.documentElement; depth++, parent = ancestor(parent)) {
              if (baseline.has(parent)) continue;
              const parentState = snapshot(parent);
              if (parentState) baseline.set(parent, parentState);
            }
          }
        }
        // A native viewport shell distributes its remaining height to nested
        // scrollers. Turning that shell into auto height removes their scroll
        // range and makes their later captions unreachable behind root clips.
        for (const [element, state] of baseline) {
          if (Math.abs(state.box.top) > EPSILON || Math.abs(state.box.bottom - innerHeight) > EPSILON
              || state.box.width < innerWidth * 0.8 || ["auto", "scroll"].includes(state.overflowY)) continue;
          if ([...element.querySelectorAll("*")].some((child) => {
            const css = styleFor(child), box = child.getBoundingClientRect();
            return ["auto", "scroll"].includes(css.overflowY) && child.clientHeight > 0
              && child.scrollHeight > child.clientHeight + EPSILON && box.top >= state.box.top - EPSILON
              && box.bottom <= state.box.bottom + EPSILON;
          })) viewportScrollOwners.add(element);
        }
        // Fixed banners may have an empty flow sibling reserving exactly the
        // author height. Retain that measured relationship before typography
        // grows the banner; its placeholder has no text ancestor to collect.
        for (const [panel, state] of baseline) {
          if (state.position !== "fixed" || state.box.height < 70 || state.box.width < innerWidth * 0.8
              || Math.abs(state.box.top) > EPSILON) continue;
          const sibling = panel.nextElementSibling;
          if (!sibling || sibling.textContent.trim() || sibling.querySelector("img,picture,svg,video,canvas,iframe,input,button,select,textarea,a[href]")) continue;
          // A purely geometric spacer can intentionally have visibility:hidden
          // while still reserving flow space. Its empty contents stay hidden;
          // only the matching footprint participates in this relationship.
          const css = styleFor(sibling), old = { box: rect(sibling.getBoundingClientRect()), position: css.position };
          if (css.display === "none" || !["static", "relative"].includes(old.position) || Math.abs(old.box.top - state.box.top) > EPSILON
              || Math.abs(old.box.height - state.box.height) > EPSILON || old.box.width < state.box.width * 0.9) continue;
          panelReservations.set(panel, { sibling, before: old });
        }
        // A translated vertical label track deliberately paints one frame.
        // Typography can change the height of its preceding hidden frames;
        // retain that active frame instead of unfolding the animation mask.
        for (const [mask, state] of baseline) {
          if (!["hidden", "clip"].includes(state.overflowY) || mask.children.length !== 1
              || state.box.height < 8 || state.box.height > innerHeight * 0.5) continue;
          const track = mask.firstElementChild, css = styleFor(track);
          if (!css.display.includes("flex") || css.flexDirection !== "column" || track.children.length < 2 || track.children.length > 12
              || track.querySelector("input,button,select,textarea,a[href],img,video,canvas,[role='button']")) continue;
          const matrix = new DOMMatrixReadOnly(css.transform);
          if (!matrix.is2D || matrix.a !== 1 || matrix.b !== 0 || matrix.c !== 0 || matrix.d !== 1 || matrix.f >= -EPSILON) continue;
          const frames = [...track.children].map((element) => ({ element, box: element.getBoundingClientRect(), css: styleFor(element) }));
          if (frames.some((frame) => !["static", "relative"].includes(frame.css.position) || !frame.element.textContent.trim())) continue;
          const active = frames.reduce((best, frame) => intersection(frame.box, state.box) > intersection(best.box, state.box) ? frame : best);
          const visibleHeight = Math.min(active.box.bottom, state.box.bottom) - Math.max(active.box.top, state.box.top);
          if (visibleHeight < Math.min(active.box.height, state.box.height) * 0.7
              || !frames.some((frame) => frame.box.bottom <= state.box.top + EPSILON)) continue;
          maskedTickers.set(mask, { track, active: active.element, offset: active.box.top - state.box.top });
          for (const item of textElements) if (track.contains(item) && item !== active.element && !active.element.contains(item)) textElements.delete(item);
        }
        for (const [element, state] of baseline) {
          if (element instanceof HTMLElement && control(element)) {
            const pseudos = ["before", "after"].map((name) => [name, pseudoBox(element, name)]).filter(([, box]) => box);
            if (pseudos.length) pseudoBaseline.set(element, new Map(pseudos));
          }
          state.contentBounds = bounds(containedRects(element, true));
        }
      });
    };
    const pseudoBox = (element, name) => {
      const css = styleFor(element, `::${name}`);
      if (css.position !== "absolute" || css.transform !== "none" || !css.content
          || styleFor(element).position === "static"
          || /^(?:none|normal|counter\(|attr\(|url\()/i.test(css.content) || css.content.length < 4) return null;
      let width = parseFloat(css.width), left = parseFloat(css.left);
      if (!Number.isFinite(width) || !Number.isFinite(left) || width < 8 || width > innerWidth - 8) return null;
      if (css.boxSizing !== "border-box") width += (parseFloat(css.paddingLeft) || 0) + (parseFloat(css.paddingRight) || 0)
        + (parseFloat(css.borderLeftWidth) || 0) + (parseFloat(css.borderRightWidth) || 0);
      const translate = (css.translate === "none" ? "0px" : css.translate).split(/\s+/)[0];
      if (!/^-?[\d.]+(?:px|%)?$/.test(translate)) return null;
      const offset = parseFloat(translate) * (translate.endsWith("%") ? width / 100 : 1);
      const marginLeft = parseFloat(css.marginLeft) || 0;
      left += element.getBoundingClientRect().left + (parseFloat(styleFor(element).borderLeftWidth) || 0) + marginLeft + offset;
      return { left, right: left + width, width, marginLeft };
    };
    const repairPseudoTooltips = () => {
      for (const [element, pseudos] of pseudoBaseline) for (const [name, before] of pseudos) {
        const now = pseudoBox(element, name);
        if (!now || now.width <= before.width + EPSILON || (now.right <= innerWidth - 2 && now.left >= 2) || now.width > innerWidth - 8) continue;
        const shift = now.left < 4 ? 4 - now.left : Math.min(0, innerWidth - 4 - now.right);
        write(element, `--lexend-layout-${name}-margin-left`, `${(now.marginLeft + shift).toFixed(3)}px`, "fit-tooltip");
        mark(element, `data-lexend-fit-pseudo-${name}`, "");
      }
    };
    const measureWord = (element, state, text) => {
      canvas ??= document.createElement("canvas");
      const context = canvas.getContext("2d");
      if (!context) return 0;
      const css = styleFor(element);
      context.font = `${css.fontStyle} ${css.fontWeight} ${state.fontSize}px ${css.fontFamily}`;
      const rendered = css.textTransform === "uppercase" ? text.toLocaleUpperCase() : css.textTransform === "lowercase" ? text.toLocaleLowerCase() : text;
      return context.measureText(rendered).width + Math.max(0, [...rendered].length - 1) * state.letterSpacing;
    };
    const fitHeading = (element, before, now) => {
      const semanticHeading = heading(element) ? element : element.closest("h1,h2,h3,h4,h5,h6,[role=heading]");
      // A card heading can itself be a link. Its full-word fit needs the
      // heading geometry path, not the short action-label path.
      const actionLabel = !semanticHeading && now.fontSize < 32 && element.closest("a[href],button,[role=button]");
      if (!semanticHeading && !actionLabel && now.fontSize < 32) return;
      // BR and nested emphasis create word boundaries even when textContent
      // concatenates them. Measure this element's actual direct text runs.
      const words = [...element.childNodes].filter((node) => node.nodeType === Node.TEXT_NODE)
        .flatMap((node) => node.textContent.trim().split(/\s+/)).filter(Boolean);
      if (!words.length || words.length > 18) return;
      if (actionLabel && element.textContent.length > 40 && /[`/\\]/.test(element.textContent)) return;
      // A ticker track is intrinsically sized to its label. Fit against its
      // actual painted viewport, rather than repeatedly shrinking a label to
      // make room inside its own newly measured intrinsic width.
      const ticker = [...maskedTickers].find(([, { active }]) => active === element || active.contains(element));
      let container = semanticHeading ?? ticker?.[0] ?? element;
      let containerState = snapshot(container);
      // A semantic heading can be display:contents while its text span paints
      // normally. Its zero box must not abort repairs for the rest of the page.
      if (!containerState) { container = element; containerState = now; }
      const parent = ancestor(container);
      const parentState = parent ? snapshot(parent) : null;
      let available = Math.min(
        containerState.box.width - containerState.paddingLeft - containerState.paddingRight,
        parentState ? parentState.box.width - parentState.paddingLeft - parentState.paddingRight : innerWidth,
        innerWidth - Math.max(0, containerState.box.left)
      );
      let longest = 0;
      let brokenWord = false;
      // Canvas cannot reproduce author variable-font axes or every font feature.
      // Sum a word's actual range fragments if it was split across lines.
      for (const node of element.childNodes) {
        if (node.nodeType !== Node.TEXT_NODE) continue;
        for (const match of node.textContent.matchAll(actionLabel ? /\p{Script=Latin}{2,}/gu : /\S+/g)) {
          const range = document.createRange();
          range.setStart(node, match.index); range.setEnd(node, match.index + match[0].length);
          const fragments = [...range.getClientRects()].filter((box) => box.width > 0 && box.height > 0);
          brokenWord ||= fragments.length > 1;
          const width = fragments.reduce((sum, box) => sum + box.width, 0);
          longest = Math.max(longest, width || measureWord(element, now, match[0]));
        }
      }
      if (actionLabel) {
        // Long technical paths can legitimately wrap at punctuation. Only a
        // short natural-language label is safe to keep as whole words here.
        if (brokenWord && longest <= available - 4) {
          write(element, "word-break", "normal", "whole-action-word");
          write(element, "overflow-wrap", "normal", "whole-action-word");
          write(element, "hyphens", "none", "whole-action-word");
        } else if (brokenWord && words.length <= 4 && !/[`/\\]/.test(element.textContent)) {
          let rightLimit = innerWidth - 4, branch = element;
          for (let depth = 0; branch && depth < 4; depth++) {
            const parent = ancestor(branch);
            if (!parent) break;
            const parentCss = styleFor(parent), parentBox = parent.getBoundingClientRect();
            if (["hidden", "clip"].includes(parentCss.overflowX)) rightLimit = Math.min(rightLimit, parentBox.right - 2);
            for (const sibling of parent.children) {
              if (sibling === branch) continue;
              const box = sibling.getBoundingClientRect();
              if (box.left >= now.box.right - 1 && box.top < now.box.bottom - 2 && box.bottom > now.box.top + 2) {
                const siblingText = bounds(containedRects(sibling));
                const padding = parseFloat(styleFor(sibling).paddingLeft) || 0;
                const occupiedLeft = siblingText?.left > box.left ? siblingText.left : box.left + padding;
                rightLimit = Math.min(rightLimit, occupiedLeft - 4);
              }
            }
            branch = parent;
          }
          const required = Math.ceil(longest + 2);
          if (required > now.box.width + 1 && required <= rightLimit - now.box.left) {
            if (now.display === "inline") write(element, "display", "inline-block", "whole-action-word");
            write(element, "min-width", `${required}px`, "whole-action-word");
            write(element, "width", `${required}px`, "whole-action-word");
            write(element, "word-break", "normal", "whole-action-word");
            write(element, "overflow-wrap", "normal", "whole-action-word");
            write(element, "hyphens", "none", "whole-action-word");
          } else {
            const size = now.fontSize * Math.max(0, available - 2) / longest;
            if (size >= before.fontSize - 0.05 && size < now.fontSize - 0.05) {
              write(element, "font-size", `${size.toFixed(3)}px`, "fit-tight-label");
              mark(element, "data-lexend-layout-baseline-font-size", String(before.fontSize));
              write(element, "word-break", "normal", "whole-action-word");
              write(element, "overflow-wrap", "normal", "whole-action-word");
              write(element, "hyphens", "none", "whole-action-word");
            }
          }
        }
        return;
      }
      if (longest > available - Math.max(4, now.letterSpacing * 2) || brokenWord) {
        const containerCss = styleFor(container);
        const safeParentWidth = parentState ? Math.max(0, Math.min(
          parentState.box.width - parentState.paddingLeft - parentState.paddingRight,
          parentState.box.right - parentState.paddingRight - containerState.box.left - (parseFloat(containerCss.marginRight) || 0),
          innerWidth - Math.max(0, containerState.box.left))) : available;
        if (safeParentWidth > available + EPSILON && containerState.box.width < safeParentWidth - EPSILON) {
          const inlineGroup = containerState.display.startsWith("inline") && parent && [...parent.children].some((sibling) => sibling !== container && styleFor(sibling).display.startsWith("inline"));
          const siblingsWidth = inlineGroup ? [...parent.children].filter((sibling) => {
            const css = styleFor(sibling);
            return sibling !== container && css.display.startsWith("inline") && !["absolute", "fixed"].includes(css.position)
              && sibling.getBoundingClientRect().left >= containerState.box.right - EPSILON;
          }).reduce((sum, sibling) => {
            const css = styleFor(sibling);
            return sum + sibling.getBoundingClientRect().width + (parseFloat(css.marginLeft) || 0) + (parseFloat(css.marginRight) || 0);
          }, 0) : 0;
          const targetWidth = Math.max(available, Math.min(safeParentWidth - siblingsWidth, longest + containerState.paddingLeft + containerState.paddingRight + 4));
          write(container, "box-sizing", "border-box", "fit-heading");
          write(container, "width", `${Math.floor(inlineGroup ? targetWidth : safeParentWidth)}px`, "fit-heading");
          write(container, "max-width", `${Math.floor(safeParentWidth)}px`, "fit-heading");
          available = (inlineGroup ? targetWidth : safeParentWidth) - containerState.paddingLeft - containerState.paddingRight;
        }
        // A narrow card can put its heading in a full-width link and still
        // reserve unused padding outside that link. Borrow only enough of a
        // nearby painted card's space to keep a newly split word whole. The
        // bound accounts for clipping ancestors and neighboring row content.
        if (semanticHeading && brokenWord && longest > available - 2) {
          let rightLimit = innerWidth - 2, paintedRight = null, branch = container;
          for (let depth = 0; branch && depth < 8; depth++) {
            const outer = ancestor(branch);
            if (!outer || outer.matches("body,html")) break;
            const css = styleFor(outer), box = outer.getBoundingClientRect();
            if (["hidden", "clip"].includes(css.overflowX)) rightLimit = Math.min(rightLimit, box.right - 1);
            for (const sibling of outer.children) {
              if (sibling === branch) continue;
              const beside = sibling.getBoundingClientRect();
              if (beside.left >= containerState.box.right - 1 && beside.top < containerState.box.bottom - 2
                  && beside.bottom > containerState.box.top + 2) rightLimit = Math.min(rightLimit, beside.left - 2);
            }
            const painted = css.backgroundImage !== "none" || !["transparent", "rgba(0, 0, 0, 0)"].includes(css.backgroundColor)
              || [css.borderLeftWidth, css.borderRightWidth].some((width) => parseFloat(width) > 0);
            if (painted && box.width > containerState.box.width + 8) { paintedRight = box.right - 1; break; }
            branch = outer;
          }
          const required = Math.ceil(longest + 2);
          if (paintedRight !== null && required > containerState.box.width + 1
              && containerState.box.left + required <= Math.min(rightLimit, paintedRight) + EPSILON) {
            write(container, "box-sizing", "border-box", "fit-heading");
            write(container, "width", `${required}px`, "fit-heading");
            write(container, "max-width", `${required}px`, "fit-heading");
            write(element, "word-break", "normal", "fit-heading");
            write(element, "overflow-wrap", "normal", "fit-heading");
            write(element, "hyphens", "none", "fit-heading");
            return;
          }
        }
        if (longest <= available - Math.max(4, now.letterSpacing * 2) && !brokenWord) return;
        const floor = Math.min(24, before.fontSize);
        const size = Math.min(now.fontSize, Math.max(floor, now.fontSize * Math.max(0, available - Math.max(4, now.letterSpacing * 2)) / longest));
        if (size < before.fontSize - 0.1) mark(element, "data-lexend-layout-repair", "fit-heading-below-baseline");
        write(element, "font-size", `${size.toFixed(3)}px`, "fit-heading");
        mark(element, "data-lexend-layout-baseline-font-size", String(before.fontSize));
        write(element, "word-break", "normal", "fit-heading");
        write(element, "overflow-wrap", "normal", "fit-heading");
      }
    };
    const fitTightLabel = (element, before, now) => {
      if (element.childElementCount || now.texts.length !== 1 || before.texts.length !== 1
          || now.fontSize <= before.fontSize + 0.1 || !now.text || !before.text) return;
      let clip = ancestor(element);
      for (let depth = 0; clip && depth < 4; depth++, clip = ancestor(clip)) {
        const css = styleFor(clip);
        if (!["hidden", "clip"].includes(css.overflowX)) continue;
        const old = baseline.get(clip), box = clip.getBoundingClientRect();
        if (!old || !old.box.width || box.width < 16
            || before.text.left < old.box.left - 1 || before.text.right > old.box.right + 1) return;
        const over = Math.max(0, box.left - now.text.left, now.text.right - box.right);
        const inkWidth = now.text.right - now.text.left;
        if (over <= 1 || over > 16 || inkWidth <= box.width + 1) return;
        // A fractional glyph crop in a fixed one-line label can be resolved
        // with a tiny size adjustment while retaining growth over its author
        // baseline. This leaves the surrounding card and artwork untouched.
        let size = Math.max(before.fontSize, now.fontSize * (box.width - 0.75) / inkWidth);
        if (size >= now.fontSize - 0.05) return;
        for (let attempt = 0; attempt < 4; attempt++) {
          write(element, "font-size", `${size.toFixed(3)}px`, "fit-tight-label");
          const fitted = snapshot(element);
          if (!fitted?.text) break;
          const crop = Math.max(0, box.left - fitted.text.left, fitted.text.right - box.right);
          if (crop <= 0.75 || size <= before.fontSize + 0.01) break;
          size = Math.max(before.fontSize, size - Math.max(0.2, crop * size / (fitted.text.right - fitted.text.left)));
        }
        mark(element, "data-lexend-layout-baseline-font-size", String(before.fontSize));
        return;
      }
    };
    const repairText = (element, before) => {
      let now = snapshot(element);
      if (!now) return;
      if (now.fontSize > before.fontSize + 0.1 && before.hangulTokens.length && now.hangulTokens.length === before.hangulTokens.length) {
        const parent = ancestor(element), parentState = parent && snapshot(parent);
        const available = Math.min(now.box.width - now.paddingLeft - now.paddingRight,
          parentState ? parentState.box.width - parentState.paddingLeft - parentState.paddingRight : innerWidth,
          innerWidth - Math.max(0, now.box.left));
        const newlySplit = now.hangulTokens.some((token, index) => /\p{Script=Hangul}/u.test(token.word)
          && token.word === before.hangulTokens[index].word && before.hangulTokens[index].lines === 1 && token.lines > 1);
        // Keep only measured, formerly whole whitespace-delimited tokens.
        // A token wider than its column retains the author's wrapping policy.
        if (newlySplit && now.hangulTokens.every((token) => token.width <= available - 1)) {
          write(element, "word-break", "keep-all", "whole-script-word");
          write(element, "overflow-wrap", "normal", "whole-script-word");
          now = snapshot(element);
        }
      }
      fitHeading(element, before, now);
      now = snapshot(element);
      fitTightLabel(element, before, now);
      now = snapshot(element);
      if (control(element) && now.text && before.text) {
        const oldCenter = (before.text.top + before.text.bottom - before.box.top - before.box.bottom) / 2;
        const newCenter = (now.text.top + now.text.bottom - now.box.top - now.box.bottom) / 2;
        if (Math.abs(oldCenter) < 3 && Math.abs(newCenter) > 3 && now.box.height > now.fontSize * 1.8 && !["absolute", "fixed"].includes(now.position)) {
          write(element, "display", now.display.startsWith("inline") ? "inline-flex" : "flex", "center-control");
          write(element, "align-items", "center", "center-control");
        }
      }
      const wide = Math.max(0, now.scrollWidth - now.clientWidth);
      const oldWide = Math.max(0, before.scrollWidth - before.clientWidth);
      const tall = Math.max(0, now.scrollHeight - now.clientHeight);
      const oldTall = Math.max(0, before.scrollHeight - before.clientHeight);
      const grown = now.fontSize > before.fontSize + 0.1 || now.box.height > before.box.height + EPSILON || tall > oldTall + EPSILON || wide > oldWide + EPSILON;
      if (!grown) return;
      if (now.display === "inline-block" && !["absolute", "fixed"].includes(now.position)
          && before.box.right <= innerWidth + EPSILON && now.box.right > innerWidth + EPSILON
          && now.box.left >= 0 && now.fontSize > before.fontSize + 0.1) {
        const parent = ancestor(element), css = parent ? styleFor(parent) : null;
        const available = Math.max(0, Math.min(innerWidth - now.box.left,
          parent ? parent.getBoundingClientRect().right - (parseFloat(css.paddingRight) || 0) - now.box.left : innerWidth));
        if (available > 32) {
          write(element, "box-sizing", "border-box", "viewport-fit");
          write(element, "max-width", `${Math.floor(available)}px`, "viewport-fit");
          if (now.whiteSpace === "nowrap") write(element, "white-space", "normal", "viewport-fit");
        }
      }
      // Do not dissolve horizontal scrollers (navigation, carousel tracks).
      const scrolling = ["auto", "scroll"].includes(now.overflowX) && !control(element);
      if (wide > oldWide + EPSILON && !scrolling && !element.matches("input,select,textarea")) {
        if (now.whiteSpace === "nowrap" || now.textOverflow === "ellipsis") {
          write(element, "white-space", "normal", "wrap");
          write(element, "text-overflow", "clip", "wrap");
        }
        if (!heading(element)) write(element, "overflow-wrap", "anywhere", "wrap");
        write(element, "min-width", "0", "wrap");
      }
      const clamped = Number.parseInt(now.lineClamp, 10) > 0;
      if (clamped && (tall > oldTall + EPSILON || now.fontSize > before.fontSize + 0.1)) {
        write(element, "-webkit-line-clamp", "unset", "expand");
        write(element, "max-height", "none", "expand");
        if (now.display === "-webkit-box") write(element, "display", "block", "expand");
      }
      if ((tall > oldTall + EPSILON || clamped) && !element.matches("input,select,textarea") && !["auto", "scroll"].includes(now.overflowY)) {
        expandContainer(element, now, Math.max(0, tall - oldTall), "expand");
        // Retain clipping for image masks; text boxes can safely expose their
        // newly expanded content while the ancestors are repaired below.
        if (["hidden", "clip"].includes(now.overflowY) && !hasVisualBackground(element)) write(element, "overflow", "visible", "expand");
      }
      const expandedConstraint = now.box.height > before.box.height + EPSILON && ["hidden", "clip"].includes(before.overflowY);
      if ((clamped || tall > oldTall + EPSILON || expandedConstraint) && !hasVisualBackground(element)) {
        for (const pseudo of ["before", "after"]) {
          const css = styleFor(element, `::${pseudo}`);
          const empty = ['""', "''"].includes(css.content);
          const fading = `${css.backgroundImage} ${css.maskImage ?? css.webkitMaskImage ?? "none"}`;
          if (empty && css.position === "absolute" && /(?:linear|radial)-gradient\(/.test(fading)
              && !/url\(/.test(fading) && Number.parseFloat(css.height) > now.fontSize * 0.6) {
            mark(element, `data-lexend-hide-fade-${pseudo}`, "");
            mark(element, "data-lexend-layout-repair", "remove-text-fade");
          }
        }
      }
      if (element.matches("input,select")) {
        const parent = ancestor(element);
        const parentCss = parent ? styleFor(parent) : null;
        const available = Math.max(0, Math.min(parent ? parent.clientWidth - (parseFloat(parentCss.paddingLeft) || 0) - (parseFloat(parentCss.paddingRight) || 0) : innerWidth,
          innerWidth - Math.max(0, now.box.left) - 2));
        // Native fields do not expose placeholder or selected-option clipping
        // through scrollWidth. Measure the rendered label instead.
        const label = element.tagName === "SELECT" ? element.selectedOptions?.[0]?.textContent : element.placeholder;
        const labelWidth = label ? measureWord(element, now, label) : 0;
        const required = labelWidth + now.paddingLeft + now.paddingRight + now.borderLeft + now.borderRight + (element.tagName === "SELECT" ? 24 : 4);
        const labelClips = required > now.box.width + EPSILON && now.fontSize > before.fontSize + 0.1;
        const escapes = now.box.right > innerWidth + EPSILON && before.box.right <= innerWidth + EPSILON;
        if (wide <= oldWide + EPSILON && !labelClips && !escapes) return;
        const desired = Math.min(available, Math.max(now.box.width, required, now.scrollWidth + now.paddingLeft + now.paddingRight + 4));
        write(element, "box-sizing", "border-box", "wrap");
        write(element, "max-width", `${available}px`, "wrap");
        if (desired > now.box.width + EPSILON) write(element, "width", `${desired}px`, "wrap");
        if (labelClips && desired >= required - EPSILON && parentCss && /^(?:inline-)?flex$/.test(parentCss.display)) {
          write(element, "min-width", `${desired}px`, "wrap");
          write(parent, "flex-wrap", "wrap", "wrap");
        }
      }
    };
    const containedText = (container) => descendants.get(container) ?? [];
    const heightForBox = (element, outerHeight) => {
      const css = styleFor(element);
      const inset = css.boxSizing === "border-box" ? 0 : [css.paddingTop, css.paddingBottom, css.borderTopWidth, css.borderBottomWidth]
        .reduce((sum, value) => sum + (parseFloat(value) || 0), 0);
      return Math.ceil(Math.max(0, outerHeight - inset));
    };
    const measureContainedRects = (container, original) => containedText(container).flatMap((item) => {
      for (const { track, active } of maskedTickers.values()) {
        if (track.contains(item) && item !== active && !active.contains(item)) return [];
      }
      // Fixed overlays own their viewport geometry. Their text cannot enlarge
      // a zero-height portal, page shell, or scrolling card that happens to
      // contain the overlay in the DOM. Keep measuring the overlay itself.
      for (let branch = item; branch && branch !== container; branch = ancestor(branch)) {
        const old = baseline.get(branch), owner = baseline.get(container);
        const position = original ? old?.position : styleFor(branch).position;
        if (position === "fixed") return [];
        // An authored popup may intentionally protrude from its anchor/header.
        // It owns its enlarged text; a visible-overflow anchor has no flow
        // obligation to grow around that already out-of-flow popup.
        if (old?.position === "absolute" && owner?.overflowY === "visible"
            && (old.box.top < owner.box.top - EPSILON || old.box.bottom > owner.box.bottom + EPSILON)) return [];
      }
      let boxes = (original ? baseline.get(item)?.texts ?? [] : directTextRects(item)).map((box) => ({ ...box }));
      // A nested scroller owns its offscreen text. Its ancestors must measure
      // only the visible scroll viewport, otherwise a dialog can expand to the
      // full height of every intentionally scrollable disclosure.
      let parent = ancestor(item);
      for (let depth = 0; parent && parent !== container && depth < 10; depth++, parent = ancestor(parent)) {
        const state = original ? baseline.get(parent) : null;
        const css = original ? state : styleFor(parent);
        if (!css) continue;
        const scrollX = ["auto", "scroll"].includes(css.overflowX), scrollY = ["auto", "scroll"].includes(css.overflowY);
        if (!scrollX && !scrollY) continue;
        const box = original ? state.box : parent.getBoundingClientRect();
        boxes = boxes.map((text) => ({ ...text,
          left: scrollX ? Math.max(text.left, box.left) : text.left,
          right: scrollX ? Math.min(text.right, box.right) : text.right,
          top: scrollY ? Math.max(text.top, box.top) : text.top,
          bottom: scrollY ? Math.min(text.bottom, box.bottom) : text.bottom
        })).filter((text) => text.right > text.left && text.bottom > text.top);
      }
      return boxes;
    });
    const containedRects = (container, original = false) => {
      if (original || !measurements) return measureContainedRects(container, original);
      if (!measurements.containedRects.has(container)) measurements.containedRects.set(container, measureContainedRects(container, false));
      return measurements.containedRects.get(container);
    };
    const overflowing = (container, state) => {
      const boxes = containedRects(container);
      const text = bounds(boxes);
      return text ? Math.max(0, text.bottom - (state.box.bottom - state.paddingBottom - state.borderBottom))
        + Math.max(0, state.box.top + state.paddingTop + state.borderTop - text.top) : 0;
    };
    const hasVisualBackground = (element) => {
      if (visualContainers.has(element)) return visualContainers.get(element);
      const visual = (item) => item.matches("img,picture,video,svg,canvas") || styleFor(item).backgroundImage !== "none";
      let result = visual(element);
      if (!result) {
        const walker = document.createTreeWalker(element, NodeFilter.SHOW_ELEMENT);
        let item, count = 0;
        // Local card/panel imagery is found without repeatedly scanning an
        // entire document for every ancestor constraint.
        while ((item = walker.nextNode()) && count++ < 256) {
          if (visual(item)) { result = true; break; }
        }
      }
      visualContainers.set(element, result);
      return result;
    };
    const needsDefiniteHeight = (element, now) => {
      if (/url\(/.test(styleFor(element).backgroundImage)) return true;
      const walker = document.createTreeWalker(element, NodeFilter.SHOW_ELEMENT);
      let child, count = 0;
      while ((child = walker.nextNode()) && count++ < 256) {
        const css = styleFor(child);
        if (/url\(/.test(css.backgroundImage)) return true;
        if (!child.matches("img,picture,video,canvas,svg")) continue;
        const box = baseline.get(child)?.box ?? child.getBoundingClientRect();
        // Small quote glyphs and flow avatars do not need a definite height.
        // Treating them as photograph layers pins their growing prose parent.
        if (box.width * box.height >= now.box.width * now.box.height * 0.15
            && (box.width >= now.box.width * 0.5 || box.height >= now.box.height * 0.5)) return true;
      }
      return false;
    };
    const expandContainer = (element, now, additional, category) => {
      const css = styleFor(element);
      const definite = Number.parseFloat(css.height);
      // Percentage-height image layers need a definite containing-block height.
      // 'auto' can erase photographs or collapse background layers to zero.
      if (needsDefiniteHeight(element, now) && Number.isFinite(definite)) {
        write(element, "height", `${Math.ceil(definite + Math.max(0, additional))}px`, category);
      } else {
        write(element, "height", "auto", category);
      }
      write(element, "max-height", "none", category);
    };
    const repairExpandedFades = () => {
      for (const [element, before] of baseline) {
        if (!element.getAttribute("data-lexend-layout-repair")?.split(" ").includes("expand")) continue;
        const now = snapshot(element);
        if (!now || !["hidden", "clip"].includes(before.overflowY)
            || now.box.height <= before.box.height + EPSILON || needsDefiniteHeight(element, now)
            || element.children.length > 8) continue;
        for (const child of element.children) {
          const css = styleFor(child), box = child.getBoundingClientRect();
          const fading = `${css.backgroundImage} ${css.maskImage ?? "none"}`;
          if (css.position !== "absolute" || css.pointerEvents !== "none" || child.textContent.trim()
              || child.querySelector("img,svg,video,canvas,input,button,a,[tabindex]")
              || !/(?:linear|radial)-gradient\(/.test(fading) || /url\(/.test(fading)
              || box.width < now.box.width * 0.6 || box.height < now.fontSize * 0.6
              || box.height > now.box.height * 0.5) continue;
          write(child, "display", "none", "remove-text-fade");
          // A flex excerpt can shrink again after its parent's height changes.
          // Once its truncation mask is removed, reserve the whole text height.
          const flowBottom = Math.max(now.box.top, ...[...element.children]
            .filter((item) => !["absolute", "fixed"].includes(styleFor(item).position))
            .map((item) => item.getBoundingClientRect().bottom));
          write(element, "min-height", `${heightForBox(element, Math.max(before.box.height, flowBottom - now.box.top + now.paddingBottom + now.borderBottom))}px`, "expand");
        }
      }
    };
    const repairContainers = () => {
      // Inner containers first. Their growth then informs outer constraints.
      const containers = [...baseline.keys()].filter((element) => !element.closest(PROTECTED)).reverse();
      for (const element of containers) {
        const before = baseline.get(element);
        const now = snapshot(element);
        if (!now || maskedTickers.has(element) || viewportScrollOwners.has(element)
            || element.matches("input,select,textarea") || ["auto", "scroll"].includes(now.overflowY)) continue;
        const text = bounds(containedRects(element));
        const wide = text ? Math.max(0, text.right - (now.box.right - now.paddingRight - now.borderRight))
          + Math.max(0, now.box.left + now.paddingLeft + now.borderLeft - text.left) : 0;
        const oldWide = before.contentBounds ? Math.max(0, before.contentBounds.right - (before.box.right - before.paddingRight - before.borderRight))
          + Math.max(0, before.box.left + before.paddingLeft + before.borderLeft - before.contentBounds.left) : 0;
        if (wide > oldWide + EPSILON && control(element) && !element.matches("input,select,textarea")) {
          write(element, "white-space", "normal", "wrap");
          expandContainer(element, now, 0, "wrap");
          write(element, "min-width", "0", "wrap");
          for (const child of containedText(element)) {
            if (child === element || heading(child)) continue;
            write(child, "min-width", "0", "wrap");
            write(child, "white-space", "normal", "wrap");
            write(child, "overflow-wrap", "anywhere", "wrap");
          }
        }
        const overflow = overflowing(element, snapshot(element));
        const baselineTextOverflow = before.contentBounds ? Math.max(0, before.contentBounds.bottom - (before.box.bottom - before.paddingBottom - before.borderBottom))
          + Math.max(0, before.box.top + before.paddingTop + before.borderTop - before.contentBounds.top) : 0;
        const baselineOverflow = Math.max(0, before.scrollHeight - before.clientHeight);
        const scrollOverflow = Math.max(0, now.scrollHeight - now.clientHeight);
        // Image-backed flex cards often align a caption to the bottom. Enlarged
        // captions can extend upward while their glyphs still fit the outer
        // box. Preserve the original space around that complete flow branch.
        let flowGrowth = 0;
        if (element.children.length <= 16 && hasVisualBackground(element) && before.box.height < innerHeight * 1.2) {
          for (const child of element.children) {
            const old = baseline.get(child), current = snapshot(child);
            if (!old || !current || ["absolute", "fixed"].includes(current.position) || !containedText(child).length) continue;
            if (old.box.top < before.box.top - EPSILON || old.box.bottom > before.box.bottom + EPSILON) continue;
            flowGrowth = Math.max(flowGrowth, before.box.height + current.box.height - old.box.height - now.box.height);
          }
        }
        if (overflow <= baselineTextOverflow + EPSILON && flowGrowth <= EPSILON) continue;
        // Some engines honor inherited card clamps even with flow-root/block
        // display. Containers without direct text still need their clamp freed.
        if (Number.parseInt(now.lineClamp, 10) > 0) {
          write(element, "-webkit-line-clamp", "unset", "expand");
          if (now.display === "-webkit-box") write(element, "display", "block", "expand");
        }
        if (now.position === "fixed" || element.matches("dialog,[role='dialog'],[aria-modal='true']")) continue;
        // Ignore transformed art/canvas and large pre-existing scrolling tracks.
        if (now.transform !== "none" && !new DOMMatrixReadOnly(now.transform).isIdentity && !textElements.has(element)) continue;
        const hasAbsolute = [...element.children].some((child) => ["absolute", "fixed"].includes(styleFor(child).position));
        const css = styleFor(element);
        if (css.height !== "auto") {
          const growth = Math.max(0, overflow - baselineTextOverflow, flowGrowth);
          expandContainer(element, now, growth, "expand");
          if (hasAbsolute) write(element, "min-height", `${heightForBox(element, now.box.height + growth)}px`, "expand");
          const remaining = snapshot(element);
          if (remaining && before.box.height > 0 && ["hidden", "clip"].includes(before.overflowY)
              && overflowing(element, remaining) > baselineTextOverflow + EPSILON) {
            write(element, "min-height", `${heightForBox(element, remaining.box.height + overflowing(element, remaining) - baselineTextOverflow)}px`, "expand");
          }
        }
      }
    };
    const branchBounds = (element) => {
      const texts = ["auto", "scroll"].includes(styleFor(element).overflowY)
        ? [] : containedRects(element);
      return bounds(texts) ?? rect(element.getBoundingClientRect());
    };
    const repairSiblings = () => {
      for (const [parent, before] of baseline) {
        if (parent.children.length < 2 || parent.children.length > 16) continue;
        const children = [...parent.children].filter((child) => baseline.has(child)
          && baseline.get(child).position !== "fixed" && visible(child, styleFor(child))
          // Full-cover empty artwork is an overlay, not a flow column. Its
          // intentional overlap cannot wrap a viewport's sidebar/content row.
          && !(baseline.get(child).position === "absolute" && !containedText(child).length
            && baseline.get(child).box.width >= before.box.width * 0.8
            && baseline.get(child).box.height >= before.box.height * 0.65));
        if (children.length < 2) continue;
        let collision = false;
        for (let i = 0; i < children.length && !collision; i++) {
          for (let j = i + 1; j < children.length; j++) {
            const a = children[i], b = children[j];
            const previous = intersection(baseline.get(a).contentBounds ?? baseline.get(a).box, baseline.get(b).contentBounds ?? baseline.get(b).box);
            const current = intersection(branchBounds(a), branchBounds(b));
            if (current > previous + 8) { collision = true; break; }
          }
        }
        if (!collision) continue;
        const now = snapshot(parent);
        if (!now) continue;
        if (now.display.includes("flex") && now.flexDirection.startsWith("row")) {
          if (!["auto", "scroll"].includes(now.overflowX)) write(parent, "flex-wrap", "wrap", "reflow");
          for (const child of children) write(child, "min-width", "0", "reflow");
          // Percentage-sized media can have a zero intrinsic flex basis. Do
          // not erase their measured footprint when relaxing text min-widths.
          for (const child of children) {
            const old = baseline.get(child), box = child.getBoundingClientRect();
            const threshold = old.box.width >= before.box.width * 0.85 ? 0.85 : 0.5;
            if (old.box.width < 40 || box.width >= old.box.width * threshold || !hasVisualBackground(child)) continue;
            const width = Math.min(old.box.width, parent.clientWidth);
            write(child, "flex-basis", `${Math.ceil(width)}px`, "media-footprint");
            write(child, "min-width", `min(100%, ${Math.ceil(width)}px)`, "media-footprint");
            write(child, "max-width", "100%", "media-footprint");
          }
        } else if (now.display.includes("grid")) {
          // Shared grid cells intentionally layer an action over a navigation
          // track. Its scrolling repair must keep that painted composition.
          if (children.some((a, index) => children.slice(index + 1).some((b) => intersection(baseline.get(a).box, baseline.get(b).box) > 8))) continue;
          const widths = children.map((child) => baseline.get(child).box.width);
          const minimum = Math.max(120, Math.min(...widths));
          write(parent, "grid-template-columns", `repeat(auto-fit, minmax(min(100%, ${Math.ceil(minimum)}px), 1fr))`, "reflow");
          write(parent, "grid-auto-rows", "auto", "reflow");
          for (const child of children) {
            write(child, "min-width", "0", "reflow"); write(child, "height", "auto", "reflow");
            write(child, "grid-column", baseline.get(child).box.width >= before.box.width * 0.85 ? "1 / -1" : "auto", "reflow");
            write(child, "grid-row", "auto", "reflow");
          }
        } else if (children.every((child) => baseline.get(child).position === "absolute") && children.every((child) => containedText(child).length)) {
          // Preserve columns around artwork. Increase only vertical gaps in
          // the existing visual columns instead of replacing the composition.
          const groups = [];
          for (const child of children.sort((a, b) => baseline.get(a).box.left - baseline.get(b).box.left)) {
            const oldBox = baseline.get(child).box;
            let group = groups.find((items) => Math.abs(baseline.get(items[0]).box.left - oldBox.left) < Math.min(oldBox.width, baseline.get(items[0]).box.width) * 0.65);
            if (!group) groups.push(group = []);
            group.push(child);
          }
          for (const group of groups) {
            group.sort((a, b) => baseline.get(a).box.top - baseline.get(b).box.top);
            for (let index = 1; index < group.length; index++) {
              const previous = group[index - 1], child = group[index];
              const oldPrevious = baseline.get(previous).contentBounds ?? baseline.get(previous).box;
              const oldChild = baseline.get(child).contentBounds ?? baseline.get(child).box;
              const gap = Math.max(2, oldChild.top - oldPrevious.bottom);
              const delta = Math.max(
                branchBounds(previous).bottom + gap - branchBounds(child).top,
                previous.getBoundingClientRect().bottom + gap - child.getBoundingClientRect().top
              );
              if (delta > EPSILON) {
                const top = parseFloat(styleFor(child).top) || child.offsetTop;
                write(child, "top", `${Math.ceil(top + delta)}px`, "reflow");
              }
            }
          }
          const bottom = Math.max(...children.map((child) => branchBounds(child).bottom));
          if (bottom > now.box.bottom) write(parent, "min-height", `${heightForBox(parent, now.box.height + bottom - now.box.bottom + 4)}px`, "reflow");
        } else {
          // A viewport-positioned search/form can stay at its old y coordinate
          // while a preceding brand heading grows. Move only the newly
          // colliding control block, preserving the original horizontal layout.
          for (const child of children) {
            const old = baseline.get(child);
            if (old.position !== "absolute" || !child.querySelector("input,button,select")) continue;
            for (const preceding of children) {
              if (preceding === child || ["absolute", "fixed"].includes(baseline.get(preceding).position)) continue;
              const previous = baseline.get(preceding).contentBounds ?? baseline.get(preceding).box;
              if (previous.bottom > old.box.top + EPSILON) continue;
              const current = branchBounds(preceding), box = child.getBoundingClientRect();
              if (current.right <= box.left || current.left >= box.right) continue;
              const delta = current.bottom + Math.max(2, old.box.top - previous.bottom) - box.top;
              if (delta > EPSILON && delta < innerHeight * 0.5) write(child, "top", `${Math.ceil((parseFloat(styleFor(child).top) || child.offsetTop) + delta)}px`, "reflow");
            }
          }
          for (const child of children) {
            const image = child.matches("img,picture,video,canvas") || (!containedText(child).length && child.querySelector("img,picture,video,svg,canvas"));
            if (!image || !["absolute", "fixed"].includes(baseline.get(child).position)) continue;
            const currentArt = child.getBoundingClientRect();
            const newlyCovered = children.some((sibling) => sibling !== child && containedText(sibling).length
              // Artwork already under painted text is a layered backdrop. A
              // larger caption does not turn that background into a flow row.
              && intersection(baseline.get(sibling).contentBounds ?? baseline.get(sibling).box, baseline.get(child).box) <= 8
              && intersection(bounds(containedRects(sibling)) ?? sibling.getBoundingClientRect(), currentArt)
                > intersection(baseline.get(sibling).contentBounds ?? baseline.get(sibling).box, baseline.get(child).box) + 8);
            // Another pair's collision does not give every decorative image a
            // flow slot. Move only artwork actually reached by enlarged text.
            if (!newlyCovered) continue;
            // An absolutely positioned image spanning its parent is a backdrop,
            // not independent sibling artwork that should acquire a flow slot.
            const artBox = baseline.get(child).box;
            if (artBox.width >= before.box.width * 0.8 && artBox.height >= before.box.height * 0.65) continue;
            // Decorative sibling art must acquire space in the flow when text
            // newly reaches it. Keep its intrinsic dimensions and crop rules.
            write(child, "position", "relative", "reflow");
            write(child, "inset", "auto", "reflow");
            write(child, "transform", "none", "reflow");
            write(child, "max-width", "100%", "reflow");
            write(parent, "height", "auto", "reflow");
          }
          // Negative margins or positioned headings can preserve a fixed
          // visual gap even though the text above them acquired another line.
          // Restore that measured gap instead of inventing a site-specific gap.
          for (let i = 0; i < children.length - 1; i++) {
            const a = children[i], b = children[i + 1];
            if (!["static", "relative"].includes(styleFor(a).position) || !["static", "relative"].includes(styleFor(b).position)) continue;
            const oldA = baseline.get(a).contentBounds ?? baseline.get(a).box;
            const oldB = baseline.get(b).contentBounds ?? baseline.get(b).box;
            const newA = branchBounds(a), newB = branchBounds(b);
            const gap = oldB.top - oldA.bottom, currentGap = newB.top - newA.bottom;
            if (oldB.top > oldA.top && gap >= -EPSILON && currentGap < gap - EPSILON && Math.min(newA.right, newB.right) > Math.max(newA.left, newB.left)) {
              const margin = parseFloat(styleFor(b).marginTop) || 0;
              write(b, "margin-top", `${Math.ceil(margin + gap - currentGap)}px`, "reflow");
            }
          }
          // Relative/fixed-height blocks can paint text into their next sibling.
          for (let i = 0; i < children.length - 1; i++) {
            const child = children[i];
            const box = child.getBoundingClientRect();
            const text = branchBounds(child);
            if (text.bottom > box.bottom + EPSILON && baseline.get(child).position !== "absolute") {
              write(child, "min-height", `${heightForBox(child, box.height + text.bottom - box.bottom + 4)}px`, "reflow");
              write(child, "height", "auto", "reflow");
            }
          }
        }
      }
    };
    const repairPanels = () => {
      for (const [panel, before] of baseline) {
        const now = snapshot(panel, true);
        if (!now) continue;
        const modal = panel.matches("dialog,[role='dialog'],[aria-modal='true']");
        if (!modal && before.box.width >= innerWidth * 0.9 && before.box.height >= innerHeight * 0.9
            && !before.texts.length && panel.querySelector("dialog,[role='dialog'],[aria-modal='true']")) continue;
        // Embedded consent applications often mount an absolute panel without
        // dialog semantics. Only treat a large, originally visible viewport
        // panel as a dialog when text growth displaces its existing controls.
        const embeddedPanel = window !== window.top && now.position === "absolute"
          && before.box.width >= innerWidth * 0.8 && before.box.height >= innerHeight * 0.5
          && before.box.top >= -EPSILON && before.box.top < innerHeight * 0.5;
        if (!modal && !embeddedPanel && (now.position !== "fixed" || now.box.width < innerWidth * 0.45 || before.box.height < 70)) continue;
        if (!containedText(panel).length) continue;
        const grows = now.box.height > before.box.height + EPSILON || now.scrollHeight > before.scrollHeight + EPSILON;
        const missingControl = [...panel.querySelectorAll("button,input,select,a[href],[role='button']")].some((item) => {
          const old = baseline.get(item);
          const box = item.getBoundingClientRect();
          return old && old.box.bottom <= innerHeight + EPSILON && old.box.top >= -EPSILON && (box.bottom > innerHeight + EPSILON || box.top < -EPSILON || box.bottom > now.box.bottom + EPSILON);
        });
        const escapesViewport = now.box.top < -EPSILON || now.box.bottom > innerHeight + EPSILON;
        if ((!grows && !missingControl) || (embeddedPanel && !missingControl && !escapesViewport)) continue;
        const limit = modal || embeddedPanel ? Math.max(160, innerHeight - 32) : innerHeight * 0.5;
        write(panel, "box-sizing", "border-box", "bounded-panel");
        if (!modal && !embeddedPanel) writePanelConstraint(panel, "height", `${Math.ceil(Math.min(limit, Math.max(now.box.height, now.scrollHeight)))}px`);
        writePanelConstraint(panel, "max-height", `${Math.floor(limit)}px`);
        writePanelConstraint(panel, "min-height", "0");
        write(panel, "overflow-y", "auto", "bounded-panel");
        write(panel, "overscroll-behavior", "contain", "bounded-panel");
        // Keep a clearly separate terminal action row visible within small
        // fixed panels while their expanded explanation remains scrollable.
        // Dialogs and ambiguous mixed-content groups retain ordinary scrolling.
        if (!modal && !embeddedPanel) {
          const groups = new Set([...panel.querySelectorAll("button,input[type='button'],input[type='submit']")].map(ancestor));
          for (const group of groups) {
            if (!group || group === panel || group !== group.parentElement?.lastElementChild) continue;
            const old = baseline.get(group), current = snapshot(group, true);
            if (!old || !current || old.box.bottom > before.box.bottom + EPSILON || old.box.bottom > innerHeight + EPSILON) continue;
            if (current.box.bottom <= Math.min(innerHeight, panel.getBoundingClientRect().bottom) + EPSILON) continue;
            if (containedText(group).some((item) => !item.closest("button,input[type='button'],input[type='submit']"))) continue;
            let background = ancestor(group);
            while (background && styleFor(background).backgroundColor === "rgba(0, 0, 0, 0)") background = ancestor(background);
            write(group, "position", "sticky", "panel-actions");
            write(group, "bottom", "0", "panel-actions");
            write(group, "z-index", "1", "panel-actions");
            write(group, "background-color", background ? styleFor(background).backgroundColor : "white", "panel-actions");
            write(panel, "scroll-padding-bottom", `${Math.ceil(current.box.height)}px`, "panel-actions");
          }
        }
        const bounded = snapshot(panel, true);
        if (bounded && (bounded.box.top < 0 || bounded.box.bottom > innerHeight)) {
          // Preserve the author's horizontal centering and transforms. Move
          // only the measured vertical excess after applying the scroll bound.
          const css = styleFor(panel);
          const top = parseFloat(css.top);
          const target = Math.max(0, Math.min(bounded.box.top, innerHeight - bounded.box.height));
          if (Number.isFinite(top)) write(panel, "top", `${top + target - bounded.box.top}px`, "bounded-panel");
          else if (css.bottom !== "auto") {
            write(panel, "bottom", `${(parseFloat(css.bottom) || 0) + bounded.box.top - target}px`, "bounded-panel");
          }
        }
        // Fixed/absolute footers must participate in dialog scrolling, rather
        // than covering its explanation or leaving their controls offscreen.
        for (const child of panel.querySelectorAll("*")) {
          const childStyle = styleFor(child);
          if (!["absolute", "fixed"].includes(childStyle.position) || !child.querySelector("button,input,[role='button']")) continue;
          if (!containedText(child).length || child.getBoundingClientRect().width < now.box.width * 0.45) continue;
          write(child, "position", "relative", "bounded-panel");
          write(child, "inset", "auto", "bounded-panel");
          write(child, "height", "auto", "bounded-panel");
        }
        if (!modal && !embeddedPanel) {
          // Releasing an inset wrapper or wrapping its choices can add height
          // after the first measurement. Settle once against the same viewport
          // bound so newly revealed controls do not lose their bottom edge.
          const settled = snapshot(panel, true);
          if (settled) writePanelConstraint(panel, "height", `${Math.ceil(Math.min(limit, Math.max(settled.box.height, settled.scrollHeight)))}px`);
          const reservation = panelReservations.get(panel), finalBox = panel.getBoundingClientRect();
          if (reservation?.sibling.isConnected && finalBox.height > before.box.height + EPSILON) {
            writePanelConstraint(reservation.sibling, "height", `${heightForBox(reservation.sibling,
              reservation.before.box.height + finalBox.height - before.box.height)}px`);
          }
        }
      }
    };
    const repairTables = () => {
      for (const [table, before] of baseline) {
        if (table.tagName !== "TABLE" || !table.isConnected) continue;
        const now = snapshot(table);
        if (now && ["auto", "scroll"].includes(now.overflowX) && now.scrollWidth > now.clientWidth + EPSILON) {
          if (!table.hasAttribute("tabindex")) mark(table, "tabindex", "0");
          if (!table.hasAttribute("role")) mark(table, "role", "region");
          if (!table.hasAttribute("aria-label")) mark(table, "aria-label", table.caption?.textContent.trim() || "Scrollable table");
          continue;
        }
        if (!now || now.box.right <= innerWidth + EPSILON || now.box.width <= before.box.width + EPSILON) continue;
        const parent = ancestor(table);
        if (!parent) continue;
        // Give enlarged cells a keyboard-accessible horizontal viewport rather
        // than squeezing prose, numbers or native form controls into tiny cells.
        const padding = parseFloat(styleFor(parent).paddingRight) || 0;
        const available = Math.max(80, innerWidth - Math.max(0, now.box.left) - padding);
        let viewport;
        if (parent !== document.body && parent !== document.documentElement && parent.children.length === 1 && !parent.matches("td,th")) {
          viewport = parent;
        } else {
          viewport = document.createElement("div");
          table.before(viewport); viewport.append(table);
          invalidateMeasurements();
          viewport.tabIndex = 0;
          viewport.setAttribute("role", "region");
          viewport.setAttribute("aria-label", table.caption?.textContent.trim() || "Scrollable table");
          tableWrappers.set(table, viewport);
        }
        write(viewport, "box-sizing", "border-box", "scroll-table");
        write(viewport, "max-width", `${Math.floor(available)}px`, "scroll-table");
        write(viewport, "overflow-x", "auto", "scroll-table");
        write(viewport, "overscroll-behavior-x", "contain", "scroll-table");
        if (!viewport.hasAttribute("tabindex")) mark(viewport, "tabindex", "0");
        if (!viewport.hasAttribute("role")) mark(viewport, "role", "region");
        if (!viewport.hasAttribute("aria-label")) mark(viewport, "aria-label", table.caption?.textContent.trim() || "Scrollable table");
      }
    };
    const repairMaskedContent = () => {
      for (const [container, before] of baseline) {
        if (maskedTickers.has(container)) continue;
        if (!["hidden", "clip"].includes(before.overflowX) || container.matches("nav,[role='navigation'],[role='menu'],[role='listbox'],[role='tablist'],[aria-roledescription='carousel']")) continue;
        if (container.querySelector("[aria-controls],button[aria-label*='next' i],button[aria-label*='previous' i]")) continue;
        const now = snapshot(container);
        const texts = containedText(container);
        if (!now || !texts.length || texts.length > 80 || now.box.width < 150 || now.box.height < 80 || now.box.width > innerWidth + EPSILON) continue;
        const oldText = before.contentBounds, newText = bounds(containedRects(container));
        if (!oldText || !newText) continue;
        const enlarged = texts.some((item) => (snapshot(item)?.fontSize ?? 0) > (baseline.get(item)?.fontSize ?? Infinity) + 0.1);
        // Negative margins in visual specimens can crop the top of a partly
        // visible caption. Give that flow branch enough space to paint its
        // first line; scrolling cannot reach content above scrollTop zero.
        const topClip = now.box.top + now.borderTop - newText.top;
        if (enlarged && ["hidden", "clip"].includes(before.overflowY) && topClip > EPSILON
            && topClip < Math.max(48, now.fontSize * 2) && oldText.top > before.box.top - Math.max(48, before.fontSize * 2)
            && oldText.bottom > before.box.top + EPSILON && container.children.length <= 8) {
          const branch = [...container.children].find((item) => {
            const css = styleFor(item);
            return parseFloat(css.marginTop) < 0 && !["absolute", "fixed"].includes(css.position)
              && containedText(item).length && item.getBoundingClientRect().top < now.box.top;
          });
          if (branch) {
            write(branch, "margin-top", `${parseFloat(styleFor(branch).marginTop) + topClip + 2}px`, "expose-text-top");
            write(container, "min-height", `${heightForBox(container, now.box.height + topClip + 2)}px`, "expose-text-top");
          }
        }
        if (now.scrollWidth <= now.clientWidth + EPSILON) continue;
        const oldOverflow = Math.max(0, oldText.right - before.box.right) + Math.max(0, before.box.left - oldText.left);
        const overflow = Math.max(0, newText.right - now.box.right) + Math.max(0, now.box.left - newText.left);
        // Keep the visual crop, but make its meaningful text reachable. Only
        // visible baseline content is eligible; closed menus remain excluded.
        if (overflow < EPSILON || (!enlarged && overflow <= oldOverflow + EPSILON)) continue;
        if (!maskedScrollOffsets.has(container)) maskedScrollOffsets.set(container, container.scrollLeft);
        write(container, "overflow-x", "auto", "scroll-masked-content");
        write(container, "overscroll-behavior-x", "contain", "scroll-masked-content");
        if (!container.hasAttribute("tabindex")) mark(container, "tabindex", "0");
        if (!container.hasAttribute("role")) mark(container, "role", "region");
        if (!container.hasAttribute("aria-label") && !container.hasAttribute("aria-labelledby")) mark(container, "aria-label", "Scrollable content");
      }
    };
    const repairBackdropSpacing = () => {
      for (const [parent, before] of baseline) {
        if (parent.children.length > 16 || before.box.height > innerHeight * 1.2) continue;
        const visuals = [...parent.children].flatMap((child) => child.tagName === "PICTURE" ? [...child.children].filter((item) => item.tagName === "IMG") : [child]);
        const art = visuals.find((child) => child.matches("img,video,canvas") && baseline.get(child)?.position === "absolute"
          && baseline.get(child).box.width >= before.box.width * 0.8 && baseline.get(child).box.height <= before.box.height + EPSILON);
        if (!art) continue;
        const branch = [...parent.children].find((child) => child !== art && baseline.get(child)?.position === "absolute" && containedText(child).some(heading));
        if (!branch) continue;
        const previous = baseline.get(branch).contentBounds;
        const current = bounds(containedRects(branch));
        if (!previous || !current) continue;
        const growth = current.bottom - current.top - (previous.bottom - previous.top);
        if (growth < Math.max(12, before.fontSize) || growth > innerHeight * 0.5) continue;
        // Preserve the art's size and horizontal composition. Give its old
        // vertical position the same added space as the headline/CTA group.
        const top = baseline.get(art).authoredTop;
        if (!Number.isFinite(top)) continue;
        write(art, "top", `${Math.ceil(top + growth)}px`, "art-spacing");
        const height = before.authoredHeight;
        if (Number.isFinite(height)) write(parent, "height", `${Math.ceil(height + growth)}px`, "art-spacing");
      }
    };
    const repairOverlays = () => {
      for (const element of textElements) {
        const before = baseline.get(element);
        const now = snapshot(element);
        if (!now || !lightText(now.color)) continue;
        const growth = (now.text?.bottom ?? now.box.bottom) - (now.text?.top ?? now.box.top);
        const previous = (before.text?.bottom ?? before.box.bottom) - (before.text?.top ?? before.box.top);
        if (growth <= previous + EPSILON && now.fontSize <= before.fontSize + 0.1) continue;
        let parent = ancestor(element), imageContainer = null;
        for (let depth = 0; parent && depth < 6; depth++, parent = ancestor(parent)) {
          const style = styleFor(parent);
          const images = [...parent.querySelectorAll(":scope > img,:scope > video,:scope > picture > img,:scope > div > img,:scope > div > picture > img,:scope > div > div > img,:scope > div > div > picture > img")];
          const hasImage = /url\(/.test(style.backgroundImage) || images.some((image) => intersection(image.getBoundingClientRect(), element.getBoundingClientRect()) > 0);
          if (hasImage) { imageContainer = parent; break; }
        }
        if (!imageContainer) continue;
        // A local opaque scrim keeps enlarged white glyphs readable wherever
        // they wrap over a photograph; no image pixel or hostname assumptions.
        write(element, "background-color", "rgba(15, 23, 42, 0.94)", "overlay-contrast");
        write(element, "box-decoration-break", "clone", "overlay-contrast");
        write(element, "-webkit-box-decoration-break", "clone", "overlay-contrast");
      }
    };
    const repairSolidContrast = () => {
      const rgb = (value) => {
        if (!/^rgba?\(/.test(value)) return null;
        const channels = value.match(/[\d.]+/g)?.map(Number);
        return channels?.length >= 3 ? { channels: channels.slice(0, 3), alpha: channels[3] ?? 1 } : null;
      };
      const luminance = (channels) => channels.map((value) => {
        const unit = value / 255;
        return unit <= 0.04045 ? unit / 12.92 : ((unit + 0.055) / 1.055) ** 2.4;
      }).reduce((sum, value, index) => sum + value * [0.2126, 0.7152, 0.0722][index], 0);
      const pseudoPaint = (element) => ["::before", "::after"].some((pseudo) => {
        const css = styleFor(element, pseudo);
        if (["none", "normal"].includes(css.content) || css.display === "none" || css.visibility === "hidden" || Number(css.opacity) === 0) return false;
        return css.backgroundImage !== "none" || (rgb(css.backgroundColor)?.alpha ?? 0) > 0;
      });
      for (const element of textElements) {
        if (!/\p{L}|\p{N}/u.test([...element.childNodes].filter((node) => node.nodeType === Node.TEXT_NODE).map((node) => node.textContent).join(""))
            || element.closest(":disabled,[aria-disabled='true'],[inert]")) continue;
        const now = snapshot(element);
        const foreground = now && rgb(now.color);
        if (!now?.text || !foreground || foreground.alpha !== 1) continue;
        let background = null, safe = true;
        for (let current = element, depth = 0; current && depth < 24; current = ancestor(current), depth++) {
          const css = styleFor(current);
          if (Number(css.opacity) < 1 || css.filter !== "none" || css.mixBlendMode !== "normal"
              || css.backgroundImage !== "none" || (css.backdropFilter && css.backdropFilter !== "none")) { safe = false; break; }
          if (pseudoPaint(current)) { safe = false; break; }
          const color = rgb(css.backgroundColor);
          if (!color || (color.alpha > 0 && color.alpha < 1)) { safe = false; break; }
          if (color.alpha === 1) {
            const media = current.querySelectorAll("img,video,canvas,svg");
            if (media.length > 128 || [...media].some((item) => intersection(item.getBoundingClientRect(), now.text) > 0)) safe = false;
            background = color; break;
          }
        }
        if (!safe || !background) continue;
        const ink = luminance(foreground.channels), surface = luminance(background.channels);
        const contrast = (Math.max(ink, surface) + 0.05) / (Math.min(ink, surface) + 0.05);
        // Correct only severe, established solid-surface contrast failures.
        // Disabled/faded states, image captions and composited surfaces retain
        // their authored colors; their effective background is not established.
        if (contrast >= 2) continue;
        for (let current = ancestor(element); current; current = ancestor(current)) {
          const css = styleFor(current);
          if (Number(css.opacity) < 1 || css.filter !== "none" || css.mixBlendMode !== "normal" || pseudoPaint(current)) { safe = false; break; }
        }
        if (safe) write(element, "color", surface > 0.179 ? "rgb(0, 0, 0)" : "rgb(255, 255, 255)", "solid-text-contrast");
      }
    };
    const repairImageLayers = () => {
      for (const [parent, before] of baseline) {
        const now = snapshot(parent);
        if (!now || now.box.height <= before.box.height + EPSILON || parent.children.length > 16) continue;
        for (const layer of parent.children) {
          const old = baseline.get(layer), current = snapshot(layer);
          if (!old || !current || current.position !== "absolute" || !hasVisualBackground(layer)) continue;
          // A full-cover photographic layer must continue to cover its card
          // when captions add lines. Preserve cropped media in smaller slots.
          if (Math.abs(old.box.top - before.box.top) > EPSILON || old.box.width < before.box.width * 0.9 || old.box.height < before.box.height * 0.9) continue;
          if (current.box.height >= now.box.height - EPSILON) continue;
          write(layer, "height", "100%", "image-layer");
          write(layer, "max-height", "none", "image-layer");
        }
      }
    };
    const repairBorderBackdrops = () => {
      for (const [backdrop, before] of baseline) {
        const outline = backdrop.querySelector(":scope > svg[fill='none']");
        const viewBox = outline?.viewBox?.baseVal;
        const frame = outline && [...outline.querySelectorAll("path[stroke],rect[stroke]")].find((path) => {
          const box = path.getBBox();
          return viewBox?.width > 0 && box.width >= viewBox.width * 0.9 && box.height >= viewBox.height * 0.9;
        });
        if (before.position !== "absolute" || before.box.width < 100 || before.box.height < 100 || !(before.borderTop || before.borderBottom || frame) || containedText(backdrop).length) continue;
        const parent = ancestor(backdrop), now = snapshot(backdrop);
        if (!parent || !now || parent.children.length > 16) continue;
        for (const sibling of parent.children) {
          if (sibling === backdrop) continue;
          const old = baseline.get(sibling)?.contentBounds, current = bounds(containedRects(sibling));
          if (!old || !current || old.left < before.box.left - EPSILON || old.right > before.box.right + EPSILON || old.top < before.box.top - EPSILON || old.bottom > before.box.bottom + EPSILON) continue;
          if (current.bottom <= now.box.bottom + EPSILON) continue;
          const oldGap = before.box.bottom - old.bottom;
          const height = Math.ceil(current.bottom + oldGap - now.box.top);
          write(backdrop, "width", `${Math.ceil(before.box.width)}px`, "border-backdrop");
          write(backdrop, "height", `${height}px`, "border-backdrop");
          write(backdrop, "max-height", "none", "border-backdrop");
          if (frame) {
            write(outline, "display", "block", "border-backdrop");
            write(outline, "height", "100%", "border-backdrop");
            write(outline, "width", `${Math.ceil(before.box.width)}px`, "border-backdrop");
            mark(outline, "preserveAspectRatio", "none");
          }
          let container = parent;
          for (let depth = 0; container && depth < 6; depth++, container = ancestor(container)) {
            const original = baseline.get(container), box = container.getBoundingClientRect();
            if (!original || original.box.height < before.box.height * 0.8 || original.box.width < before.box.width) continue;
            const oldOverflow = Math.max(0, before.box.bottom - original.box.bottom);
            if (original.box.top > before.box.top + EPSILON || oldOverflow > Math.max(20, before.box.height * 0.05)) continue;
            const additional = backdrop.getBoundingClientRect().bottom - box.bottom;
            if (additional > EPSILON) {
              write(container, "min-height", `${heightForBox(container, box.height + additional)}px`, "border-backdrop");
              write(container, "height", "auto", "border-backdrop");
            }
            break;
          }
        }
      }
    };
    const repairMediaFootprints = () => {
      for (const [element, before] of baseline) {
        let parent = ancestor(element);
        while (parent && styleFor(parent).display === "contents") parent = ancestor(parent);
        if (!parent || before.box.width < 40) continue;
        const display = styleFor(parent).display;
        if (!display.includes("flex") && !display.includes("grid")) continue;
        const box = element.getBoundingClientRect();
        const threshold = before.box.width >= (baseline.get(parent)?.box.width ?? Infinity) * 0.85 ? 0.85 : 0.5;
        if (box.width >= before.box.width * threshold || !hasVisualBackground(element)) continue;
        const width = Math.min(before.box.width, parent.clientWidth);
        if (width < 40) continue;
        if (display.includes("grid")) {
          write(element, "grid-column", before.box.width >= (baseline.get(parent)?.box.width ?? Infinity) * 0.85 ? "1 / -1" : "auto", "media-footprint");
          write(element, "grid-row", "auto", "media-footprint");
          write(element, "min-width", "0", "media-footprint");
          continue;
        }
        write(element, "flex-basis", `${Math.ceil(width)}px`, "media-footprint");
        write(element, "min-width", `min(100%, ${Math.ceil(width)}px)`, "media-footprint");
        write(element, "max-width", "100%", "media-footprint");
      }
    };
    const repairFloatingBounds = () => {
      for (const [parent, before] of baseline) {
        if (before.box.height < 32 || parent.children.length > 32) continue;
        const children = [...parent.children].filter((child) => baseline.has(child) && styleFor(child).float !== "none");
        if (children.length < 2 || children.some((child) => baseline.get(child).box.bottom > before.box.bottom + EPSILON)) continue;
        const now = snapshot(parent);
        if (!now || ["auto", "scroll"].includes(now.overflowY)) continue;
        const bottom = Math.max(...children.map((child) => child.getBoundingClientRect().bottom));
        const growth = bottom + now.paddingBottom + now.borderBottom - now.box.bottom;
        if (growth <= EPSILON || growth > innerHeight * 2) continue;
        write(parent, "min-height", `${heightForBox(parent, now.box.height + growth)}px`, "float-containment");
        write(parent, "height", "auto", "float-containment");
      }
    };
    const repairLayout = () => {
      if (!baseline.size) return;
      for (const [mask, { track, active, offset }] of maskedTickers) {
        if (!mask.isConnected || !active.isConnected) continue;
        const before = baseline.get(mask), box = active.getBoundingClientRect();
        const matrix = new DOMMatrixReadOnly(styleFor(track).transform);
        const height = Math.max(before.authoredHeight, box.height + before.paddingTop + before.paddingBottom);
        write(mask, "height", `${Math.ceil(height)}px`, "active-ticker-frame");
        write(mask, "max-height", "none", "active-ticker-frame");
        const delta = mask.getBoundingClientRect().top + offset - active.getBoundingClientRect().top;
        if (Math.abs(delta) > 0.1) {
          write(track, "transform", `matrix(${matrix.a}, ${matrix.b}, ${matrix.c}, ${matrix.d}, ${matrix.e}, ${matrix.f + delta})`, "active-ticker-frame");
        }
      }
      for (const element of textElements) if (element.isConnected) repairText(element, baseline.get(element));
      repairContainers(); repairSiblings(); repairContainers();
      repairMediaFootprints(); repairContainers();
      globalThis.LexendControls?.repair({ baseline, textElements, descendants, snapshot, write, mark, ancestor, bounds, directTextRects, containedText, expandContainer });
      repairFloatingBounds();
      repairExpandedFades(); repairContainers(); repairPseudoTooltips();
      repairPanels(); repairBackdropSpacing(); repairBorderBackdrops(); repairImageLayers(); repairOverlays(); repairTables(); repairMaskedContent();
      repairSolidContrast();
      globalThis.LexendControls?.finalizeIconLabels?.({ baseline, snapshot, write });
      // Controls and flex repairs can narrow an action after the first text
      // pass. Recheck only short action words against their settled geometry.
      for (const element of textElements) {
        const before = baseline.get(element), now = snapshot(element);
        if (before && now && element.closest("a[href],button,[role=button]")) fitHeading(element, before, now);
      }
    };
    const getFrameRequirement = (originalViewportHeight = innerHeight) => {
      const viewportHeight = originalViewportHeight;
      if (window === window.top || viewportHeight > 160 || !baseline.size || textElements.size > 40) return null;
      const oldBoxes = [], currentBoxes = [];
      for (const element of textElements) {
        const old = baseline.get(element);
        if (!old || !element.isConnected) continue;
        const css = styleFor(element);
        if (css.display === "none" || css.visibility === "hidden" || Number(css.opacity) === 0) continue;
        oldBoxes.push(...old.texts, ...(control(element) ? [old.box] : []));
        currentBoxes.push(...directTextRects(element), ...(control(element) ? [rect(element.getBoundingClientRect())] : []));
      }
      const before = bounds(oldBoxes), now = bounds(currentBoxes);
      if (!before || !now) return null;
      // An author-centered caption moves when our own iframe resize changes
      // its viewport. Retain the original fit qualification for the same text
      // nodes until the native/original viewport or content actually changes.
      if (innerHeight <= viewportHeight + EPSILON || frameQualification?.viewportHeight !== viewportHeight) {
        frameQualification = { viewportHeight, baselineHeight: Math.ceil(before.bottom),
          eligible: before.top >= -EPSILON && before.bottom <= viewportHeight + EPSILON,
          elements: new Set(textElements) };
      }
      if (!frameQualification.eligible || textElements.size !== frameQualification.elements.size
          || [...textElements].some((element) => !frameQualification.elements.has(element))) return null;
      // Compact captions beside a thumbnail can request their measured extra
      // line. A large photographic surface keeps its authored crop/viewport.
      if ([...baseline].some(([element, state]) => element.matches("img,video,canvas")
          && state.box.width >= innerWidth * 0.65 && state.box.height >= viewportHeight * 0.65)) return null;
      // Centered announcements move their glyphs when their iframe grows.
      // Once the repaired viewport contains them, retain its measured height
      // rather than treating that movement as another request for growth.
      const fitsCurrentViewport = now.top >= 0 && now.bottom <= innerHeight;
      if (innerHeight <= viewportHeight + EPSILON && fitsCurrentViewport) return null;
      const requiredHeight = fitsCurrentViewport
        ? Math.ceil(innerHeight) : Math.ceil(Math.max(viewportHeight, now.bottom + scrollY + 8));
      const limit = Math.min(320, Math.max(120, viewportHeight * 4));
      if (requiredHeight > limit) return null;
      return { baselineHeight: frameQualification.baselineHeight, requiredHeight, viewportHeight };
    };
    const capture = (roots) => withMeasurements(() => captureBaseline(roots));
    const repair = () => withMeasurements(repairLayout);
    return Object.freeze({ capture, repair, restore, getFrameRequirement, refresh: (roots) => { capture(roots); repair(); } });
  };

  globalThis.LexendLayout = Object.freeze({ create });
})();
