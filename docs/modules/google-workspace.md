## Google Workspace (`google-workspace`)

`Module: Coretelligent.GoogleWorkspace` · `Mode: api` · `Build tier: 2` · `Appears in: ~25%` · `Lanes: both`

Identity origin for `google`-backbone clients; also present as an extra identity on some AD
clients (UOVO). Heavy offboard (data custody lives here).

### Auth
Secret: `google-admin` (Admin SDK / Directory API; domain-wide-delegated service account).
`Connect-CtgGoogle` mints a short-lived OAuth token by signing an RS256 JWT with the service
account's private key (`iss`=SA email, `sub`=impersonated super-admin, `scope`=Directory scopes)
and exchanging it at `oauth2.googleapis.com/token` — pure .NET crypto + REST, no external module,
cross-platform (central runner on Mac/Linux).

**Canonical vaulted shape:** the app writes `google-admin` on Secret Server's stock
"Automation - API" template (the same template Adobe reuses) — no field is native to this
secret type, so the fields are repurposed:

| Template field | Holds |
| --- | --- |
| `ClientSecret` | The service-account key material — **base64 of the full downloaded JSON key** (preferred), or base64 of a bare PEM private key, or either un-encoded. |
| `accountid` | The service account's client email (`client_email`). Only required when `ClientSecret` is a bare PEM — a full JSON key already carries its own `client_email`. |
| `apiURL` | The Workspace **super-admin email to impersonate** (domain-wide delegation) — repurposed field name; it is an email, not a URL. Only honored when it contains `@`. |
| `ClientID` | The Google Workspace **customer id**. Falls back to `my_customer` when absent. |

`Use-CtgGoogleSecret` tries this shape only as a fallback: the older field names are checked
first and win when present — `ServiceAccountKeyBase64`/`ServiceAccountJson`/`ServiceAccountKeyJson`/`KeyJson`
(or split `ClientEmail`+`PrivateKey`) for the key, `Impersonate`/`AdminEmail`/`Admin`/`Subject`/
`DelegatedAdmin`/`AdminUser` (or the secret's `Username`) for the admin, `CustomerId`/`Customer`
for the customer id, plus optional `Scopes`. Full operator setup (service account, domain-wide
delegation, Delinea storage): **/help/google**. Rotating the service-account key (auto-setup's
force-rotate, or a manual re-run) does not revoke the previously issued key in GCP — old keys
stay valid until cleaned up manually; automated cleanup is a planned follow-up.

### Onboard lane
`always`. (1) Create user with the username pattern; password generated or shared-default;
multi-domain selection (e.g. uovo.com vs uovo.fashion). (2) Place in OU — default Active
Users (never Root), with conditional routing (Prialto → Prialto OU, MFA → MFA OU,
uovo.fashion → GardeRobe). (3) Add group memberships. (4) Assign license (procure if needed).
(5) Calendar sharing — all-staff "see all event details"; share named conference-room
calendars with "make changes to events". (6) Test mail flow (critical). For mirror clients,
M365 later reuses this username/password.

### Offboard lane
`always`, `captureEvidence`, guardrail `do-not-delete`. Reset password (capture for manager).
Remove recovery info; screenshot + remove groups; remove connected apps; remove shared-drive
access; device → Wipe Account or Sign Out User (guardrail `no-device-wipe-without-approval`);
reset sign-in cookies; remove recovery options and add the IT-support address as notify.
Move to the Email & Calendar / Inactive OU. On request: transfer Drive ownership to the
delegate, transfer calendar events, set Gmail default-routing forwarding. NEVER delete —
deactivate only; archive later (`archive` module).

### Config keys
`usernamePattern`, `password{mode,sharedSecret}`, `domainSelection`, `ou`, `conditionalOus[]`,
`groups[]`, `license{procureIfUnavailable}`, `calendars[]`, `calendarPermission`,
`transferTarget`, `guardrails[]`, `archiveOffsetDays`.

### Functions
`Invoke-CtgGoogleOnboarding`, `Invoke-CtgGoogleOffboarding`, `New-CtgGoogleUser`,
`Set-CtgGoogleOu`, `Add-CtgGoogleGroups`, `Set-CtgGoogleCalendarShare`,
`Transfer-CtgGoogleDrive`, `Set-CtgGoogleForwarding`, `Suspend-CtgGoogleUser`.

### Depends on
`servicenow`. Offboard: OU-move must precede Drive transfer (transfer only works once moved
out of Active Users). `archive` is the scheduled follow-up.

### Variants & gotchas
Never-delete guardrail; device-wipe approval gate; OU-move-before-transfer ordering;
multi-domain + conditional OUs; "test mail flow" is a required verification; shared default
password for some clients.

### Manual fallback
Admin Console for the steps without clean Directory API coverage.
