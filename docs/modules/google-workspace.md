## Google Workspace (`google-workspace`)

`Module: Coretelligent.GoogleWorkspace` · `Mode: api` · `Build tier: 2` · `Appears in: ~25%` · `Lanes: both`

Identity origin for `google`-backbone clients; also present as an extra identity on some AD
clients (UOVO). Heavy offboard (data custody lives here).

### Auth
Secret: `google-admin` (Admin SDK / Directory API; domain-wide-delegated service account).

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
