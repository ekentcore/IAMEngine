## Printix (`printix`)

`Module: Coretelligent.M365` (group-driven) · `Mode: api` · `Build tier: 3` · `Appears in: ~3%` · `Lanes: onboard`

Print management. Printers are assigned by geo security-group membership, so this is
verify/assign-group rather than a direct Printix API call.

### Onboard lane
`on-request`. Add the user to the geo Printix group (e.g. Stamford Printix Users / Houston
Printix Users) based on location; printers are auto-assigned by group membership.

### Config keys
`geoGroups{location:group}`.

### Functions
Handled via `Add-CtgM365GroupMember` / AD group add; `Confirm-CtgPrintixAssignment`.

### Depends on
`m365` / `active-directory` (group membership).

### Variants & gotchas
Geo-based group selection; auto-assignment by group — don't double-provision.

### Manual fallback
Group membership via admin.
