# Layout adjustments

Lexend can take up more space than a site's original font. The extension
measures the page before and after changing the text, then makes room where
that change causes clipping or overlap.

It can:

- Let text boxes grow and short labels wrap without splitting words.
- Keep buttons and dialog actions reachable, adding scrolling where needed.
- Give wide tables a scrolling area you can focus with the keyboard.
- Keep photos from shrinking when their captions grow.
- Move tooltips back onscreen and keep fixed controls clear of page content.

These adjustments use the page's measured layout, with no rules for specific
websites. Text added later, window resizing, and newly loaded fonts trigger
another check. Focus and scroll positions are preserved.

Height repairs follow the same rules at every window size:

- Expanding text must not shrink its container or erase space allocated to
  children. A repair measures the effect of `height: auto` before keeping it.
- Keep a definite height when automatic sizing would collapse flex or grid
  space, or a child's percentage height. This also applies to narrow columns,
  containers below a header, and pages that have already been scrolled.
- Grow preserved heights only for new overflow. Glyphs extending beyond a
  tight line box must not add page height on every refresh. Preserve fractional
  heights so browser zoom does not introduce an extra scrollbar.
- Recalculate from the site's styles after a resize, and restore those styles
  when Lexend is paused. Existing scrolling regions keep their own bounds.

With **Default** line height and letter spacing, enlarging or shrinking text
scales the site's spacing with it. An explicit spacing setting takes priority;
font-dependent `normal` line height still follows the font's natural metrics.

Code, math, SVG artwork, icon fonts, and elements marked `data-lexend-ignore`
keep their original typography. Characters Lexend doesn't cover use the site's
fallback fonts.

Pausing restores the styles the extension changed while keeping later updates
made by the site. If a page still looks wrong, use **Pause here** in the popup.

Layout measurements are reused within each synchronous pass and invalidated
after a repair changes the page. Protected code and editor subtrees inherit
their original typography from the boundary without styling every token.
Paused pages skip refreshes; theme changes and rules for other sites also
avoid remeasuring the page.
