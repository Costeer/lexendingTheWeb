(() => {
  "use strict";

  // This deliberately runs in MAIN, where the page calls attachShadow. An
  // isolated-world prototype patch cannot intercept those calls. Each hint is
  // only a discovery suggestion: the isolated runtime must verify the native
  // host and open root, and must never trust event data for privileged work.
  //
  // Pages must not be able to recognise this bridge, including on paused
  // sites where it still runs. Each hook is a Proxy of the native function, so
  // its name, length, missing prototype and non-constructibility stay native,
  // and Function.prototype.toString reports native source for it. Errors that
  // pass through a hook lose the bridge's own stack frames. Hints use an event
  // type that only this document's isolated runtime learns, exchanged before
  // any page script can listen.
  const attachDescriptor = Object.getOwnPropertyDescriptor(Element.prototype, "attachShadow");
  if (typeof attachDescriptor?.value !== "function") return;
  const apply = Reflect.apply;
  const defineProperty = Object.defineProperty;
  const dispatch = EventTarget.prototype.dispatchEvent;
  const listen = EventTarget.prototype.addEventListener;
  const unlisten = EventTarget.prototype.removeEventListener;
  const preventDefault = Event.prototype.preventDefault;
  const createElement = Document.prototype.createElement;
  const setAttribute = Element.prototype.setAttribute;
  const NativeEvent = Event;
  const NativeFocusEvent = FocusEvent;
  const enqueue = queueMicrotask;
  const connected = Object.getOwnPropertyDescriptor(Node.prototype, "isConnected").get;
  const rootMode = Object.getOwnPropertyDescriptor(ShadowRoot.prototype, "mode").get;
  const nativeToString = Function.prototype.toString;
  const split = String.prototype.split;
  const join = Array.prototype.join;
  const filter = Array.prototype.filter;
  const includes = String.prototype.includes;
  const originals = new WeakMap();
  const weakGet = WeakMap.prototype.get;
  const weakSet = WeakMap.prototype.set;
  const mapGet = Map.prototype.get;

  // Content-script frames name the extension's own URL, which identifies it
  // (and, in Firefox, a stable per-install UUID). Learn this script's URL once.
  const scriptUrl = /([a-z-]+-extension:\/\/[^\s)]+?):\d+:\d+/.exec(new Error().stack ?? "")?.[1] ?? null;
  const rethrow = (error) => {
    try {
      const stack = error?.stack;
      if (typeof stack === "string" && scriptUrl !== null && apply(includes, stack, [scriptUrl])) {
        const lines = apply(split, stack, ["\n"]);
        let outermost = -1;
        for (let index = 0; index < lines.length; index++) if (apply(includes, lines[index], [scriptUrl])) outermost = index;
        // Frames inside the outermost bridge frame, including its own call
        // into the native, are the bridge's. Page frames stay untouched.
        const kept = apply(filter, lines, [(line, index) => !apply(includes, line, [scriptUrl])
          && !(index < outermost && apply(includes, line, ["Reflect.apply"]))]);
        defineProperty(error, "stack", { value: apply(join, kept, ["\n"]), writable: true, configurable: true, enumerable: false });
      }
    } catch { /* An unexpected stack shape must not replace the page's error. */ }
    throw error;
  };
  const disguise = (original, trap) => {
    const proxy = new Proxy(original, { apply: trap });
    apply(weakSet, originals, [proxy, original]);
    return proxy;
  };
  const call = (target, self, args) => {
    try { return apply(target, self, args); } catch (error) { return rethrow(error); }
  };

  // Every frame's bridge hooks the same three functions but knows only its own
  // proxies. A page can compare against another frame's hook, which a native
  // toString prints without a name. Restore just those, in this engine's own
  // format (Firefox, for example, prints native bodies on separate lines).
  const getOwnDescriptor = Object.getOwnPropertyDescriptor;
  const designModeDescriptor = getOwnDescriptor(Document.prototype, "designMode");
  const nativeSources = new Map([[attachDescriptor.value, "attachShadow"], [designModeDescriptor?.set, "set designMode"],
    [nativeToString, "toString"]].filter(([fn]) => typeof fn === "function").map(([fn, name]) => [name, apply(nativeToString, fn, [])]));
  const anonymousNative = apply(nativeToString, new Proxy(nativeToString, {}), []);
  const toString = disguise(nativeToString, (target, self, args) => {
    const source = call(target, apply(weakGet, originals, [self]) ?? self, args);
    if (source !== anonymousNative) return source;
    try { return apply(mapGet, nativeSources, [getOwnDescriptor(self, "name")?.value]) ?? source; } catch { return source; }
  });
  defineProperty(Function.prototype, "toString", { ...Object.getOwnPropertyDescriptor(Function.prototype, "toString"), value: toString });

  // Both content scripts run at document_start, before page scripts, in an
  // unspecified order. Whichever starts second completes the exchange: the
  // isolated runtime accepts an offer by cancelling it, or asks for one with
  // a cancellable request that this bridge answers exactly once.
  const words = crypto.getRandomValues(new Uint32Array(4));
  let hintType = "lexend-";
  for (const word of words) hintType += word.toString(36).padStart(7, "0");
  const offer = () => {
    const carrier = apply(createElement, document, ["span"]);
    apply(setAttribute, carrier, ["data-channel", hintType]);
    return !apply(dispatch, document, [new NativeFocusEvent("lexend-bridge-offer", { cancelable: true, relatedTarget: carrier })]);
  };
  if (!offer()) {
    const answer = (event) => {
      apply(unlisten, document, ["lexend-bridge-request", answer, true]);
      if (offer()) apply(preventDefault, event, []);
    };
    apply(listen, document, ["lexend-bridge-request", answer, true]);
  }
  const hint = (target, bubbles) => {
    try { apply(dispatch, target, [new NativeEvent(hintType, { bubbles, composed: bubbles })]); }
    catch { /* Discovery must never interrupt the page's component. */ }
  };

  defineProperty(Element.prototype, "attachShadow", { ...attachDescriptor, value: disguise(attachDescriptor.value, (target, host, args) => {
    const root = call(target, host, args);
    try {
      if (apply(rootMode, root, []) !== "open" || !apply(connected, host, [])) return root;
      // Let the caller populate its new root in the same task. Hosts attached
      // while disconnected are already covered by ordinary insertion events.
      // No root/host collection survives this single microtask.
      enqueue(() => {
        try { if (apply(connected, host, [])) hint(host, true); } catch { /* See hint(). */ }
      });
    } catch { /* Notification failure must not change a successful attach. */ }
    return root;
  }) });

  // designMode is a DOM property without a corresponding attribute mutation.
  // Announce successful native setter calls synchronously so entering editing
  // mode can restore author markup before the caller serializes its document.
  // The isolated listener verifies the real mode and ignores unchanged hints.
  if (typeof designModeDescriptor?.set === "function") {
    defineProperty(Document.prototype, "designMode", { ...designModeDescriptor, set: disguise(designModeDescriptor.set, (target, owner, args) => {
      const result = call(target, owner, args);
      hint(owner, false);
      return result;
    }) });
  }
})();
