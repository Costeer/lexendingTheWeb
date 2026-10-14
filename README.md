# Lexend for the Web

A Chrome and Firefox extension that lets you read websites in
[Lexend](https://www.lexend.com/). Choose which text to change, adjust the size
and spacing, and pause it on sites where you prefer the original font.

This is an unofficial project, with no affiliation with or endorsement from
the creators of Lexend.

## Using Lexend

Open the extension from your browser's toolbar. Choose **Body text** to change
paragraphs, links, labels, and controls, or **Body and headings** to include
headings too. The spacing options let you add more room between letters.

The popup and settings page use the Lexend interface, with light and dark themes.

Use **Pause here** to keep the current site's font. Use the switch at the top
of the popup to turn Lexend off everywhere. You can also pause or resume the
current site with `Ctrl+Shift+L` (`Command+Shift+L` on macOS).

Open **Settings** with the gear button to adjust text size, line height, and
letter spacing. The preview offers **Reading**, **Compare**, and **Glyphs** views.
Compare puts a system font at default settings beside Lexend with your settings;
Glyphs shows similar letterforms, numbers, accents, and three font weights.
Use **Try your own text** to preview a sample without saving or sending it.

You can also search and edit saved site rules, or add a rule
that covers a domain and its subdomains. A rule for `example.com` covers only
that hostname unless you select **Include subdomains**; with that option, it
also covers addresses such as `news.example.com`.

Settings sync through your browser when browser sync is enabled. Use the
import and export controls in Settings to save or restore a JSON backup.
Imports show a replacement preview and offer a conditional undo while Settings
stays open. See [site rules and backup recovery](docs/rule-controls.md) for rule
inheritance, Custom values, and recovery limits.
Current-format backups must be complete; supported legacy backups are still accepted.
See the [preference persistence and recovery contract](docs/preferences.md).

## On the page

When text no longer fits, Lexend makes room by letting boxes grow, labels wrap,
or panels scroll. Pause it on a site to return to that site's styles. There's a
short guide to [layout adjustments](docs/adaptive-layout.md).

Code, math, SVG artwork, and common icon fonts keep their original fonts.
Missing icons can use the included Nerd Fonts symbols. Browser settings and
extension stores are off limits to extensions; the popup will tell you when
Lexend can't change a page.

## Privacy

The fonts are included with the extension. Page text stays in your browser,
and the extension has no analytics or trackers. Your preferences and site
rules are saved in your browser's synchronized extension storage; the
developer does not receive them.

Read the [privacy policy](PRIVACY.md) for the full details. The same policy is
available in [HTML](docs/privacy.html) for hosting as a standalone page.

## Build and test

You'll need Node.js 22.13 or newer within the 22.x line, or Node.js 24 or newer,
matching the locked development dependencies. Install the dependencies and
Chromium for the browser tests, then run the tests and repository checks:

```sh
npm ci
npx playwright install chromium
npm test
npm run check
npm run build
```

`npm test` runs at most four test files concurrently because several launch
real browsers. The empirical performance command runs separately on an idle
machine.

Browser-ready files are written to `dist/chrome` and `dist/firefox`.
The build prints their absolute paths. If you are working in a separate Git
worktree, use the folders printed by that worktree's build. Another checkout's
`dist` folder can contain an older extension even when both have the same version.

### Installed-browser regression tests

```sh
npm run package
npm run test:browser -- chrome
npm run test:browser -- firefox
# Exercise the Firefox desktop minimum declared in its manifest:
npm run test:browser -- firefox --browser-version 140.0 --output /tmp/lexend-firefox-140
```

These tests install the built extension into an isolated browser profile and
exercise real synchronized storage, the background worker, document-start
content scripts, typography, exclusions, shadow-root recovery, related frames,
keyboard deletion, imports, and responsive settings and popup layouts. Chrome
also checks forced colors and reduced motion. Selenium Manager downloads matching
browser/driver binaries as needed; its usage statistics are disabled by the test
runner. Reports include actual browser and driver versions and artifact hashes;
results and screenshots default to `dist/browser-tests/`. Use an absolute
`--output` directory outside `dist` to preserve evidence across builds.
The tests open desktop browser windows. On a Linux server without a desktop,
prefix each browser command with `xvfb-run -a`; CI does this automatically so
pointer/hover media queries match the desktop interface.

CI runs stable Chrome and Firefox plus Firefox's manifest-declared desktop minimum
on pull requests, and checks dependency advisories. Chrome currently has no declared
minimum version, so its stable result does not establish a Chrome version floor.
The narrow-window tests cover responsive layout, not Firefox Android's browser
chrome. See [platform validation](docs/platform-validation.md) for the matrix,
evidence requirements, and Android and manual accessibility checks before release.

### Additional regression checks

For runtime changes, compare the working tree against its previous revision:

```sh
npm run test:performance -- --base HEAD
```

Use the PR base (for example `--base origin/main`) if the changes are already
committed. This runs serial Chromium workloads, fails on measured regressions,
and saves raw results and comparison thresholds to `dist/performance/report.json`.
Run it after builds and separately from other tests. See the
[performance guide](docs/performance.md#empirical-regression-gate) for metrics,
tolerances, limitations, and the workflow for models making changes.

`npm test` also runs reproducible generated settings/rule cases, synthetic
cached-page event handling checks, and a 12-cycle dynamic feed stress test. These
events do not prove that a browser restored a cached document. CI repeats the full
suite nightly at 03:17 UTC, with 100 stress cycles. To run the longer test locally:

```sh
LEXEND_STRESS_CYCLES=100 node --test test/typography-stress.test.mjs
```

After packaging, `npm run test:packages` checks both ZIPs against their build
folders and validates runtime references, linked assets, and font licenses.
The installed Chrome suite loads the extracted release ZIP and also restarts
the browser with the same profile to check saved preferences and site pauses.
The installed suites separately record back/forward restoration after preferences
change. Only a retained document with a real `pageshow.persisted` event counts as
BFCache coverage; unavailable restoration is reported explicitly.

The interface suite runs axe accessibility scans, keyboard deletion checks,
asset/error checks, and screenshot comparisons in light and dark themes at
desktop and mobile widths. It loads built interface files with simulated browser
APIs; the installed-browser suite exercises real extension APIs separately.
Run it with `npm run test:ui`. It creates an isolated build in
`dist/ui-tests/build`, without deleting release packages or browser results.
Reports, failure screenshots and traces are saved under `dist/ui-tests/`.

Screenshot baselines in `test/ui/snapshots/` were generated using the same pinned
Playwright Ubuntu image as CI. For matching results on another OS, use Docker:

```sh
docker run --rm --ipc=host \
  -e CI=true -v "$PWD:/work" -w /work \
  mcr.microsoft.com/playwright:v1.63.0-noble \
  bash -lc 'npm ci && npm run test:ui'
```

For an intentional visual change, use `npm run test:ui:update` in that same
container, inspect the changed PNGs, and commit them with the change. Normal CI
runs fail for missing or changed baselines and never update them automatically.
When upgrading Playwright, update both pinned dependencies, both workflow image
references, this Docker command, and the reviewed baselines together. Pull
requests and releases must pass the interface suite; failure reports are uploaded
as GitHub Actions artifacts.

### Load in Chrome

1. Run `npm run build`.
2. Open `chrome://extensions`.
3. Turn on **Developer mode**.
4. Choose **Load unpacked** and select `dist/chrome`.

After rebuilding, click **Reload** on this extension in `chrome://extensions`,
then close and reopen its settings and popup. Refreshing just the settings tab
does not reload the background worker or apply manifest changes.

### Load in Firefox

1. Run `npm run build`.
2. Open `about:debugging#/runtime/this-firefox`.
3. Choose **Load Temporary Add-on**.
4. Select `dist/firefox/manifest.json`.

After rebuilding, use the add-on's **Reload** button in `about:debugging` and
reopen settings so the interface and background scripts come from the same build.

## Package

```sh
npm run package
```

This builds both extensions and creates their ZIP files in `dist/releases`.

Before submitting a release, run `npm run verify:chrome`,
`npm run verify:firefox` (including Mozilla's `addons-linter`), and both
installed-browser regression suites from the exact commit being submitted.
Complete the [platform release record](docs/platform-validation.md#release-record),
including keyboard and screen-reader checks and installed Firefox Android popup
and settings flows. Desktop narrow-window and axe results do not establish those
manual/device checks.

Default rule writes preserve older-readable storage; profiles already using
compact rules still require compatible extension versions on participating
installations. Review the [saved-rule upgrade and rollback plan](docs/rule-format-rollout.md)
before enabling a public migration.

## For website authors

Add `data-lexend-ignore` to an element to keep its original typography,
including all of its children:

```html
<section data-lexend-ignore>Keep this section's fonts and spacing.</section>
```

## License

Source code is released under the [MIT License](LICENSE). Lexend is distributed
under the [SIL Open Font License 1.1](assets/fonts/LICENSE).
The bundled Nerd Fonts symbols fallback includes its
[license](assets/fonts/LICENSE-NERD-FONTS) and
[source and glyph attributions](assets/fonts/README-NERD-FONTS.md).
