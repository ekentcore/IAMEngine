## Directory sync (`directory-sync`)

`Module: Coretelligent.ActiveDirectory` (shared) · `Mode: api (agent)` · `Build tier: 2` · `Appears in: ~37%` · `Lanes: both`

Pushes on-prem AD changes up to Entra so 365/downstream see the user. `ad-synced` only.

### Auth
Secret: `ad-dc`. Runs on the Entra Connect / sync server (the agent host or a reachable DC).

### Onboard / Offboard lane
`always` (when backbone is ad-synced). Run `Start-ADSyncSyncCycle -PolicyType Delta`, wait,
and verify the user appears (onboard) or reflects disabled state (offboard) in Entra.

### Config keys
`host` (sync server), `command` (default `Start-ADSyncSyncCycle -PolicyType Delta`),
`waitSeconds`, `verifyTarget`.

### Functions
`Invoke-CtgDirectorySync` (run + poll until reflected, with timeout).

### Depends on
`active-directory` (runs immediately after, both lanes).

### Variants & gotchas
Must execute on the sync server, not just any DC; timing is asynchronous — poll/verify
rather than fixed sleep; only present for ad-synced clients (ad-standalone manages 365
separately, so no sync).

### Manual fallback
A privileged engineer runs the sync command manually if remoting is unavailable.
