# Typography performance

## Empirical regression gate

Run this on an otherwise idle machine, after building and separately from other
tests. It uses the pinned Playwright Chromium already installed for `npm test`:

```sh
npm run test:performance -- --base HEAD
# For committed changes, select the revision from before the changes:
npm run test:performance -- --base origin/main
```

The command compares that Git revision's runtime scripts and bundled fonts with
the working tree, using the same current harness and fixtures for both. It reads
the old files directly from Git, freezes all tested bytes before running, and
does not check out files or rewrite baselines. Missing revisions/resources,
browser errors, unloaded fonts, unhealthy runtimes, incomplete workloads, and
timeouts fail the command. The installed-extension suites remain necessary for
real storage, background workers, document-start injection, and Firefox.

Each version gets one discarded warm-up and five measured runs per workload,
in fresh browser contexts at 1280 × 800. Versions alternate execution order;
no measured workloads run concurrently. Six settings updates within a context
are averaged into one sample. `--samples 3` is a quicker local check;
`--samples 9` can help investigate noise. CI uses the default five. A changed
sample count must apply equally to both versions.

The reading fixtures have 80 or 400 cards and 500 protected code tokens. They
measure startup against an already populated DOM, six alternating 110%/120%
preference changes, and insertion through completed layout repair. The synthetic
120-reply conversation adds a four-second idle observation with an author style
observer, 100 streamed text edits across microtasks, six tree replacements with
120 shadow roots each, post-GC heap/DOM retention, and pause/resume. The stream
is a burst of existing-text edits, not a timed network stream. Each phase checks
actual Lexend application and sizing, protected code, and a healthy settled
runtime; replacement also checks shadow text. Measurements include deferred
repair. These fixtures cannot establish performance on every real site.

The JSON report records every measured sample, medians, p95, min/max, exact
source/font/harness hashes, Git state, browser/Node/OS/CPU versions, sampling
order, thresholds, and failures. It is written even when a workload fails.
Timing units are milliseconds, heap units are bytes, and work metrics are
counts. `firstFontFrameMs` is the first animation-frame callback observing
loaded Lexend at the requested size; it is a rendering opportunity, not a
compositor paint measurement. `settledMs` includes two consecutive settled
frames. `taskMs` is Chromium's main-thread task-time delta, including the test
driver's small in-page probes, not wall time or whole-browser CPU. Heap is
post-GC V8 heap, not process RSS. Browser layout/style recalculation counts and
refresh counts are also recorded as diagnostics.

The gate checks per-workload medians. An increase must exceed **both** the
relative tolerance and the absolute noise floor:

- First font frame: 30% and 30 ms; complete settling: 30% and 50 ms.
- Main-thread task time: 30% and 25 ms.
- Computed-style reads: 15% and 100 reads; bounding-box reads: 15% and 50 reads.
- Post-GC heap: 20% and 1 MB; live DOM: 5% and 20 nodes.

P95 is reported for diagnosis, not gated with only five samples. Every measured
candidate run must have zero typography reads/refreshes while idle or paused,
at most 1 MB heap growth and at most 20 extra DOM nodes between replacements
2 and 6. These absolute checks apply even when the baseline is already bad.
Existing deterministic regression tests in `npm test` supply tighter targeted
work budgets and longer stress coverage. Tolerances trade sensitivity for
repeatability; a pass means no regression exceeding these limits was detected.

Exit status is 0 for a pass and 1 for a regression or invalid run. CI compares
PRs with their base SHA, pushes with the previous tip, and scheduled/manual runs
with `HEAD^`, uploading the report as `performance-regressions`. A separate job
avoids contention with this repository's other test processes.

For models making changes:

1. Choose a baseline from before the change (`HEAD` only for uncommitted work).
2. Make the change, run correctness checks, then run the comparison by itself.
3. Inspect failures and raw distributions in `dist/performance/report.json`.
   Use `--output dist/performance/investigation.json` to preserve another run.
   Builds clear `dist`; copy evidence elsewhere before rebuilding.
4. Fix regressions. If contention explains a result, preserve the failure and
   rerun both versions together; do not cherry-pick samples or relax thresholds.
5. Report the baseline SHA, result, and report path with the change.

