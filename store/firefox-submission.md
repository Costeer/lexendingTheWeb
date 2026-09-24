# Firefox Add-on Developer Hub submission

## Preflight

Run this from a clean checkout with Node.js 20 or newer:

```sh
npm ci
npm run verify:firefox
```

Upload `dist/releases/lexend-the-web-firefox-v<version>.zip`. Do not upload the
Chrome archive. The Firefox archive has `manifest.json` at its root.

The verification command runs the test suite, repository checks, creates fresh
browser packages, and runs Mozilla's `web-ext lint` against `dist/firefox`.
Resolve every linter error, warning, or notice before uploading.

## Developer Hub answers

- Distribution: On this site
- Platforms: Firefox and Firefox for Android
- Category: Accessibility
- License: MIT License
- Source-code submission required: No
- Data collection and transmission: None
- Privacy policy URL:
  `https://github.com/Costeer/lexendingTheWeb/blob/main/PRIVACY.md`
- Homepage URL: `https://github.com/Costeer/lexendingTheWeb`
- Support URL: `https://github.com/Costeer/lexendingTheWeb/issues`

The packaged JavaScript and CSS are the readable, unminified source files. The
build only copies files and selects the Firefox manifest, so there is no
generated or bundled extension code that requires a separate source archive.

Use the summary, detailed description, and permission explanations from
[`listing.md`](listing.md). Upload both `screenshot-*.png` files from
`store/assets/` and provide concise captions describing the controls shown.

## Reviewer notes

No account, API key, or test credentials are required. The extension makes no
network requests and includes the Lexend font locally.

Suggested functional check:

1. Install the submitted archive and open an ordinary HTTP or HTTPS page.
2. Open the toolbar popup and switch between **BODY TEXT** and
   **BODY + HEADERS**; the page updates without a reload.
3. Pause the current site, then resume it.
4. Open **ALL SETTINGS** to edit readability settings and saved site rules.
5. Use the import/export controls to confirm settings files stay local.

Permission rationale:

- Access to HTTP and HTTPS pages is required to inject the locally bundled font
  and update visible typography.
- `storage` saves the enabled state, typography preferences, and user-created
  site rules with Firefox Sync.
Firefox 140 desktop and Firefox for Android 142 are the declared minimums so
the manifest can use Firefox's built-in data-collection disclosure. The
manifest declares `none`, matching the extension's behavior.

## Release checklist

- Confirm the version matches in `package.json` and both manifests.
- Confirm the release version has not previously been uploaded to AMO.
- Run `npm run verify:firefox` from the exact commit being submitted.
- Confirm `web-ext` reports zero errors, warnings, and notices.
- Inspect the ZIP and confirm it contains only runtime files.
- Upload the Firefox ZIP and copy the relevant release notes into AMO.
- Recheck the listing's data-collection answer and privacy-policy link.
- Save the AMO validation result with the release records.
