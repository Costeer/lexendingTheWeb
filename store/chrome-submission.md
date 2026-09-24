# Chrome Web Store submission

## Preflight

Run this from a clean checkout with Node.js 20 or newer:

```sh
npm ci
npm run verify:chrome
```

Upload `dist/releases/lexend-the-web-chrome-v<version>.zip`. Do not upload the
Firefox archive. The Chrome archive has `manifest.json` at its root and
contains only runtime files.

## Store listing

- Language: English
- Category: Accessibility
- Homepage URL: `https://github.com/Costeer/lexendingTheWeb`
- Support URL: `https://github.com/Costeer/lexendingTheWeb/issues`
- Privacy policy URL:
  `https://github.com/Costeer/lexendingTheWeb/blob/main/PRIVACY.md`
- Summary and detailed description: use `store/listing.md`
- Store icon: use `assets/icons/icon-128.png`
- Screenshots: upload both `store/assets/screenshot-*.png` files in numerical
  order

Suggested screenshot captions:

1. Choose where Lexend applies and adjust reading comfort from the toolbar.
2. Pause Lexend for the current website without changing global settings.

## Privacy practices

Single purpose:

> Make HTTP and HTTPS pages easier to read by applying the bundled Lexend font
> and user-selected typography settings.

Permission justifications:

- **Host access (HTTP and HTTPS):** Required to apply the locally bundled
  Lexend font and user-selected typography settings to visible page text. Page
  content is processed locally and is not recorded or sent to the developer.
- **storage:** Saves the enabled state, typography preferences, and
  user-created hostname rules in Chrome's synchronized extension storage.

Remote code:

- Select **No, I am not using remote code**. All JavaScript, CSS, icons, and
  fonts are included in the submitted package.

User data disclosures:

- Disclose **Website content** because the content script processes visible
  text locally to change its typography.
- Disclose **Web history** because the extension reads the current hostname and
  can store user-created hostname rules in Chrome Sync.
- Certify all Limited Use statements. The extension uses this information only
  for its disclosed typography features and does not transfer it to the
  developer or third parties.

Use the privacy policy URL above. Keep these dashboard answers aligned with
`PRIVACY.md`; Chrome requires disclosure even when information is processed
only on-device or stored only with the Chrome Storage Sync API.

## Distribution and reviewer notes

- Visibility: Public, unless a limited rollout is intentional
- Regions: All regions, unless distribution needs to be restricted
- Mature content: No
- Test account or credentials: Not required

Reviewer notes:

> No account, API key, or test credentials are required. The extension makes
> no network requests and includes the Lexend font locally. Install the package,
> open an ordinary HTTP or HTTPS page, and use the toolbar popup to switch text
> scope, adjust spacing, or pause the current site. Open Settings to test the
> remaining readability controls, site rules, and local JSON import/export.

## Final checklist

- Confirm the version matches in `package.json` and
  `manifests/manifest.chrome.json`.
- For an update, confirm the version is greater than the version already in the
  Chrome Web Store.
- Run `npm run verify:chrome` from the exact commit being submitted.
- Load `dist/chrome` as an unpacked extension and test the reviewer flow above
  on a normal HTTP or HTTPS page.
- Upload the Chrome ZIP, listing graphics, copy, and privacy answers specified
  above.
- Check that the developer-account contact email is verified.
- Choose deferred publishing if the release should not go live immediately
  after approval.
