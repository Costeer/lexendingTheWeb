# Saved-rule upgrade and rollback

**Recommendation: keep public publication blocked until the default rule-writing
policy remains readable by older installations.** A compatibility reader release
should come first, but its publication or a waiting period cannot prove that every
offline installation has upgraded. The current automatic compact migration is
appropriate only for a controlled set of profiles whose versions and sync state
can all be verified.

This is a release plan, not an implemented migration switch. It describes source
at `61dc886875f82152cc98fdca3656591cc247a377`, the audit baseline
`9ba8c632ba900c39c0b102daa163ae3f0409488e`, and published `v0.5.0`
(`f2670e24aa210b80f6baedfcf09d22a5dd91e640`). Other historical versions need their
own compatibility checks before being named supported rollback targets.

## What changes today

The normalized public model and exported backup format remain unchanged. The
stored `siteRules` value changes from an object array, or legacy `disabledSites`,
to a string beginning `@1\n`. Current readers accept all three representations.
Unknown or malformed compact strings cause a read error and block mutations,
including replacement imports; they do not become an empty rule list.

Loading, installing and restarting do not themselves migrate storage. The first
successful writer operation encodes the complete configuration: changing Theme,
changing readability, toggling a site or applying an import can migrate rules.
Even a scalar operation that changes no scalar value can convert the stored rule
representation. The changed canonical values commit in one `storage.sync.set`;
legacy-key removal follows. A confirmed quota rejection does not commit that
write. A client timeout or lost reply can occur after a commit or while the writer
is still running; it does not prove storage is unchanged. Reread and reconcile
confirmed values before backup, rollback or retry. An interrupted cleanup leaves
the committed canonical representation authoritative.

The writer preserves an existing rule representation when compact rule bytes
exceed 8,192 during a scalar-only edit. Additions, rule updates and imports enforce
250 rules and the 8,192-byte rule item limit, including the key and serialized
value; reads do not truncate oversized existing lists. Total browser storage
quota can reject a write even if these local checks pass. Not every 250-rule list
fits.

| Operation | Current reader/writer | `v0.5.0` and audit-baseline reader/writer |
| --- | --- | --- |
| Read object-array rules or legacy pauses | Supported | Supported |
| Read `@1` compact rules | Supported | Produces an empty rule list; paused sites can reactivate |
| Edit after reading compact rules | Retains decoded rules | Can overwrite the stored rule list with an empty array or only the newly added rule |
| Import a complete schema 2 backup | Validates normalized rules and compact capacity | Accepts the format, but enforces its smaller expanded-array capacity |
| Export settings | Downloads normalized objects; does not rewrite storage | Same backup envelope; exporting after a compact read can export the empty interpreted list |

The old decoder gives a present `siteRules` value precedence over `disabledSites`.
Keeping a duplicate legacy pause list therefore does not protect an old reader
from a compact value under that same key. A successful unrelated old preference
write can replace that value because its writer compares the normalized complete
configuration with raw storage. This is a concrete data-loss path, not merely an
unsupported display format.

## Public release sequence

1. **Prepare a compatibility release.** Retain the current multi-format decoder
   and fail-closed behavior. For profiles that have not deliberately migrated,
   write a representation readable by the supported old versions. Do not convert
   rules on startup, a timer, an unrelated edit, a no-op edit or import. Preserve
   authentic large legacy pause lists rather than expanding them into an item
   that exceeds browser quota. Reject edits that cannot be represented safely;
   do not truncate rules or silently change their meaning. Profiles already
   storing compact rules need readable, lossless handling without forced expansion.
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

These steps require production work: the current writer always requests compact
encoding for rules that fit. Release documentation alone cannot implement them.
The release-comparison policy is a separate publication gate.

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
merge changes across devices. Importing the file in the current version writes
compact storage again and is not a downgrade operation.

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

- [Current codec and capacity](../src/settings.js), lines 94–175; complete import
  validation, lines 178–223.
- [Current serialized writer](../src/preferences.js), lines 96–120; unreadable
  snapshots and client readiness, lines 202–279.
- [Backup export and replacement preview](../options.js), lines 885–957 and
  1012–1048; displayed values are supplied by the client at lines 139–149.
- [Install/startup handlers](../src/background.js), lines 198–218.
- Historical files are available with `git show v0.5.0:src/settings.js` (reader,
  lines 90–109; import/capacity, lines 125–166),
  `git show v0.5.0:src/preferences.js` (writer, lines 37–53), and
  `git show v0.5.0:options.js` (export/import, lines 631–664). The audit baseline
  has the same relevant decoder/writer behavior.
- [Existing persistence guide](preferences.md) and source fixtures in
  [test/preferences.test.js](../test/preferences.test.js), lines 152–200 and
  296–334. Those fixtures cover in-installation migration and failure behavior;
  they do not establish automatic mixed-version browser-sync safety.

An exact-source diagnostic with an in-memory storage adapter confirmed the two
old readers see zero rules where the current reader sees two, an old Theme-only
save removes those rules, a small schema 2 backup imports successfully into both
old versions, and a valid current 250-rule backup is rejected by both old capacity
checks. It also confirmed an unknown `@2` string causes zero current writes. This
diagnostic is not an installed-browser, real-quota or account-sync qualification.
