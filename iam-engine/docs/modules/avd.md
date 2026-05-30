## Azure Virtual Desktop (`avd`)

`Module: Coretelligent.AVD` · `Mode: api` · `Build tier: 3` · `Appears in: ~1%` · `Lanes: both`

Session-host assignment for AVD clients.

### Auth
Secret: `m365-admin` / Azure service principal with AVD host-pool rights.

### Onboard lane
`on-request`. Assign the user to the highest-numbered unassigned session host in the host
pool (reuse before deploying); if none free, deploy a new session host and assign.

### Offboard lane
`on-request`. Unassign the user from their session host, then stop the AVD. If unassign
fails, stop the AVD first, then unassign.

### Config keys
`hostPool`, `reuseHighestUnassigned`, `deployIfNone`.

### Functions
`Invoke-CtgAvdAssign`, `Invoke-CtgAvdUnassign`.

### Depends on
`m365` (+ `active-directory` group membership for AVD core group on onboard).

### Variants & gotchas
Stop-before-unassign ordering on offboard; AVD core security group often added in AD.

### Manual fallback
Portal-driven assignment if the API path isn't built yet.
