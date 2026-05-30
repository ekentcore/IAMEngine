## SharePoint (`sharepoint`)

`Module: Coretelligent.M365` (shared) · `Mode: api` · `Build tier: 3` · `Appears in: ~15%` · `Lanes: both`

Site membership for clients that use SharePoint sites for file access.

### Auth
Secret: `m365-admin` (Graph Sites scopes).

### Onboard lane
`always`/`on-request`. Add the user to the requested SharePoint sites/groups.

### Offboard lane
covered by group removal + OneDrive handling in the `m365` offboard; explicit site removal
if needed.

### Config keys
`sites[]`.

### Functions
`Add-CtgSharePointSiteMember`, `Remove-CtgSharePointSiteMember`.

### Depends on
`m365`.

### Variants & gotchas
Often overlaps with M365 group membership; the "Offboarded User Data" SharePoint site is the
backup target for OneDrive on offboard (see `m365`/`data-transfer`).

### Manual fallback
Site membership via SharePoint admin.