For deeper diagnosis, use the conversation profiler described below. It writes
CPU profiles and traces; those expensive probes are excluded from this gate.

## Runtime design and previous measurements

Font conversion now runs separately from layout repair on settled, visible
pages. Native typography and layout are captured together, then Lexend is
applied immediately. The browser receives a rendering frame before the
geometry repair runs. Each phase preserves the current focus and scroll
positions, including scrolling performed between the two phases.

New preferences cancel the previous pending repair. Content and geometry mutations
invalidate its baseline and make the next refresh complete capture and repair
together, so animated pages cannot starve repairs. Temporary author style and
accessibility changes suspend a pending repair while they coalesce; reverting
them resumes that repair without another conversion. Focused controls, embedded frames, and
hidden documents also complete both phases in the same task. Offscreen frames
cannot rely on animation frames to relay their measured height. The runtime
`pending` flag includes the deferred repair; `refreshRevision` counts successful
conversions.

Startup applies fonts and sizing immediately, then requests the bundled regular
and bold reading fonts before capturing native layout, with a 50 ms limit before
the initial scheduled capture proceeds using fallback metrics. Confirmed
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
was removed. The combined regression budget requires fewer than 7,000 style reads
and 3,500 bounding-box reads across both phases for its large-page fixture.

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

## Conversation feedback investigation (2026-10-12)

The reported ChatGPT hang occurred on another device. Its authenticated
conversation, incident settings, performance trace and heap snapshot were not
available here. The reported 160.5% CPU and approximately 1.5–2 GB renderer
memory remain incident evidence, not measurements reproduced by this fixture.
The original incident's precise trigger is still unconfirmed.

The investigation used source revision
`cc5e738f32f2f25fc3cd6b54d06a5e4ed99b00b4`, rather than assuming the installed
0.5.0 extension was that build. The locally stored settings were scope `all`,
text scale `100`, line height `0`, letter spacing `0`, and one disabled rule for
`www.canva.com`. These are this device's settings, not confirmed incident
settings. Profiling used the same typography settings and no matching site rule;
regressions and installed-extension verification also exercise 120% sizing.

Two defects were reproduced independently of the unavailable conversation:

- An idempotent page observer restores an inline style after Lexend writes it.
  Typography retention answers it, and its restoration invalidates the whole
  page again. Each full refresh restarts the exchange after the cooldown. The
  old source completed 14 refreshes in the 12-second capture and remained
  pending. The first quiet-looking interval did not establish that it settled.
- Editing text whose parent is already managed still runs shadow discovery,
  clone recovery and subtree classification synchronously. In the profiling
  fixture, 100 token updates visited 48,100 elements and spent about 397 ms in
  incoming-font processing, even though those edits introduced no elements.

The CPU profile attributes about 2.47 seconds inclusively to `refresh`, of which
about 1.68 seconds is in `repairLayout` and 0.45 seconds in `captureBaseline`.
Prominent stacks are `repairContainers` / `repairText` → `snapshot` →
`measureSnapshot`, visibility checks and text rectangle measurements. The
trace records 44 layouts (358 ms total) and 1,738 style recalculations (58 ms).
These are nested measurements, not additive totals. Typography-retention writes
and incoming-font work are small in the idle-feedback capture; the expensive
operation is the repeated page-wide layout pass. Frame sizing does not cause
this reproduction. A separate large fixture with automatic content visibility
settled without the style observer.

The fix compares author-style declarations after removing Lexend's applied
values from the comparison. It coalesces temporary style changes across
observer deliveries until the queued deadline, including changes that return
to their baseline. Real style changes, content updates, explicit preferences,
and layout repairs remain enabled. This also handles a reproduced interaction
with Dark Reader's temporary inline colour variables; it does not special-case
ChatGPT, Dark Reader names, or hostnames.

For an element whose author observer repeatedly removes inline typography,
Lexend keeps its declarations in the existing reversible stylesheet. This
avoids another write exchange while retaining typography and sizing. The
latest author baseline is still recorded, subsequent author edits are handled,
and refresh/pause remove the temporary rules. Clones discard the original
owner's rule marker. Existing text edits no longer enter subtree discovery;
new elements still receive fonts before the scheduled full repair.

