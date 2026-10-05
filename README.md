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

The build writes extensions you can load locally to `dist/chrome` and
`dist/firefox`.

### Load in Chrome

1. Run `npm run build`.
2. Open `chrome://extensions`.
3. Turn on **Developer mode**.
4. Choose **Load unpacked** and select `dist/chrome`.

### Load in Firefox

1. Run `npm run build`.
2. Open `about:debugging#/runtime/this-firefox`.
3. Choose **Load Temporary Add-on**.
4. Select `dist/firefox/manifest.json`.

## Package

```sh
npm run package
```

This builds both extensions and creates their ZIP files in `dist/releases`.

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
