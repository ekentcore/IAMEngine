## Egnyte (`egnyte`)

`Module: Coretelligent.Egnyte` · `Mode: api` · `Build tier: 3` · `Appears in: ~12% on / ~30% off` · `Lanes: both`

Cloud file platform. Clean public API for users/groups (the on-prem sync appliance is a
separate module).

### Auth
Secret: `egnyte-portal` (Egnyte Public API token).

### Onboard lane
`always`. Add a Power User; set auth type to SSO; add to groups (AllUsers + requested).

### Offboard lane
`always`. Deactivate/remove the user; reassign or preserve shared content per the case.

### Config keys
`portal`, `userType` (power), `authType` (sso), `groups[]`.

### Functions
`Invoke-CtgEgnyteOnboarding`, `Add-CtgEgnyteGroups`, `Disable-CtgEgnyteUser`.

### Depends on
`m365` / source identity.

### Variants & gotchas
SSO auth type; some Egnyte clients also have the on-prem Sync Server appliance step
(`egnyte-sync-server`).

### Manual fallback
Egnyte admin portal.