The fixture is synthetic and is not a saved ChatGPT DOM. Dark Reader 4.9.133
was exercised in dynamic mode in an isolated profile. Adding Stylus 2.4.14
loaded its default configuration, with no matching userstyle; arbitrary
userstyles and the other device's extension settings remain unverified.

### Controlled measurements

Headless Chromium 153.0.8010.12, 1280 × 800, 120 synthetic replies. The
idle comparison excludes the first two seconds and spans approximately ten
seconds of the same fixture; runs were sequential. CPU is percent of one
logical core for the test browser's renderers, not whole-browser CPU.

| Metric during idle window | Disabled | Reported source | Fixed |
| --- | ---: | ---: | ---: |
| Renderer CPU | 1.2% | 27.7% | 1.1% |
| Main-thread task time | 2.6 ms | 2209.0 ms | 3.8 ms |
| Additional full refreshes | 0 | 12 | 0 |
| Renderer RSS at end, before forced GC | 113.8 MiB | 219.3 MiB | 155.7 MiB |

The final incoming-font comparison was approximately 397 ms / 48,100 element
visits before versus 0.1 ms / zero visits after, for 100 edits to existing
text. New branches still receive fonts immediately.

After replacements 6 and 12, fixed-build post-GC V8 heap was 3.29 and 3.47 MiB,
with exactly 1,718 live DOM nodes both times and no detached entries in the
inspected typography, eligible-text, shadow-root or automatic-content maps.
Heap after the subsequent stream was 3.39 MiB. The reported source also had
stable DOM counts and approximately 3.48 MiB heap at both replacement samples.
These results show allocation/renderer-memory churn in this reproduction,
not evidence of the reported device's JavaScript heap leak.

A separate 48-replacement run kept 1,718 live DOM nodes at replacements 24
and 48, with post-GC heaps of 3.55 and 3.62 MiB and zero detached entries in
the inspected collections. After streaming, heap was 3.49 MiB. This bounds the
observed retention for this workload; it cannot establish the remote incident's
heap behaviour.

Validation: 14 focused tests and all 202 project tests passed, as did static
checks and the build. The exact built resources also passed isolated Helium
verification alone and with Dark Reader dynamic mode plus default Stylus.

### Reproduce the evidence

The profiler writes `summary.json`, a DevTools `cpu.cpuprofile`, and a Chromium
`trace.json`. `LEXEND_HEAP_SNAPSHOT=true` also writes `heap.heapsnapshot` after
replacements settle and garbage collection. Its temporary instrumentation is
in `test/helpers/conversation.mjs`; it is not shipped in the content script.
Counters include observer deliveries, mutation types/targets, subtree sizes,
refresh and retention call counts/durations, frame notifications, and collection
sizes/detached entries. The traces retain scheduling call stacks.

Run comparisons sequentially on an otherwise quiet machine:

```sh
mkdir -p /tmp/lexend-reported-source/src
for file in settings adaptive-controls adaptive-layout content; do
  git show "cc5e738:src/$file.js" > "/tmp/lexend-reported-source/src/$file.js"
done
LEXEND_PROFILE_SOURCE=/tmp/lexend-reported-source \
  LEXEND_PROFILE_OUT=/tmp/lexend-before node scripts/profile-conversation.mjs
LEXEND_HEAP_SNAPSHOT=true LEXEND_PROFILE_OUT=/tmp/lexend-after \
  node scripts/profile-conversation.mjs
LEXEND_ENABLED=false LEXEND_PROFILE_CYCLES=0 \
  LEXEND_PROFILE_OUT=/tmp/lexend-disabled node scripts/profile-conversation.mjs
```

Use `LEXEND_PROFILE_EXTENSIONS` with a JSON array of unpacked extension paths
for isolated interaction checks. `LEXEND_STYLE_SAMPLES=true` adds a bounded
sample of old/current inline styles. The synthetic fixture contains no account
or conversation data. CPU timing uses the renderer process CPU-time delta;
main-thread task time is reported separately. RSS is process memory, and
post-GC V8 heap is not interchangeable with RSS. Profiling itself has overhead.

The new performance tests fail against the reported source:

