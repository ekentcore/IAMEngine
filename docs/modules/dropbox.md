## Dropbox (`dropbox`)

`Module: Coretelligent.Dropbox` · `Mode: api` · `Build tier: 3` · `Appears in: ~19% offboard` · `Lanes: both (offboard-heavy)`

Cloud file storage. Notably offboard-weighted (data custody on departure).

### Auth
Secret: `dropbox-admin` (Dropbox Business API).

### Onboard lane
`on-request`. Provision the member; add to team folders.

### Offboard lane
`always` (for Dropbox clients). Transfer the user's files to the delegate, then deactivate
the member.

### Config keys
`transferTarget`, `teamFolders[]`.

### Functions
`Invoke-CtgDropboxOnboarding`, `Transfer-CtgDropboxFiles`, `Disable-CtgDropboxMember`.

### Depends on
`m365` / `google-workspace` (identity).

### Variants & gotchas
Offboard data transfer to a named recipient (see `data-transfer`); appears far more on the
leave side than join.

### Manual fallback
Dropbox admin console transfer + deactivate.
