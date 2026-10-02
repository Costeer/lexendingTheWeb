# Visual testing on real websites

This harness loads **the URL you supply** in Chromium with the real unpacked
extension. It compares the same page with Lexend paused and enabled, captures
the entire page in readable screenshot tiles, and audits rendered text in
the main document, open shadow roots, and accessible browser frames, including
cross-origin frames. It does not proxy websites or replace them with fixtures.

## Run a website

```sh
npm ci
npx playwright install chromium
npm run build
npm run test:visual -- --url https://example.com --output artifacts/example
npm run test:visual -- --serve artifacts/example
```

Open the report at `http://localhost:4173`. Agents can navigate to that port
using their browser tools or inspect the PNG files directly. Each run produces:

- `index.html`: paired before/after tiles, conversion coverage, and findings.
- `results.json`: case results, findings with element paths, and evidence paths.
- `<case>/elements.json`: every audited text element, its bounds, and typography.
- `<case>/before-full.png` and `after-full.png`: page overview screenshots (capped when `maxTiles` is reached).
- `review-template.json`: required visual assessments for an agent's verdict.

The default matrix uses desktop (1440×900) and narrow mobile (390×844) widths,
and three profiles: current body defaults, all text with readable spacing, and
all text at maximum size with wider spacing. Mobile is a **layout viewport** in
desktop Chromium, not a claim about browser extensions on mobile platforms.
Only Chromium is exercised; Firefox compatibility requires a separate run in
Firefox. Harness files are not shipped in extension packages.

## Test interactive page states

Inspect the real website with your browser tools first. Copy
`harness/example.config.json`, add the selectors for the state you want to
test, and pass `--config path/to/site.json`. Each configuration captures one
page state across the viewport/profile matrix. Run separate configurations
for menus, dialogs, expanded cards, error states, and other flows.

```json
{
  "readyLocator": "main",
  "actions": [
    { "type": "click", "locator": "role=button[name='Accept cookies']" },
    { "type": "click", "locator": "role=button[name='Open menu']" },
    { "type": "wait", "locator": "role=navigation[name='Main menu']" }
  ],
  "settleMs": 1000,
  "maxTiles": 40
}
```

Supported actions are `click`, `focus`, `fill` (`value`), `press` (`key`), `wait`
(`state`, defaults to `visible`), and `scroll` (`x`, `y`, optional `locator`
for an inner scrolling container). A `frame` URL
option targets a specific embedded frame; `frameSelector` targets its iframe
element (useful when several frames have the URL `about:blank`). Actions use Playwright locators.
`afterActions` runs with Lexend already enabled to check newly inserted content.
`captureActions` repeats non-submitting `focus`, `press`, `scroll`, or `wait`
steps after each settings toggle and before each image, so a revealed inner
pane is captured in both typography states. Use it for native consent-pane
scrolling or focus evidence; keep one-time clicks in `actions`/`afterActions`.
New or changed text without a matching baseline makes the run incomplete;
recapture with the corresponding action in `actions` for a complete comparison.
`--headed` displays the actual test browser. Settings and the temporary browser
profile are isolated from your own extension preferences.

The harness confirms a successful refresh with the main frame's content script;
an embedded widget's response cannot acknowledge the main document. Protocol
evaluations are bounded to 15 seconds for the main page and 5 seconds for embedded
frames. Short finite positioning transitions settle before screenshot capture;
continuous animations do not impose an unbounded wait. Screenshots retain the
author animation timeline; they do not fast-forward transitions, fire animation
completion handlers, or temporarily cancel moving artwork. Before capture the
harness waits for a quiet completed extension refresh, with a bounded wait. A
continuously changing page that cannot settle keeps its evidence and receives an
incomplete-state limitation. If screenshot readiness stalls, the harness retains
the currently painted Chromium surface through a bounded protocol capture and
records incomplete screenshot-readiness or font-state evidence. It still checks
Lexend loading and glyph coverage independently; this recovery cannot turn
unloaded or fallback glyphs into a passing result.

For lazy-loaded pages, use scroll/wait actions to load the target content first.
An infinite feed is tested as a bounded state, never as an assertion that all
future content was converted. Scrolling that changes content, frames that
cannot be compared, and truncated screenshot coverage prevent a passing verdict.
Coverage checks use actual scroll positions and final document height, so
stalled scrolling and deferred layout growth are also marked incomplete.
Viewport-sized independently scrolling bodies are detected and tiled using
their actual scroll offsets; window offsets alone would repeat the first tile.
Increase `maxTiles` or stabilize the target state and rerun.

Subtrees skipped by `content-visibility:auto` retain a reveal limitation until
scrolled into view. Their placeholder geometry cannot establish clipping or
readability. The matching painted tile supplies that evidence.

## Agent review procedure

1. Read `results.json`; inspect every before/after tile at native resolution.
   Confirm the title and final URL belong to the intended page rather than an
   access challenge or login screen. Tile paths and element bounds let you
   locate missed conversions visually.
