# Site rules and backup recovery

Popup scope and spacing controls change global preferences. The current-site
explanation names the matching rules that supply enablement and scope; these can
come from different rules. Turning Lexend off globally pauses every site, even
when a site rule is enabled.

In Settings → Site rules, open **Edit rule** to change enablement, scope, layout
repair or whether the rule includes subdomains. Each value can inherit independently. Removing an
override lets the next matching rule supply that value, or uses the global default
when no rule supplies it. If all three values inherit, the empty rule is removed.
Changing matching mode cannot overwrite another saved rule for that identity.

Precedence is unchanged: an exact-host rule wins first, followed by the most
specific matching hostname. Enablement, scope and layout repair resolve separately.
For example,
if `example.com` and its subdomains are paused and an exact `news.example.com`
rule changes only scope, that site remains paused. Enabling the exact rule
changes enablement while its inherited scope can still come from `example.com`.

Basic readability controls show selected **Custom** values for saved settings
that differ from the presets. Switching between Basic and Advanced preserves
those values. Advanced visibility is local to the device; the settings sync.

Importing a supported backup opens a replacement preview. It lists changed
global preferences and rules that will be added, removed or changed. Canceling
does not write settings. Applying a stale preview is rejected so a newer edit
cannot be silently replaced.
Applying an import also replaces earlier unsaved intentions for every imported
preference, including values the backup keeps unchanged. An older failed save
cannot reappear through the ordinary Retry control after Apply.

After a confirmed import, **Undo import** is available while that Settings page
remains open. It restores imported changes only where the imported value is
still present, preserving later edits to other settings and rules. A changed
existing rule is recovered field by field; newly imported rules are removed only
when unchanged, and removed rules are restored only when their identity remains
absent. Undo shows a recovery preview before applying. If settings change while
an undo is queued, it fails without writing.
Retries retain the same state guard.
Undo retires earlier unsaved intentions only for the values it restores (or the
whole rule collection when rules change), keeping unrelated failed saves
available for ordinary Retry. Import and undo failures are retried only through
their own preview's Apply control.

Recovery compares normalized values, not a durable edit history. An external
change away from an imported value and then back to that identical value cannot
be distinguished from an unchanged value. After an uncertain connection failure,
if current settings match the file, Settings labels the import as unconfirmed
and keeps conditional recovery available even if an unrelated edit follows.
Matching values cannot establish which writer saved them. Closing the Settings
page discards its undo snapshot. Export a backup when recovery must remain available later.

## Optional layout repair

Layout repair starts off for new and existing profiles. Enable it for the
current site in the popup, or edit a rule in Settings. Repair decisions inherit
independently from enablement and scope. A repair-only rule remains meaningful.

**Enable layout repair on all sites** in Settings temporarily takes precedence
over saved site repair choices. It does not create or change rules; switching it
off restores those choices. The master switch still pauses Lexend everywhere.
See [layout adjustments](adaptive-layout.md) for the effects of repair.

New backups include layout repair choices. Older supported backups without
these settings import with repair off. Current-format backups must be complete.
