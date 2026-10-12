# Typography performance

The optimization work compared complete, synchronous preference refreshes on
a local Chromium page with 80 reading cards, 500 code tokens, and 1,019 elements.
Fonts were loaded before six alternating changes between 110% and 120% text
size, at a 1280 × 800 viewport with default line height and letter spacing.

| Approach | Median refresh | Average computed-style reads |
| --- | ---: | ---: |
| Original engine | 684 ms | 149,508 |
| Reuse layout measurements within a pass | 211 ms | 11,351 |
| Also prune protected branches and reuse typography reads | 205 ms | 7,742 |
| Also scale the original spacing with text | 167 ms | 7,060 |

These are local fixture measurements, not a promise about every website or
machine. The final run used about 76% less time and 95% fewer style reads than
the original. Scaling line height also avoided unnecessary clipping repairs.

The caches live only for a synchronous capture or repair pass. Any repair
write invalidates them globally, including attribute changes that could affect
ancestor or sibling selectors. Capture and repair use separate caches so
native font measurements cannot leak into the converted layout. Text candidates
are grouped by document or shadow root instead of repeatedly filtering the
entire page for each component.

Protected subtrees receive their original typography at the boundary. Code
tokens and opt-out descendants then inherit normally, including relative sizes
and shadow content. Paused pages skip mutation, focus, resize, and preference
refreshes; resuming captures the current page and preferences. Theme changes
and unrelated site rules also skip typography work.

A further experiment removed duplicate inline custom properties from ordinary
text. It produced no consistent timing improvement and complicated later slot
assignment, so the full declarations were retained.

## Geometry and generated-text measurements

A follow-up compared the existing optimized engine with two additional caches.
The local Chromium specimen contained 80 reading cards and 500 code tokens
(916 elements), at 1280 × 800. Each row used eight synchronous changes between
110% and 120% text size after fonts loaded; timings include the complete refresh.

| Approach | Median refresh | Computed-style reads | Bounding-box reads |
| --- | ---: | ---: | ---: |
| Existing optimized engine | 141 ms | 8,171 | 15,984 |
| Cache boxes and box visibility; reuse styles in sibling checks | 132 ms | 7,211 | 2,001 |
| Also cache generated-text styles | 126 ms | 5,297 | 2,001 |

The retained changes remove about 87% of bounding-box reads and 35% of style
reads on this specimen. Wall-clock improvement was about 11%; timings vary
with browser, hardware, and page structure. These results are a separate
comparison from the earlier table, with a different fixture.

Boxes, box visibility, and `::before`/`::after` styles share the existing
pass-local invalidation mechanism. Any repair write, including an attribute
change or table wrapper insertion, discards all caches. Native capture and
converted-layout repair still have separate caches. Nothing is reused across
events, preference changes, or viewport changes.

An additional experiment skipped repeated container-repair passes when no
intervening writes occurred. It showed no consistent timing improvement and
was removed. The regression budget now requires fewer than 7,000 style reads
and 4,000 bounding-box reads for its large-page fixture.

## Continuous updates and responsive navigation

Continuous page updates also need a work budget. After a refresh takes more
than 50 ms, automatic updates leave four times that duration for the website
before another pass. Text insertions can still accelerate a pending style
update, but layout repairs cannot bypass this cooldown. The deadline stays
fixed during a burst, so incoming updates cannot postpone repairs indefinitely.
Explicit preference changes, including pause and resume, still apply immediately.

Font application runs separately from that budget. Startup applies typography
and starts loading the bundled fonts before scheduling the first layout capture
and repair. Parser and navigation mutations apply font families to incoming
branches synchronously in the mutation observer, before the next paint. A slow
repair on a page such as GitHub therefore does not hold new text in its original
font for the duration of the cooldown.

The incoming pass reuses the author-font classification for code, icons,
headings, opt-outs, generated text, and shadow content. It maps the exact font
stacks applied by the extension back to their author families when classifying
new descendants. This avoids inherited Lexend in protected children without
rewriting existing text or measuring the whole page. It changes only families
until the scheduled pass measures sizes and geometry together. Both passes keep reversible author
state, including cloned content, so pausing also restores text inserted during
the cooldown. Startup can apply sizing immediately because no previous layout
repairs are present.

Mutation batches whose final class/style values are unchanged no longer
schedule a refresh. Font transition guards are measured together before any
are released, and scroll offsets are collected before writing anchoring
styles. These changes avoid repeated style calculations within one refresh.
A 200-label fixture with `transition: all .2s` went from 204 style
recalculations per preference refresh to 4.

In a separate local Chromium run with 500 such labels and text changing every
20 ms for about 2.2 seconds, automatic refreshes fell from 13 to 2. Chromium's
main-thread task time fell from 2.257 seconds to 0.432 seconds (about 81%).
This is a single synthetic busy-page measurement, not a guarantee for every
site; individual full-page repairs still run synchronously.

GitHub's responsive navigation exposed a separate feedback loop: hidden links
still reserve space, and the site measures their size to populate its overflow
menu. Removing their layout repairs during a refresh alternated their heights,
which restarted navigation measurement and rebuilt the open menu indefinitely.
Automatic refreshes now retain repairs on `visibility: hidden` elements that
still have layout boxes. Revealing those elements remeasures them, and explicit
preference changes or pausing still restore their original styles. Elements
removed from layout with `display: none` do not retain repairs.

Temporary `aria-hidden` changes are also coalesced across observer deliveries.
If they settle back to their original values before the queued pass, no full
refresh is needed. Persistent changes and accompanying content updates still
refresh normally. The regression fixture uses a real ResizeObserver and an
overflow menu to check that loading and clicking settle without a loop.

The regression tests check deterministic style and geometry read budgets,
the scheduling budget with a controlled clock, unchanged mutation batches,
browser style-recalculation counts, proportional spacing, protected
descendants, pause/resume, and unrelated settings updates. Startup and insertion
regressions hold scheduled tasks to verify that font application and bundled
font loading do not depend on running a layout repair:

```sh
node --test test/typography-performance.test.mjs
```

The wider suite covers reversible repairs, late fonts, icons, transitions,
hover rerenders, cloned content, nested scrolling, frames, and slotted text:

```sh
npm test
npm run verify:firefox
npm run test:browser -- chrome
npm run test:browser -- firefox
```
