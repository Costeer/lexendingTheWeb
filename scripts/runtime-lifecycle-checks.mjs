import assert from 'node:assert/strict';
import { By, Key } from 'selenium-webdriver';

// Shared installed-extension checks. The launcher owns browser setup and
// settings writes; these operations and assertions run against real page DOM.
export async function runLifecycleChecks({ driver, script, wait, check, setSettings }) {
  await setSettings({ enabled: true, layoutRepair: true, scope: 'all', textScale: 110, lineHeight: 0, letterSpacing: 0 });
  await script(() => {
    const fixture = document.createElement('section');
    fixture.id = 'lifecycle-fixture';
    fixture.innerHTML = `<style>
      #lifecycle-state {font:20px/1.2 Arial}
      #lifecycle-state[data-state="large"] {font-size:40px}
      .lifecycle-editor {font:16px/20px Arial; width:180px; height:20px; overflow:hidden}
      #lifecycle-disclosure-text {font:16px/20px Arial; width:150px; height:20px; overflow:hidden;white-space:nowrap}
    </style>
    <p id="lifecycle-state" data-state="small">State-dependent reading text</p>
    <div id="lifecycle-editor-true" class="lifecycle-editor" contenteditable="true">Editable <span>inherited</span><span contenteditable="false">read-only island</span></div>
    <div id="lifecycle-editor-empty" class="lifecycle-editor" contenteditable>Empty syntax <span>inherits</span></div>
    <div id="lifecycle-editor-plain" class="lifecycle-editor" contenteditable="plaintext-only">Plain text editor</div>
    <div id="lifecycle-editor-shadow" contenteditable="true"></div>
    <div id="lifecycle-editor-typing" contenteditable="true" style="font:16px/20px Arial">Draft</div>
    <details id="lifecycle-disclosure"><summary>Open details</summary><div id="lifecycle-disclosure-text">Read these additional disclosure instructions</div></details>`;
    const shadow = fixture.querySelector('#lifecycle-editor-shadow').attachShadow({ mode: 'open' });
    shadow.innerHTML = '<p>Editor-owned shadow content</p>';
    const editors = [...fixture.querySelectorAll('[id^="lifecycle-editor-"]')];
    window.__lifecycleEditors = editors;
    window.__lifecycleOriginal = editors.map(element => element.outerHTML);
    window.__lifecycleShadowOriginal = shadow.innerHTML;
    window.__lifecycleEditorMutations = [];
    window.__lifecycleObserver = new MutationObserver(records => {
      __lifecycleEditorMutations.push(...records.map(record => ({ type: record.type, attribute: record.attributeName })));
    });
    for (const editor of editors) __lifecycleObserver.observe(editor, { childList: true, subtree: true, attributes: true });
    __lifecycleObserver.observe(shadow, { childList: true, subtree: true, attributes: true });
    document.body.append(fixture);
  });

  await check('state-only author typography is remeasured at 110 percent', async () => {
    await wait("getComputedStyle(document.querySelector('#lifecycle-state')).fontSize === '22px'", 'Initial scaled state');
    await script(() => { document.querySelector('#lifecycle-state').dataset.state = 'large'; });
    await wait("getComputedStyle(document.querySelector('#lifecycle-state')).fontSize === '44px'", 'State-only change produces 44px');
  });
  await check('programmatic details disclosure repairs without resize', async () => {
    await script(() => { document.querySelector('#lifecycle-disclosure').open = true; });
    await wait("document.querySelector('#lifecycle-disclosure-text').getBoundingClientRect().height > 20 && document.querySelector('#lifecycle-disclosure-text').hasAttribute('data-lexend-layout-repair')", 'Opening details schedules repair');
  });
  await check('all editor forms and readonly islands preserve author serialization', async () => {
    const result = await script(() => ({
      original: __lifecycleOriginal,
      current: __lifecycleEditors.map(element => element.outerHTML),
      shadowOriginal: __lifecycleShadowOriginal,
      shadowCurrent: document.querySelector('#lifecycle-editor-shadow').shadowRoot.innerHTML,
      mutations: __lifecycleEditorMutations,
      heights: ['true', 'empty', 'plain'].map(kind => document.querySelector(`#lifecycle-editor-${kind}`).getBoundingClientRect().height)
    }));
    assert.deepEqual(result.current, result.original);
    assert.equal(result.shadowCurrent, result.shadowOriginal);
    assert.deepEqual(result.mutations, [], 'No transient extension writes occur inside the editing boundary');
    assert.deepEqual(result.heights, [20, 20, 20]);
  });
  await check('typing selection and native undo survive runtime refresh', async () => {
    await script(() => {
      __lifecycleObserver.disconnect();
      const editor = document.querySelector('#lifecycle-editor-typing');
      editor.focus();
      getSelection().collapse(editor.firstChild, editor.firstChild.length);
    });
    await driver.findElement(By.id('lifecycle-editor-typing')).sendKeys(' hello');
    assert.equal(await script(() => document.querySelector('#lifecycle-editor-typing').textContent), 'Draft hello');
    const before = await script(() => ({ text: getSelection().anchorNode?.textContent, offset: getSelection().anchorOffset }));
    await script(() => { document.querySelector('#lifecycle-state').dataset.state = 'small'; });
    await wait("getComputedStyle(document.querySelector('#lifecycle-state')).fontSize === '22px'", 'Refresh while editor has caret');
    assert.deepEqual(await script(() => ({ text: getSelection().anchorNode?.textContent, offset: getSelection().anchorOffset })), before);
    assert.equal(await script(() => document.activeElement.id), 'lifecycle-editor-typing');
    // Actions preserves the physical undo shortcut on the host's keyboard
    // layout; element.sendKeys mapped this chord to KeyY in the native control.
    await driver.actions().keyDown(Key.CONTROL).sendKeys('z').keyUp(Key.CONTROL).perform();
    assert.equal(await script(() => document.querySelector('#lifecycle-editor-typing').textContent), 'Draft');
  });
  await check('pause and resume leave editor markup intact', async () => {
    const original = await script(() => __lifecycleEditors.map(element => element.outerHTML));
    await setSettings({ enabled: false });
    await wait("!getComputedStyle(document.querySelector('#lifecycle-state')).fontFamily.includes('Lexend')", 'Pause restores ordinary prose');
    assert.deepEqual(await script(() => __lifecycleEditors.map(element => element.outerHTML)), original);
    await setSettings({ enabled: true });
    await wait("getComputedStyle(document.querySelector('#lifecycle-state')).fontSize === '22px'", 'Resume converts current prose');
    assert.deepEqual(await script(() => __lifecycleEditors.map(element => element.outerHTML)), original);
  });
  await script(() => {
    __lifecycleObserver.disconnect();
    document.querySelector('#lifecycle-fixture').remove();
    for (const key of ['__lifecycleObserver', '__lifecycleEditors', '__lifecycleOriginal', '__lifecycleShadowOriginal', '__lifecycleEditorMutations']) delete window[key];
  });
  await check('page-world designMode restores author DOM synchronously and resumes on exit', async () => {
    const result = await script(() => {
      document.designMode = 'on';
      return {
        mode: document.designMode,
        size: getComputedStyle(document.querySelector('#prose')).fontSize,
        markers: document.querySelectorAll('[data-lexend-text],[data-lexend-protected],[data-lexend-layout-repair],[data-lexend-original-typography]').length,
        sheets: document.querySelectorAll('#lexend-the-web-styles,#lexend-the-web-transitions').length,
        fonts: [...document.fonts].filter((face) => /Lexend/.test(face.family)).length
      };
    });
    assert.equal(result.mode, 'on');
    assert.equal(result.size, '20px');
    assert.equal(result.markers, 0);
    assert.equal(result.sheets, 0);
    assert.equal(result.fonts, 0, 'editing documents also release the bundled faces');
    const original = await script(() => document.body.outerHTML);
    await setSettings({ textScale: 120 });
    assert.equal(await script(() => document.body.outerHTML), original);
    await script(() => { document.designMode = 'off'; });
    await wait("getComputedStyle(document.querySelector('#prose')).fontSize === '24px'", 'Leaving document editing resumes conversion');
  });
  await check('pages cannot recognise the extension from its hooks, errors, events, styles or loads', async () => {
    // WebDriver scripts can run outside the page realm (Firefox uses a
    // Marionette sandbox with its own globals and functions). Every probe
    // below therefore runs as an ordinary page script.
    const inPage = (probe) => script((source) => {
      const element = document.createElement('script');
      element.textContent = `document.documentElement.dataset.recognition = JSON.stringify((${source})());`;
      document.documentElement.append(element);
      element.remove();
      const value = document.documentElement.dataset.recognition;
      delete document.documentElement.dataset.recognition;
      return JSON.parse(value ?? 'null');
    }, probe.toString());
    // Page scripts start after the document_start bridge exchange.
    await inPage(() => {
      window.__recognitionHeard = [];
      for (const type of ['lexend-open-shadow-root', 'lexend-design-mode', 'lexend-bridge-offer']) {
        addEventListener(type, (event) => __recognitionHeard.push(event.type), true);
      }
      document.dispatchEvent(new Event('lexend-bridge-request', { cancelable: true }));
      const host = document.createElement('div');
      host.id = 'recognition-host';
      document.body.append(host);
      host.attachShadow({ mode: 'open' }).innerHTML = '<p>Recognition probe text</p>';
      return true;
    });
    await wait("/Lexend/.test(getComputedStyle(document.querySelector('#recognition-host').shadowRoot.querySelector('p')).fontFamily)", 'Private hints still discover the root');
    const result = await inPage(() => {
      const source = (fn) => Function.prototype.toString.call(fn);
      const host = document.querySelector('#recognition-host');
      const setter = Object.getOwnPropertyDescriptor(Document.prototype, 'designMode').set;
      const idSetter = Object.getOwnPropertyDescriptor(Element.prototype, 'id').set;
      const stack = (run) => { try { run(); } catch (error) { return String(error.stack); } return 'no error'; };
      const css = [...document.querySelectorAll('style')].map((style) => style.textContent)
        .concat([...document.styleSheets].map((sheet) => { try { return [...sheet.cssRules].map((rule) => rule.cssText).join(' '); } catch { return ''; } }));
      const visible = { stacks: [stack(() => host.attachShadow({ mode: 'open' })), stack(() => Function.prototype.toString.call({})),
        stack(() => setter.call({}, 'on'))], css, loads: performance.getEntriesByType('resource').map((entry) => entry.name) };
      host.remove();
      // Expected strings come from untouched natives in this same engine.
      const expected = [source(Element.prototype.getAttribute).replace('getAttribute', 'attachShadow'),
        source(idSetter).replace(/(function (?:set )?)id\(/, '$1designMode('), source(Element.prototype.getAttribute).replace('getAttribute', 'toString')];
      return { sources: [source(Element.prototype.attachShadow), source(setter), source(Function.prototype.toString)], expected,
        setterName: setter.name, expectedSetterName: idSetter.name.replace(/id$/, 'designMode'), prototype: Object.hasOwn(Element.prototype.attachShadow, 'prototype'), heard: __recognitionHeard,
        leaks: Object.entries(visible).filter(([, texts]) => texts.some((text) => /-extension:\/\//.test(text))).map(([name]) => name) };
    });
    assert.deepEqual(result.sources, result.expected);
    assert.equal(result.setterName, result.expectedSetterName);
    assert.equal(result.prototype, false);
    assert.deepEqual(result.heard, [], 'Bridge hints and the channel exchange are not observable by page scripts');
    assert.deepEqual(result.leaks, [], 'No page-visible stack, stylesheet or resource load names the extension URL');
    return result;
  });
}
