# Layout adjustments

Lexend can take up more space than a site's original font. Layout repair is off
by default. Enable **Layout repair on this site** in the popup to save a site
rule, or **Enable layout repair on all sites** in Settings. The all-sites switch
leaves saved site choices intact; turning it off restores those choices.

When enabled, repair measures the page before and after changing the text, then
makes room where that change causes clipping or overlap. Font conversion also
works with repair off.

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

Layout measurements, element boxes, and generated-text styles are reused within
each synchronous pass and invalidated after a repair changes the page.
Protected code subtrees inherit their original typography from the boundary
without styling every token. Rich editing surfaces keep their authored DOM and
typography: this includes empty, true and plaintext-only contenteditable values,
inherited editors, nested read-only islands, recognized code editors and
open-shadow descendants. A designMode document is also author-owned. The
extension does not inject styles or markers inside these surfaces, and preserves
selection, native editing and undo. An ancestor containing an editor keeps its
own typography as well, so direct text on that mixed ancestor remains unchanged.

State changes to class/style, data-state, common disclosure/accessibility state,
and contenteditable are coalesced before a new measurement. Programmatic native
disclosures trigger repair; arbitrary attributes and CSSOM edits do not have
complete invalidation coverage. A synchronous author read immediately after
turning already converted DOM into contenteditable can precede the mutation
observer's restoration; wait for the observer-driven refresh before saving that
new editing surface. Ordinary editor content starts and stays author-owned.

Pausing restores owned changes and releases captured layout and shadow-root
references; resuming discovers the current page afresh. Paused pages skip refreshes; theme changes and rules for other sites also
avoid remeasuring the page.

See [Runtime lifecycle contracts](runtime-lifecycle.md) for discovery boundaries,
measurement ownership, and installed-browser verification.
