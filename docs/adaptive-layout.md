# Layout adjustments

Lexend can take up more space than a site's original font. Layout repair is off
by default. Enable **Layout repair on this site** in the popup to save a site
choice, or **Enable layout repair on all sites** in Settings. The all-sites switch
leaves saved site choices intact; turning it off restores those choices.
Font conversion works with repair off.

When enabled, repair checks whether changing the text causes clipping or overlap.
It can:

- Let text boxes grow and short labels wrap without splitting words.
- Keep buttons and dialog actions reachable, adding scrolling where needed.
- Give wide tables a scrolling area you can focus with the keyboard.
- Keep photos from shrinking when their captions grow.
- Move tooltips back onscreen and keep fixed controls clear of page content.

Text added later, window resizing and newly loaded fonts can trigger another
check. Existing scrolling regions keep their bounds, and repair preserves focus
and scroll positions. Some site changes may require a page refresh.

With **Default** line height and letter spacing, changing text size scales the
site's spacing with it. An explicit spacing setting takes priority.

Code, math, SVG artwork, icon fonts and elements marked `data-lexend-ignore`
keep their original typography. Characters Lexend does not cover use the site's
fallback fonts. Editing surfaces keep their original typography and native
selection and undo behavior; text on an ancestor shared with an editor may also
remain unchanged.

Pausing restores the styles Lexend changed while keeping later site updates.
Resuming checks the current page afresh. If a page still looks wrong, disable
repair or use **Pause here**, then [report the problem](https://github.com/Costeer/lexendingTheWeb/issues).
