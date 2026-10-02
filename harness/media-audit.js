// Independently protect meaningful imagery from text-layout repairs. Runs in
// the website frame, using the same stable DOM identities as the text audit.
export function collectMediaSnapshot() {
  const state = window.__lexendAudit ??= { ids: new WeakMap(), nextId: 1 };
  const media = [];
  const elements = [];
  const visit = (root) => {
    for (const element of root.querySelectorAll("*")) {
      elements.push(element);
      if (element.shadowRoot) visit(element.shadowRoot);
    }
  };
  visit(document);
  for (const element of elements) {
    const css = getComputedStyle(element);
    const image = element.matches("img,video,canvas,svg");
    if (!image && css.backgroundImage === "none") continue;
    let id = state.ids.get(element);
    if (!id) { id = state.nextId++; state.ids.set(element, id); }
    const box = element.getBoundingClientRect();
    const hidden = css.display === "none" || css.visibility === "hidden"
      || Number(css.opacity) === 0 || !element.getClientRects().length
      || (element.checkVisibility && !element.checkVisibility({ opacityProperty: true, visibilityProperty: true, contentVisibilityAuto: true }));
    media.push({ id, path: `${element.localName}${element.id ? `#${element.id}` : ""}`,
      width: box.width, height: box.height, hidden,
      viewport: { x: box.x, y: box.y, width: innerWidth, height: innerHeight, scrollX, scrollY: scrollY + (document.body?.scrollTop ?? 0) },
      responsiveSource: element.matches("img") && (element.srcset || element.closest("picture"))
        ? JSON.stringify([element.getAttribute("src"), element.getAttribute("srcset"),
          [...(element.closest("picture")?.querySelectorAll("source") ?? [])]
            .map((source) => [source.getAttribute("srcset"), source.getAttribute("media"), source.getAttribute("type")])]) : null,
      source: image ? element.currentSrc || element.src || element.poster || "" : css.backgroundImage });
  }
  return media;
}

export function compareMediaSnapshots(before = [], after = []) {
  const current = new Map(after.map((item) => [item.id, item]));
  const findings = [];
  for (const original of before) {
    if (original.hidden || original.width < 40 || original.height < 40) continue;
    const next = current.get(original.id);
    const add = (code, severity, message) => findings.push({ code, severity,
      elementId: original.id, path: original.path, text: "", message, before: original, after: next ?? null });
    if (!next || next.hidden) {
      add("media-state-change", "review", "Previously rendered imagery is missing or hidden; capture an equivalent state and visually verify preservation.");
    } else if (next.width < 2 || next.height < 2) {
      add("media-collapsed", "error", `Rendered imagery collapsed from ${original.width.toFixed(1)}×${original.height.toFixed(1)} to ${next.width.toFixed(1)}×${next.height.toFixed(1)} pixels.`);
    } else if (original.viewport && next.viewport
        && Math.abs(original.viewport.scrollX - next.viewport.scrollX) < 2
        && Math.abs(original.viewport.scrollY - next.viewport.scrollY) < 2
        && original.viewport.x < original.viewport.width && original.viewport.x + original.width > 0
        && original.viewport.y < original.viewport.height && original.viewport.y + original.height > 0
        && (next.viewport.x >= next.viewport.width || next.viewport.x + next.width <= 0
          || next.viewport.y >= next.viewport.height || next.viewport.y + next.height <= 0)) {
      add("media-displaced", "review", "Previously visible imagery moved entirely outside the paired viewport; verify that typography repairs preserve the artwork in an equivalent state.");
    } else if (original.source && next.source !== original.source
        && !(original.responsiveSource && next.responsiveSource === original.responsiveSource)) {
      add("media-content-change", "review", "Image content changed; compare the same image before assessing its readability.");
    } else if (next.width * next.height < original.width * original.height * 0.25) {
      add("media-shrunk", "review", "Rendered imagery lost more than three quarters of its area; visually verify that the layout preserved meaningful artwork.");
    }
  }
  return findings;
}