2. Check **all eligible text**, including navigation, headings in full scope,
   forms, tables, captions, menus, and shadow components. Check all deliberate
   exclusions separately: code, math, SVG, icons, opt-outs, and body-scope headings.
3. Judge whether text is **more readable** after conversion: letter shapes,
   size, spacing, contrast, wrapping, and comfort of reading long passages.
   Also inspect overlaps, clipping, truncation, and lost content. Interact with
   important controls on the real site to support the usability assessment.
4. Fill a copy of `review-template.json`. Set `inspectedTiles` to the IDs you
   actually inspected, record concrete case notes, and explain each review flag
   and limitation in its corresponding notes array. Do not bulk approve unread
   screenshots. The harness validates completeness; the agent supplies judgment.
5. Submit the review:

```sh
npm run test:visual -- --output artifacts/example --review /path/to/review.json
```

An automated clean run remains `needs-visual-review`. A passing verdict requires
all tiles inspected, all five case assessments true, no automated errors, and
complete evidence. A failure should name the site, state, element, screenshot,
and why readability or conversion was inadequate. Fix the extension and rerun;
existing evidence is never overwritten.

`--strict` returns exit code 1 for automated errors and 2 for pending visual
review. Review submission returns 0 for pass and 1 for fail or invalid review.
This makes it possible to integrate agents without treating an unreviewed run
as successful.

## What the audit can establish

The DOM audit checks computed font family, font loading, size scaling, requested
line height and letter spacing, preservation of excluded typography, missing
text, new clipping, form overflow, and new horizontal page overflow. It uses
an independent eligibility policy so it can catch gaps in extension selectors.
The audit independently checks registered Lexend Unicode ranges and font-load
state. Unsupported glyphs use the author fallback font and produce a
`font-fallback-coverage` review finding; those elements do not count as fully
converted and cannot pass. Unknown coverage also prevents a pass. Computed font
declarations alone do not prove every glyph was drawn with Lexend.
Each screenshot tile also saves an adjacent `.elements.json` snapshot, so
transient scaling errors are retained even when the final page snapshot looks
correct. An independent imagery audit flags collapsed photos and backgrounds.
It requests review when previously visible artwork moves entirely outside an
equally scrolled paired viewport, so preserved dimensions cannot conceal displacement.
It also requests review of substantial image shrinkage, while recognizing
responsive variants from the same declared picture sources. Text that grows
beyond the document's reachable scroll range is an error. Clipping inside a
scrolling container requires interaction evidence for the affected axis;
horizontal scrolling cannot excuse vertically clipped lines.
Newly split heading words are errors; bounded heading-size adaptations require
visual review. Native select/button-input line heights and deliberate scrollable panels also
require review. Content changing or becoming hidden between states blocks a
passing verdict until equivalent evidence is captured.
Generated content, fallback scripts, canvas text, possible closed shadow roots,
contrast, and overlaps require visual inspection. Generated content, fallback
scripts, canvas, and possible closed roots receive review flags or limitations;
contrast and overlaps must be assessed in every case. Visually hidden labels
are not part of screenshot coverage. Hidden content must be revealed in a
separate state.

`npm test` validates audit and review rules. `npm run test:harness` uses a small
internal adversarial specimen to verify that the detector catches real misses;
that specimen is not the website-testing workflow.

To combine a retained survey, fresh captures, and targeted agent assessments:

```sh
node harness/remediation-report.mjs --survey artifacts/survey-60/summary.json \
  --output artifacts/remediation/report \
  --captures artifacts/remediation/survey-60/summary.json \
  --reviews artifacts/remediation/review-01-20.json
npm run test:visual -- --serve artifacts --port 4180
```

Repeat `--captures` and `--reviews` for additional evidence generations. Open
`/remediation/report/index.html` in the shared preview. Targeted assessments
retain their limitations and never become formal whole-page passing verdicts.

Repair surveys can be consolidated without discarding older evidence:

```sh
node harness/remediation-report.mjs --survey artifacts/survey-60/summary.json \
  --captures artifacts/retest/summary.json --reviews artifacts/retest/agent-review.json \
  --output artifacts/repair-report
npm run test:visual -- --serve artifacts
```

Open `/repair-report/index.html` on the displayed server. New captures appear
first; failed attempts and targeted review limits remain visible. Identical
text replaced at the same DOM location requires a fresh stable baseline.
Overflow inside an iframe hidden by its parent requires a separate revealed
state; it does not establish a visible page regression or compatibility pass.

Per-tile text snapshots record the extension state immediately before and after
serialization, alongside the earlier screenshot readiness state. Pending work or
a changed completed revision makes the evidence incomplete. A continuously
changing feed cannot use an earlier quiet acknowledgement as proof that the
later image and DOM snapshot describe the same completed refresh.
