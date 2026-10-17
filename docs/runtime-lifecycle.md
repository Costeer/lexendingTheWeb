# Runtime lifecycle contracts

See [Layout adjustments](adaptive-layout.md) for the product's editor policy:
editor DOM, read-only islands, and editor-owned shadow content stay author-owned;
mixed ancestors keep their original typography to avoid inheritance into editors.
`LexendProtection` is shared by typography, controls, layout, and root discovery.
Ordinary inputs and textareas retain the existing readable-control behavior;
their values are not HTML editing subtrees.

Ownership follows DOM serialization ancestry and shadow hosts, rather than
visual slot assignment. Light-DOM text slotted into an editor's visual subtree
is not thereby part of the editor's saved shadow markup; if its own DOM ancestry
is not editable, it retains the ordinary reading policy.

## Invalidation and optimization boundaries

The runtime classifies work before the existing coalescing/cooldown scheduler:

| Change | Work |
| --- | --- |
| Inserted branches and open roots | Discover/classify new reading content, then schedule capture and repair |
| Author class, role, editability, icon or opt-out state | Reclassify with a fresh author baseline |
| Author inline style | Compare authored declarations, retain later author writes, and coalesce temporary changes |
| Supported state attributes | Compare the first old value with the final value before recapturing |
| Native disclosure `toggle`, viewport, font, and content visibility signals | Schedule geometry/baseline refresh |
| Unchanged/reverted state and extension-owned mutations | No redundant full conversion |
| Other arbitrary attributes | No blanket observer coverage |

State attributes include `data-state`, `hidden`, `aria-hidden`, `open`,
`aria-expanded`, `aria-selected`, and `aria-pressed`. A 20px author font changed
to 40px by `data-state` becomes 44px at 110% scale. Programmatically opened
`details` repair without needing a resize. CSSOM-only updates and arbitrary
unlisted state attributes are not a general reactive-style contract.

Editor text is excluded from incoming typography traversal. Its mutations may
still alter neighboring geometry, so protection alone is not proof that a
global repair can be skipped. Contained-region optimizations must account for
ancestor selectors, sibling layout effects, slots, and font dependencies. Keep
the conservative global fallback when those dependencies are unknown.
Measurement caches remain pass-local and are invalidated on writes.

## Pause and ownership

Pausing restores owned changes, disconnects the DOM observer, removes extension
styles, and releases strong root references. `layout.dispose()` restores edits
and drops capture-only baselines, text candidates, descendant indexes, pseudo
measurements, panel reservations, ticker state, scroll owners, and frame
qualification. Paused mutations and discovery hints perform no typography reads
or scans. Resume discovers the current document and open roots afresh.

Frame sizing owns a separate group containing the iframe, its clipping ancestors
and any separately adjusted fixed navigation. If any member becomes editor-owned,
the runtime restores the group's author overrides, including synchronously when
entering `designMode`.

This addresses the audited bounded retention of 30 detached roots and 60
baseline elements after pause and replacement. It is not evidence about the
unreproduced memory incident on another device.

## Delayed shadow roots and browser worlds

The second static content-script entry runs `src/shadow-discovery.js` in `MAIN`
at `document_start`. Its wrapper calls native `attachShadow` with the original
receiver and arguments, preserves its return value and errors, and emits a
composed `lexend-open-shadow-root` hint in one microtask for connected open hosts.
Disconnected construction is discovered by ordinary insertion. No persistent
host collection, timer, polling, network, or privileged API is added.

The isolated receiver trusts the current DOM rather than event payload. It
verifies a connected host in the same document with an open root and rejects
known roots, non-hosts, editor-owned boundaries, and paused state before doing
discovery. A forged event cannot select an arbitrary scan root or request
extension privileges. `lexend-design-mode` similarly compares the document's
actual current mode and ignores unchanged hints. Its native setter wrapper emits
the hint synchronously so entering document editing can restore author markup
before the caller serializes the document.

MAIN hooks are best effort: a page can replace them or call a native method
saved before installation/from another realm. Another extension's isolated
`attachShadow` calls do not pass through the MAIN prototype. Those roots can be
found on a later ordinary discovery or resume. Closed shadow boundaries remain
outside the traversal contract. The extension does not poll to bypass these
limits. Hooks remain installed while paused; the receiver does no page work.

