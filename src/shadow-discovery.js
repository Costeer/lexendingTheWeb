(() => {
  "use strict";

  // This deliberately runs in MAIN, where the page calls attachShadow. An
  // isolated-world prototype patch cannot intercept those calls. The event is
  // only a discovery hint: the isolated runtime must verify the native host and
  // open root, and must never trust event data or use it for privileged work.
  const descriptor = Object.getOwnPropertyDescriptor(Element.prototype, "attachShadow");
  if (typeof descriptor?.value !== "function") return;
  const original = descriptor.value;
  const apply = Reflect.apply;
  const dispatch = EventTarget.prototype.dispatchEvent;
  const NativeEvent = Event;
  const enqueue = queueMicrotask;
  const connected = Object.getOwnPropertyDescriptor(Node.prototype, "isConnected").get;
  const rootMode = Object.getOwnPropertyDescriptor(ShadowRoot.prototype, "mode").get;

  Object.defineProperty(Element.prototype, "attachShadow", {
    ...descriptor,
    value: function attachShadow(options) {
      const root = apply(original, this, arguments);
      try {
        if (apply(rootMode, root, []) !== "open" || !apply(connected, this, [])) return root;
        // Let the caller populate its new root in the same task. Hosts attached
        // while disconnected are already covered by ordinary insertion events.
        // No root/host collection survives this single microtask.
        const host = this;
        enqueue(() => {
          try {
            if (!apply(connected, host, [])) return;
            apply(dispatch, host, [new NativeEvent("lexend-open-shadow-root", {
              bubbles: true,
              composed: true
            })]);
          } catch { /* Discovery must never interrupt the page's component. */ }
        });
      } catch { /* Notification failure must not change a successful attach. */ }
      return root;
    }
  });

  // designMode is a DOM property without a corresponding attribute mutation.
  // Announce successful native setter calls synchronously so entering editing
  // mode can restore author markup before the caller serializes its document.
  // The isolated listener verifies the real mode and ignores unchanged hints.
  const designModeDescriptor = Object.getOwnPropertyDescriptor(Document.prototype, "designMode");
  if (typeof designModeDescriptor?.set === "function") {
    Object.defineProperty(Document.prototype, "designMode", {
      ...designModeDescriptor,
      set: function designMode(value) {
        const result = apply(designModeDescriptor.set, this, arguments);
        try { apply(dispatch, this, [new NativeEvent("lexend-design-mode")]); }
        catch { /* Preserve the native setter even if discovery is unavailable. */ }
        return result;
      }
    });
  }
})();
