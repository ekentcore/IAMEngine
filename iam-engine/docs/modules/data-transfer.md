## Data transfer (`data-transfer`)

`Module: cross-cutting (m365 / exchange / google / dropbox)` · `Mode: api` · `Build tier: 2` · `Lanes: offboard`

Not a single integration — the data-custody pattern woven through the offboard side. It
ensures a departing user's data reaches a named recipient (manager / delegate / specified
user) before access is removed. Centralized here so the recipient and retention rules are
defined once per case.

### Inputs (from case payload)
`provideMailboxAccessTo` (delegate), `allowedToMaintainEmail`, plus per-system targets.

### Targets
- Mailbox → convert to shared + add delegate (`exchange`).
- OneDrive → back up to the designated location if under retention (`m365`/`sharepoint`).
- Google Drive → transfer ownership to the recipient (`google-workspace`).
- Google Calendar → transfer events to the recipient (`google-workspace`).
- Dropbox → transfer files to the recipient (`dropbox`).

### Config keys
`recipient` (manager|delegate|named), `retention{backupIfUnderDays,target}`, per-target overrides.

### Behavior
Resolve one recipient for the case; each owning module performs its transfer against that
recipient; `captureEvidence` records pre-removal state. Retention-aware: only back up when
under the policy window. Ordering: transfers happen before the corresponding access removal.

### Depends on
The owning system modules; for Google, the OU-move precedes Drive transfer.

### Variants & gotchas
Recipient varies (manager vs explicitly named delegate); "allowed to maintain email" changes
whether the mailbox/address is preserved; never delete the source until transfer confirms.
