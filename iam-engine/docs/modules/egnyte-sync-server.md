## Egnyte Sync Server (`egnyte-sync-server`)

`Module: (Playwright in agent)` · `Mode: browser` · `Build tier: 3` · `Appears in: few` · `Lanes: onboard`

On-prem Egnyte appliance with no documented API — the canonical browser-fallback case.

### Auth
Secrets: `ess-host` (the appliance host login) + `ess-app` (the appliance admin login).
Executed by the client-network agent via Playwright (or surfaced as manual).

### Onboard lane
`always` (for clients with the appliance). User Settings → User Filtering → Add User Account
(random unused password). User Settings → User Mapping → Actions → Refresh and Auto Map
Users. Confirm the user is mapped.

### Config keys
`host`, `applianceUrl`, `steps[]`.

### Functions
Playwright script driven by the agent; `Invoke-CtgEssMapUser`.

### Depends on
`egnyte` (the cloud user must exist before mapping).

### Variants & gotchas
No API — Playwright against the appliance UI, run locally by the agent; falls back to a
manual checklist if Playwright isn't deployed.

### Manual fallback
Primary fallback: the two appliance steps as a case checklist item.
