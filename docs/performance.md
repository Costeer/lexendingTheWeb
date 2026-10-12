# Typography performance

Font conversion now runs separately from layout repair on settled, visible
pages. Native typography and layout are captured together, then Lexend is
applied immediately. The browser receives a rendering frame before the
geometry repair runs. Each phase preserves the current focus and scroll
positions, including scrolling performed between the two phases.

New preferences cancel the previous pending repair. Author mutations invalidate
its baseline and make the next refresh complete capture and repair together,
so animated pages cannot starve repairs. Focused controls, embedded frames, and
hidden documents also complete both phases in the same task. Offscreen frames
cannot rely on animation frames to relay their measured height. The runtime
`pending` flag includes the deferred repair; `refreshRevision` counts successful
conversions.

Startup requests the bundled regular and bold reading fonts before measuring
the page, with a 50 ms limit before fallback conversion proceeds. Confirmed
pause/site preferences are respected, and a newer storage event wins over an
initial read or font preload. A bundled font completing while a repair is
pending uses that repair rather than starting another full conversion. Late
author fonts still require a new native baseline.

Local Chromium measurements at 1280 × 800 compared the previous implementation
with this one on 80- and 400-card pages, each with 500 protected code tokens.
Results are medians of three fresh contexts; each settings sample alternated
110% and 120% scale six times, waiting for repairs to settle between updates.

| Work on the 400-card page | Previous | Current |
| --- | ---: | ---: |
| First rendering frame with loaded Lexend | 610 ms | 240 ms |
| Applying a new font-size preference | 716 ms | 192 ms |
| Rendering newly inserted text in Lexend | 704 ms | 178 ms |
| Preference change through completed layout repair | 730 ms | 644 ms |

These results measure local fixtures, not every website. Moving repair work
after the font's first frame improves visible response more than total repair
time. Measurement caches also freeze ancestor paint properties, bounding boxes,
and pseudo styles for each synchronous pass; every repair write invalidates
them. Sibling collision detection measures each branch once, and already fitting
single-fragment headings avoid measuring every word separately.

The 80-card work-budget fixture dropped from 16,029 bounding-box reads to 2,009
for a complete preference refresh. Its CI budget is 3,500, including both the
font and deferred repair phases. Startup tests cover rendering before repair,
bounded fallback, font failures, preference races, cancellation, and intervening
scrolling:

```sh
node --test test/typography-startup.test.mjs test/typography-performance.test.mjs
```

## Earlier measurement optimizations

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

The regression test checks a deterministic work budget, proportional spacing,
protected descendants, pause/resume, and unrelated settings updates:

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
