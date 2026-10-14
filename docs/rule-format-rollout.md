# Saved-rule upgrade and rollback

**Publication remains blocked pending the compatibility release's qualification
and the separate release-comparison gate.** The implemented default writer now
keeps unmigrated profiles readable by the supported older versions. It does not
activate compact migration or make already-compact profiles safe for obsolete
writers.

This guide describes the compatibility work following
`55e79688ded6c168406c200bd346524212952bbe`. Historical controls use the audit
baseline `9ba8c632ba900c39c0b102daa163ae3f0409488e` and published `v0.5.0`
(`f2670e24aa210b80f6baedfcf09d22a5dd91e640`); their relevant reader and writer
sources are byte-identical. Other versions require their own checks before being
named supported rollback targets. Qualification must retain the actual current
source and package identities; this document does not establish account-wide sync
or offline-device safety.

## What changes today

The normalized public model and schema 2 export remain unchanged. Current
readers accept object-array `siteRules`, legacy `disabledSites`, and `@1` compact
strings. Unknown or malformed compact strings block reads and mutations, including
replacement imports; they never become an empty rule list.

The background selects the representation from the latest raw storage read:

- Fresh profiles and existing object-array profiles write object arrays.
- Legacy `disabledSites` profiles keep that key while rules remain exact pauses.
  Scalar edits, removal, site toggling and complete imports can retain all 250
  authentic legacy pauses without creating an oversized object array.
- Existing compact profiles retain compact writes, including rich 250-rule edits
  that fit their compact item. No operation migrates an unmigrated profile to
  compact storage, and no operation forces compact data into an oversized array.

Scalar edits and normalized rule no-ops preserve existing rule bytes. A rich
legacy edit can transition to an object array only when its selected item fits.
All changed values commit in one `storage.sync.set`; `disabledSites` removal
follows a successful authoritative `siteRules` commit. Interrupted cleanup leaves
canonical data authoritative. There is no automatic reverse key transition.

The writer checks 250 rules and the selected item's 8,192-byte limit, including
the key and serialized value, before a changed-rule write. Compatible arrays have
less capacity than compact strings. A valid compact-capable 250-rule backup can
therefore fail Apply on an unmigrated profile; the previous configuration is
retained. Existing oversized rules remain readable and survive unrelated edits,
but an edit that still requires an oversized item is rejected. Browser total
quota can reject a locally valid write too.

A confirmed quota rejection does not commit the write. A lost reply or client
timeout can occur after a commit and does not prove storage unchanged. Reconcile
actual storage before backup, rollback or retry. When no storage event accompanied
a successful response, the client rereads raw storage; overlapping responses,
newer events and loads cannot be overwritten by an older reread. Reread failure
keeps the confirmed successful response but disables further writes until reload.

| Operation | Current reader/writer | `v0.5.0` and audit-baseline reader/writer |
| --- | --- | --- |
| Read object-array rules or legacy pauses | Supported | Supported |
| Read `@1` compact rules | Supported | Produces an empty rule list; paused sites can reactivate |
| Edit after reading compact rules | Retains decoded rules | Can overwrite the stored rule list with an empty array or only the newly added rule |
| Import a complete schema 2 backup | Validates normalized rules, then enforces the destination profile’s selected storage capacity before writing | Accepts the format, but enforces its smaller expanded-array capacity |
| Export settings | Downloads normalized objects; does not rewrite storage | Same backup envelope; exporting after a compact read can export the empty interpreted list |

The old decoder gives a present `siteRules` value precedence over `disabledSites`.
Keeping a duplicate legacy pause list therefore does not protect an old reader
from a compact value under that same key. A successful unrelated old preference
write can replace that value because its writer compares the normalized complete
configuration with raw storage. This is a concrete data-loss path, not merely an
unsupported display format.

## Public release sequence

1. **Qualify the implemented compatibility writer.** Retain the multi-format
   decoder and fail-closed behavior, older-readable default writes, authentic
   legacy pause lists and lossless handling of existing compact profiles. Prove
   quota rejection and interrupted cleanup without truncation or changed meaning.
   Do not add startup, timer, unrelated-edit, no-op or import compact migration.
2. **Qualify upgrade and rollback paths.** Exercise the actual old decoder and
   writer against the compatibility release. Cover offline old profiles, queued
   writes, reconnection, imports, quota failures and restart. Retain source/package
   identities and the failed controls. This release becomes the minimum rollback
   target for compact data only after its read/write behavior is proven.
3. **Keep automatic public migration disabled.** Store update availability,
   a reader-release waiting period or observed version markers do not establish
   that no old profile exists. Compact migration requires a separately reviewed
   activation policy. For a public population containing unknown offline devices,
   the default must remain compatible until the old-reader exposure has a
   concrete solution. Moving compact data to another key or dual-writing is not
   an approved shortcut: old writes, reconciliation, quota and rule semantics
   would still require a defined and tested protocol.

