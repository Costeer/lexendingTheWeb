# Platform validation

Manifest minimum versions describe where installation is allowed. Release evidence
must also identify which versions, artifacts, and behaviors were exercised. A
passing desktop run does not establish Android or assistive technology coverage.

## Desktop matrix

The reusable `.github/workflows/installed-browsers.yml` workflow reads desktop
minimums from the manifests and runs the packaged extension in each declared
minimum and in stable Chrome and Firefox. CI calls this workflow on pull requests,
main pushes, manual dispatches, and its nightly schedule. It also runs correctness,
package, and Firefox lint checks on Node 22.13.0; the existing CI jobs use Node 24.
The package engine range excludes Node 23, which the locked tooling does not
support.

| Surface | Manifest boundary | Automated target |
| --- | --- | --- |
| Chrome desktop | No `minimum_chrome_version` declared | Stable Chrome for Testing |
| Firefox desktop | `gecko.strict_min_version`: 140.0 | Firefox 140.0 and stable |
| Firefox Android | `gecko_android.strict_min_version`: 142.0 | Separate installed-device verification required |

Chrome's stable result cannot establish a minimum Chrome version. If a minimum
is added to its manifest, the matrix adds it automatically. Changing a manifest
minimum requires examining that version's results; do not substitute current
stable when the requested older engine cannot launch or install the artifact.

The matrix verifies built files against the release ZIPs with `npm run
test:packages` immediately after packaging. After the workflow03 delayed-root
runner is integrated, every matrix entry must also run that installed-browser
runner with `--browser-version "$TEST_BROWSER_VERSION"` set to its requested
numeric minimum or `stable`, plus `--checks scripts/runtime-lifecycle-checks.mjs`
and without `--checks-only`. The default shadow checks alone do not establish
the full lifecycle contract, and any runner failure must block publication.
It must exercise the actual MAIN and ISOLATED execution worlds
using the original manifest entries and production script bytes that match the
verified ZIP. Injected-source `npm test` fixtures do not establish this coverage.
The runner invocation is pending integration; this branch does not invoke an
unavailable script.

From a packaged checkout, use:

```sh
npm ci
npm run package
npm run test:browser -- chrome --browser-version stable --output /tmp/lexend-chrome-stable
npm run test:browser -- firefox --browser-version stable --output /tmp/lexend-firefox-stable
npm run test:browser -- firefox --browser-version 140.0 --output /tmp/lexend-firefox-140
```

On Linux without a desktop, prefix each browser command with `xvfb-run -a`.
Selenium Manager downloads matching browser and driver binaries; its usage
statistics are disabled. The runner asserts that a requested numeric version
matches the actual browser's version prefix. An unavailable download or driver is
a verification failure, not a minimum-version pass.

Each output directory contains `results.json` and applicable screenshots. The
report records requested and actual browser versions, driver version, platform,
the release ZIP path and SHA-256, manifest, and individual check outcomes. It also
includes packaged `build-identity.json` when available; a missing identity is
recorded as `null`, not inferred from a version label. Keep the ZIP with its
report. An absolute output directory outside `dist` survives subsequent builds.
The report also records the harness checkout commit and dirty state when Git
metadata is accessible. For mounted worktrees whose Git directory is outside the
container, `checkout.status` is `unavailable`, with null commit/dirty values and
the error reason. The retained ZIP and harness file hashes remain available;
checkout metadata is not a substitute for the packaged build identity.
CI uploads the exact ZIPs, reports and command logs even when verification fails, and puts
unsupported or failed checks in the job summary.

## Lifecycle evidence

Related-frame checks must observe active typography, restored author typography
after pausing, and active typography again after resuming. Check the reported
frame cases individually, including related-origin `about:blank`, `srcdoc`, and
`blob:` documents. A frame that never received the extension cannot count as a
successful pause. The installed Chromium cross-origin sizing and spoof-rejection
test in `test/typography-browser.test.mjs` supplies separate coverage.

Back/forward history navigation and BFCache restoration are separate outcomes.
BFCache evidence requires a real `pageshow` event with `persisted === true`, a
retained document identity, and reconciliation with preferences changed while the
document was away. Synthetic event dispatch in the unit fixture checks event
handling only. If the browser reloads instead, the installed report records the
BFCache case as `unsupported`, including the observed events and available
restoration diagnostics. That outcome does not count as a BFCache pass even if
ordinary history navigation succeeds or the overall run has no failing checks.

## Device and accessibility checks

Use an installed Firefox Android build on physical hardware or an Android
emulator. Record which one was used, the Android and Firefox versions, device
name, installation method, and the exact extension artifact. A desktop window at
390 CSS pixels checks responsive layout only. An emulator result must not be
reported as a physical-device result.

1. Open the browser's actual extension popup on an ordinary HTTP(S) page. Toggle
   global enablement and pause/resume the site; observe page typography change.
2. Open Settings from the popup, change text size and spacing, create and delete a
   site rule, then reopen both surfaces and confirm the saved values.
3. Exercise scrolling, portrait and landscape layouts, and the Android keyboard.
   Confirm focused controls and save/error feedback remain reachable.
4. Restart Firefox and check the saved setting and site pause. Record screenshots
   or a video with the artifact/version record and each result.

If no device is available, or an unsigned local build cannot be installed in the
available Firefox channel, record that exact limitation and installation error.
Do not record a desktop or uninstalled-page result as an Android pass. No device
or manual result is implied by the repository's automated jobs.

Automated axe scans check selected accessibility rules. Keyboard assertions,
RTL fixtures, zoom checks, editable controls, and native disclosure behavior each
prove their specific tested interactions. They do not establish screen-reader
announcements, touch accessibility, IME behavior, or every editable surface.

Before release, a person should use a screen reader with the installed extension
and record the OS, browser, screen reader and version, and observed results:

1. Navigate the actual popup and Settings with Tab/Shift+Tab, activate controls
   with Space/Enter, and return focus after closing dialogs or deleting a rule.
2. Confirm names, checked/expanded states, saved/error feedback, and import
   confirmation are announced correctly. Include an error/retry path when the
   build provides one.
3. Read and operate RTL text, zoomed controls, a native `<details>` disclosure,
   and a text input or editor before and after pause/resume. Check caret,
   selection, and undo; test IME composition with an actual input method.

## Release record

Keep this evidence with the release candidate, outside directories deleted by
builds. Record `passed`, `failed`, `unsupported`, or `not run` for every surface;
do not turn unavailable coverage into a pass.

- Exact commit, packaged build source hash when present, ZIP SHA-256, and report
  path for each target.
- Requested and actual engine/driver versions for Firefox minimum, Firefox
  stable, and Chrome stable; declare the missing Chrome minimum explicitly.
- Per-frame active/paused/resumed outcomes and genuine BFCache outcomes from
  `results.json`, including reasons for unsupported cases.
- Node version, operating system or container image identity, validation commands,
  and retained logs and failure screenshots.
- Android device/emulator and browser versions, installation method, popup and
  Settings results, and precise unavailable steps.
- Manual keyboard/screen-reader/IME checks, tester and date, versions, observed
  announcements and behavior, and any unperformed checks.

This record is a template, not evidence that these manual checks have happened.
The release publishing workflow must depend on the installed-browser workflow
in addition to the other correctness, interface, and performance gates.
