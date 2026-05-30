## Zoom (`zoom`)

`Module: Coretelligent.Zoom` · `Mode: api` · `Build tier: 3` · `Appears in: ~14% on / ~34% off` · `Lanes: both`

Meetings licensing. Higher on offboard (license reclaim).

### Auth
Secret: `zoom-admin` (Zoom API; some clients use Google sign-in).

### Onboard lane
`always`/`on-request`. Create the user with a license; if no license is available, purchase
one (client-permitted) via the Zoom admin center.

### Offboard lane
`always`. Deactivate the user (User Management → Users → deactivate).

### Config keys
`license`, `procureIfUnavailable`, `signIn` (google|zoom).

### Functions
`Invoke-CtgZoomOnboarding`, `Disable-CtgZoomUser`.

### Depends on
`m365` / `google-workspace` (identity / SSO).

### Variants & gotchas
Google-SSO clients; purchase-if-none permission varies by client.

### Manual fallback
Zoom admin console.
