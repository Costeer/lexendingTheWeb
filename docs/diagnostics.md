# Build identity and local diagnostics

Open **About** from settings to see the installed version, browser target, and
complete source fingerprint. Each build includes `build-identity.json`:

```json
{
  "schemaVersion": 1,
  "version": "0.5.0",
  "target": "chrome",
  "sourceHash": "64 lowercase hexadecimal characters"
}
```

The fingerprint covers the actual packaged files (except the identity file
itself), package metadata, locked dependencies, and build/package scripts. Paths
and file bytes are sorted and length-prefixed before SHA-256 hashing. Chrome and
Firefox have different fingerprints because their manifests differ. Timestamps,
Git commit IDs, dirty flags, and checkout paths are excluded. Identical build
inputs produce identical identity files and ZIP bytes; a source edit can change
the fingerprint without changing the displayed release version.

Open the toolbar popup on the affected website and click **Save diagnostics** to
include that page's runtime state. The same button on About provides a general
build/preferences report. Either button creates a local JSON download only when
clicked. The report
contains the build identity, a recognized browser product/version, general
preferences, and a bounded snapshot from the active tab if it responds. It omits
site rules, URLs, hostnames, page text, custom preview text, raw user-agent strings,
and error messages. Errors are represented only by their presence. The operation
does not write preferences, upload the report, or start background collection.

The runtime snapshot uses the existing `LEXEND_GET_STATE` response from the top
frame of one active tab. When About itself is active, there is normally no content
script to respond, so the report marks runtime state unavailable. Restricted tabs,
missing responders, and failed or timed-out reads are also unavailable; they are
not reported as healthy pages. The toolbar popup keeps the website active, so its
export can include runtime state. No other tabs are scanned. Browser versions
from the user-agent fallback may be reduced by the browser. Installed-browser
test reports separately record the actual test environment.

Review the downloaded file before sharing it. Saving does not send it to the
developer. If the build identity is unavailable, rebuild, reload the extension,
and reopen About; the report retains an explicit missing identity instead of
guessing which source was installed.
