# Measured typography adaptation

The content script measures author typography before applying Lexend. It reads
all baselines before writing any converted styles, so nested relative font
sizes do not inherit an already enlarged parent. Font transitions are suppressed
during measurement; non-font transitions retain their timing. DOM changes,
responsive layout changes, font loading, and revealed focus states trigger a
new measurement. Open shadow roots and related frames use the same process.

The layout controller compares author geometry with converted geometry. Rules
operate on constraints and measured changes; they do not select website names,
URLs, or author class names.

| Measured problem | Adaptation |
| --- | --- |
| New prose clipping or truncation | Release unsafe height and line-clamp constraints |
| A display word newly splits | Fit complete words within a bounded size and record a review exception |
| A fitted heading retains a large authored side offset | Bound its width to the remaining space after that offset |
| A linked heading newly splits inside a padded card | Treat it as a heading and borrow measured unused card padding while staying inside the painted card |
| Text rows or positioned controls newly collide | Restore the measured gap while preserving positioning |
| Percentage-height artwork collapses when captions grow | Preserve a definite image-container height |
| Expanded light captions cross bright imagery | Add a local dark text backdrop |
| A fixed or embedded viewport panel loses its actions | Bound the panel and expose internal scrolling |
| A nested scrolling disclosure contains hidden text | Keep its scroll viewport when measuring outer containers |
| A native dropdown extends beyond its column | Contain its width and preserve the native arrow |
| Touching button segments acquire different heights | Align the segments to their measured maximum height |
| Short pill text overflows | Allow the complete label to wrap and grow its control |
| Large local padding leaves long prose extremely narrow | Reduce decorative gutters within that local column |
| Originally aligned float rows become staggered | Reflow that sibling group into measured grid columns |
| A bottom utility control grows over the final content | Reserve a reachable footer footprint |
| Empty gradient fades mask expanded prose | Remove the noninteractive fade and retain the full text height in shrinking flex layouts |
| A table becomes wider | Expose a keyboard-focusable horizontal scrolling wrapper |
| A reflowed grid leaves a child in a removed track | Reset that flow child's placement, preserving intentional layered cells |
| A flex text repair would erase a media column | Preserve the measured photographic footprint |
| A short rail caption newly splits a complete word | Expand its local card within the existing scrolling rail |
| A decorative vector border stays smaller than its quotation | Grow the enclosing backdrop and flow footprint |
| A native input's unchanged default prompt no longer fits | Measure that prompt alongside placeholders and enlarge its local control |
| A small embedded announcement exceeds its frame height | Request a bounded measured height from its parent and restore it on pause |
| An enlarged generated tooltip extends offscreen | Shift its measured position within the viewport, retaining text and author visibility |
| A partially visible specimen loses more of its first line | Move its negative-margin flow branch enough to expose that line |
| Tracking spreads joining Arabic glyphs beyond a narrow label | Keep the requested size and line height, with zero added tracking for that script |
| A fixed one-line label gains a small glyph crop | Fit its complete text at or above its original size, then record a visual review |
| A short action word splits inside a bounded link | Keep the whole word on one line or move it as a unit to the next line |

Small quote icons and avatars do not qualify as photographic layers that need
a fixed parent height. Embedded announcement measurements follow the native
startup frame size until a requested parent resize has actually taken effect.

Code, math, SVG artwork, author opt-outs, icon fonts, and private-use glyphs keep
their original typography. Transparent image-replacement labels and fully
clipped focus-only labels also keep their hidden metrics. Visible prose remains
eligible even when its author marks it `aria-hidden`.

All inline writes and attributes record their original values. Pausing restores
them; author changes made after a repair are retained. Table wrappers restore
the original DOM placement. Cloned nodes recover serialized author typography
before a new baseline is taken. Repeated repairs must not increase font size or
footer spacing cumulatively.

Browser regression tests exercise geometry, keyboard reachability, and
restoration. Real-site visual checks also require reviewing complete text,
requested spacing, preserved imagery, and native interactions. Offscreen
carousel states need to be revealed before their readability can be assessed.

Refreshes preserve focus and document, body, and nested scrolling positions.
The runtime state reports whether the most recent refresh completed.

Automatic rendering skips offscreen content whose placeholder geometry cannot
serve as an author baseline. Revealing that subtree triggers a fresh measured
repair. The guard tracks the most recent completed refresh, including repeat
visits and responsive changes. Positioning animations likewise reclassify
previously hidden image-backed labels when they finish.

For constrained visual specimens, a local keyboard-focusable scrolling region
can retain the larger text without losing the surrounding design. This requires
interaction evidence that the final word or column is reachable. Consent copy
can scroll inside a bounded panel while its separate terminal actions remain
visible. These are geometry rules; neither behavior depends on a site's name.

