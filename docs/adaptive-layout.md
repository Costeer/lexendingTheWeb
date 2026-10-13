# Layout modes

The extension starts with layout repair **Off**, including when upgrading from
settings that predate layout modes. Lexend, text size, and spacing still apply.
Off is a useful baseline: font changes can naturally reflow a page, but the
extension does not rewrite its layout to compensate.

Choose **Layout on this site** in the toolbar popup:

- **Off** keeps your typography settings and leaves layout constraints alone.
- **Gentle repair** grows a simple text box only when text that originally fit
  becomes clipped. It preserves the requested type size. It does not restructure
  navigation, flex or grid layouts, positioned panels, scrolling regions, or media.
- **Fit text** keeps layout CSS intact and finds the largest fitting font size
  between your requested size and the site's original size. If that cannot fit,
  it tries the site's original typography for that text alone. Ordinary reading
  text keeps Lexend. This mode can locally reduce your chosen size and spacing.

**Use default** removes that site's layout override without removing its pause
or heading preference. Change the global choice in **Settings → Readability →
Default layout mode**. Site choices sync with your other preferences and are
included in settings backups. An exact hostname choice wins over an inherited
subdomain rule. **Settings → Site rules** lets you choose the layout when
creating a rule and change existing rules directly, including rules covering
subdomains. The separate **Lexend** choice controls on/paused behavior; changing
Layout preserves that choice and any saved heading preference. Choose at least
one non-default setting when creating a rule. Edits save automatically, and a
rule with no remaining overrides is removed. Deleting a rule also removes its
pause and scope settings.

## Comparing on a real site

1. Reload the rebuilt extension in your browser and refresh already-open site
   tabs once so they receive the new content script.
2. Keep font size, scope, and spacing fixed. Start with **Off** in the popup.
3. Switch to **Gentle repair**, then **Fit text**, and compare the same area.
   Switching takes effect on open pages without another refresh. Each change
   first restores the preceding mode's edits.
4. Check menus, dialogs, narrow windows, and content loaded after scrolling.
   Leave the best mode selected for that hostname, or choose **Use default**.
5. **Pause here** restores the site's typography too; Off only disables repairs.

A page that already accommodates the changed text may look identical in all
three modes. That's intentional: a mode needs evidence of new overflow before
it can change anything.

## Boundaries and rollback

Both active modes compare native and converted text geometry. They leave
existing clipping, ellipses, line clamps, transformed/animated regions, hidden
labels, code, editors, SVG, and explicit opt-outs alone. Measurements follow
open shadow roots and slot ancestry. Only simple direct text with an unambiguous
box qualifies; complex mixed markup and generated text can remain clipped.

A trial must eliminate the measured new overflow without adding horizontal
page overflow, ancestor clipping, changed neighboring widths, or overlap with
nearby siblings. Failed trials restore their changes. Gentle growth is limited
to the smaller of 96 pixels or the box's existing height. Fit text never squeezes
glyphs with transforms or shrinks below the smaller of the native and requested
font sizes. Falling back to original typography is a local exception.

Repairs have a finite budget: at most 1,500 text candidates and 40 attempted
repairs per pass. These are conservative heuristics, not a guarantee that every
site can be fixed. Long pages may exceed the budget; unusual layouts may receive
no repair. If a mode is unhelpful, use Off or pause that site.

The previous broad engine has been removed. Modes do not insert table wrappers,
change colors, move artwork, resize iframes, rewrite grid tracks, change control
semantics, or convert hidden content into scrolling panels. Restoring an owned
style preserves later inline updates from the site. Cloned repaired elements
carry a small reversible record so copied styles do not become a new baseline.

For debugging, the extension's `LEXEND_GET_STATE` response includes the effective
`layoutMode` and numeric `layout` counts (`candidates`, `changed`, `reverted`,
`skipped`, `limited`). These stay local and contain no page text or URLs beyond
the existing hostname field. `healthy` reports runtime completion, not a visual
quality score. The settings sample previews typography, not live layout repair.