## Verification

`test/runtime-lifecycle.test.mjs` covers editor DOM/selection/native Chromium
composition/undo, state/disclosure invalidation, and pause disposal. The installed
proof adds an isolated test-only read/scan counter to a temporary build copy.
It establishes page-world versus isolated-world behavior, including a positive
control showing that an isolated prototype patch cannot intercept page calls:

```sh
npm run build
node scripts/shadow-browser-tests.mjs chrome --output /absolute/evidence/chrome --checks scripts/runtime-lifecycle-checks.mjs
node scripts/shadow-browser-tests.mjs firefox --output /absolute/evidence/firefox --checks scripts/runtime-lifecycle-checks.mjs
node scripts/shadow-browser-tests.mjs firefox --browser-version 140 --output /absolute/evidence/firefox-140 --checks scripts/runtime-lifecycle-checks.mjs
```

The first positional argument remains `chrome` or `firefox`. `--browser-version`
defaults to `stable` and accepts `stable` or a numeric Selenium browser version
with one to four components (for example `140` or `140.0.4`). Empty or malformed
versions fail before starting a browser. Selenium Manager resolves the requested
engine, then the runner verifies the actual capability version matches a numeric
request and meets the built manifest's `minimum_chrome_version` or Firefox
`browser_specific_settings.gecko.strict_min_version`. A mismatch fails before
fixture checks. The Firefox 140 command requests the declared minimum without claiming
that an unexecuted minimum-engine run has passed. `--output` names the evidence
directory. `--checks` loads an ES module exporting `runLifecycleChecks`; without
it, the shadow checks still run and the report scope is `shadow-only`. After a
custom module completes, the full run records `shadow-and-custom`.
`--checks-only` requires `--checks` and runs only
that additional module for diagnosis, which the report labels `custom-only`.
Unknown, duplicate or missing-value flags and invalid browser arguments fail
closed. Explicit output paths must be absolute.

The runner consumes an existing `dist/chrome` or `dist/firefox` build and never
rebuilds it. `results.json` records completed checks on success; `failure.json`
retains completed checks and the error, with `failure.png` and `failure.html`
when a browser was available. Use distinct output directories to preserve failed
runs. Reports retain the requested and actual browser versions, driver version,
all production content-script and web-accessible-resource SHA-256 hashes,
separate original/instrumented manifest hashes, the isolated probe hash, checks,
the packaged minimum version and probe measurements. Firefox installs the exact
`test-instrumented-extension.zip` retained in the output directory through the
local geckodriver path endpoint. Reports include `testInstrumentedArchive`
(path/SHA-256) and `installation` (method `geckodriver-path`, temporary flag, path,
archive SHA-256 and returned add-on ID), including available metadata on failure. Keep the output
directory outside `dist` so builds cannot erase this archive. It remains present
after browser shutdown. This avoids premature deletion of temporary base64
backing files in older Firefox, documented in [Mozilla bug 2045054](https://bugzilla.mozilla.org/show_bug.cgi?id=2045054)
and the [Firefox 140 installation source](https://raw.githubusercontent.com/mozilla-firefox/firefox/FIREFOX_140_0_RELEASE/remote/shared/Addon.sys.mjs).
The runner uses a local driver sharing the archive's filesystem; remote-grid
path installation is outside this contract. Firefox runs require a graphical
display; the pinned Linux container can supply a dedicated Xvfb display.

For a diagnostic negative control, `--negative-bridge-world` changes only the
temporary bridge manifest entry to `ISOLATED`. It runs the same real delayed-root
assertion and must exit nonzero when that assertion times out; it does not turn
an expected failure into a successful command. The report explicitly marks this
as `negativeControl` with `releaseProof: false`, preserves original source hashes
and records the altered manifest hash. It cannot be combined with `--checks-only`
and must never be used as release proof.

Browser-driven composition is not a manual operating-system IME
or assistive-technology check. Run repository tests and the full empirical
comparison after all builds against a commit that predates the changes.
The performance loader includes every content-script resource in its hashes and
sampling, including the MAIN bridge; its controlled page context does not itself
establish extension-world isolation. Installed-browser evidence supplies that
separate guarantee.
