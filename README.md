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
letter spacing. You can also search and edit saved site rules, or add a rule
that covers a domain and its subdomains. A rule for `example.com` covers only
that hostname unless you select **Include subdomains**; with that option, it
also covers addresses such as `news.example.com`.

Settings sync through your browser when browser sync is enabled. Use the
import and export controls in Settings to save or restore a JSON backup.

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

You'll need Node.js 20 or newer. Install the dependencies and Chromium for the
browser tests, then run the tests and repository checks:

```sh
npm ci
npx playwright install chromium
npm test
npm run check
npm run build
```

Browser-ready files are written to `dist/chrome` and `dist/firefox`.
The build prints their absolute paths. If you are working in a separate Git
worktree, use the folders printed by that worktree's build. Another checkout's
`dist` folder can contain an older extension even when both have the same version.

### Installed-browser regression tests

```sh
npm run package
npm run test:browser -- chrome
npm run test:browser -- firefox
```

These tests install the built extension into an isolated browser profile and
exercise real synchronized storage, the background worker, document-start
content scripts, typography, exclusions, shadow-root recovery, related frames,
keyboard deletion, imports, and responsive settings and popup layouts. Chrome
also checks forced colors and reduced motion. Selenium Manager downloads matching
browser/driver binaries as needed; its usage statistics are disabled by the test
runner. Results and screenshots are written to `dist/browser-tests/`.
The tests open desktop browser windows. On a Linux server without a desktop,
prefix each browser command with `xvfb-run -a`; CI does this automatically so
pointer/hover media queries match the desktop interface.

CI runs both browsers on pull requests and checks dependency advisories. The
narrow-window tests cover responsive layout, not Firefox Android's browser chrome;
the Android add-on still needs device testing before release.

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
Check navigation and rule deletion with a keyboard and screen reader. Also
smoke-test the popup and settings on a real Firefox Android device; desktop
narrow-window tests do not cover Android's extension surface.

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
