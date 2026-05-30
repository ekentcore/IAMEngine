## Notion (`notion`)

`Module: Coretelligent.Notion` (or manual) · `Mode: api` · `Build tier: 3` · `Appears in: ~1%` · `Lanes: onboard`

Workspace invite, typically via Google SSO.

### Auth
Secret: `notion-admin` (often the Google admin credential for SSO).

### Onboard lane
`on-request`. Invite the user (Settings & Members → Add members); accept the invite from the
user's mailbox; verify the user can sign in.

### Config keys
`workspace`.

### Functions
`Invoke-CtgNotionInvite`, `Confirm-CtgNotionSignIn`.

### Depends on
`google-workspace` / mailbox (to accept the invite).

### Variants & gotchas
Invite-accept step needs mailbox access; Google-SSO.

### Manual fallback
Invite + verify manually.
