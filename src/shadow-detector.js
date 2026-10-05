(() => {
  "use strict";

  // MAIN-world bridge: no extension APIs, settings, or page content cross it.
  // The isolated script treats these events only as hints to enable discovery.
  const STATE_EVENT = "lexend-shadow-state-v1";
  const ATTACHED_EVENT = "lexend-shadow-attached-v1";
  const PROBE_EVENT = "lexend-shadow-probe-v1";
  const dispatch = EventTarget.prototype.dispatchEvent;
  const apply = Reflect.apply;
  const NativeEvent = Event;
  const NativeCustomEvent = CustomEvent;
  const hooks = [];
  let state = "ready";

  const emit = (target, event) => {
    try { apply(dispatch, target, [event]); } catch {}
  };
  const report = () => emit(document, new NativeCustomEvent(STATE_EVENT, { detail: state }));
  const requireDiscovery = (nextState = "watch") => {
    if (state === "fallback" || state === "shadow" || state === nextState) return;
    state = nextState;
    report();
  };

  const wrap = (owner, name, after) => {
    const descriptor = Object.getOwnPropertyDescriptor(owner, name);
    if (typeof descriptor?.value !== "function") return;
    const original = descriptor.value;
    const wrapped = function (...args) {
      // Call first: a failed native operation must retain its original exception.
      const result = apply(original, this, args);
      try { after(this, result); } catch {}
      return result;
    };
    Object.defineProperty(wrapped, "name", { value: original.name });
    Object.defineProperty(wrapped, "length", { value: original.length });
    Object.defineProperty(owner, name, { ...descriptor, value: wrapped });
    hooks.push({ owner, name, wrapped });
  };

  try {
    if (typeof Element.prototype.attachShadow !== "function") throw new Error("No shadow API");
    wrap(Element.prototype, "attachShadow", (host, root) => {
      if (root.mode !== "open") return;
      // Report on document even for a detached host, then send a targeted hint
      // for connected hosts (including hosts within other open shadow roots).
      requireDiscovery("shadow");
      emit(host, new NativeEvent(ATTACHED_EVENT, { bubbles: true, composed: true }));
    });

    // Native parsing and cloning can create roots without calling attachShadow.
    // Conservatively retain discovery when one of these APIs is used. No HTML
    // strings are inspected, and native Trusted Types/sanitization stay intact.
    for (const owner of [Element.prototype, ShadowRoot.prototype, Document]) {
      for (const name of Object.getOwnPropertyNames(owner)) {
        if (/^(?:set|parse|append|prepend|replace|stream).*HTML/.test(name)) {
          wrap(owner, name, (target) => {
            requireDiscovery();
            // Also recheck an open root on the receiver. Keep this targeted
            // hint after the first conservative signal, without inspecting HTML.
            if (target instanceof Element && target.shadowRoot?.mode === "open") {
              emit(target, new NativeEvent(ATTACHED_EVENT, { bubbles: true, composed: true }));
            }
          });
        }
      }
    }
    wrap(Node.prototype, "cloneNode", () => requireDiscovery());
    wrap(Document.prototype, "importNode", () => requireDiscovery());
    wrap(Document.prototype, "adoptNode", () => requireDiscovery());
  } catch {
    state = "fallback";
  }

  document.addEventListener(PROBE_EVENT, () => {
    // Check at startup and lifecycle boundaries, without polling the page.
    if (hooks.some(({ owner, name, wrapped }) => owner[name] !== wrapped)) state = "fallback";
    report();
  });
  report();
})();
