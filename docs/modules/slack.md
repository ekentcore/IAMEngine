## Slack (`slack`)

`Module: Coretelligent.Slack` · `Mode: api` · `Build tier: 3` · `Appears in: ~7%` · `Lanes: both`

Workspace membership. Some clients run multiple workspaces (e.g. a TM and an IM workspace).

### Auth
Secret: `slack-admin` (SCIM / admin API; often Google SSO).

### Onboard lane
`always`/`on-request`. Invite the user to each configured workspace.

### Offboard lane
`always`. Deactivate the account in each workspace.

### Config keys
`workspaces[]`.

### Functions
`Invoke-CtgSlackInvite`, `Disable-CtgSlackUser` (per workspace).

### Depends on
`google-workspace` / `m365` (SSO identity).

### Variants & gotchas
Multi-workspace clients require iterating all workspaces; Google-SSO invite flow.

### Manual fallback
Manage Members in each workspace.
