# Preference persistence and recovery

The public settings model remains `{ enabled, scope, siteRules, theme, textScale,
lineHeight, letterSpacing }`. Rules remain normalized objects with `hostname`,
`includeSubdomains`, `enabled`, and `scope`. Matching precedence is unchanged.
The authenticated background writer serializes all mutations. Interface code
submits operations to `LexendPreferences`, rather than writing whole snapshots.

## Stored representation

`LexendSettings.decodeSettings(raw)` reads legacy, object-array and compact
storage representations into the public model. `encodeSettings(settings)`
produces the compact representation for synchronized storage. Compact site
rules are versioned strings under the existing `siteRules` key; exact disabled
hosts need only a hostname. The codec is internal: exports and mutation responses
continue to contain normalized rule objects. Readers retain raw snapshots when
merging storage changes, including deleted keys, and decode after reconciliation.

A mutation commits all changed canonical fields in one `storage.sync.set`. Legacy
keys are cleaned up only after that write succeeds. An interrupted cleanup leaves
harmless legacy data behind; canonical settings take precedence on restart. A
failed write retains the previous configuration. The writer never truncates rules
or asks the user to erase all settings as recovery. Rule capacity measures the
persisted item, including its key, and retains the supported 250-rule ceiling.
Malformed or unknown compact formats fail closed instead of becoming an empty
rule list. Until a readable snapshot loads, all mutations, including replacement
imports, remain blocked. Reloading or using a compatible extension version can
recover a version mismatch; this does not repair arbitrary corrupted storage.

Older extension versions cannot decode compact rules. Mixed-version browser sync
is unsupported: update extensions on synced devices before changing preferences.
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
page discloses replacement and requires an explicit confirmation; cancellation
does not write. The background `replace` operation independently validates the
complete normalized object. A future preview/undo flow can reuse this parser and
writer operation without depending on the storage codec.

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
and site toggles also compare global enablement. These conservative checks keep
newer confirmed edits intact. The client's `confirmedSettings` snapshot excludes
optimistic pending values, so retry baselines reflect confirmed preferences.

## Validation boundaries

Unit/browser fixtures exercise startup event ordering, write failure and retry
supersession, import rejection/cancellation, interrupted migration and restart.
The packaged installed-browser suite seeds authentic lists of 120 and 250 legacy
pauses, proves that the old expanded form exceeds the real storage item quota,
and verifies unrelated concurrent edits and individual deletion. Chromium also
restarts its worker and browser with the migrated list. This does not simulate
every cross-device browser-sync ordering.

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
