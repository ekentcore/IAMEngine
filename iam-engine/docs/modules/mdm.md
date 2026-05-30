## MDM (`mdm`)

`Module: Coretelligent.Mdm` · `Mode: api` · `Build tier: 3` · `Appears in: ~7%` · `Lanes: both`

Device management — vendor variant: Addigy or Jamf (Mac) or Intune (Windows). Mac-heavy
clients especially.

### Auth
Secret: `mdm-admin` (per-vendor API).

### Onboard lane
`on-request`. Enroll/assign the device to the user; apply the device group/profile.

### Offboard lane
`on-request`, may `requireApproval`. Retire/wipe the device, remove from MDM. Wipe is
gated by written approval (same posture as Google device wipe).

### Config keys
`vendor` (addigy|jamf|intune), `enrollProfile`, `wipeRequiresApproval`.

### Functions
`Invoke-CtgMdmEnroll`, `Invoke-CtgMdmRetire`.

### Depends on
`m365` / identity.

### Variants & gotchas
Vendor-specific APIs behind one interface; wipe approval gate; Windows vs Mac.

### Manual fallback
Vendor console enroll/retire.
