// Synthetic conversation; this is not a saved ChatGPT DOM or evidence that
// ChatGPT uses this particular author observer.
export const conversationHtml = ({ turns = 120, feedback = true, containment = false } = {}) => `<!doctype html>
<style>
  body {font:16px/24px Arial} main {width:720px} article {padding:12px;${containment ? 'content-visibility:auto;contain-intrinsic-size:auto 250px;' : ''}}
  p {margin:0} pre {font:14px/20px monospace}
</style>
<span id="author-label" style="color:rgb(12, 34, 56)">Conversation actions</span>
<main>${Array.from({ length: turns }, (_, i) => `<article><h2>Reply ${i}</h2>
<p>Install the application and check its release settings. ${'Read the instructions carefully. '.repeat(8)}</p>
<pre><code>${'const value = true;\n'.repeat(8)}</code></pre><button>Copy response</button></article>`).join('')}</main>
<textarea aria-label="Message"></textarea>
<script>
  globalThis.__authorWrites = 0;
  const label = document.querySelector('#author-label');
  globalThis.__authorStyle = label.style.cssText;
  globalThis.__authorObserver = new MutationObserver(() => {
    // Idempotent without Lexend. This models a style-prop owner responding to
    // extension writes, including a whole-attribute replacement.
    if (label.style.cssText !== __authorStyle) {
      __authorWrites++;
      label.style.cssText = __authorStyle;
    }
  });
  ${feedback ? "__authorObserver.observe(label, {attributes:true, attributeFilter:['style']});" : ''}
</script>`;

// Test/profiling instrumentation only: the production script exposes no DOM
// references or global counters. Timings are inclusive and must not be summed.
export const instrumentContent = (source) => {
  const names = ['applyIncomingFonts', 'refresh', 'queueRefresh', 'invalidateAutoContent',
    'measureTypography', 'applyTypography', 'retainOverwrittenTypography', 'notifyFrameRequirement'];
  let wrappers = '';
  for (const name of names) {
    const needle = `const ${name} =`;
    if (!source.includes(needle)) throw new Error(`Cannot instrument ${name}`);
    source = source.replace(needle, `const original_${name} =`);
    wrappers += `const ${name} = (...args) => {
      const start = performance.now(), s = __probe.calls.${name} ??= {count:0, ms:0, max:0};
      s.count++;
      try { return original_${name}(...args); }
      finally { const ms = performance.now()-start; s.ms+=ms; s.max=Math.max(s.max,ms); }
    };\n`;
  }
  source = source.replace('    if (!isActive()) return;\n    // Frameworks', `
    __probe.deliveries++;
    for (const m of mutations) {
      const key = m.type + ':' + (m.attributeName ?? '');
      __probe.mutations[key] = (__probe.mutations[key] ?? 0) + 1;
      const target = m.target.nodeName + '#' + (m.target.id ?? '');
      __probe.targets[target] = (__probe.targets[target] ?? 0) + 1;
    }
    if (!isActive()) return;
    // Frameworks`);
  source = source.replace('    observer.disconnect();\n    try {\n      applyToRoot(document.documentElement);', `
    for (const branch of branches) __probe.incomingNodes += 1 + branch.querySelectorAll('*').length;
    observer.disconnect();
    try {
      applyToRoot(document.documentElement);`);
  return source.replace('  start();', `
    globalThis.__probe = {calls:{}, mutations:{}, targets:{}, deliveries:0, incomingNodes:0};
    ${wrappers}
    globalThis.__collections = () => ({
      managed: managedElements.size,
      detached: [...managedElements.keys()].filter(e => !e.isConnected).length,
      eligibleRoots: eligibleTextRoots.size,
      eligibleDetached: [...eligibleTextRoots.values()].reduce((n, elements) => n + [...elements].filter(e => !e.isConnected).length, 0),
      styledRoots: styledRoots.size,
      detachedRoots: [...styledRoots].filter(e => !e.isConnected).length,
      knownAuto: knownAutoContent.size,
      detachedAuto: [...knownAutoContent.keys()].filter(e => !e.isConnected).length,
      frames: resizedFrames.size,
      authorFamilies: authorFontFamilies.size
    });
    start();`);
};