The default compatibility writer is implemented; qualification and publication
remain separate decisions. The release-comparison policy is a separate publication
gate, and there is no implemented or approved compact activation switch.

## Controlled migration and offline profiles

A controlled migration can be considered when an operator can enumerate every
profile using the same browser-sync account and keep unknown or offline old
profiles out of that sync group. Record the exact extension version/package on
each profile. Preserve exports before updating, resolve divergent rule lists
explicitly, and establish one intended configuration before allowing writes.

Browser sync runs separately from the extension's interaction controls. Chrome
retains offline changes and resumes sync on reconnection. Firefox desktop can
overwrite a local key with the server value during sync; Firefox Android currently
does not synchronize extension storage with the account. Confirm the browser's
actual sync configuration for each profile. Disabling Lexend, selecting global
Pause or restarting one browser does not prove account-wide sync isolation or
that every device has upgraded. See the official
[Chrome storage documentation](https://developer.chrome.com/docs/extensions/reference/api/storage)
and [Firefox storage.sync documentation](https://developer.mozilla.org/en-US/docs/Mozilla/Add-ons/WebExtensions/API/storage/sync).

Before reconnecting a previously offline profile, preserve its local settings,
update to a compatible reader/writer and reconcile its saved values. Prevent it
from participating in extension-data sync while still running an old decoder;
use verified browser/account controls rather than assuming that disabling the
extension disables sync. Recheck values after sync on every participating profile.
The in-installation writer queue is not a transaction or conflict-resolution
protocol across devices. A whole rule-list conflict can still replace concurrent
edits even when every version understands the encoding.

## Backups and rollback

Before migration or rollback, wait for confirmed saved state, reopen Settings,
verify the intended rules and download the settings export. Preserve divergent
device exports separately. The export uses the displayed normalized model, which
can include an optimistic scalar value during a pending save; it is not a raw
sync-store snapshot or an account-wide point-in-time backup. Exporting does not
change compact storage back to an array.

A current schema 2 file is not universally incompatible with `v0.5.0`: both use
normalized rule arrays and the same seven public fields. However, the old importer
requires no more than 250 rules and at most 7,000 UTF-8 bytes for serialized expanded
rules. A backup accepted by the compact writer can exceed that cap. A successful
old import writes expanded storage and replaces the configuration; it does not
merge changes across devices. Importing in the current version preserves the destination profile’s storage
policy. An existing compact profile stays compact; import is not a downgrade
conversion tool.

**Preferred rollback: use an independently qualified version that understands
compact rules.** Do not reinstall `v0.5.0` over compact data and expect it to recover
the rules. An emergency old-version restore is eligible only if its backup has
been validated against that exact old importer and participating sync profiles
are isolated and coordinated. There is currently no supported lossless old-format
conversion tool. If the old importer rejects the full rule list, retain the backup
and use a compatible release; do not erase or shorten rules to force rollback.

If an old write has already replaced compact rules, the new decoder cannot infer
the missing rules. Preserve current and pre-migration backups, isolate obsolete
writers, review a complete replacement in a compatible version, then verify the
saved result and sync reconciliation. Unknown-format read errors require a reader
that understands that format; the current UI intentionally blocks imports into
unreadable storage. Neither a reload nor deleting all settings is a general repair.

## Source evidence

- [Current codec, storage selection and capacity](../src/settings.js).
- [Serialized writer and raw client reconciliation](../src/preferences.js).
- [Backup export and replacement preview](../options.js) use normalized settings;
  exports are not raw storage snapshots.
- [Install/startup handlers](../src/background.js) do not perform migration.
- [Pinned historical reader/writer fixture](../scripts/fixtures/rule-format-v0.5.0.json)
  retains exact published source bytes and SHA-256 identities. Those same bytes
  occur at the audit baseline. The fixture is test-only and is not packaged as
  production runtime code.
- [Persistence guide](preferences.md),
  [source controls](../test/preferences.test.js),
  [Settings controls](../test/options-rules.test.js), and the
  [installed-browser runner](../scripts/browser-tests.mjs) exercise compatible
  writes, compact preservation, unsafe-capacity rejection, old-reader/writer
  positives and the actual old compact-loss negative control.

The earlier exact-source diagnostic on `61dc886875f82152cc98fdca3656591cc247a377`
showed old readers see zero compact rules and an old Theme-only write erases them.
That remains a real limitation of existing compact profiles. The current default
policy prevents new automatic exposure; it cannot infer rules already lost or
resolve browser-sync conflicts across independently writing installations.