Fixed descendants contribute text geometry only to their owning fixed branch.
A fixed portal's text must not enlarge an unrelated flow container. Repairs of
positioned artwork derive offsets from the captured author position, so repeated
scroll/resize passes remain stable. Bounded dialogs retain their authored
centering transform and make excess text reachable through an internal pane.

A vertically translated announcement track is repaired only when a small
clipping mask contains multiple text frames with exactly one active frame and
no interactive/media content. The mask grows to the active frame, and the track
translation is rebased to its new frame heights. Inactive frames remain clipped.

Short local action labels preserve complete words. Compact fixed utilities may
borrow bounded width while retaining their edge anchor; header action rows can
wrap when their newly enlarged labels no longer fit. A repaired scrolling panel
reveals native focused controls vertically without stealing focus or modifying
the document's horizontal position.

Converted slotted text receives the same typography in its first shadow style
layer, which keeps author shadow-root `!important` slot rules from undoing the
requested size. Registered Lexend subsets use exact, disjoint glyph ranges.
Unsupported scripts retain author fallback glyphs; loading the registered
Lexend faces does not establish full glyph coverage for those scripts.

Font-load refreshes deduplicate immutable Lexend face descriptors. The browser
can emit repeated load events for an already loaded face after temporary author
style restoration; those events must not start an endless refresh cycle. Newly
loaded author faces still trigger a fresh baseline measurement.

Typography baseline measurement suppresses both running font transitions and
zero-duration transitions with a positive delay, including generated text.
Otherwise the browser can retain the previous converted size during the author
measurement and enlarge the same text on every refresh. Non-font transitions
retain their authored timing and pausing restores the original transition rules.

Text and child-list mutations receive an immediate coalesced refresh;
style-only animation updates retain a bounded debounce. The runtime exposes
pending work and a completed refresh revision so screenshot agents can wait
for repaired incoming text without treating the preceding acknowledgement as
proof that the latest DOM update has finished.

If an author hover rerender replaces owned inline typography, the mutation
observer retains the current converted values before paint. The replacement
declarations become the next author baseline and are restored on pause;
unrelated author styles remain intact. Immediate retention is bounded within
each task to prevent competing observers from creating a microtask write loop,
while subsequent animation frames can retain typography again.

An already converted numeric counter can update without a full-page refresh
when its formatting, character count, and measured text width stay the same
and its glyphs still fit the text column and ancestor clips. Changed prose,
new elements, wider numbers, line clamps, and uncertain font features continue
through the full measurement and repair process.

Measured outer heights are converted to the author's `box-sizing` before
writing a minimum height, so content-box padding and borders are counted once.
Originally absolute popups own their protruding text rather than enlarging
their anchor. Far-left focus-only absolute labels keep their hidden geometry
until native focus brings them into view.

Compact multipart selectors can borrow measured free space for a complete
label without discarding their authored transform. An inline action containing
an enlarged block label participates in normal flow inside its fixed footer,
so the footer grows while retaining its bottom anchor.

For eligible painted text with a severe contrast failure, a color repair is
allowed only when its effective background is an established opaque solid
surface. Images, gradients, painted pseudo backdrops, blending, filters, alpha,
disabled controls and hidden states prevent that inference. The original color
is restored on pause. This guard does not certify contrast over arbitrary media.

Inherited typography transitions on nontext wrappers are guarded before any
parent font changes. The whole inherited branch is restored and flushed before
transition guards are released, including cloned branches. This prevents a
short transition from preserving a converted value as a fresh author baseline.

Repaired panel height constraints settle without restarting authored height
animations on each refresh. Other transition properties retain their timing.
An already focused action is revealed after a completed refresh restores saved
scroll positions, using only repaired vertical panes. Empty absolute overlays
without eligible text do not participate in sibling flow collisions; positioned
artwork moves into flow only when enlarged text newly overlaps that artwork.

A fixed banner's matching empty flow reservation may be visually hidden while
still reserving space. Its measured size follows the banner without changing
visibility. An already focused action can be revealed through a native scrolling
pane nested inside an explicitly repaired dialog.

When an originally whole whitespace-delimited Hangul token newly splits and
every complete token fits the column, the local text uses whole-word boundaries
at the requested size. Oversized words retain their existing break behavior.

Small caption frames qualify only when their original text fits their viewport.
The sender, authenticated relay and receiver agree on the 160px starting bound
and bounded growth. Positive caption requests can arrive below the fold; hidden,
transparent or wholly clipped ancestor branches prevent resizing. Original-fit
qualification remains stable across the extension's own centered-frame resize.
