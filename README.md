# Lexend for the Web

A small Chrome and Firefox extension that replaces website typography with
[Lexend](https://www.lexend.com/). Choose between body text only or body text
plus headings, and toggle the effect without reloading the page.

## Features

- Applies Lexend to every HTTP and HTTPS website
- Switches between **body text** and **body + headers**
- Pauses globally or on individual websites
- Supports exact-host and subdomain-wide rules with per-site text scope
- Adjusts base text size, line height, and letter spacing when requested
- Manages, searches, and clears saved site rules from a dedicated settings page
- Toggles the current website with `Ctrl+Shift+L` (`Command+Shift+L` on macOS)
- Updates open tabs as soon as a setting changes
- Handles content added later, open shadow roots, and related iframe documents
- Preserves code, SVGs, common icon-font systems, and opt-out regions
- Imports and exports settings through a versioned JSON file
- Syncs preferences through the browser's extension storage
- Visually distinguishes active and paused toolbar states
- Uses a deliberately light-only, square-cornered interface
- Ships the font locally—no page data or external font request is involved
- Includes Latin, Latin Extended, and Vietnamese Lexend subsets

## Develop

Requirement: Node.js 20+.

```sh
npm test
npm run check
npm run build
```

The browser-ready folders are written to `dist/chrome` and `dist/firefox`.
The popup handles the active website; the browser's extension settings link
opens the full site-rule, readability, and backup manager.

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

This creates Chrome and Firefox ZIP archives in `dist/releases`.

Package filenames include the version from `package.json`. To bump a release,
use `npm version patch`, `npm version minor`, or `npm version major`; the npm
version lifecycle synchronizes both browser manifests automatically.

Pushing a `v*` tag runs the release workflow and publishes both browser ZIPs
to a GitHub release.

## Website opt-out

Extension users can preserve a specific subtree by adding
`data-lexend-ignore` to it. The extension also leaves code, mathematical
notation, SVGs, hidden accessible content, and common icon/symbol containers
alone.

## Privacy

Lexend for the Web does not collect, transmit, or sell data. The only stored data
is the user's enabled state, typography preferences, and user-created site
rules, saved through the browser's synchronized extension storage.

See the complete [privacy policy](PRIVACY.md). A standalone HTML copy lives at
`docs/privacy.html` and is ready for any static host.

## Store submission

Listing copy, permission explanations, screenshots, and promotional graphics
live under `store/`. These assets cover the Chrome Web Store and Firefox
Add-ons submission fields.

## License

Source code is released under the [MIT License](LICENSE). Lexend is distributed
under the [SIL Open Font License 1.1](assets/fonts/LICENSE).
