import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { runInNewContext } from "node:vm";
import test from "node:test";

const source = await readFile(new URL("../src/shadow-detector.js", import.meta.url), "utf8");
const STATE = "lexend-shadow-state-v1";
const PROBE = "lexend-shadow-probe-v1";

function install({ frozen = false } = {}) {
  const calls = [];
  class Node extends EventTarget {
    cloneNode(...args) { calls.push(["cloneNode", this, args]); return { clone: true }; }
  }
  class Element extends Node {
    attachShadow(options) {
      calls.push(["attachShadow", this, options]);
      if (options.fail) throw options.fail;
      return { mode: options.mode };
    }
    setHTMLUnsafe(...args) { calls.push(["setHTMLUnsafe", this, args]); return undefined; }
  }
  class ShadowRoot extends Node {}
  class Document extends Node {
    static parseHTMLUnsafe(...args) { calls.push(["parseHTMLUnsafe", this, args]); return { parsed: true }; }
    importNode(...args) { calls.push(["importNode", this, args]); return { imported: true }; }
    adoptNode(node) { calls.push(["adoptNode", this, node]); return node; }
  }
  const document = new Document();
  const states = [];
  document.addEventListener(STATE, (event) => states.push(event.detail));
  const originalAttach = Element.prototype.attachShadow;
  if (frozen) Object.freeze(Element.prototype);
  runInNewContext(source, { document, Node, Element, ShadowRoot, Document, EventTarget, Event, CustomEvent });
  return { document, Element, Document, Node, states, calls, originalAttach };
}

test("detector announces readiness and can replay its state after listener startup", () => {
  const { document, states } = install();
  assert.deepEqual(states, ["ready"]);
  document.dispatchEvent(new Event(PROBE));
  assert.deepEqual(states, ["ready", "ready"]);
});

test("shadow hooks preserve arguments, receiver, return values and thrown errors", () => {
  const { Element, states, calls, originalAttach } = install();
  const host = new Element();
  const options = { mode: "open" };
  let attached = 0;
  host.addEventListener("lexend-shadow-attached-v1", () => attached++);
  assert.equal(host.attachShadow.name, originalAttach.name);
  assert.equal(host.attachShadow.length, originalAttach.length);
  assert.deepEqual(host.attachShadow(options), { mode: "open" });
  assert.equal(calls[0][1], host);
  assert.equal(calls[0][2], options);
  assert.equal(attached, 1);
  assert.deepEqual(states, ["ready", "shadow"]);
  host.attachShadow({ mode: "open" });
  assert.equal(attached, 2, "each host gets a targeted event even after promotion");
  assert.deepEqual(states, ["ready", "shadow"], "only the first root broadcasts a full-discovery hint");
  const error = new Error("Native failure");
  assert.throws(() => host.attachShadow({ fail: error }), (value) => value === error);
  assert.equal(attached, 2);
});

test("closed shadow roots do not promote ordinary pages", () => {
  const { Element, states } = install();
  new Element().attachShadow({ mode: "closed" });
  assert.deepEqual(states, ["ready"]);
});

test("declarative parsing and DOM cloning/import/adoption conservatively wake discovery", () => {
  for (const operation of ["setHTMLUnsafe", "parseHTMLUnsafe", "cloneNode", "importNode", "adoptNode"]) {
    const { Element, Document, document, states, calls } = install();
    const token = { trustedHTML: true };
    if (operation === "parseHTMLUnsafe") Document[operation](token);
    else if (["importNode", "adoptNode"].includes(operation)) document[operation](token);
    else new Element()[operation](token);
    assert.equal(calls[0][0], operation);
    assert.equal(states.at(-1), "watch", operation);
  }
});

test("parsing targets open roots even after the first conservative signal", () => {
  const { Element, states } = install();
  const host = new Element();
  host.shadowRoot = { mode: "open" };
  let attached = 0;
  host.addEventListener("lexend-shadow-attached-v1", () => attached++);
  host.setHTMLUnsafe("first");
  host.setHTMLUnsafe("second");
  assert.equal(attached, 2);
  assert.deepEqual(states, ["ready", "watch"]);
});

test("a frozen API or a subsequently replaced hook falls back without breaking the page", () => {
  const frozen = install({ frozen: true });
  assert.equal(frozen.states.at(-1), "fallback");
  assert.equal(frozen.Element.prototype.attachShadow, frozen.originalAttach);
  const replaced = install();
  replaced.Element.prototype.attachShadow = replaced.originalAttach;
  replaced.document.dispatchEvent(new Event(PROBE));
  assert.equal(replaced.states.at(-1), "fallback");
});
