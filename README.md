# Lexend for the Web

A Chrome and Firefox extension that replaces website typography with
[Lexend](https://www.lexend.com/).

## Features

- Apply Lexend to body copy alone or include headings.
- Set text size, line height, and letter spacing.
- Pause the extension globally, for one hostname, or for a domain and its
  subdomains.
- Use `Ctrl+Shift+L` (`Command+Shift+L` on macOS) to toggle the current site.
- Import, export, and sync settings through browser storage.
- Keep code, mathematical notation, SVGs, and common icon fonts unchanged.

The font files are bundled with the extension. It does not use analytics or
send page content to a server.

## Develop

Requirement: Node.js 20+.

```sh
npm test
npm run check
npm run build
npm run verify:chrome
npm run verify:firefox
```

Browser-ready files are written to `dist/chrome` and `dist/firefox`.

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

This creates both browser archives in `dist/releases`.

`npm run verify:chrome` runs the tests and checks, then creates a fresh archive
for the [Chrome Developer Dashboard](https://chrome.google.com/webstore/devconsole/).

`npm run verify:firefox` does the same and runs Mozilla's `web-ext` linter. Use
the resulting Firefox ZIP in the
[Firefox Add-on Developer Hub](https://addons.mozilla.org/developers/).

Package filenames use the version from `package.json`. `npm version` also
updates both manifests.

Pushing a `v*` tag runs the release workflow and publishes both browser ZIPs
to a GitHub release.

## Website opt-out

Add `data-lexend-ignore` to any subtree that the extension should leave alone.

## Privacy

Lexend for the Web stores its enabled state, typography preferences, and site
rules in the browser's synchronized extension storage. The developer does not
collect or receive them.

See the complete [privacy policy](PRIVACY.md). A standalone HTML copy lives at
`docs/privacy.html` and is ready for any static host.

## Store submission

Store copy, screenshots, and submission notes live under `store/`. See the
[Chrome checklist](store/chrome-submission.md) or the
[Firefox checklist](store/firefox-submission.md).

## License

Source code is released under the [MIT License](LICENSE). Lexend is distributed
under the [SIL Open Font License 1.1](assets/fonts/LICENSE).
