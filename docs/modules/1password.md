## 1Password (`1password`)

`Module: Coretelligent.OnePassword` · `Mode: api` · `Build tier: 3` · `Appears in: ~1%` · `Lanes: both`

Password manager. Distinctive in needing two secrets (login + security key).

### Auth
Secrets: `1password-login` AND `1password-secret-key` (both required — the canonical
multi-secret module).

### Onboard lane
`on-request`. Create the user / send the invite.

### Offboard lane
`always` (if present). Suspend the user (Manage People → Suspend).

### Config keys
(uses two `secretNames`); `vault` if scoped.

### Functions
`Invoke-CtgOnePasswordInvite`, `Suspend-CtgOnePasswordUser`.

### Depends on
identity.

### Variants & gotchas
Two-secret auth is the reason `ClientSystem.secretNames` is an array; SCIM-based.

### Manual fallback
1Password admin console.
