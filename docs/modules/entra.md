## Entra (`entra`)

`Module: Coretelligent.M365` (shared) · `Mode: api` · `Build tier: 1` · `Appears in: ~90%` · `Lanes: mostly offboard`

Identity-state and MFA/session control. Shares the Graph module and `m365-admin` secret.

### Auth
Secret: `m365-admin` — the same app registration as `m365`. Adds
`UserAuthenticationMethod.ReadWrite.All` (MFA factor removal + session revocation on offboard).

We deliberately do NOT hold `Application.ReadWrite.All` or `AppRoleAssignment.ReadWrite.All`:
together they let an app grant itself further permissions, which is a self-escalation path to
tenant admin. Adding a Graph permission stays a manual act by a client's Global Admin. Nothing
in this module needs them — enterprise-app *assignment* removal on offboard works from
`User.ReadWrite.All` + `Group.ReadWrite.All`. See `web/app/help/cloud-auth`, which is the
client-facing source of truth for the consent list.

### Onboard lane
`on-request`/`always` depending on client. Add MFA email/phone if the backbone requires it;
assign requested Enterprise Applications / SSO app groups.

### Offboard lane
`always`. Ensure the account is disabled, remove from all groups (evidence first), check and
remove application/enterprise-app access (evidence first), revoke MFA sessions, revoke active
sessions. Then verify after sync that the account was not moved to the deleted-users group.

### Config keys
`enterpriseApps[]`, `ssoGroups[]`, `verifyAfterSync{waitMinutes,confirm}`.

### Functions
`Invoke-CtgEntraOffboarding` (disable/groups/app-access/revoke), `Add-CtgEntraAppAccess`,
`Revoke-CtgEntraSessions`.

### Depends on
`m365`. Offboard ordering: app-access/revoke after group removal.

### Variants & gotchas
Some clients reset the password here and capture it for the manager (deliver in
case-resolution); the "confirm not moved to deleted users" wait (~5 min) is real and
prevents premature license/cleanup actions.

### Manual fallback
None expected.
