# Lexend the Web

A small Chrome and Firefox extension that replaces website typography with
[Lexend](https://www.lexend.com/). Choose between body text only or body text
plus headings, and toggle the effect without reloading the page.

## Features

- Applies Lexend to every HTTP and HTTPS website
- Switches between **body text** and **body + headers**
- Updates open tabs as soon as a setting changes
- Handles content added later and open shadow roots
- Preserves code, SVGs, common icon containers, and opt-out regions
- Syncs preferences through the browser's extension storage
- Uses a deliberately light-only, square-cornered interface
- Ships the font locally—no page data or external font request is involved

## Develop

Requirement: Node.js 20+.

```sh
npm test
npm run check
npm run build
```

The browser-ready folders are written to `dist/chrome` and `dist/firefox`.

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

## Website opt-out

Extension users can preserve a specific subtree by adding
`data-lexend-ignore` to it. The extension also leaves code, mathematical
notation, SVGs, hidden accessible content, and common icon/symbol containers
alone.

## Privacy

Lexend the Web does not collect, transmit, or sell data. The only stored data
is the user's enabled state and text-scope preference, saved through the
browser's synchronized extension storage.

## License

Source code is released under the [MIT License](LICENSE). Lexend is distributed
under the [SIL Open Font License 1.1](assets/fonts/LICENSE).