```sh
LEXEND_TEST_SOURCE=/tmp/lexend-reported-source node --test \
  --test-name-pattern='conversation style feedback|streaming existing|temporary theme' \
  test/typography-performance.test.mjs
```

Run the fixed regressions and ordinary project checks:

```sh
node --test test/typography-performance.test.mjs test/typography-stress.test.mjs test/navigation-lifecycle.test.mjs
npm test
npm run check
npm run build
node scripts/verify-conversation-extension.mjs
```

The last command loads this checkout's `dist/chrome` in a fresh browser profile,
fetches the actual extension resources to compare SHA-256 hashes with source,
and exercises idle settling, 120% sizing, streaming, protected code, typing,
pause/resume and navigation. `LEXEND_CHROMIUM_EXECUTABLE` can name a Helium
launcher; `LEXEND_EXTRA_EXTENSION_PATHS` accepts additional unpacked extensions.
Local Helium is 0.15.3.1 (Chromium 151.0.7922.108), not the reported 0.18.2.1.
The normal Helium session and `/home/costeer/git/lexendingTheWeb/dist/chrome`
are separate from this worktree's tested build. Retesting the affected
conversation requires loading this rebuilt checkout on the affected device;
version 0.5.0 alone does not identify the tested code.

## Release evidence and detector controls

CI and tag publishing call the same reusable `performance.yml` workflow. A
release cannot publish until its empirical job succeeds; the publishing job
then downloads and verifies that exact run's report immediately before creating
the release. Reports are uploaded with `if: always()`, including regressions
and invalid browser runs. Packaging does not delete the report because the
publishing job downloads it after all builds and installed-browser checks.

A release tag must be a stable `vMAJOR.MINOR.PATCH` tag matching `package.json`.
The checkout must be that exact clean commit. Its baseline is the highest
lower-version release tag, which must resolve to a **strict ancestor** of the
candidate. An unrelated previous tag or a same-commit version tag fails;
neither can silently fall back to `HEAD`, `HEAD^`, or another newer baseline.
If no lower-version tag exists, the explicit initial anchor is the audited
pre-roadmap revision `9ba8c632ba900c39c0b102daa163ae3f0409488e`. A checkout
missing that anchor or the previous release's resources fails rather than
choosing another baseline. Fetch the full history and tags when reproducing.

```sh
node scripts/release-performance.mjs baseline --tag v0.6.0
npm run test:performance -- --base <printed-baseline-commit>
node scripts/release-performance.mjs verify --tag v0.6.0 --report dist/performance/report.json
```

The version-2 report binds the candidate commit and Git tree, clean source state
at both ends, exact runtime/font hashes for both versions, and current harness
hashes. The release verifier requires all workloads and phases, the unchanged
protocol and comparison policy, five samples plus alternating warm-ups, and
browser/environment identity. It recomputes comparisons from the raw samples;
a manually changed `status: passed`, missing metric, stale commit, altered
harness, relaxed threshold, or candidate-as-baseline report cannot pass.
Local uncommitted comparisons remain supported; their reports simply cannot
serve as release evidence.

Conversation profiling probes require exactly one source anchor for every
insertion. `test/conversation-instrumentation.test.mjs` checks absent and duplicate
anchors (including the previously silent whitespace change), observes a positive
count for newly inserted elements, then restores the historical expensive
existing-text scan in memory and proves that the normal zero-scan assertion
rejects it. These probes do not replace the empirical gate's unmodified-source
measurements.

When changing the harness, run the comparator and release gate negatives:

```sh
node --test test/performance-comparison.test.mjs test/release-performance.test.mjs test/conversation-instrumentation.test.mjs
```

Also demonstrate the actual browser gate rejecting a temporary synchronous
500 ms delay at the start of the candidate's `refresh` function, with exactly
one injection match. Preserve the original bytes, run the full default comparison
against the pre-change revision with `--output` outside `dist`, and restore the
source in a `finally` block. Require exit 1, report status `failed`, and a measured
`settings.taskMs` regression, rather than accepting a harness error. Pass that
same failed report to `release-performance.mjs verify` and require its
`Performance report is not passed` rejection. This is the verifier on the
publishing path; never run a publication to test a negative control. Preserve
the failed report and command logs before rerunning the restored candidate.
