(() => {
  "use strict";

  // Refresh scheduling for the content runtime: which page events can change a
  // conversion, and how full-page refreshes are coalesced and budgeted.
  // content.js owns measurement, typography and repair, and supplies hooks.
  //
  // Trigger policy. Layout repair needs fresh geometry after most visual
  // changes. Typography-only conversion, the default, remeasures only when
  // author typography or a label's paint-dependent classification can change.
  //
  //   event                         typography only               layout repair
  //   resize                        yes (media queries)           yes
  //   focusin / focusout            paint-classified labels       yes
  //   popover toggle                yes                           yes
  //   transitionend / animationend  moved background labels       same
  //   content-visibility reveal     no (style still computes)     once per reveal
  //   load                          stylesheets only              yes
  //   font loadingdone              new author or bundled metrics same
  //
  // DOM mutations are classified by content.js's observer, which queues here.
  const listen = ({ isActive, isLayoutRepairActive, editorOwned, queue, invalidate, labelRevealedByFocus,
    revealFocused, labelRevealedByMovement, autoContentRevealed, isOwnStyle, fontMetricsChanged }) => {
    window.addEventListener("resize", (event) => invalidate(event), { passive: true });
    // Without layout repair, a full-page conversion for an ordinary focus
    // change would only block input on large pages.
    const focusChanges = (event) => isLayoutRepairActive() || labelRevealedByFocus(event);
    document.addEventListener("focusin", (event) => {
      if (!isActive() || editorOwned(event.target)) return;
      if (focusChanges(event)) queue();
      requestAnimationFrame(() => {
        if (isLayoutRepairActive()) revealFocused(event.target);
      });
    }, true);
    document.addEventListener("focusout", (event) => {
      if (isActive() && !editorOwned(event.target) && focusChanges(event)) queue();
    }, true);
    document.addEventListener("toggle", (event) => {
      if (!isActive() || !(event.target instanceof Element) || editorOwned(event.target)) return;
      // details.open is observed and coalesced; popovers have no open attribute.
      if (event.target.matches("[popover]") && event.oldState !== event.newState) invalidate();
    }, true);
    const moved = (event) => {
      if (event.type === "transitionend"
          && !/^(transform|translate|left|right|top|bottom|inset.*|width|height)$/.test(event.propertyName)) return;
      const target = event.target;
      if (!isActive() || !(target instanceof Element) || editorOwned(target)) return;
      // The mutation that starts a drawer/rail animation can be measured while
      // its labels are still outside the viewport. Reclassify once movement
      // finishes; ordinary font/color transitions do not schedule this work.
      if (labelRevealedByMovement(target)) queue();
    };
    document.addEventListener("transitionend", moved, true);
    document.addEventListener("animationend", moved, true);
    document.addEventListener("contentvisibilityautostatechange", (event) => {
      // Skipped subtrees still compute their typography. Only layout repair
      // needs the painted geometry of automatically contained content.
      if (!(event.target instanceof Element) || !isLayoutRepairActive()) return;
      if (autoContentRevealed(event.target, event.skipped)) queue();
    }, true);
    document.addEventListener("load", (event) => {
      const target = event.target;
      if (!(target instanceof Element) || isOwnStyle(target)) return;
      // Images, scripts and frames change only geometry. A stylesheet can also
      // change author typography, which conversion has to remeasure.
      if (isLayoutRepairActive() || target.matches("link[rel~='stylesheet' i],style")) invalidate();
    }, true);
    document.fonts?.addEventListener("loadingdone", (event) => {
      if (fontMetricsChanged(event.fontfaces)) invalidate(true);
    });
  };

  const create = ({ canQueue, isStarting, onQueued, styleSignature, refresh, refreshRegions, resumeRepair }) => {
    let timer = null;
    let urgentTimer = false;
    let deadline = 0;
    let required = false;
    const ariaChanges = new Map();
    const styleChanges = new Map();
    const stateChanges = new Map();
    let regions = null;
    let global = false;
    // A starting refresh covers every queued change.
    const claim = () => {
      if (timer !== null) clearTimeout(timer);
      timer = null;
      urgentTimer = false;
      required = false;
      ariaChanges.clear();
      styleChanges.clear();
      stateChanges.clear();
      regions = null;
      global = false;
    };
    const run = () => {
      // Responsive navigation can temporarily hide and reveal the same links
      // across separate observer deliveries while measuring them. Restoring
      // typography restarts that measurement, so refreshing an unchanged final
      // state would create a feedback loop even with a refresh cooldown. Theme
      // observers can likewise add/remove inline variables in separate tasks.
      const changed = !required && ([...ariaChanges].some(([element, value]) =>
        element.isConnected && element.getAttribute("aria-hidden") !== value)
        || [...styleChanges].some(([element, value]) => element.isConnected
          && styleSignature(element, element.getAttribute("style")) !== value)
        || [...stateChanges].some(([element, names]) => element.isConnected
          && [...names].some(([name, value]) => element.getAttribute(name) !== value)));
      if (required || changed) {
        if (!changed && !global && regions?.size) refreshRegions([...regions]);
        else refresh();
        return;
      }
      claim();
      // A reverted temporary style/accessibility change leaves the saved native
      // baseline valid. Finish its suspended repair without another conversion.
      resumeRepair();
    };
    const queue = (urgent = false, aria = null, style = null, state = null, regionRoots = null) => {
      urgent = urgent === true;
      if (!canQueue()) return;
      // Content and geometry changes invalidate a deferred repair's baseline.
      // Temporary author styles can settle back before the queued deadline.
      onQueued(Boolean(aria || style || state));
      if (regionRoots && !global && !aria && !style && !state) {
        regions ??= new Set();
        for (const root of regionRoots) regions.add(root);
      } else {
        global = true;
        regions = null;
      }
      if (aria) for (const mutation of aria) {
        if (!ariaChanges.has(mutation.target)) ariaChanges.set(mutation.target, mutation.oldValue);
      }
      if (style) for (const [element, value] of style) {
        if (!styleChanges.has(element)) styleChanges.set(element, value);
      }
      if (state) for (const mutation of state) {
        let names = stateChanges.get(mutation.target);
        if (!names) stateChanges.set(mutation.target, names = new Map());
        if (!names.has(mutation.attributeName)) names.set(mutation.attributeName, mutation.oldValue);
      }
      if (!aria && !style && !state) required = true;
      // Parser mutations still receive their fonts immediately, but cannot
      // start native capture before the startup preload has settled or timed out.
      if (isStarting()) return;
      if (timer !== null) {
        if (!urgent || urgentTimer) return;
        clearTimeout(timer);
      }
      // Fonts have already been applied to incoming text. Keep layout repairs
      // on a fixed deadline so a continuous feed cannot starve or flood them.
      urgentTimer = urgent;
      timer = setTimeout(run, Math.max(urgent ? 0 : 100, deadline - performance.now()));
    };
    return Object.freeze({
      queue,
      claim,
      cancel() {
        if (timer !== null) clearTimeout(timer);
        timer = null;
      },
      // Count synchronous work in both phases, excluding time spent waiting
      // for a rendering frame or coalescing author changes. Large pages can
      // spend hundreds of milliseconds in a full repair: give the site four
      // times that duration to handle input and paint before the next pass.
      // A cheaper regional pass still consumes the same share of a busy stream.
      budget(duration, regional = false) {
        deadline = performance.now() + (regional || duration > 50 ? duration * 4 : 0);
      },
      get pending() { return timer !== null; },
      get hasQueuedWork() { return required || ariaChanges.size > 0 || styleChanges.size > 0 || stateChanges.size > 0; }
    });
  };

  globalThis.LexendRefreshScheduler = Object.freeze({ create, listen });
})();
