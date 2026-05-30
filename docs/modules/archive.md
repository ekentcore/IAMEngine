## Archive (`archive`)

`Module: Coretelligent.GoogleWorkspace / M365 (scheduled)` · `Mode: api` · `Build tier: 3` · `Lanes: offboard`

The deferred final step of an offboard — the lifecycle's time dimension. Some clients archive
the account only after a 30–90 day grace window (Drive/Google: move to Inactive Users OU and
Archive User; M365/Spanning: swap to archive licensing).

### When
`schedule{offsetDaysMin,offsetDaysMax}` after the offboard date. The exact window is
POC-specified; if not specified, the engine flags it for the requestor (it cannot be skipped).
`immediateTermination` in the case payload collapses this to run now.

### Steps
Google: ensure the user is in the Inactive Users OU, then Archive User. M365 path: confirm
mailbox is shared + licensed appropriately; Spanning archive license already applied.

### Config keys
`offsetDaysMin`, `offsetDaysMax`, `target` (inactive-ou / archive-license), `note`.

### Functions
`Schedule-CtgArchive` (creates a deferred job), `Invoke-CtgArchive`.

### Depends on
The full offboard lane for the client (the grace window starts after teardown).

### Variants & gotchas
Scheduled jobs need a due-date queue + a worker that wakes on schedule; the window must be
captured before close (read out to requestor if missing); archiving cannot be skipped.
