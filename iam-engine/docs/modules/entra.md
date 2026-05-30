## Entra (`entra`)

`Module: Coretelligent.M365` (shared) · `Mode: api` · `Build tier: 1` · `Appears in: ~90%` · `Lanes: mostly offboard`

Identity-state and MFA/session control. Shares the Graph module and `m365-admin` secret.

### Auth
Secret: `m365-admin`. Scopes add `Directory.ReadWrite.All`, `Application.ReadWrite.All`,
`UserAuthenticationMethod.ReadWrite.All` (for MFA/session revocation).

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
