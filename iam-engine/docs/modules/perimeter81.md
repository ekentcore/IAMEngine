## Perimeter 81 (`perimeter81`)

`Module: Coretelligent.Perimeter81` · `Mode: api` · `Build tier: 3` · `Appears in: ~1%` · `Lanes: both`

VPN/RDS access. Often laptop-gated and partly group-driven.

### Auth
Secret: `perimeter81` (admin API token).

### Onboard lane
`on-request` (default on if the user receives a laptop). Ensure a license is available;
make a procurement uptick case if not. Membership is frequently group-driven (assign the
Perimeter group in AD/365) rather than adding the user directly.

### Offboard lane
`always` (if the user had it). Remove the member; submit a procurement request to downtick
the license.

### Config keys
`defaultIf` (e.g. laptop), `ensureLicenseAvailable`, `procureIfUnavailable`, `downtickLicense`,
`groupDriven`.

### Functions
`Invoke-CtgPerimeter81Onboarding`, `Remove-CtgPerimeter81Member`.

### Depends on
`m365` / `active-directory` (group membership).

### Variants & gotchas
Group-driven for some clients ("do not add the user"); license downtick is a procurement
action, not an API delete only.

### Manual fallback
Member add/remove via the Perimeter 81 console.
