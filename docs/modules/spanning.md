## Spanning (`spanning`)

`Module: Coretelligent.Spanning` · `Mode: api` · `Build tier: 3` · `Appears in: ~28% on / ~15% off` · `Lanes: both`

SaaS backup (M365 or Google). Notable for strict offboard ordering.

### Auth
Secret: `spanning` (often the 365/Google admin credential).

### Onboard lane
`always`. Sync the user list; assign a backup license once the user appears. Procure via
Kaseya / procurement if none available.

### Offboard lane
`always`, lane-`dependsOn` `exchange` + `m365`. MUST run after the mailbox is converted to
shared and its M365 license removed. Sync, confirm the mailbox appears in Shared Mailboxes,
then swap the Shared Mailbox license → Archive license (procure if unavailable). Archive
licenses only for terminated users, not service accounts.

### Config keys
`licenseType`, `procureIfUnavailable`, `swapLicense{from,to}`, `afterMailboxConvertAndLicenseRemoval`.

### Functions
`Invoke-CtgSpanningOnboarding`, `Invoke-CtgSpanningOffboarding`, `Swap-CtgSpanningLicense`.

### Depends on
`m365` (onboard). Offboard: strictly after `exchange` + `m365` license removal.

### Variants & gotchas
The ordering is load-bearing; archive vs standard license distinction; service-account
exclusion.

### Manual fallback
Spanning portal sync + license swap.

### Force sync (browser automation)
Spanning discovers M365 users on its own schedule — the API has **no** sync endpoint, so onboarding
returns `RetryAfterMinutes` and waits. To make Spanning scan **now**, an ad-hoc `spanning-force-sync`
job drives the Spanning admin portal via the Playwright sidecar (`Invoke-CtgSpanningForceSync` →
`Invoke-CtgBrowserFlow -Flow 'spanning-force-sync'`). Dispatched from the Spanning step in the run
report (`↻ force Spanning sync`), gated on the runner's `browser` capability. See
[docs/BROWSER_AUTOMATION.md](../BROWSER_AUTOMATION.md) — the portal URL + selectors still need
verification against a real login.
