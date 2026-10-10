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
