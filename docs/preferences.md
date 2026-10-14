# Preference persistence and recovery

The public settings model remains `{ enabled, scope, siteRules, theme, textScale,
lineHeight, letterSpacing }`. Rules remain normalized objects with `hostname`,
`includeSubdomains`, `enabled`, and `scope`. Matching precedence is unchanged.
The authenticated background writer serializes all mutations. Interface code
submits operations to `LexendPreferences`, rather than writing whole snapshots.

## Stored representation

`LexendSettings.decodeSettings(raw)` reads legacy, object-array and compact
storage representations into the public model. The writer uses
`encodeSettingsForStorage(settings, raw)` to preserve the profile's representation:

- Fresh and object-array profiles write older-readable arrays under `siteRules`.
- Legacy `disabledSites` profiles retain that key while every rule is an exact
  pause. This keeps authentic large legacy lists editable without expanding them.
- Profiles already storing compact `@1` rules retain compact encoding. No current
  operation opts an unmigrated profile into compact storage.

Scalar edits and normalized rule no-ops preserve existing rule bytes. A richer
edit to legacy pauses uses an object array only if the selected item fits quota;
otherwise it fails before any write. `encodeSettings(settings)` remains the
explicit compact codec for existing compact data and test fixtures. Exports and
mutation responses always contain normalized rule objects. Readers retain raw
snapshots when merging storage changes, including deleted keys. If a successful
mutation has no observed storage event, the client rereads actual storage rather
than inferring its keys or cleanup from the normalized reply. A failed reread
does not turn the committed save into a failure, but blocks further writes until
a readable reload succeeds.

A mutation commits all changed fields in one `storage.sync.set`. When a legacy
rule list changes to an object array, `siteRules` commits before `disabledSites`
is cleaned up. Interrupted cleanup leaves harmless legacy data behind; canonical
settings take precedence on restart. There is no reverse key transition. A
failed write retains the previous configuration. The writer never truncates rules
or asks the user to erase all settings as recovery. Rule capacity measures the
selected persisted item, including its key, and retains the supported 250-rule
ceiling. Compatible arrays have lower effective capacity than compact strings;
not every 250-rule configuration fits an unmigrated profile. Reads and unrelated
edits preserve existing oversized data; a changed item that remains over quota
is rejected rather than relying on the browser to truncate or accept it.
Malformed or unknown compact formats fail closed instead of becoming an empty
rule list. Until a readable snapshot loads, all mutations, including replacement
imports, remain blocked. Reloading or using a compatible extension version can
recover a version mismatch; this does not repair arbitrary corrupted storage.

Older extension versions cannot decode existing compact rules. The default write
policy avoids introducing that exposure, but does not repair compact data already
replaced by an old writer. Supported old readers can read the compatible formats;
their mutation/import capacity remains smaller, and large legacy lists can still
exceed an old writer's expanded-array quota. Update extensions on synced devices
before changing preferences.
Browser sync retains its normal per-key conflict behavior; the writer serializes
clients within an installation, not simultaneous edits across devices.

## Import contract

Exports use `schemaVersion: 2` and a complete `settings` object with all seven
public fields. Current-format imports must contain those fields, valid values,
and valid distinct rules. Empty or partial current-format files are rejected
before any write. Schema 1 intentionally supports recognized legacy settings,
including `disabledSites` and `spacing`; omitted fields follow legacy defaults.

`validateImport(payload)` returns normalized settings and performs no mutation.
Import replaces the configuration, including the complete rule list. The settings
page shows the complete replacement preview and requires explicit Apply;
cancellation does not write. The background `replace` operation independently validates the
complete normalized object. Import and conditional Undo keep their exact reviewed
snapshot and dedicated retry controls; see [rule and import recovery](rule-controls.md).

Replacement operations may include an `expected` normalized snapshot. The writer
compares it with current settings inside the same serialized queue and rejects
`STALE_IMPORT` before writing if preferences or rule values changed. Rule ordering
does not affect equality. This prevents a delayed replacement from erasing an
earlier queued edit; callers without `expected` retain ordinary replacement
semantics. The guard does not add a transaction across independently synced
devices or detect a value changed away and back to its original state.

Retries can guard smaller operations too. A patch's optional `expected` must
contain each patched field; the writer compares only those fields and rejects
`STALE_SETTINGS` on change. Rule retries compare the expected rule collection,
including rule edits, and site toggles also compare global enablement. These conservative checks keep
newer confirmed edits intact. The client's `confirmedSettings` snapshot excludes
optimistic pending values, so retry baselines reflect confirmed preferences.

## Validation boundaries

Unit/browser fixtures exercise startup event ordering, write failure and retry
supersession, import rejection/cancellation, interrupted representation changes,
raw response rereads and restart. Exact published reader/writer source is retained
with pinned hashes for positive compatible-array and negative compact-loss
controls. The packaged suite seeds authentic 120- and 250-pause legacy lists,
requires a real browser quota rejection for their expanded form, and checks
legacy retention, concurrent scalar edits, deletion and unsafe rich-edit rejection.
Chromium also checks worker and browser restart. These controls do not simulate
every offline profile or cross-device browser-sync ordering; qualification results
must retain the tested source/package identities.

Retry guards are deliberately conservative. If an earlier queued edit commits
after a later attempt captured its baseline, or another page changes the same
field/rules, Retry can report a conflict even when reapplying would be reasonable.
The unsaved operation stays visible; making a new explicit edit establishes fresh
intent. No retry silently adopts a newer saved value as permission to overwrite it.

Interfaces with their own replacement or undo flow can call
`tracker.supersede(fields)` before submitting an accepted operation directly to
the preferences writer. Pass an array of deliberately replaced public field
names: all seven for a complete import, or just restored fields for undo. A
`siteRules` entry conservatively supersedes all tracked rule intents. Invalid
arguments are rejected before changing any ownership. Previewing or cancelling
an import must not supersede intent.

Supersession removes matching pending and failed generic retry ownership without
writing or adding a generic replacement retry. A late failure of an obsolete
operation cannot reappear. The dedicated flow retains its exact operation,
expected-state guard, observed-commit handling, and retry controls. Unrelated
failures remain visible. This explicit action is necessary even when a replacement
keeps the saved value unchanged: equality guards cannot infer the newer user's
intent. Supersession does not cancel writes already in flight.
Tracker state callbacks can still run when obsolete requests settle; interfaces
must give dedicated import/undo pending or failure messages priority over an
empty generic retry state.

A rule edit that changes matching mode owns both its old and new identity for
retry supersession. A newer edit at either identity retires the entire older
atomic operation. A confirmed rename or inherit-both removal fulfills a lost
reply without replaying the operation against a different rule.
