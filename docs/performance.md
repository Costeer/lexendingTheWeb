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
