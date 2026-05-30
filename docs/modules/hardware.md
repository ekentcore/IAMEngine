## Hardware (`hardware`)

`Module: none (manual)` · `Mode: manual` · `Build tier: 3` · `Lanes: offboard`

Physical device handling on departure — recovery of files and profile cleanup.

### Offboard lane
`on-request`. If the client needs documents/files off the user's machine, back them up to the
storage destination specified by the requestor (commonly the "Offboarded User Data"
SharePoint site, keeping Desktop/Documents/Downloads/Pictures), then remove the user profile(s).

### Config keys
`backupTarget`, `keep[]`, `removeProfiles`.

### Functions
None — manual checklist with the resolved backup target.

### Depends on
none.

### Variants & gotchas
Backup destination is requestor-specified for some clients, a fixed SharePoint site for
others; device wipe is a separate, approval-gated MDM action.

### Manual fallback
Manual by design (on-site/remote engineer).
