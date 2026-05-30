## Case resolution (`case-resolution`)

`Module: Coretelligent.ServiceNow` (+ delivery) · `Mode: api` · `Build tier: 1` · `Appears in: ~90%` · `Lanes: both`

The closeout: deliver credentials, verify, and resolve the case.

### Auth
Secret: `servicenow-admin` (+ the delivery mechanism — Mimecast secure email).

### Onboard lane
`always`. If a computer is requested, ensure workstation setup is complete (Win/Mac). Verify
the MFA phone is set to the user's cell (or removed if unavailable). Send credentials via
Mimecast secure email to the requested parties. Close all tasks and resolve the case.

### Offboard lane
`always`. If the requestor needs the reset password, deliver it via Mimecast secure email.
When no steps remain, close all tasks and resolve the case.

### Config keys
`deviceSetup[]` (windows/mac), `verifyMfaPhone`, `sendCredentials`, `closeAllTasks`,
`deliverResetPasswordIfRequested`, `welcomeLetter`.

### Functions
`Send-CtgSecureCredentials` (Mimecast), `Close-CtgCaseTasks` (reused), `Confirm-CtgMfaPhone`.

### Depends on
Terminal — all other lanes for the action. Onboard creds delivery depends on the password
origin (`m365`/`google`/`active-directory`).

### Variants & gotchas
Delivery uses Mimecast secure email even for clients with no Mimecast provisioning. Some
clients require a welcome letter and a scheduled first-day call (separate modules).

### Manual fallback
Credential delivery and task closure can be done manually if delivery automation is down.
