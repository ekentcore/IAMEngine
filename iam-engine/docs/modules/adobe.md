## Adobe (`adobe`)

`Module: Coretelligent.Adobe` · `Mode: api` · `Build tier: 2` · `Appears in: ~18% on / ~37% off` · `Lanes: both`

Acrobat / Creative Cloud licensing. Higher on offboard (license reclaim). Often
client-managed but we hold admin access.

### Auth
Secret: `adobe-admin` (User Management API / UMAPI — requires an Adobe Developer Console
service account / OAuth server-to-server credential set up once).

### Onboard lane
`always`/`on-request`. Add the user (email + name); assign the product profile/license
(Acrobat Standard default; Pro/Creative Cloud if specified). Procure an uptick if no license
is available (POC approves). Verify provisioning status = Completed.

### Offboard lane
`always`. Remove license(s); remove the user account; transfer assets to the delegate named
in the case, or select "Transfer Later".

### Config keys
`productProfile`, `defaultLicense`, `procureIfUnavailable`, `transferTarget`.

### Functions
`Invoke-CtgAdobeOnboarding`, `Invoke-CtgAdobeOffboarding`, `Set-CtgAdobeLicense`,
`Remove-CtgAdobeUser`.

### Depends on
`m365` / source identity (email).

### Variants & gotchas
Enterprise vs team plans (product profile vs product); one-time service-account setup is the
real prerequisite; asset transfer on removal.

### Manual fallback
Adobe Admin Console add/remove + license.
